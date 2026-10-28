import { systemState, systemUrl, operatorViews } from "@/lib/crm-destination-state";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, getCsrfToken } from "@/lib/queryClient";
import { ContentOrganicKpiPanel } from "@/components/ContentOrganicKpiPanel";
import { PageHeader } from "@/components/crm/CrmPresentation";
import {useRetainedLocalIntent} from "@/hooks/use-retained-local-intent";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Activity, AlertTriangle, ArrowUpRight, BarChart3, Calendar, CheckCircle2,
  Clock, Loader2, Mail, MessageSquare, Phone, RefreshCw, Send, Shield,
  Target, TrendingUp, Users, XCircle, Zap, Eye, Filter, ChevronRight, ChevronDown, Server, GitMerge,
  Bot, DollarSign, Hash, Play, Flag, ShieldCheck, FileText, Upload, Database,
  LayoutDashboard, Menu, GitBranch, Megaphone, Sparkles, Settings, Link2, ArrowRight,
  ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSearch, useLocation } from "wouter";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import StatementChainPanel from "@/components/operator/StatementChainPanel";
import { ALeadQueue } from "./sdr/ALeadQueue";
import { LeadQueuePanel } from "@/components/dashboard/LeadQueuePanel";
import { ProcessorIntelligence } from "./sdr/ProcessorIntelligence";
import LaunchReadinessPage from "./LaunchReadiness";
import AiLearningCenter from "./AiLearningCenter";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell, Legend, LineChart, Line } from "recharts";
import type { LifecycleStageCountsResponse, OperatorSdrStatsResponse } from "@shared/operator-dashboard-types";

interface SyncConflict {
  id: number;
  contactId: number;
  fieldName: string;
  internalValue: string | null;
  ghlValue: string | null;
  internalUpdatedAt: string | null;
  ghlUpdatedAt: string | null;
  resolution: string;
  resolvedAt: string | null;
  createdAt: string | null;
}

function SyncConflictsPanel() {
  const { toast } = useToast();
  const [filter, setFilter] = useState("pending");

  const { data: conflicts, isLoading, isError, refetch } = useQuery<SyncConflict[]>({
    queryKey: ["/api/operator/sync-conflicts", filter],
    queryFn: async () => {
      const url = filter === "all"
        ? "/api/operator/sync-conflicts"
        : `/api/operator/sync-conflicts?resolution=${filter}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sync conflicts");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ id, resolution }: { id: number; resolution: "kept-internal" | "kept-ghl" | "manual" }) => {
      const res = await apiRequest("PATCH", `/api/operator/sync-conflicts/${id}/resolve`, { resolution });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Conflict resolved" });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/sync-conflicts"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to resolve conflict", description: err.message, variant: "destructive" });
    },
  });

  const conflictList = Array.isArray(conflicts) ? conflicts : [];
  const pendingCount = conflictList.filter(c => c.resolution === "pending").length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="sync-conflicts-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load sync conflicts</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-sync-conflicts">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">GHL Sync Conflicts</h3>
          {pendingCount > 0 && (
            <Badge variant="destructive" data-testid="badge-pending-conflicts">{pendingCount} pending</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[140px]" data-testid="select-conflict-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="kept-internal">Kept Ours</SelectItem>
              <SelectItem value="kept-ghl">Kept GHL</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} aria-label="Refresh sync conflicts" data-testid="btn-refresh-conflicts">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {conflictList.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground" data-testid="no-conflicts-message">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="text-sm font-medium">No conflicts found</p>
          <p className="text-xs">GHL sync is clean — no unresolved field conflicts</p>
        </div>
      )}

      <div className="space-y-3">
        {conflictList.map((conflict) => (
          <Card key={conflict.id} data-testid={`conflict-card-${conflict.id}`} className={conflict.resolution === "pending" ? "border-yellow-300 dark:border-yellow-700" : ""}>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="font-mono text-xs" data-testid={`conflict-field-${conflict.id}`}>
                      {conflict.fieldName}
                    </Badge>
                    <Badge
                      variant={conflict.resolution === "pending" ? "destructive" : conflict.resolution === "kept-internal" ? "default" : "secondary"}
                      data-testid={`conflict-resolution-${conflict.id}`}
                    >
                      {conflict.resolution}
                    </Badge>
                    <span className="text-xs text-muted-foreground">Contact #{conflict.contactId}</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <div className="text-xs text-muted-foreground mb-1 font-medium">Internal (Ours)</div>
                      <div className="font-mono text-xs break-all" data-testid={`conflict-internal-${conflict.id}`}>
                        {conflict.internalValue || <span className="italic text-muted-foreground">(empty)</span>}
                      </div>
                      {conflict.internalUpdatedAt && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(conflict.internalUpdatedAt).toLocaleString()}
                        </div>
                      )}
                    </div>
                    <div className="bg-orange-50 dark:bg-orange-950/30 rounded p-2">
                      <div className="text-xs text-muted-foreground mb-1 font-medium">GHL Value</div>
                      <div className="font-mono text-xs break-all" data-testid={`conflict-ghl-${conflict.id}`}>
                        {conflict.ghlValue || <span className="italic text-muted-foreground">(empty)</span>}
                      </div>
                      {conflict.ghlUpdatedAt && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(conflict.ghlUpdatedAt).toLocaleString()}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="text-xs text-muted-foreground">
                    Detected: {conflict.createdAt ? new Date(conflict.createdAt).toLocaleString() : "—"}
                    {conflict.resolvedAt && ` · Resolved: ${new Date(conflict.resolvedAt).toLocaleString()}`}
                  </div>
                </div>

                {conflict.resolution === "pending" && (
                  <div className="flex gap-2 sm:flex-col sm:items-end shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/30"
                      onClick={() => resolveMutation.mutate({ id: conflict.id, resolution: "kept-internal" })}
                      disabled={resolveMutation.isPending}
                      data-testid={`btn-keep-ours-${conflict.id}`}
                    >
                      Keep Ours
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-orange-300 text-orange-700 hover:bg-orange-50 dark:border-orange-700 dark:text-orange-400 dark:hover:bg-orange-950/30"
                      onClick={() => resolveMutation.mutate({ id: conflict.id, resolution: "kept-ghl" })}
                      disabled={resolveMutation.isPending}
                      data-testid={`btn-keep-ghl-${conflict.id}`}
                    >
                      Keep GHL
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

interface SerperControl {
  id: number;
  enabled: boolean;
  state: "closed" | "open" | "half_open";
  consecutive_failures: number;
  opened_at: string | null;
  reason_code: string | null;
  window_calls: number;
  window_successes: number;
  window_failures: number;
  window_started_at: string;
  window_ends_at: string;
  lifetime_calls: string | number;
  lifetime_successes: string | number;
  lifetime_failures: string | number;
  yield_websites: string | number;
  yield_emails: string | number;
  yield_phones: string | number;
}

function SerperControlPanel() {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<null | "toggle" | "recovery" | "reset">(null);
  const [reason, setReason] = useState("");

  const { data, isLoading, isError, refetch } = useQuery<{ control: SerperControl }>({
    queryKey: ["/api/admin/serper/control"],
    queryFn: async () => {
      const res = await fetch("/api/admin/serper/control", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch Serper control state");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const control = data?.control;

  const onMutationSuccess = (title: string) => (resp: any) => {
    toast({ title });
    setDialog(null);
    setReason("");
    // Update from committed server response only — no optimistic UI.
    queryClient.setQueryData(["/api/admin/serper/control"], { control: resp.control });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/serper/control"] });
  };

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/admin/serper/enabled", {
        enabled: !control?.enabled,
        reason: reason.trim(),
      });
      return res.json();
    },
    onSuccess: onMutationSuccess("Serper gateway updated"),
    onError: (err: any) => toast({ title: "Toggle failed", description: err.message, variant: "destructive" }),
  });

  const recoveryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/serper/recovery", { reason: reason.trim() });
      return res.json();
    },
    onSuccess: onMutationSuccess("Manual recovery attempted"),
    onError: (err: any) => toast({ title: "Recovery failed", description: err.message, variant: "destructive" }),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/serper/reset-window", {
        reason: reason.trim(),
        expectedWindowStartedAt: control?.window_started_at,
      });
      return res.json();
    },
    onSuccess: onMutationSuccess("Window counters reset"),
    onError: (err: any) => toast({ title: "Window reset failed", description: err.message, variant: "destructive" }),
  });

  const anyPending = toggleMutation.isPending || recoveryMutation.isPending || resetMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !control) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="serper-control-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load Serper gateway state</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-serper-control">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const stateBadge =
    control.state === "closed" ? (
      <Badge className="bg-green-600 text-white" data-testid="badge-serper-state">closed</Badge>
    ) : control.state === "open" ? (
      <Badge variant="destructive" data-testid="badge-serper-state">open</Badge>
    ) : (
      <Badge className="bg-yellow-500 text-black" data-testid="badge-serper-state">half_open</Badge>
    );

  const activeMutation = dialog === "toggle" ? toggleMutation : dialog === "recovery" ? recoveryMutation : resetMutation;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">Serper Gateway Control</h3>
          <Badge variant={control.enabled ? "default" : "secondary"} data-testid="badge-serper-enabled">
            {control.enabled ? "Enabled" : "Disabled"}
          </Badge>
          {stateBadge}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={anyPending} aria-label="Refresh Serper control status" data-testid="btn-refresh-serper">
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground mb-1">Circuit</div>
          <div className="text-sm font-medium">{control.state}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {control.consecutive_failures} consecutive failures
            {control.reason_code ? ` · ${control.reason_code}` : ""}
          </div>
          {control.opened_at && (
            <div className="text-xs text-muted-foreground">Opened {new Date(control.opened_at).toLocaleString()}</div>
          )}
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground mb-1">Window Usage</div>
          <div className="text-sm font-medium" data-testid="text-serper-window-usage">
            {control.window_calls} requests
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {control.window_successes} ok · {control.window_failures} failed
          </div>
          <div className="text-xs text-muted-foreground">Ends {new Date(control.window_ends_at).toLocaleString()}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground mb-1">Lifetime</div>
          <div className="text-sm font-medium">{String(control.lifetime_calls)} calls</div>
          <div className="text-xs text-muted-foreground mt-1">
            {String(control.lifetime_successes)} ok · {String(control.lifetime_failures)} failed
          </div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground mb-1">Yield</div>
          <div className="text-xs text-muted-foreground mt-1">
            {String(control.yield_websites)} websites · {String(control.yield_emails)} emails · {String(control.yield_phones)} phones
          </div>
        </CardContent></Card>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={control.enabled ? "destructive" : "default"}
          size="sm"
          disabled={anyPending}
          onClick={() => { setReason(""); setDialog("toggle"); }}
          data-testid="btn-serper-toggle"
        >
          {control.enabled ? "Disable Serper" : "Enable Serper"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={anyPending}
          onClick={() => { setReason(""); setDialog("recovery"); }}
          data-testid="btn-serper-recovery"
        >
          Manual Recovery
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={anyPending}
          onClick={() => { setReason(""); setDialog("reset"); }}
          data-testid="btn-serper-reset-window"
        >
          Reset Window
        </Button>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !anyPending) { setDialog(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "toggle"
                ? control.enabled ? "Disable Serper gateway?" : "Enable Serper gateway?"
                : dialog === "recovery"
                ? "Attempt manual recovery?"
                : "Reset window counters?"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {dialog === "toggle" && !control.enabled && control.state === "open" && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                The circuit breaker is currently open. Enabling Serper will NOT close it — traffic remains
                blocked until recovery succeeds.
              </p>
            )}
            {dialog === "recovery" && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                This transitions the circuit to half_open and fires one diagnostic probe. If the probe fails,
                the circuit re-opens automatically.
              </p>
            )}
            {dialog === "reset" && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                This only resets local window accounting (calls, successes, failures, yields). It does NOT
                grant additional provider quota, enable Serper, or close an open circuit.
              </p>
            )}
            <Textarea
              placeholder="Reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={anyPending}
              data-testid="input-serper-reason"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={anyPending} onClick={() => { setDialog(null); setReason(""); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={anyPending || !reason.trim()}
                onClick={() => activeMutation.mutate()}
                data-testid="btn-serper-confirm"
              >
                {anyPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SerperUsageLogPanel />
    </div>
  );
}

interface SerperUsageDayRow {
  day: string;
  successes: string | number;
  provider_errors: string | number;
  blocked: string | number;
  total: string | number;
}

interface SerperUsageCallSiteRow {
  call_site: string | null;
  successes: string | number;
  provider_errors: string | number;
  blocked: string | number;
  total: string | number;
}

interface SerperUsageBlockReasonRow {
  block_reason: string | null;
  total: string | number;
}

interface SerperUsageLogResponse {
  days: number;
  byDay: SerperUsageDayRow[];
  byCallSite: SerperUsageCallSiteRow[];
  byBlockReason: SerperUsageBlockReasonRow[];
}

function SerperUsageLogPanel() {
  const [days, setDays] = useState("14");

  const { data, isLoading, isError, error, refetch } = useQuery<SerperUsageLogResponse>({
    queryKey: ["/api/admin/serper/usage-log", days],
    queryFn: async () => {
      const res = await fetch(`/api/admin/serper/usage-log?days=${encodeURIComponent(days)}`, { credentials: "include" });
      if (!res.ok) {
        if (res.status === 404) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.message ?? "serper_call_log table missing — run migrations");
        }
        throw new Error("Failed to fetch Serper usage log");
      }
      return res.json();
    },
    refetchInterval: 60000,
  });

  const num = (v: string | number | null | undefined) => Number(v ?? 0);
  const failRate = (row: { total: string | number; provider_errors: string | number; blocked: string | number }) => {
    const total = num(row.total);
    if (total === 0) return 0;
    return (num(row.provider_errors) + num(row.blocked)) / total;
  };

  // Day buckets come back as UTC midnight timestamps (date_trunc('day', ...)). Format the
  // calendar date directly from the UTC fields so it never shifts to the prior day in
  // timezones behind UTC (e.g. all US timezones).
  const formatUtcDay = (iso: string, opts?: Intl.DateTimeFormatOptions) =>
    new Date(iso).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });

  const chartData = (data?.byDay ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      day: formatUtcDay(row.day, { month: "short", day: "numeric" }),
      Successes: num(row.successes),
      "Provider Errors": num(row.provider_errors),
      Blocked: num(row.blocked),
    }));

  return (
    <div className="space-y-4" data-testid="section-serper-usage-log">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-semibold">Serper Usage by Day &amp; Feature</h3>
        <div className="flex items-center gap-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-32" data-testid="select-serper-usage-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} aria-label="Refresh Serper usage log" data-testid="btn-refresh-serper-usage-log">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="serper-usage-log-error">
          <AlertTriangle className="w-8 h-8 text-red-500" />
          <p className="text-sm text-muted-foreground">
            {(error as Error)?.message || "Failed to load Serper usage log"}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Retry
          </Button>
        </div>
      ) : !data || (data.byDay.length === 0 && data.byCallSite.length === 0) ? (
        <p className="text-sm text-muted-foreground py-6 text-center" data-testid="serper-usage-log-empty">
          No Serper calls logged in this window.
        </p>
      ) : (
        <>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground mb-2">Calls per day</div>
              <div style={{ width: "100%", height: 220 }}>
                <ResponsiveContainer>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="day" fontSize={11} />
                    <YAxis fontSize={11} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="Successes" stackId="a" fill="#16a34a" />
                    <Bar dataKey="Provider Errors" stackId="a" fill="#ea580c" />
                    <Bar dataKey="Blocked" stackId="a" fill="#dc2626" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div>
            <div className="text-xs text-muted-foreground mb-2">Usage by call site (feature)</div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Call Site</th>
                    <th className="text-right p-2 font-medium">Total</th>
                    <th className="text-right p-2 font-medium">Successes</th>
                    <th className="text-right p-2 font-medium">Provider Errors</th>
                    <th className="text-right p-2 font-medium">Blocked</th>
                    <th className="text-right p-2 font-medium">Fail Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCallSite.map((row) => {
                    const rate = failRate(row);
                    const highFail = rate > 0.2 && num(row.total) >= 5;
                    return (
                      <tr key={row.call_site ?? "unknown"} className="border-t" data-testid={`row-serper-callsite-${row.call_site ?? "unknown"}`}>
                        <td className="p-2">{row.call_site ?? "unknown"}</td>
                        <td className="p-2 text-right">{num(row.total)}</td>
                        <td className="p-2 text-right text-green-600">{num(row.successes)}</td>
                        <td className="p-2 text-right text-orange-600">{num(row.provider_errors)}</td>
                        <td className="p-2 text-right text-red-600">{num(row.blocked)}</td>
                        <td className="p-2 text-right">
                          <span className={cn(highFail && "font-semibold text-red-600")}>
                            {(rate * 100).toFixed(0)}%
                          </span>
                          {highFail && (
                            <Badge variant="destructive" className="ml-2" data-testid={`badge-high-fail-${row.call_site ?? "unknown"}`}>
                              High
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {data.byBlockReason.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-2">Block reasons</div>
              <div className="flex flex-wrap gap-2">
                {data.byBlockReason.map((row) => (
                  <Badge
                    key={row.block_reason ?? "unspecified"}
                    variant="outline"
                    data-testid={`badge-block-reason-${row.block_reason ?? "unspecified"}`}
                  >
                    {(row.block_reason ?? "unspecified")}: {num(row.total)}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs text-muted-foreground mb-2">Usage by day</div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Day</th>
                    <th className="text-right p-2 font-medium">Total</th>
                    <th className="text-right p-2 font-medium">Successes</th>
                    <th className="text-right p-2 font-medium">Provider Errors</th>
                    <th className="text-right p-2 font-medium">Blocked</th>
                    <th className="text-right p-2 font-medium">Fail Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byDay.map((row) => {
                    const rate = failRate(row);
                    const highFail = rate > 0.2 && num(row.total) >= 5;
                    return (
                      <tr key={row.day} className="border-t" data-testid={`row-serper-day-${row.day}`}>
                        <td className="p-2">{formatUtcDay(row.day)}</td>
                        <td className="p-2 text-right">{num(row.total)}</td>
                        <td className="p-2 text-right text-green-600">{num(row.successes)}</td>
                        <td className="p-2 text-right text-orange-600">{num(row.provider_errors)}</td>
                        <td className="p-2 text-right text-red-600">{num(row.blocked)}</td>
                        <td className="p-2 text-right">
                          <span className={cn(highFail && "font-semibold text-red-600")}>
                            {(rate * 100).toFixed(0)}%
                          </span>
                          {highFail && (
                            <Badge variant="destructive" className="ml-2">High</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface InvalidGhlContactRow {
  contactId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  reasonCode: string | null;
  stage: string | null;
  occurrences: number;
  lastOccurredAt: string;
  status: "resolved" | "unresolved";
}

function GhlInvalidContactsPanel() {
  const [statusFilter, setStatusFilter] = useState<"unresolved" | "all">("unresolved");

  const { data, isLoading, isError, refetch } = useQuery<{ total: number; rows: InvalidGhlContactRow[] }>({
    queryKey: ["/api/admin/ghl/invalid-contacts", statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/admin/ghl/invalid-contacts?status=${statusFilter}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch invalid contacts");
      return res.json();
    },
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="invalid-contacts-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load invalid contacts</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-invalid-contacts">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">GHL Invalid Contacts</h3>
          {data && data.total > 0 && statusFilter === "unresolved" && (
            <Badge variant="destructive" data-testid="badge-invalid-contacts-count">{data.total}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "unresolved" | "all")}>
            <SelectTrigger className="w-[140px]" data-testid="select-invalid-contacts-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unresolved">Unresolved</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} aria-label="Refresh invalid contacts" data-testid="btn-refresh-invalid-contacts">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground" data-testid="no-invalid-contacts-message">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="text-sm font-medium">No contacts flagged for invalid identity.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3">Contact</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Reason</th>
                <th className="py-2 pr-3">Stage</th>
                <th className="py-2 pr-3">Occurrences</th>
                <th className="py-2 pr-3">Last Occurred</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.contactId} className="border-b" data-testid={`invalid-contact-row-${row.contactId}`}>
                  <td className="py-2 pr-3">
                    <a href={`/dashboard/contacts/${row.contactId}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      {[row.firstName, row.lastName].filter(Boolean).join(" ") || `Contact #${row.contactId}`}
                    </a>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{row.email || <span className="italic text-muted-foreground">(none)</span>}</td>
                  <td className="py-2 pr-3"><Badge variant="outline" className="font-mono text-xs">{row.reasonCode || "—"}</Badge></td>
                  <td className="py-2 pr-3 text-xs">{row.stage || "—"}</td>
                  <td className="py-2 pr-3">{row.occurrences}</td>
                  <td className="py-2 pr-3 text-xs">{new Date(row.lastOccurredAt).toLocaleString()}</td>
                  <td className="py-2">
                    <Badge variant={row.status === "unresolved" ? "destructive" : "secondary"}>{row.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface OperatorKpis {
  range: string;
  startDate: string;
  endDate: string;
  leadsQueued: number;
  emailsSent: number;
  smsSent: number;
  callsMade: number;
  totalContacted: number;
  replies: number;
  positiveReplies: number;
  meetingsBooked: number;
  statementsRequested: number;
  proposalsSent: number;
  closedWon: number;
  closedLost: number;
  bounceRate: number;
  replyRate: number;
  positiveIntentRate: number;
  bookedCallRate: number;
  sendSuccessRate: number;
  activeIdentities: number;
  pausedSystems: number;
  stuckLeadsCount: number;
}

interface SendMonitoringIdentity {
  id: number;
  label: string;
  domain: string;
  emailAddress: string;
  isActive: boolean | null;
  warmupStatus: string | null;
  warmupProgress: number;
  warmupDays: number;
  dailyLimit: number;
  sentToday: number;
  bouncesToday: number;
  complaintsToday: number;
  healthScore: number | null;
  capUtilization: number;
  week: {
    sent: number;
    delivered: number;
    bounced: number;
    replied: number;
    complaints: number;
    opened: number;
    positiveReplies: number;
    bounceRate: number;
    replyRate: number;
    complaintRate: number;
    openRate: number;
  };
}

interface RecentSend {
  action: string;
  channel: string;
  entityId: number | null;
  sentAt: string;
}

interface SendMonitoringData {
  identities: SendMonitoringIdentity[];
  aggregated: {
    totalIdentities: number;
    activeIdentities: number;
    totalSentToday: number;
    totalDailyLimit: number;
    overallCapUtilization: number;
    smtpFallbacksLast24h?: number | null;
    ghlSendsLast24h?: number | null;
    channelCountsAvailable?: boolean;
    asOf?: string;
    scope?: string;
  };
  recentSends?: RecentSend[];
}

interface WebhookEvent {
  id: number;
  eventType: string;
  merchantId: number | null;
  businessName: string;
  leadStateId: number | null;
  fromStage: string | null;
  toStage: string | null;
  actionType: string | null;
  channel: string | null;
  actorType: string | null;
  decisionReason: string | null;
  complianceResult: string | null;
  metadata: any;
  ghlRefId: string | null;
  createdAt: string | null;
  eventAt: string | null;
}

interface LowConfidenceItem {
  id: number;
  merchantId: number;
  businessName: string;
  classifiedIntent: string;
  confidence: number;
  replyText: string;
  channel: string;
  createdAt: string;
}

interface StuckLead {
  type: string;
  leadId: number | null;
  merchantId: number;
  businessName: string;
  currentStage: string | null;
  nextActionAt: string | null;
  reason: string;
  stageAgeDays?: number;
}

function KpiCard({ label, value, icon: Icon, color, suffix, subtext }: {
  label: string;
  value: number | string;
  icon: any;
  color: string;
  suffix?: string;
  subtext?: string;
}) {
  return (
    <Card data-testid={`kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Icon className={`w-4 h-4 ${color}`} />
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <div className="text-2xl font-bold" data-testid={`kpi-value-${label.toLowerCase().replace(/\s+/g, "-")}`}>
          {value}{suffix}
        </div>
        {subtext && <div className="text-xs text-muted-foreground mt-1">{subtext}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * ConfirmationSuccessRateCard
 * Shows the "Confirmation send success rate" stat for today's ET window.
 * Fetches from /api/operator/confirmation-metric, polls every 60 seconds.
 * Semantics: enrolled + sent / (enrolled + sent + failed). Skipped excluded from both.
 * "Delivered" and "Delivery rate" labels are intentionally absent — no delivery webhook exists.
 */
function ConfirmationSuccessRateCard() {
  const { data, isLoading } = useQuery<{
    rate: number;
    numerator: number;
    denominator: number;
    windowStart: string;
    windowEnd: string;
    timezone: string;
    cohortSemantics: string;
  }>({
    queryKey: ["/api/operator/confirmation-metric"],
    queryFn: async () => {
      const res = await fetch("/api/operator/confirmation-metric", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch confirmation metric");
      return res.json();
    },
    refetchInterval: 60000,
  });

  return (
    <Card data-testid="card-confirmation-rate">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Confirmation send success rate</div>
            {isLoading ? (
              <div className="h-7 w-16 bg-muted animate-pulse rounded" />
            ) : data?.denominator === 0 ? (
              <div className="text-2xl font-bold text-muted-foreground">—</div>
            ) : (
              <div className="text-2xl font-bold" data-testid="text-confirmation-rate">
                {data?.rate ?? 0}%
              </div>
            )}
            <div className="text-xs text-muted-foreground" data-testid="text-confirmation-counts">
              {isLoading
                ? "Loading…"
                : data?.denominator === 0
                ? "No submissions today"
                : `${data?.numerator ?? 0} of ${data?.denominator ?? 0} submissions · today ET`}
            </div>
          </div>
          <Mail className="w-8 h-8 text-muted-foreground opacity-40" />
        </div>
      </CardContent>
    </Card>
  );
}

function OperatorKpiPanel() {
  const [range, setRange] = useState("today");

  const { data: kpis, isLoading, isError, refetch } = useQuery<OperatorKpis>({
    queryKey: ["/api/sdr/operator/kpis", range],
    queryFn: async () => {
      const res = await fetch(`/api/sdr/operator/kpis?range=${range}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch KPIs");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const rangeLabel = range === "today" ? "Today" : range === "yesterday" ? "Yesterday" : "Last 7 Days";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="kpi-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load KPI data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-kpis">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Pilot KPIs — {rangeLabel}</h3>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-[140px]" data-testid="select-kpi-range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="yesterday">Yesterday</SelectItem>
            <SelectItem value="7day">Last 7 Days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <KpiCard label="Leads Queued" value={kpis?.leadsQueued || 0} icon={Users} color="text-blue-600" />
        <KpiCard label="Contacted" value={kpis?.totalContacted || 0} icon={Send} color="text-purple-600" subtext={`${kpis?.emailsSent || 0} email, ${kpis?.smsSent || 0} sms`} />
        <KpiCard label="Send Success" value={kpis?.sendSuccessRate || 0} icon={CheckCircle2} color="text-green-600" suffix="%" subtext={`${kpis?.bounceRate || 0}% bounce`} />
        <KpiCard label="Bounce Rate" value={kpis?.bounceRate || 0} icon={XCircle} color="text-red-600" suffix="%" />
        <KpiCard label="Reply Rate" value={kpis?.replyRate || 0} icon={MessageSquare} color="text-orange-600" suffix="%" subtext={`${kpis?.replies || 0} replies`} />
        <KpiCard label="Positive Intent" value={kpis?.positiveIntentRate || 0} icon={TrendingUp} color="text-emerald-600" suffix="%" subtext={`${kpis?.positiveReplies || 0} positive`} />
        <KpiCard label="Booked Calls" value={kpis?.meetingsBooked || 0} icon={Calendar} color="text-indigo-600" subtext={`${kpis?.bookedCallRate || 0}% rate`} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Statements" value={kpis?.statementsRequested || 0} icon={Target} color="text-teal-600" />
        <KpiCard label="Stuck Leads" value={kpis?.stuckLeadsCount || 0} icon={AlertTriangle} color="text-yellow-600" subtext="Needs attention" />
        <KpiCard label="Active Identities" value={kpis?.activeIdentities || 0} icon={Activity} color="text-cyan-600" subtext={`${kpis?.pausedSystems || 0} paused`} />
      </div>

      <ConfirmationSuccessRateCard />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-2">Outreach Breakdown</div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> Email</span>
                <span className="font-medium">{kpis?.emailsSent || 0}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> SMS</span>
                <span className="font-medium">{kpis?.smsSent || 0}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> Calls</span>
                <span className="font-medium">{kpis?.callsMade || 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-2">Funnel Progress</div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>Proposals Sent</span>
                <span className="font-medium">{kpis?.proposalsSent || 0}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>Closed Won</span>
                <span className="font-medium text-green-600">{kpis?.closedWon || 0}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>Closed Lost</span>
                <span className="font-medium text-red-600">{kpis?.closedLost || 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-2">System Status</div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>Active Inboxes</span>
                <Badge variant={kpis?.activeIdentities ? "default" : "destructive"} data-testid="badge-active-inboxes">
                  {kpis?.activeIdentities || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>Paused Systems</span>
                <Badge variant={(kpis?.pausedSystems || 0) > 0 ? "destructive" : "secondary"} data-testid="badge-paused-systems">
                  {kpis?.pausedSystems || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>Stuck Leads</span>
                <Badge variant={(kpis?.stuckLeadsCount || 0) > 5 ? "destructive" : "secondary"} data-testid="badge-stuck-leads">
                  {kpis?.stuckLeadsCount || 0}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface BounceFeedbackIdentity {
  emailAddress: string;
  label: string;
  inboxBouncesToday: number;
}

interface BounceFeedbackSummary {
  contactsWrittenBackToday: number;
  identities: BounceFeedbackIdentity[];
}

function SendMonitoringPanel() {
  const { data, isLoading, isError, refetch } = useQuery<SendMonitoringData>({
    queryKey: ["/api/sdr/operator/send-monitoring"],
    refetchInterval: 15000,
  });

  const { data: bounceFeedback } = useQuery<BounceFeedbackSummary>({
    queryKey: ["/api/sdr/operator/bounce-feedback-summary"],
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="send-monitoring-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load send monitoring data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-send-monitoring">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const agg = data?.aggregated;
  const recentSends = Array.isArray(data?.recentSends) ? data.recentSends : [];
  const identities = Array.isArray(data?.identities) ? data.identities : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Send Monitoring</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="w-3 h-3 animate-spin" /> Auto-refresh every 15s
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KpiCard label="Total Identities" value={agg?.totalIdentities || 0} icon={Mail} color="text-blue-600" />
        <KpiCard label="Active" value={agg?.activeIdentities || 0} icon={Activity} color="text-green-600" />
        <KpiCard label="Sent Today" value={agg?.totalSentToday || 0} icon={Send} color="text-purple-600" subtext={`of ${agg?.totalDailyLimit || 0} limit`} />
        <KpiCard label="Cap Used" value={agg?.overallCapUtilization || 0} icon={BarChart3} color="text-orange-600" suffix="%" />
        <KpiCard
          label="Contacts Written Back"
          value={bounceFeedback?.contactsWrittenBackToday ?? 0}
          icon={AlertTriangle}
          color="text-red-600"
          subtext="bounced today (CRM)"
        />
      </div>

      {(agg?.smtpFallbacksLast24h ?? 0) > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3" data-testid="banner-smtp-fallback-warning">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <span className="font-semibold text-amber-800 dark:text-amber-300">SMTP Fallback Active: </span>
            <span className="text-amber-700 dark:text-amber-400">
              {agg!.smtpFallbacksLast24h} email{agg!.smtpFallbacksLast24h === 1 ? "" : "s"} delivered via SMTP in the last 24 hours.
              GHL was unavailable for these sends. Check the{" "}
              <a href="/dashboard/operator" className="underline font-medium">Email Health tab</a>.
            </span>
          </div>
        </div>
      )}

      {((agg?.ghlSendsLast24h ?? 0) > 0 || (agg?.smtpFallbacksLast24h ?? 0) > 0) && (
        <Card data-testid="card-channel-breakdown">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">Communication Channel (24h)</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 overflow-x-auto">
            <table className="w-full text-sm min-w-[240px]">
              <thead>
                <tr className="border-b">
                  <th className="text-left font-medium text-muted-foreground pb-1.5">Channel</th>
                  <th className="text-right font-medium text-muted-foreground pb-1.5">Sends</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b last:border-0">
                  <td className="py-2 flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                    GHL (all channels)
                  </td>
                  <td className="py-2 text-right font-medium" data-testid="channel-count-ghl">{agg?.channelCountsAvailable === false ? "unavailable" : (agg?.ghlSendsLast24h ?? 0)}</td>
                </tr>
                <tr>
                  <td className="py-2 flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                    SMTP Fallback
                  </td>
                  <td className="py-2 text-right font-medium" data-testid="channel-count-smtp">{agg?.channelCountsAvailable === false ? "unavailable" : (agg?.smtpFallbacksLast24h ?? 0)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {recentSends.length > 0 && (
        <Card data-testid="card-recent-sends">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">Recent Sends — Communication Channel</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 overflow-x-auto">
            <table className="w-full text-xs min-w-[400px]">
              <thead>
                <tr className="border-b">
                  <th className="text-left font-medium text-muted-foreground pb-1.5">Type</th>
                  <th className="text-left font-medium text-muted-foreground pb-1.5">Communication Channel</th>
                  <th className="text-right font-medium text-muted-foreground pb-1.5">Time</th>
                </tr>
              </thead>
              <tbody>
                {recentSends.map((s, idx) => {
                  const channelColor =
                    s.channel === "GHL-Direct" ? "text-green-600 dark:text-green-400" :
                    s.channel === "GHL-Workflow" ? "text-blue-600 dark:text-blue-400" :
                    s.channel === "SMTP-Fallback" ? "text-amber-600 dark:text-amber-400" :
                    "text-muted-foreground";
                  const typeLabel =
                    s.action === "proposal_email_sent" ? "Proposal" :
                    s.action === "merchant_welcome_sent" ? "Merchant Welcome" :
                    s.action === "merchant_portal_welcome_sent" ? "Portal Welcome" :
                    s.action === "co_branded_proposal_sent" ? "Co-Brand Proposal" : s.action;
                  return (
                    <tr key={idx} className="border-b last:border-0" data-testid={`recent-send-${idx}`}>
                      <td className="py-1.5 pr-2 text-muted-foreground">{typeLabel}</td>
                      <td className={`py-1.5 pr-2 font-medium ${channelColor}`}>{s.channel}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{new Date(s.sentAt).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {identities.map((identity) => (
          <Card key={identity.id} data-testid={`send-identity-${identity.id}`}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="font-medium text-sm">{identity.label}</div>
                    <div className="text-xs text-muted-foreground">{identity.emailAddress}</div>
                  </div>
                  <Badge
                    variant={identity.warmupStatus === "warm" ? "default" : identity.warmupStatus === "warming" ? "secondary" : "destructive"}
                    data-testid={`badge-warmup-${identity.id}`}
                  >
                    {identity.warmupStatus || "unknown"}
                  </Badge>
                  {identity.isActive ? (
                    <Badge variant="outline" className="text-green-600 border-green-300">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-red-600 border-red-300">Paused</Badge>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold" data-testid={`health-score-${identity.id}`}>{identity.healthScore != null ? Math.round(identity.healthScore) : "—"}</div>
                  <div className="text-xs text-muted-foreground">Health</div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm mb-3">
                <div>
                  <div className="text-xs text-muted-foreground">Today</div>
                  <div className="font-medium">{identity.sentToday} / {identity.dailyLimit}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">7d Sent</div>
                  <div className="font-medium">{identity.week.sent}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">7d Bounced</div>
                  <div className="font-medium text-red-600">{identity.week.bounced} ({identity.week.bounceRate}%)</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">7d Replied</div>
                  <div className="font-medium text-green-600">{identity.week.replied} ({identity.week.replyRate}%)</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Inbox Bounces Today</div>
                  {(() => {
                    const entry = bounceFeedback?.identities?.find(b => b.emailAddress === identity.emailAddress);
                    const count = entry?.inboxBouncesToday ?? 0;
                    return (
                      <div className={`font-medium ${count > 0 ? "text-red-600" : "text-muted-foreground"}`} data-testid={`bounce-contacts-${identity.id}`}>
                        {count}
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span>Daily Cap Utilization</span>
                  <span>{identity.capUtilization}%</span>
                </div>
                <Progress value={identity.capUtilization} className="h-2" />
                {identity.warmupStatus === "warming" && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span>Warmup Progress ({identity.warmupDays}d / 14d)</span>
                      <span>{identity.warmupProgress}%</span>
                    </div>
                    <Progress value={identity.warmupProgress} className="h-2" />
                  </div>
                )}
              </div>

              {identity.week.complaints > 0 && (
                <div className="mt-2 flex items-center gap-1 text-xs text-red-600">
                  <AlertTriangle className="w-3 h-3" />
                  {identity.week.complaints} complaint(s) this week ({identity.week.complaintRate}%)
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function WebhookEventViewer() {
  const [eventFilter, setEventFilter] = useState<string>("all");

  const { data: events, isLoading, isError, refetch } = useQuery<WebhookEvent[]>({
    queryKey: ["/api/sdr/operator/webhook-events", eventFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "50" });
      if (eventFilter && eventFilter !== "all") params.set("eventType", eventFilter);
      const res = await fetch(`/api/sdr/operator/webhook-events?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
    refetchInterval: 30000,
  });

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="webhook-events-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load webhook events</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-webhook-events">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const eventList = Array.isArray(events) ? events : [];
  const eventTypes = [...new Set(eventList.map(e => e.eventType))];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Webhook Event Log</h3>
        <Select value={eventFilter} onValueChange={setEventFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-event-filter">
            <SelectValue placeholder="All Events" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Events</SelectItem>
            {eventTypes.map(type => (
              <SelectItem key={type} value={type}>{type.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-2">
          {eventList.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">No webhook events found</div>
          )}
          {eventList.map((event) => (
            <Card key={event.id} data-testid={`webhook-event-${event.id}`}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">{event.eventType.replace(/_/g, " ")}</Badge>
                    {event.channel && <Badge variant="secondary" className="text-xs">{event.channel}</Badge>}
                    {event.actorType && <Badge variant="secondary" className="text-xs">{event.actorType}</Badge>}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {event.createdAt ? new Date(event.createdAt).toLocaleString() : "—"}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Business: </span>
                    <span className="font-medium">{event.businessName}</span>
                  </div>
                  {event.fromStage && (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Stage: </span>
                      <span>{event.fromStage}</span>
                      <ChevronRight className="w-3 h-3" />
                      <span className="font-medium">{event.toStage}</span>
                    </div>
                  )}
                  {event.decisionReason && (
                    <div>
                      <span className="text-muted-foreground">Reason: </span>
                      <span>{event.decisionReason}</span>
                    </div>
                  )}
                  {event.complianceResult && (
                    <div>
                      <span className="text-muted-foreground">Compliance: </span>
                      <span>{event.complianceResult}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StuckLeadsPanel() {
  const { data: stuckLeads, isLoading, isError, refetch } = useQuery<StuckLead[]>({
    queryKey: ["/api/sdr/dashboard/stuck-leads"],
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="stuck-leads-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load stuck leads</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-stuck-leads">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const stuckLeadList = Array.isArray(stuckLeads) ? stuckLeads : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Stuck Leads — Needs Attention</h3>
        <Badge variant={stuckLeadList.length > 0 ? "destructive" : "secondary"} data-testid="badge-stuck-count">
          {stuckLeadList.length} leads
        </Badge>
      </div>

      {stuckLeadList.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">No stuck leads — all systems running smoothly</div>
      )}

      <div className="space-y-2">
        {stuckLeadList.map((lead, idx) => (
          <Card key={`${lead.merchantId}-${idx}`} data-testid={`stuck-lead-${lead.merchantId}`}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertTriangle className={`w-4 h-4 ${lead.type === "overdue" ? "text-red-600" : "text-yellow-600"}`} />
                  <div>
                    <div className="font-medium text-sm">{lead.businessName}</div>
                    <div className="text-xs text-muted-foreground">{lead.reason}</div>
                  </div>
                </div>
                <div className="text-right">
                  <Badge variant="outline" className="text-xs">{lead.currentStage}</Badge>
                  {lead.stageAgeDays !== undefined && (
                    <div className="text-xs text-muted-foreground mt-1">{lead.stageAgeDays}d in stage</div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

interface ActivationStatusData {
  ready: boolean;
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  heartbeat: { sequenceRunner: any; slaWorker: any; stageProgression: any };
  activeIdentities: number;
  totalIdentities: number;
  activeEnrollments: number;
  flags: Record<string, boolean>;
  ghlSync?: { circuitOpen: boolean; consecutiveFailures: number };
}

function ReadinessChecklistWidget() {
  const { data, isLoading, isError, refetch } = useQuery<ActivationStatusData>({
    queryKey: ["/api/operator/activation-status"],
    refetchInterval: 30000,
  });

  if (isLoading) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="readiness-checklist-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load readiness checklist</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-readiness-checklist">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const checks = Array.isArray(data.checks) ? data.checks : [];
  const slaTickAt = data.heartbeat?.slaWorker?.at ? new Date(data.heartbeat.slaWorker.at).getTime() : 0;
  const seqTickAt = data.heartbeat?.sequenceRunner?.at ? new Date(data.heartbeat.sequenceRunner.at).getTime() : 0;
  const STALE_MS = 15 * 60 * 1000;
  const workersFresh = slaTickAt > 0 && (Date.now() - slaTickAt) < STALE_MS;
  const systemActive = data.ready && workersFresh;
  const failed = checks.filter(c => !c.ok);
  const reason = systemActive
    ? "All preconditions met — pipeline & outreach active"
    : failed.length > 0
      ? `Idle — ${failed[0].label}`
      : "Idle — worker heartbeat stale";

  return (
    <div className="space-y-3">
      <Card className={systemActive ? "border-green-500/50 bg-green-500/5" : "border-yellow-500/50 bg-yellow-500/5"}>
        <CardContent className="p-4 flex items-start gap-3">
          {systemActive ? (
            <CheckCircle2 className="w-6 h-6 text-green-600 mt-0.5" />
          ) : (
            <AlertTriangle className="w-6 h-6 text-yellow-600 mt-0.5" />
          )}
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-base" data-testid="text-system-status">
                System {systemActive ? "Active" : "Idle"}
              </span>
              <Badge variant={systemActive ? "default" : "secondary"} data-testid="badge-system-status">
                {checks.filter(c => c.ok).length}/{checks.length} checks pass
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground mt-1" data-testid="text-system-reason">{reason}</div>
            <div className="text-xs text-muted-foreground mt-2">
              SLA tick: {data.heartbeat.slaWorker?.at ? new Date(data.heartbeat.slaWorker.at).toLocaleString() : "never"} ·
              {" "}Sequence tick: {data.heartbeat.sequenceRunner?.at ? new Date(data.heartbeat.sequenceRunner.at).toLocaleString() : "never"}
            </div>
          </div>
        </CardContent>
      </Card>

      {data.ghlSync?.circuitOpen && (
        <Card className="border-red-500/70 bg-red-500/5" data-testid="card-ghl-circuit-open">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold text-sm text-red-700 dark:text-red-400">GHL Sync Circuit Breaker — OPEN</div>
              <div className="text-xs text-muted-foreground mt-1">
                {data.ghlSync.consecutiveFailures} consecutive GHL API failures detected. The sync loop paused to avoid flooding a degraded API.
                It will automatically reset and retry on the next 45-second tick. Refresh GHL credentials if this persists.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Pre-Flight Readiness Checklist</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2">
            {checks.map((check, idx) => (
              <li key={check.id} className="flex items-start gap-3 p-2 border rounded" data-testid={`operator-check-${check.id}`}>
                <div className="flex items-center justify-center w-6 h-6 rounded-full border text-xs font-bold mt-0.5">{idx + 1}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {check.ok
                      ? <CheckCircle2 className="w-4 h-4 text-green-600" />
                      : <AlertTriangle className="w-4 h-4 text-yellow-600" />}
                    <span className="text-sm font-medium">{check.label}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 ml-6">{check.detail}</div>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 pt-3 border-t flex items-center gap-2 text-xs text-muted-foreground" data-testid="row-ghl-circuit-state">
            <span className={`w-2 h-2 rounded-full ${data.ghlSync?.circuitOpen ? "bg-red-500" : "bg-green-500"}`} />
            GHL circuit breaker: {data.ghlSync?.circuitOpen
              ? `OPEN (${data.ghlSync.consecutiveFailures} failures — will auto-reset next tick)`
              : "Closed — sync healthy"}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface RecentSendsData {
  windowHours: number;
  totals: { email: number; calls: number; outbound: number; all: number };
  recent: Array<{ id: number; channel: string; to: string; subject: string; status: string; sentAt: string }>;
}

function RecentSendsWidget() {
  const { data, isLoading, isError, refetch } = useQuery<RecentSendsData>({
    queryKey: ["/api/operator/recent-sends"],
    refetchInterval: 30000,
  });

  if (isLoading) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="recent-sends-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load recent sends</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-recent-sends">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const recent = Array.isArray(data.recent) ? data.recent : [];
  const totals = data.totals || { email: 0, calls: 0, outbound: 0, all: 0 };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Email (24h)" value={totals.email} icon={Mail} color="text-blue-600" />
        <KpiCard label="Calls (24h)" value={totals.calls} icon={Phone} color="text-purple-600" />
        <KpiCard label="Outbound (24h)" value={totals.outbound} icon={Send} color="text-green-600" />
        <KpiCard label="All Sends (24h)" value={totals.all} icon={Activity} color="text-orange-600" />
      </div>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Recent Email Sends (last 20)</CardTitle></CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm" data-testid="text-no-recent-sends">No outbound sends in last 24 hours</div>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left">
                    <th className="py-1 px-2">Time</th>
                    <th className="py-1 px-2">To</th>
                    <th className="py-1 px-2">Subject</th>
                    <th className="py-1 px-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(r => (
                    <tr key={r.id} className="border-b" data-testid={`recent-send-${r.id}`}>
                      <td className="py-1 px-2 whitespace-nowrap">{r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : "-"}</td>
                      <td className="py-1 px-2 truncate max-w-32">{r.to}</td>
                      <td className="py-1 px-2 truncate max-w-64">{r.subject}</td>
                      <td className="py-1 px-2"><Badge variant="outline" className="text-xs">{r.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface SilentSequencesData {
  totalActive: number;
  silentCount: number;
  reason: string;
  workerStale: boolean;
  outreachEnabled: boolean;
  lastTick: any;
  items: Array<{ id: number; contactId: number; dealId: number; sequenceId: number; currentStep: number; status: string; nextActionAt: string; updatedAt: string }>;
}

function SilentSequencesWidget() {
  const { data, isLoading, isError, refetch } = useQuery<SilentSequencesData>({
    queryKey: ["/api/operator/silent-sequences"],
    refetchInterval: 30000,
  });

  if (isLoading) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="silent-sequences-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load silent sequences</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-silent-sequences">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const items = Array.isArray(data.items) ? data.items : [];

  return (
    <div className="space-y-3">
      <Card className={data.silentCount > 0 || data.workerStale ? "border-yellow-500/50 bg-yellow-500/5" : ""}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className={`w-5 h-5 mt-0.5 ${data.silentCount > 0 || data.workerStale ? "text-yellow-600" : "text-muted-foreground"}`} />
            <div className="flex-1">
              <div className="font-medium text-sm" data-testid="text-silent-reason">{data.reason}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {data.totalActive} active enrollments · {data.silentCount} silent for &gt;24h ·
                {" "}Outreach flag: <span className={data.outreachEnabled ? "text-green-600" : "text-red-600"}>{data.outreachEnabled ? "ON" : "OFF"}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Last tick: {data.lastTick?.at ? new Date(data.lastTick.at).toLocaleString() : "never"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Silent Enrollments (no progress &gt;24h)</CardTitle></CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm" data-testid="text-no-silent">All enrollments are progressing</div>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left">
                    <th className="py-1 px-2">ID</th>
                    <th className="py-1 px-2">Contact</th>
                    <th className="py-1 px-2">Sequence</th>
                    <th className="py-1 px-2">Step</th>
                    <th className="py-1 px-2">Next Action</th>
                    <th className="py-1 px-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(it => (
                    <tr key={it.id} className="border-b" data-testid={`silent-row-${it.id}`}>
                      <td className="py-1 px-2">{it.id}</td>
                      <td className="py-1 px-2">{it.contactId}</td>
                      <td className="py-1 px-2">{it.sequenceId}</td>
                      <td className="py-1 px-2">{it.currentStep}</td>
                      <td className="py-1 px-2 text-muted-foreground whitespace-nowrap">{it.nextActionAt ? new Date(it.nextActionAt).toLocaleString() : "-"}</td>
                      <td className="py-1 px-2 text-muted-foreground whitespace-nowrap">{it.updatedAt ? new Date(it.updatedAt).toLocaleString() : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// #1444 Step 1 — Worker interval controls
function WorkerIntervalsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  interface WorkerIntervals {
    ghlSyncIntervalMs: number;
    slaCheckIntervalMs: number;
    ghlFloorMs: number;
    slaFloorMs: number;
  }

  const { data, isLoading } = useQuery<WorkerIntervals>({
    queryKey: ["/api/admin/settings/worker-intervals"],
  });

  const [ghlMs, setGhlMs] = useState("");
  const [slaMs, setSlaMs] = useState("");
  const [initialized, setInitialized] = useState(false);

  if (!initialized && data) {
    setGhlMs(String(data.ghlSyncIntervalMs));
    setSlaMs(String(data.slaCheckIntervalMs));
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PUT", "/api/admin/settings/worker-intervals", {
        ghlSyncIntervalMs: Number(ghlMs),
        slaCheckIntervalMs: Number(slaMs),
      });
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Worker intervals updated. Changes take effect on the next queue tick." });
      qc.invalidateQueries({ queryKey: ["/api/admin/settings/worker-intervals"] });
      setInitialized(false);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  const msToSeconds = (ms: string) => {
    const n = Number(ms);
    return isFinite(n) ? (n / 1000).toFixed(0) : "—";
  };

  return (
    <div className="space-y-4" data-testid="panel-worker-intervals">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Worker Queue Intervals
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Set how often each BullMQ repeat job fires. Changes persist to the database and are picked up on the next job cycle.
            Minimum: GHL sync 30s, SLA checks 120s.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">GHL Sync Interval (ms)</label>
              <Input
                type="number"
                min={data?.ghlFloorMs ?? 30000}
                step={1000}
                value={ghlMs}
                onChange={e => setGhlMs(e.target.value)}
                className="h-8 text-sm"
                aria-label="GHL sync interval in milliseconds" data-testid="input-ghl-sync-interval"
              />
              <p className="text-xs text-muted-foreground">≈ {msToSeconds(ghlMs)}s (floor: {((data?.ghlFloorMs ?? 30000) / 1000).toFixed(0)}s)</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">SLA Check Interval (ms)</label>
              <Input
                type="number"
                min={data?.slaFloorMs ?? 120000}
                step={1000}
                value={slaMs}
                onChange={e => setSlaMs(e.target.value)}
                className="h-8 text-sm"
                aria-label="SLA check interval in milliseconds" data-testid="input-sla-check-interval"
              />
              <p className="text-xs text-muted-foreground">≈ {msToSeconds(slaMs)}s (floor: {((data?.slaFloorMs ?? 120000) / 1000).toFixed(0)}s)</p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            data-testid="button-save-worker-intervals"
          >
            {saveMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Save Intervals
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// #1444 Step 2 — Worker heartbeat status panel
function WorkerHeartbeatPanel() {
  interface HeartbeatEntry {
    queueName: string;
    lastSeenMs: number | null;
    lastSeenAt: string | null;
    expectedIntervalMs: number;
    stale: boolean;
  }
  interface HeartbeatsResponse {
    heartbeats: HeartbeatEntry[];
    asOf: string;
  }

  const { data, isLoading, refetch } = useQuery<HeartbeatsResponse>({
    queryKey: ["/api/admin/worker-heartbeats"],
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  const staleCount = data?.heartbeats.filter(h => h.stale).length ?? 0;

  return (
    <div className="space-y-4" data-testid="panel-worker-heartbeats">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Worker Heartbeats
              {staleCount > 0 && (
                <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
                  {staleCount} stale
                </span>
              )}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => refetch()} className="h-6 px-2 text-xs gap-1">
              <RefreshCw className="w-3 h-3" /> Refresh
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Each BullMQ worker writes a heartbeat at the start of every job. A worker is flagged red when it has not
            checked in within 2× its expected interval.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2 pr-4 font-medium">Queue</th>
                  <th className="text-right py-2 px-3 font-medium">Expected interval</th>
                  <th className="text-right py-2 px-3 font-medium">Last seen</th>
                  <th className="text-right py-2 pl-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(data?.heartbeats ?? []).map(h => (
                  <tr key={h.queueName} className="border-b last:border-0" data-testid={`heartbeat-row-${h.queueName}`}>
                    <td className="py-2 pr-4">
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{h.queueName}</code>
                    </td>
                    <td className="text-right py-2 px-3 text-muted-foreground text-xs">
                      {(h.expectedIntervalMs / 1000 / 60).toFixed(0)} min
                    </td>
                    <td className="text-right py-2 px-3 text-xs text-muted-foreground">
                      {h.lastSeenAt ? new Date(h.lastSeenAt).toLocaleString() : "Never"}
                    </td>
                    <td className="text-right py-2 pl-3">
                      {h.stale ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
                          ● Stale
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                          ● OK
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.asOf && (
            <p className="text-xs text-muted-foreground mt-2">As of {new Date(data.asOf).toLocaleString()}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// #1253 — Per-stage pipeline silence thresholds editor
function PipelineSilenceThresholdsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ thresholds: Record<string, number> }>({
    queryKey: ["/api/admin/settings/pipeline-silence-thresholds"],
  });

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [initialized, setInitialized] = useState(false);

  // Sync server data into draft on first load
  if (!initialized && data) {
    const init: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.thresholds)) init[k] = String(v);
    setDraft(init);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const thresholds: Record<string, number> = {};
      for (const [k, v] of Object.entries(draft)) {
        const n = parseFloat(v);
        if (!k.trim() || !isFinite(n) || n <= 0) continue;
        thresholds[k.trim()] = n;
      }
      await apiRequest("PUT", "/api/admin/settings/pipeline-silence-thresholds", { thresholds });
      return thresholds;
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Per-stage silence thresholds updated" });
      qc.invalidateQueries({ queryKey: ["/api/admin/settings/pipeline-silence-thresholds"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="space-y-4" data-testid="panel-pipeline-silence-thresholds">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Settings className="w-4 h-4" />
            Per-Stage Pipeline Silence Thresholds
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Set how many hours of deal inactivity triggers a silence alert for each pipeline stage.
            Key format: <code className="bg-muted px-1 rounded">pipeline::stage</code> (e.g. <code className="bg-muted px-1 rounded">onboarding::New Lead</code>).
            Falls back to the global <code className="bg-muted px-1 rounded">PIPELINE_SILENCE_THRESHOLD_HOURS</code> env var (default 24h).
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.keys(draft).length === 0 && (
            <p className="text-xs text-muted-foreground italic">No per-stage overrides — all stages use the global default.</p>
          )}
          {Object.entries(draft).map(([key]) => (
            <div key={key} className="flex items-center gap-2">
              <Input
                value={key}
                readOnly
                className="h-7 text-xs font-mono flex-1"
                data-testid={`thresh-key-${key}`}
              />
              <Input
                type="number"
                min={1}
                value={draft[key]}
                onChange={e => setDraft(p => ({ ...p, [key]: e.target.value }))}
                className="h-7 text-xs w-24"
                data-testid={`thresh-val-${key}`}
              />
              <span className="text-xs text-muted-foreground">h</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-destructive hover:text-destructive"
                onClick={() => setDraft(p => { const n = { ...p }; delete n[key]; return n; })}
                data-testid={`thresh-delete-${key}`}
              >
                ✕
              </Button>
            </div>
          ))}

          <div className="flex items-center gap-2 pt-2 border-t">
            <Input
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
              placeholder="pipeline::stage"
              className="h-7 text-xs font-mono flex-1"
              data-testid="thresh-new-key"
            />
            <Input
              type="number"
              min={1}
              value={newVal}
              onChange={e => setNewVal(e.target.value)}
              placeholder="hours"
              className="h-7 text-xs w-24"
              data-testid="thresh-new-val"
            />
            <span className="text-xs text-muted-foreground">h</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => {
                if (!newKey.trim() || !newVal) return;
                setDraft(p => ({ ...p, [newKey.trim()]: newVal }));
                setNewKey("");
                setNewVal("");
              }}
              data-testid="thresh-add-btn"
            >
              + Add
            </Button>
          </div>

          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            size="sm"
            className="mt-2"
            data-testid="thresh-save-btn"
          >
            {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Save Thresholds
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

interface SubjectAuditItem {
  id: number;
  contactId: number;
  dealId: number | null;
  sequenceId: number | null;
  sequenceName: string | null;
  currentStep: number | null;
  status: string;
  nextActionAt: string | null;
  updatedAt: string | null;
  nextStepSubject: string | null;
  nextStepType: string | null;
}

interface SubjectAuditData {
  totalActive: number;
  midSequenceCount: number;
  items: SubjectAuditItem[];
}

function SubjectAuditPanel() {
  const { toast } = useToast();

  const { data, isLoading, isError, refetch } = useQuery<SubjectAuditData>({
    queryKey: ["/api/operator/enrollment-subject-audit"],
    refetchInterval: 60000,
  });

  const retriggerMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/operator/enrollment-subject-audit/retrigger", {});
      return res.json();
    },
    onSuccess: (result: { count: number; message: string }) => {
      toast({ title: `Re-triggered ${result.count} enrollment(s)`, description: result.message });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/enrollment-subject-audit"] });
    },
    onError: (err: any) => {
      toast({ title: "Re-trigger failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load enrollment audit data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-subject-audit">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const midCount = data?.midSequenceCount ?? 0;
  const auditItems = Array.isArray(data?.items) ? data.items : [];

  return (
    <div className="space-y-4">
      <Card className={midCount > 0 ? "border-yellow-500/50 bg-yellow-500/5" : "border-green-500/30 bg-green-500/5"}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Mail className={`w-5 h-5 mt-0.5 ${midCount > 0 ? "text-yellow-600" : "text-green-600"}`} />
              <div>
                <div className="font-medium text-sm" data-testid="text-subject-audit-summary">
                  {midCount > 0
                    ? `${midCount} mid-sequence enrollment${midCount !== 1 ? "s" : ""} may have pending steps with updated subject lines`
                    : "No mid-sequence enrollments — all leads are at step 0 or completed"}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {data?.totalActive ?? 0} total active enrollments · {midCount} past step 0 (subject sync relevant)
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Re-triggering bumps <code className="bg-muted px-1 rounded">nextActionAt</code> to now so the sequence worker uses the updated subject on the next tick.
                </div>
              </div>
            </div>
            {midCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10"
                disabled={retriggerMutation.isPending}
                onClick={() => retriggerMutation.mutate()}
                data-testid="btn-retrigger-enrollments"
              >
                {retriggerMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-1" />
                )}
                Re-trigger All ({midCount})
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Mid-Sequence Active Enrollments</CardTitle>
        </CardHeader>
        <CardContent>
          {auditItems.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm" data-testid="text-no-mid-sequence">
              No mid-sequence enrollments found
            </div>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left">
                    <th className="py-1 px-2">ID</th>
                    <th className="py-1 px-2">Contact</th>
                    <th className="py-1 px-2">Sequence</th>
                    <th className="py-1 px-2">Step</th>
                    <th className="py-1 px-2">Next Step Type</th>
                    <th className="py-1 px-2">Next Subject</th>
                    <th className="py-1 px-2">Next Action At</th>
                  </tr>
                </thead>
                <tbody>
                  {auditItems.map(item => (
                    <tr key={item.id} className="border-b hover:bg-muted/30" data-testid={`subject-audit-row-${item.id}`}>
                      <td className="py-1 px-2">{item.id}</td>
                      <td className="py-1 px-2">{item.contactId}</td>
                      <td className="py-1 px-2 max-w-[150px] truncate" title={item.sequenceName ?? undefined}>
                        {item.sequenceName ?? `Seq #${item.sequenceId}`}
                      </td>
                      <td className="py-1 px-2">{item.currentStep}</td>
                      <td className="py-1 px-2">
                        {item.nextStepType ? (
                          <Badge variant="secondary" className="text-xs capitalize">{item.nextStepType}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-1 px-2 max-w-[200px] truncate text-muted-foreground" title={item.nextStepSubject ?? undefined}>
                        {item.nextStepSubject ?? <span className="italic">none / non-email step</span>}
                      </td>
                      <td className="py-1 px-2 text-muted-foreground whitespace-nowrap">
                        {item.nextActionAt ? new Date(item.nextActionAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LowConfidencePanel() {
  const { data: items, isLoading, isError, refetch } = useQuery<LowConfidenceItem[]>({
    queryKey: ["/api/sdr/operator/low-confidence"],
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="low-confidence-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load low confidence data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-low-confidence">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Low Confidence Classifications (&lt;70%)</h3>
        <Badge variant={(items?.length || 0) > 0 ? "destructive" : "secondary"} data-testid="badge-low-confidence-count">
          {items?.length || 0} flagged
        </Badge>
      </div>

      {items?.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">No low-confidence classifications found</div>
      )}

      <div className="space-y-2">
        {items?.map((item) => (
          <Card key={item.id} data-testid={`low-confidence-${item.id}`}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-600" />
                  <span className="font-medium text-sm">{item.businessName}</span>
                  <Badge variant="outline">{item.classifiedIntent}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="destructive">{Math.round(item.confidence * 100)}%</Badge>
                  <span className="text-xs text-muted-foreground">
                    {item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}
                  </span>
                </div>
              </div>
              {item.replyText && (
                <div className="text-xs bg-muted p-2 rounded mt-2 line-clamp-2">{item.replyText}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

interface JobStatus {
  jobName: string;
  status: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  runCount: number;
  consecutiveFailures: number;
  updatedAt: string | null;
  lastDurationMs: number | null;
}

const JOB_LABELS: Record<string, string> = {
  "ghl-sync": "GHL Contact Sync",
  "sla-worker": "SLA Worker",
  "inbox-rotation": "Inbox Rotation",
  "content-scheduler": "Content Scheduler",
  "sequence-worker": "Sequence Worker",
  "anomaly-detection": "Anomaly Detection",
  "weekly-digest": "Weekly Digest",
  "mid-ingestion": "MID Ingestion",
  "ghl-sync-mode": "GHL Sync Mode (bullmq vs. fallback)",
  "sequence-enrollment-processor": "Sequence Enrollment Processor",
  "enrichment-queue-processor": "Enrichment Queue Processor",
};

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** Stored job status is historical. A "running" row whose last update is old is reported as stale, not live. */
const JOB_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
function jobFreshness(job: JobStatus, nowMs: number): "fresh" | "stale" | "unknown" {
  const stamp = job.updatedAt ?? job.lastFinishedAt ?? job.lastStartedAt;
  if (!stamp) return "unknown";
  const t = new Date(stamp).getTime();
  if (!Number.isFinite(t)) return "unknown";
  return nowMs - t > JOB_STALE_AFTER_MS ? "stale" : "fresh";
}

function JobHealthPanel() {
  const { data, isLoading, isError, refetch } = useQuery<{ jobs: JobStatus[] }>({
    queryKey: ["/api/operator/job-status"],
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3" data-testid="job-health-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load job health data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-job-health">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const criticalJobs = jobs.filter(j => j.consecutiveFailures >= 3);

  return (
    <div className="space-y-4" data-testid="panel-job-health">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="w-5 h-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Background Job Health</h3>
          {criticalJobs.length > 0 && (
            <Badge variant="destructive" data-testid="badge-job-failures">
              {criticalJobs.length} failing
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-refresh-job-health">
          <RefreshCw className="w-4 h-4 mr-1" /> Refresh
        </Button>
      </div>

      {criticalJobs.length > 0 && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 flex items-start gap-2" data-testid="alert-job-failures">
          <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-800 dark:text-red-200">
            <strong>{criticalJobs.length} job{criticalJobs.length > 1 ? "s" : ""}</strong> {criticalJobs.length > 1 ? "have" : "has"} 3 or more consecutive failures:{" "}
            {criticalJobs.map(j => JOB_LABELS[j.jobName] || j.jobName).join(", ")}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground" data-testid="text-job-health-note">
        Status is the last stored value for each job (historical). Rows not updated in the last 6 hours are marked stale; a stored status does not prove the job is running now.
      </p>
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]" data-testid="table-job-health">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Job</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Run</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Duration</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Runs</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Failures</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {jobs.map((job) => {
              const isCritical = job.consecutiveFailures >= 3;
              const label = JOB_LABELS[job.jobName] || job.jobName;
              return (
                <tr
                  key={job.jobName}
                  className={isCritical ? "bg-red-50 dark:bg-red-950/30" : ""}
                  data-testid={`row-job-${job.jobName}`}
                >
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      {isCritical && <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                      {label}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        job.status === "running" ? "secondary"
                          : job.status === "succeeded" ? "outline"
                          : job.status === "failed" ? "destructive"
                          : "secondary"
                      }
                      className={
                        job.status === "succeeded"
                          ? "border-green-500 text-green-700 dark:text-green-400"
                          : ""
                      }
                      data-testid={`badge-job-status-${job.jobName}`}
                    >
                      {job.status === "running" && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                      {job.status === "succeeded" && <CheckCircle2 className="w-3 h-3 mr-1" />}
                      {job.status === "failed" && <XCircle className="w-3 h-3 mr-1" />}
                      {job.status}
                    </Badge>
                    {jobFreshness(job, Date.now()) !== "fresh" && (
                      <span className="ml-2 text-xs text-amber-700 dark:text-amber-400" data-testid={`text-job-freshness-${job.jobName}`}>
                        {jobFreshness(job, Date.now()) === "stale" ? `stale · stored status from ${formatRelativeTime(job.updatedAt ?? job.lastFinishedAt ?? job.lastStartedAt)}` : "freshness unknown"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs" data-testid={`text-job-last-run-${job.jobName}`}>
                    {formatRelativeTime(job.lastFinishedAt)}
                    {job.lastError && (
                      <div className="text-red-500 truncate max-w-[180px]" title={job.lastError}>
                        {job.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDuration(job.lastDurationMs)}
                  </td>
                  <td className="px-4 py-3 text-xs">{job.runCount}</td>
                  <td className="px-4 py-3">
                    {job.consecutiveFailures > 0 ? (
                      <span className={`text-xs font-medium ${isCritical ? "text-red-600 dark:text-red-400" : "text-yellow-600 dark:text-yellow-400"}`} data-testid={`text-job-failures-${job.jobName}`}>
                        {job.consecutiveFailures}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Auto-refreshes every 30 seconds</p>
    </div>
  );
}

interface QueueMetric {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
  repeatEveryMs: number;
  lastCompletedAt: string | null;
  lastRetainedRedisCompletedAt?: string | null;
  lastFailedAt: string | null;
  workerSelected?: boolean;
  workerActive?: boolean;
  avgDurationMs: number | null;
  throughputPerHour: number | null;
}

interface DlqItem {
  id: string;
  queue: string;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  failedAt: string | number | null;
}

interface QueueMetricsData {
  status?: "ok" | "not_initialized" | "degraded";
  queues: QueueMetric[];
  queueMode?: "bullmq_redis" | "legacy_interval_partial" | "unavailable";
}

interface QueueHistoryResponse {
  status: "ok" | "not_initialized";
  resultScope: "fixed_24_hour_memory";
  history: Record<string, Array<{ label: string; completed: number; failed: number }>>;
}

interface DlqResponse {
  status: "ok" | "not_initialized" | "degraded";
  items: DlqItem[];
  resultScope: "sampled_per_queue";
  complete: boolean;
  queueStatus: Array<{ source: string; status: string; sampleLimitPerQueue?: number }>;
}

function formatRepeatInterval(ms: number): string {
  if (ms < 60000) return `${ms / 1000}s`;
  if (ms < 3600000) return `${ms / 60000}m`;
  return `${ms / 3600000}h`;
}

function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function QueueMetricsPanel() {
  const { toast } = useToast();
  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);

  const { data: metrics, isLoading: metricsLoading, isError: metricsError, refetch: refetchMetrics } = useQuery<QueueMetricsData>({
    queryKey: ["/api/operator/queue-metrics"],
    refetchInterval: 15000,
  });

  const { data: historyData } = useQuery<QueueHistoryResponse>({
    queryKey: ["/api/operator/queue-history"],
    refetchInterval: 60000,
  });

  const { data: dlqData, isLoading: dlqLoading, isError: dlqError, refetch: refetchDlq } = useQuery<DlqResponse>({
    queryKey: ["/api/operator/queue-dlq"],
    refetchInterval: 30000,
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/operator/queue-dlq/${encodeURIComponent(id)}/retry`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Job requeued for retry" });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/queue-dlq"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/queue-metrics"] });
    },
    onError: (err: any) => toast({ title: "Retry failed", description: err.message, variant: "destructive" }),
  });

  const discardMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/operator/queue-dlq/${encodeURIComponent(id)}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Job discarded" });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/queue-dlq"] });
    },
    onError: (err: any) => toast({ title: "Discard failed", description: err.message, variant: "destructive" }),
  });

  const pauseMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", `/api/operator/queue/${name}/pause`);
      return res.json();
    },
    onSuccess: (_data, name) => {
      toast({ title: `Queue ${name} paused` });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/queue-metrics"] });
    },
    onError: (err: any) => toast({ title: "Failed to pause queue", description: err.message, variant: "destructive" }),
  });

  const resumeMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", `/api/operator/queue/${name}/resume`);
      return res.json();
    },
    onSuccess: (_data, name) => {
      toast({ title: `Queue ${name} resumed` });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/queue-metrics"] });
    },
    onError: (err: any) => toast({ title: "Failed to resume queue", description: err.message, variant: "destructive" }),
  });

  const queueList = Array.isArray(metrics?.queues) ? metrics.queues : [];
  const dlqList = Array.isArray(dlqData?.items) ? dlqData.items : [];
  const queueUnavailable = metricsError || metrics?.status === "not_initialized" || (metrics?.status === "degraded" && queueList.length === 0);
  const dlqUnavailable = dlqError || dlqData?.status === "not_initialized" || dlqData?.status === "degraded";
  const totalActive = queueList.reduce((s, q) => s + q.active, 0);
  const totalWaiting = queueList.reduce((s, q) => s + q.waiting, 0);
  const totalFailed = queueList.reduce((s, q) => s + q.failed, 0);

  return (
    <div className="space-y-6">
      {metrics?.queueMode && metrics.queueMode !== "bullmq_redis" && (
        <div className="flex items-center gap-2 p-3 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-md text-sm text-yellow-800 dark:text-yellow-300" data-testid="banner-mock-redis">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>BullMQ queue mode is <strong>{metrics.queueMode}</strong>. No in-memory queue is running; configure <code className="font-mono bg-yellow-100 dark:bg-yellow-900 px-1 rounded">REDIS_URL</code> for durable queues.</span>
        </div>
      )}
      {queueUnavailable && (
        <div className="flex items-center gap-2 p-3 border border-amber-300 rounded-md text-sm text-amber-800 dark:text-amber-300" data-testid="queue-unavailable-state">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Queue metrics are unavailable because the queue service is not initialized. No worker was started by this read.
        </div>
      )}
      {!queueUnavailable && metrics?.status === "degraded" && (
        <div className="flex items-center gap-2 p-3 border border-amber-300 rounded-md text-sm text-amber-800 dark:text-amber-300" data-testid="queue-degraded-state">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Queue telemetry is degraded. Per-queue data is still shown; a completion retained in Redis does not prove this process ran it.
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <Card data-testid="card-queue-active">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="w-4 h-4 text-blue-500" />
              <span className="text-xs text-muted-foreground">Active Jobs</span>
            </div>
            <div className="text-2xl font-bold">{totalActive}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-queue-waiting">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-orange-500" />
              <span className="text-xs text-muted-foreground">Waiting</span>
            </div>
            <div className="text-2xl font-bold">{totalWaiting}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-queue-failed">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <XCircle className="w-4 h-4 text-red-500" />
              <span className="text-xs text-muted-foreground">Failed (DLQ)</span>
            </div>
            <div className="text-2xl font-bold text-red-600">{totalFailed}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Queue Health</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => refetchMetrics()} aria-label="Refresh queue metrics" data-testid="btn-refresh-queues">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {metricsLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : queueUnavailable ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">Queue state is unavailable; no health conclusion can be drawn.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left py-2 px-4 font-medium text-muted-foreground">Queue</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Active</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Waiting</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Failed</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Retained Done</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Avg Duration</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Rate/hr</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">Repeats</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">Worker / Tick</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queueList.map(q => (
                    <tr key={q.name} className={`border-b last:border-0 hover:bg-muted/20 cursor-pointer ${selectedQueue === q.name ? "bg-muted/40" : ""}`} onClick={() => setSelectedQueue(selectedQueue === q.name ? null : q.name)} data-testid={`row-queue-${q.name}`}>
                      <td className="py-2 px-4 font-mono text-xs font-medium">{q.name}</td>
                      <td className="py-2 px-3 text-right">
                        {q.active > 0 ? <Badge variant="default" className="text-xs">{q.active}</Badge> : <span className="text-muted-foreground text-xs">0</span>}
                      </td>
                      <td className="py-2 px-3 text-right text-xs text-muted-foreground">{q.waiting}</td>
                      <td className="py-2 px-3 text-right">
                        {q.failed > 0 ? <span className="text-red-600 text-xs font-medium">{q.failed}</span> : <span className="text-muted-foreground text-xs">0</span>}
                      </td>
                      <td className="py-2 px-3 text-right text-xs text-muted-foreground">{q.completed}</td>
                      <td className="py-2 px-3 text-right text-xs text-muted-foreground">{formatDurationMs(q.avgDurationMs)}</td>
                      <td className="py-2 px-3 text-right text-xs text-muted-foreground">
                        {q.throughputPerHour !== null ? `${q.throughputPerHour}/hr` : "—"}
                      </td>
                      <td className="py-2 px-3 text-center text-xs text-muted-foreground">every {formatRepeatInterval(q.repeatEveryMs)}</td>
                      <td className="py-2 px-3 text-center">
                        {q.workerSelected === false ? (
                          <Badge variant="secondary" className="text-xs">Not selected</Badge>
                        ) : q.workerActive === false ? (
                          <Badge variant="destructive" className="text-xs">Worker not ready</Badge>
                        ) : q.lastCompletedAt ? (
                          <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">{q.paused ? "Paused · ran" : "Ran in process"}</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">{q.workerActive ? "Ready · no tick yet" : q.paused ? "Paused" : "No worker proof"}</Badge>
                        )}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {q.paused ? (
                          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => resumeMutation.mutate(q.name)} data-testid={`btn-resume-queue-${q.name}`}>
                            Resume
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => pauseMutation.mutate(q.name)} data-testid={`btn-pause-queue-${q.name}`}>
                            Pause
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedQueue && historyData?.status === "ok" && historyData.history[selectedQueue] && (
        <Card data-testid={`card-queue-history-${selectedQueue}`}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Job History — <span className="font-mono">{selectedQueue}</span> (last 24h)</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setSelectedQueue(null)} aria-label="Close job history chart">
                <XCircle className="w-3.5 h-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pb-4">
            {(() => {
              const selected = queueList.find((queue) => queue.name === selectedQueue);
              if (!selected) return null;
              return (
                <div className="mb-3 space-y-1 text-xs text-muted-foreground" data-testid="queue-current-process-evidence">
                  <div>Current process last completion: {selected.lastCompletedAt ? new Date(selected.lastCompletedAt).toLocaleString() : "none observed since restart"}</div>
                  <div>Redis retained completion: {selected.lastRetainedRedisCompletedAt ? new Date(selected.lastRetainedRedisCompletedAt).toLocaleString() : "none retained"}</div>
                  <div>Worker selection/readiness: {selected.workerSelected ? (selected.workerActive ? "selected and ready" : "selected, not ready") : "not selected by this profile"}</div>
                </div>
              );
            })()}
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={historyData.history[selectedQueue]} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={3} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="completed" fill="#22c55e" name="Completed" radius={[2, 2, 0, 0]} />
                <Bar dataKey="failed" fill="#ef4444" name="Failed" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-muted-foreground mt-2">Hourly event counts since process start. Resets on server restart.</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">Dead-Letter Queue</CardTitle>
              {dlqList.length > 0 && (
                <Badge variant="destructive" data-testid="badge-dlq-count">{dlqList.length}</Badge>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => refetchDlq()} aria-label="Refresh dead-letter queue" data-testid="btn-refresh-dlq">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {dlqLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : dlqUnavailable ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground" data-testid="dlq-unavailable-state">
              <AlertTriangle className="w-8 h-8 text-amber-500" />
              <p className="text-sm">DLQ status is unavailable; this is not a confirmed empty queue.</p>
            </div>
          ) : dlqList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground" data-testid="no-dlq-message">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
              <p className="text-sm">No failed jobs in the sampled DLQ window</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">This is a per-queue sample, not a complete global DLQ list.</p>
              {dlqList.map(item => (
                <Card key={item.id} className="border-red-200 dark:border-red-900" data-testid={`dlq-item-${item.id}`}>
                  <CardContent className="p-4">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="font-mono text-xs">{item.queue}</Badge>
                          <Badge variant="destructive" className="text-xs">{item.attemptsMade} attempts</Badge>
                          {item.failedAt && <span className="text-xs text-muted-foreground">{new Date(item.failedAt).toLocaleString()}</span>}
                        </div>
                        <p className="text-sm font-medium text-red-700 dark:text-red-400">{item.failedReason}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button size="sm" variant="outline" onClick={() => retryMutation.mutate(item.id)} disabled={retryMutation.isPending} data-testid={`btn-retry-dlq-${item.id}`}>
                          Retry
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => discardMutation.mutate(item.id)} disabled={discardMutation.isPending} data-testid={`btn-discard-dlq-${item.id}`}>
                          Discard
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Queue metrics refresh every 15 seconds</p>
    </div>
  );
}

interface BounceStats {
  windowDays: number;
  emailBounceRate: number;
  smsFailureRate: number;
  emailBouncedTotal: number;
  smsUndeliverableTotal: number;
  unreachableContactCount: number;
  todayFailureEvents: number;
  topFailureReasons: Array<{ reason: string; count: number }>;
}

function BounceFailurePanel() {
  const { data, isLoading, isError, refetch } = useQuery<BounceStats>({
    queryKey: ["/api/operator/bounce-stats"],
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16" data-testid="bounce-failure-loading">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center py-16 gap-3" data-testid="bounce-failure-error">
        <AlertTriangle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-muted-foreground">Failed to load bounce &amp; failure data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-bounce-failure">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const bounceRateColor = data.emailBounceRate > 5 ? "text-red-600" : data.emailBounceRate > 2 ? "text-yellow-600" : "text-green-600";
  const smsRateColor = data.smsFailureRate > 10 ? "text-red-600" : data.smsFailureRate > 5 ? "text-yellow-600" : "text-green-600";
  const topFailureReasons = Array.isArray(data.topFailureReasons) ? data.topFailureReasons : [];

  return (
    <div className="space-y-4" data-testid="bounce-failure-panel">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card data-testid="stat-email-bounced">
          <CardContent className="pt-4 pb-3 text-center">
            <Mail className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
            <p className={`text-2xl font-bold ${bounceRateColor}`} data-testid="email-bounce-rate">{data.emailBounceRate}%</p>
            <p className="text-xs text-muted-foreground">Email Bounce Rate ({data.windowDays}d)</p>
            <p className="text-xs text-muted-foreground mt-0.5">{data.emailBouncedTotal} total contacts</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-sms-undeliverable">
          <CardContent className="pt-4 pb-3 text-center">
            <MessageSquare className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
            <p className={`text-2xl font-bold ${smsRateColor}`} data-testid="sms-failure-rate">{data.smsFailureRate}%</p>
            <p className="text-xs text-muted-foreground">SMS Failure Rate ({data.windowDays}d)</p>
            <p className="text-xs text-muted-foreground mt-0.5">{data.smsUndeliverableTotal} total contacts</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-unreachable">
          <CardContent className="pt-4 pb-3 text-center">
            <Phone className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
            <p className={`text-2xl font-bold ${data.unreachableContactCount > 0 ? "text-red-600" : "text-green-600"}`} data-testid="unreachable-count">{data.unreachableContactCount}</p>
            <p className="text-xs text-muted-foreground">Unreachable (auto-paused)</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-today-events">
          <CardContent className="pt-4 pb-3 text-center">
            <Activity className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
            <p className="text-2xl font-bold" data-testid="today-failure-events">{data.todayFailureEvents}</p>
            <p className="text-xs text-muted-foreground">Failures Today</p>
          </CardContent>
        </Card>
      </div>

      {topFailureReasons.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Top Failure Reasons (Last {data.windowDays} Days — failures only)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2" data-testid="failure-reasons-list">
              {topFailureReasons.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2" data-testid={`failure-reason-${idx}`}>
                  <div className="flex-1 text-sm capitalize">{item.reason.replace(/_/g, " ")}</div>
                  <div className="w-32 bg-muted rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-red-400 rounded-full"
                      style={{ width: `${Math.min(100, (item.count / (topFailureReasons[0]?.count || 1)) * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground w-8 text-right">{item.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {topFailureReasons.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center">
            <CheckCircle2 className="w-8 h-8 mx-auto text-green-500 mb-2" />
            <p className="text-sm text-muted-foreground">No communication failures in the last 7 days.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface CommHealthData {
  smtp: { configured: boolean; host: string | null; port: number; user: string | null; from: string | null };
  ghl: { emailConfigured: boolean; fullyConfigured: boolean };
  proposalAutoSend: boolean;
  warnings: string[];
  allHealthy: boolean;
}

function CommHealthPanel() {
  const { toast } = useToast();

  const { data, isLoading, isError, refetch, isFetching } = useQuery<CommHealthData>({
    queryKey: ["/api/operator/communications-health"],
    refetchInterval: 60_000,
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/settings/proposal-auto-send", { enabled });
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/operator/communications-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/proposal-auto-send"] });
      toast({
        title: result.enabled ? "Auto-Send Enabled" : "Auto-Send Disabled",
        description: result.enabled
          ? "Proposals will be automatically emailed to merchants after generation."
          : "Proposals will be held for rep review before sending.",
      });
    },
    onError: (err: any) => {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <AlertTriangle className="w-7 h-7 text-destructive" />
        <p className="text-sm text-muted-foreground">Failed to load communications health.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-comm-health">
          <RefreshCw className="w-4 h-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const StatusRow = ({
    label, ok, detail, testId,
  }: { label: string; ok: boolean; detail?: string; testId?: string }) => (
    <div className="flex items-start gap-3 py-2.5 border-b last:border-0" data-testid={testId}>
      {ok
        ? <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
        : <XCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {detail && <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>}
      </div>
      <Badge variant={ok ? "default" : "destructive"} className="text-xs shrink-0">
        {ok ? "OK" : "Not Set"}
      </Badge>
    </div>
  );

  const warnings = Array.isArray(data.warnings) ? data.warnings : [];

  return (
    <div className="space-y-4" data-testid="panel-comm-health">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-base">Communications Health</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Email routing status and auto-send configuration for this system.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="btn-refresh-comm-health"
        >
          {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </Button>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-3 space-y-1" data-testid="comm-health-warnings">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-800 dark:text-amber-300">{w}</p>
            </div>
          ))}
        </div>
      )}

      <Card data-testid="card-comm-channels">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Channel Status</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 pt-0">
          <StatusRow
            label="SMTP Direct Email"
            ok={data.smtp.configured}
            detail={data.smtp.configured
              ? `Host: ${data.smtp.host}  ·  Port: ${data.smtp.port}  ·  User: ${data.smtp.user}`
              : "Set SMTP_HOST, SMTP_USER, and SMTP_PASS to enable direct email fallback"}
            testId="row-smtp-status"
          />
          <StatusRow
            label="GHL Email (primary)"
            ok={data.ghl.emailConfigured}
            detail={data.ghl.emailConfigured
              ? `GHL integration active · Full SDR: ${data.ghl.fullyConfigured ? "Yes" : "Partial"}`
              : "Set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID to enable GHL email"}
            testId="row-ghl-email-status"
          />
        </CardContent>
      </Card>

      <Card data-testid="card-proposal-auto-send">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Proposal Auto-Send</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">{data.proposalAutoSend ? "Auto-Send ON" : "Hold for Review (OFF)"}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {data.proposalAutoSend
                  ? "Proposals are automatically emailed to merchants when generated."
                  : "Proposals are generated but held until a rep manually approves sending."}
              </p>
            </div>
            <Button
              variant={data.proposalAutoSend ? "default" : "outline"}
              size="sm"
              className="gap-2 shrink-0"
              onClick={() => toggleMutation.mutate(!data.proposalAutoSend)}
              disabled={toggleMutation.isPending}
              data-testid="button-toggle-auto-send-health"
            >
              {toggleMutation.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : data.proposalAutoSend ? (
                <Send className="w-3 h-3" />
              ) : (
                <Eye className="w-3 h-3" />
              )}
              {data.proposalAutoSend ? "Disable Auto-Send" : "Enable Auto-Send"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GhlConnectionPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [failedOpsOpen, setFailedOpsOpen] = useState(true);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery<{
    connected: boolean;
    status: "ok" | "expired" | "unconfigured";
    latencyMs: number;
    locationName?: string;
    error?: string;
    failureCount: number;
    lastSync: string | null;
    checkedAt?: string;
    cached?: boolean;
  }>({
    queryKey: ["/api/admin/ghl-health"],
    refetchInterval: 60_000,
    retry: false,
    staleTime: 25_000,
  });

  const { data: auditData, refetch: refetchAudit } = useQuery<{
    logs: Array<{
      id: number;
      action: string;
      entityType: string;
      entityKey?: string;
      entityId?: number | null;
      details?: any;
      createdAt?: string;
    }>;
  }>({
    queryKey: ["/api/admin/ghl-failures"],
    retry: false,
    staleTime: 30_000,
  });

  const failedOps = Array.isArray(auditData?.logs) ? auditData.logs : [];

  async function handleRetry(op: { id: number; entityId?: number | null; entityKey?: string }) {
    if (!op.entityId) {
      toast({ title: "Cannot retry", description: "No contact ID available for this log entry.", variant: "destructive" });
      return;
    }
    setRetryingId(op.id);
    try {
      const res = await apiRequest("POST", "/api/admin/ghl-sync/retry", { contactId: op.entityId });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "Retry failed");
      toast({ title: "GHL sync re-triggered", description: `Contact ${op.entityKey || op.entityId} queued for re-sync.` });
      refetchAudit();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ghl-health"] });
    } catch (err: any) {
      toast({ title: "Retry failed", description: err.message, variant: "destructive" });
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-4 mt-4" data-testid="panel-ghl-connection">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-base">GHL Connection Status</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Live connectivity check to GoHighLevel. Refreshes every 60 seconds. Results are cached 30s server-side.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/admin/ghl-health"] });
            refetch();
          }}
          disabled={isFetching}
          data-testid="button-refresh-ghl-health"
          aria-label="Refresh GHL health"
        >
          {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : !data ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">Failed to load GHL health.</CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card data-testid="card-ghl-status">
            <CardContent className="p-4 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Status</p>
              {(() => {
                const triState =
                  data.status === "ok" && (data.failureCount ?? 0) === 0 ? "ok" :
                  data.status === "ok" ? "degraded" : "down";
                return (
                  <>
                    {triState === "ok" && (
                      <div className="flex items-center gap-2 text-green-600">
                        <CheckCircle2 className="w-5 h-5" />
                        <span className="font-semibold text-sm">Connected</span>
                      </div>
                    )}
                    {triState === "degraded" && (
                      <div className="flex items-center gap-2 text-amber-600">
                        <AlertTriangle className="w-5 h-5" />
                        <span className="font-semibold text-sm">Degraded</span>
                      </div>
                    )}
                    {triState === "down" && (
                      <div className="flex items-center gap-2 text-destructive">
                        <XCircle className="w-5 h-5" />
                        <span className="font-semibold text-sm capitalize">{data.status}</span>
                      </div>
                    )}
                    {triState === "degraded" && (
                      <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                        {data.failureCount} sync failure{data.failureCount !== 1 ? "s" : ""} in last 24h
                      </p>
                    )}
                  </>
                );
              })()}
              <p className="text-xs text-muted-foreground">Provider connectivity probe only. Incoming delivery, optional CRM sync control and circuit state are reported separately.</p>
              {data.error && data.status !== "ok" && <p className="text-xs text-destructive/80 mt-1">{data.error}</p>}
              {data.checkedAt && (
                <p className="text-xs text-muted-foreground mt-auto">
                  Checked: {new Date(data.checkedAt).toLocaleTimeString()}
                  {data.cached && <span className="ml-1 opacity-60">(cached)</span>}
                </p>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-ghl-latency">
            <CardContent className="p-4 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Latency</p>
              <p className="text-2xl font-bold tabular-nums">
                {data.latencyMs ?? "—"}
                <span className="text-sm font-normal text-muted-foreground ml-1">ms</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {data.latencyMs == null ? "—" : data.latencyMs < 500 ? "Good" : data.latencyMs < 1500 ? "Moderate" : "Slow"}
              </p>
            </CardContent>
          </Card>

          <Card data-testid="card-ghl-last-sync">
            <CardContent className="p-4 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Last Successful Sync</p>
              <p className="text-sm font-medium">
                {data.lastSync ? new Date(data.lastSync).toLocaleString() : "No data yet"}
              </p>
              <p className="text-xs text-muted-foreground">
                {data.lastSync ? "Last recorded successful GHL sync" : "Sync audit logs not yet written"}
              </p>
            </CardContent>
          </Card>

          <Card data-testid="card-ghl-failure-count">
            <CardContent className="p-4 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Failures (24h)</p>
              <p className={`text-2xl font-bold tabular-nums ${(data.failureCount ?? 0) > 0 ? "text-destructive" : "text-green-600"}`}>
                {data.failureCount ?? 0}
              </p>
              <p className="text-xs text-muted-foreground">
                {(data.failureCount ?? 0) === 0 ? "None recorded in this 24h window" : "Failed GHL sync operations recorded in the window"}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <div data-testid="section-ghl-failed-ops">
        <button
          type="button"
          onClick={() => setFailedOpsOpen(v => !v)}
          className="w-full flex items-center justify-between py-2 px-0 text-left group"
          data-testid="button-toggle-failed-ops"
          aria-expanded={failedOpsOpen}
        >
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Failed GHL Operations (Last 24h)
            {failedOps.length > 0 && (
              <Badge variant="destructive" className="text-xs ml-1">{failedOps.length}</Badge>
            )}
          </h4>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${failedOpsOpen ? "rotate-180" : ""}`} />
        </button>

        {failedOpsOpen && (
          failedOps.length === 0 ? (
            <Card data-testid="card-no-ghl-failures">
              <CardContent className="py-8 text-center">
                <CheckCircle2 className="w-7 h-7 text-green-500 mx-auto mb-2" />
                <p className="text-sm font-medium">No matching GHL sync failures observed in the last 24 hours</p>
                <p className="text-xs text-muted-foreground mt-1">This shows recorded failures in this window only. It does not show that GHL is connected, delivering events or syncing now; see Last Successful Sync and the connection card.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-ghl-failures">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Contact / Key</th>
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Operation</th>
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Error</th>
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">When</th>
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {failedOps.slice(0, 25).map(f => (
                        <tr key={f.id} className="border-b hover:bg-muted/20 transition-colors" data-testid={`row-ghl-failure-${f.id}`}>
                          <td className="px-4 py-2 font-medium">{f.entityKey || `ID ${f.entityId}` || "—"}</td>
                          <td className="px-4 py-2">
                            <Badge variant="outline" className="text-xs border-destructive/40 text-destructive">{f.action}</Badge>
                          </td>
                          <td className="px-4 py-2 max-w-xs">
                            <span
                              className="truncate block max-w-xs text-destructive/80"
                              title={typeof f.details === "string" ? f.details : JSON.stringify(f.details)}
                            >
                              {typeof f.details === "object" && f.details !== null
                                ? (f.details.error || f.details.message || JSON.stringify(f.details).slice(0, 80))
                                : String(f.details || "—")}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                            {f.createdAt ? new Date(f.createdAt).toLocaleString() : "—"}
                          </td>
                          <td className="px-4 py-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 text-xs px-2"
                              disabled={retryingId === f.id || !f.entityId}
                              onClick={() => handleRetry(f)}
                              data-testid={`button-retry-ghl-${f.id}`}
                              aria-label={`Retry GHL sync for ${f.entityKey || f.entityId}`}
                            >
                              {retryingId === f.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Retry"}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )
        )}
      </div>
    </div>
  );
}

interface DeletedRecord {
  id: number;
  entityType: string | null;
  entityId: number | null;
  entityKey: string | null;
  action: string;
  details: any;
  createdAt: string | null;
}

const ACTION_LABELS: Record<string, { label: string; variant: "default" | "destructive" | "outline" | "secondary" }> = {
  ghl_delete_propagated: { label: "Sent to GHL", variant: "default" },
  ghl_delete_received: { label: "Received from GHL", variant: "secondary" },
  ghl_delete_detected: { label: "Detected by sync", variant: "outline" },
  ghl_delete_failed: { label: "Delete Failed", variant: "destructive" },
};

function DeletedRecordsPanel() {
  const { data, isLoading, isError, refetch } = useQuery<{ records: DeletedRecord[]; total: number; hasMore?: boolean; coverage?: string }>({
    queryKey: ["/api/ghl/deleted-records"],
    queryFn: async () => {
      const res = await fetch("/api/ghl/deleted-records?limit=50", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch deleted records");
      return res.json();
    },
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Loading deleted records…</span>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive text-sm">Failed to load deleted records.</p>
        </CardContent>
      </Card>
    );
  }

  const records = Array.isArray(data?.records) ? data.records : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <XCircle className="w-4 h-4 text-destructive" />
            Deleted Records
            <Badge variant="outline" className="ml-1 text-xs" data-testid="badge-deleted-records-count">{records.length}{typeof data?.total === "number" && data.total > records.length ? ` of ${data.total}` : ""}</Badge>
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-deleted-records" aria-label="Refresh deleted records">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {records.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted-foreground text-sm" data-testid="text-no-deleted-records">
              No deleted-record events were found in the audit history. This is a read of recorded events, not proof that no record was ever deleted.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-deleted-records">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Entity</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Name / Key</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">GHL ID</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Event</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Source</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Direction</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">When</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map(r => {
                    const details = typeof r.details === "object" && r.details !== null ? r.details : {};
                    const direction = details.direction || "—";
                    const source = details.source || (direction === "replit_to_ghl" ? "replit" : "—");
                    const ghlId = details.ghlContactId || details.ghlOpportunityId || details.ghlTaskId || "—";
                    const meta = ACTION_LABELS[r.action] || { label: r.action, variant: "outline" as const };
                    return (
                      <tr key={r.id} className="border-b hover:bg-muted/20 transition-colors" data-testid={`row-deleted-record-${r.id}`}>
                        <td className="px-4 py-2 capitalize font-medium">{r.entityType || "—"}</td>
                        <td className="px-4 py-2 text-muted-foreground max-w-[160px] truncate">
                          {r.entityKey || (r.entityId ? `#${r.entityId}` : "—")}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground font-mono max-w-[120px] truncate" title={ghlId} data-testid={`text-ghl-id-${r.id}`}>
                          {ghlId}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={meta.variant} className="text-xs">{meta.label}</Badge>
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground capitalize" data-testid={`text-source-${r.id}`}>
                          {source === "webhook" ? "Webhook" : source === "sync_tick" ? "Sync tick" : source === "replit" ? "Replit" : source}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {direction === "replit_to_ghl" ? "Replit → GHL" : direction === "ghl_to_replit" ? "GHL → Replit" : direction}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground whitespace-nowrap text-xs">
                          {r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">How it works</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1">
          <p><strong>This panel is read-only.</strong> It lists recorded deletion events from the audit history (filtered in the database, newest first). It never deletes or archives anything.</p>
          <p><strong>Replit → GHL:</strong> The GHL data sync is one-way into Replit. Archiving or deleting a record here does not delete it in GHL. Rows labelled "Sent to GHL" are historical audit events, not current behavior.</p>
          <p><strong>GHL → Replit:</strong> When incoming GHL delete events are received and incoming sync is enabled, the matching local record is handled as recorded in the event. Incoming sync is controlled separately from the global outbound pause.</p>
          <p><strong>Sync-tick fallback:</strong> Detection of contacts that vanish between events applies only where <code className="bg-muted px-1 rounded">GHL_SYNC_DELETE_DETECTION=true</code> is configured.</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── IA Rebuild (#625): Grouped Navigation ─────────────────────────────────────

interface OperatorNavItem {
  value: string;
  label: string;
  icon?: any;
}

interface OperatorNavGroup {
  id: string;
  label: string;
  icon: any;
  items: OperatorNavItem[];
}

const OPERATOR_NAV_GROUPS: OperatorNavGroup[] = [
  {
    id: "pipeline",
    label: "Pipeline & Conversion",
    icon: GitBranch,
    items: [
      { value: "lifecycle", label: "Lifecycle", icon: Users },
      { value: "conversion", label: "Conversion", icon: TrendingUp },
      { value: "stuck-leads", label: "Stuck Leads", icon: AlertTriangle },
      { value: "lead-queue-health", label: "Speed to Lead", icon: Clock },
      { value: "stage-health", label: "Stage Health", icon: Activity },
      { value: "vertical-coverage", label: "Vertical Coverage", icon: BarChart3 },
      { value: "statement-upload", label: "Statement Upload", icon: Upload },
    ],
  },
  {
    id: "sdr",
    label: "SDR & Outreach",
    icon: Megaphone,
    items: [
      { value: "a-lead-queue", label: "A-Lead Review Queue", icon: ListChecks },
      { value: "sdr", label: "SDR", icon: Bot },
      { value: "recent-sends", label: "Recent Sends", icon: Send },
      { value: "send-monitoring", label: "Send Monitoring", icon: Activity },
      { value: "silent-sequences", label: "Sequences Not Firing", icon: Flag },
      { value: "pipeline-silence-thresholds", label: "Silence Thresholds", icon: Settings },
      { value: "bounce-failure", label: "Bounce & Failure", icon: XCircle },
      { value: "comm-health", label: "Email Health", icon: Mail },
    ],
  },
  {
    id: "ai",
    label: "AI / Content",
    icon: Sparkles,
    items: [
      { value: "ai-health", label: "AI Health", icon: ShieldCheck },
      { value: "ai-activity", label: "AI Activity", icon: Activity },
      { value: "ai-learning-center", label: "AI Learning Center", icon: Sparkles },
      { value: "low-confidence", label: "Low Confidence", icon: Eye },
      { value: "subject-audit", label: "Subject Sync", icon: Mail },
      { value: "content-organic", label: "Content & Organic", icon: BarChart3 },
    ],
  },
  {
    id: "integrations",
    label: "Integrations & Sync",
    icon: Link2,
    items: [
      { value: "ghl-connection", label: "GHL Status", icon: Zap },
      { value: "sync-conflicts", label: "Sync Conflicts", icon: GitMerge },
      { value: "ghl-invalid-contacts", label: "Invalid Contacts", icon: XCircle },
      { value: "serper-control", label: "Serper Control", icon: Shield },
      { value: "webhook-events", label: "Webhook Events", icon: Hash },
      { value: "registry-import", label: "Registry Import", icon: Database },
      { value: "ghl-deferred-queue", label: "Deferred Enrollments", icon: Clock },
      { value: "save-cases", label: "Save Cases", icon: ShieldCheck },
    ],
  },
  {
    id: "lead-scoring",
    label: "Lead Scoring",
    icon: Target,
    items: [
      { value: "score-all", label: "Score All Contacts", icon: BarChart3 },
      { value: "new-lead-enroll", label: "New Lead Enrollment", icon: ListChecks },
    ],
  },
  {
    id: "system",
    label: "System Health",
    icon: Settings,
    items: [
      { value: "kpis", label: "KPIs", icon: BarChart3 },
      { value: "readiness", label: "Readiness", icon: CheckCircle2 },
      { value: "job-health", label: "Job Health", icon: Server },
      { value: "queue-metrics", label: "Job Queue", icon: Zap },
      { value: "worker-intervals", label: "Worker Intervals", icon: Clock },
      { value: "worker-heartbeats", label: "Worker Heartbeats", icon: Activity },
      { value: "deleted-records", label: "Deleted Records", icon: XCircle },
      { value: "outbound-preflight", label: "Outbound Preflight", icon: CheckCircle2 },
      { value: "queue-holds", label: "Queue Holds", icon: Server },
      { value: "data-health", label: "Data Health", icon: Database },
      { value: "system-audit", label: "System Audit", icon: Shield },
      { value: "launch-readiness", label: "Launch Readiness", icon: CheckCircle2 },
      { value: "data-quality", label: "Data Quality", icon: Database },
      { value: "deliverability-settings", label: "Deliverability Settings", icon: Activity },
    ],
  },
];

const ALL_OPERATOR_VIEWS = new Set<string>([
  "command-center",
  ...OPERATOR_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.value)),
]);

function getOperatorViewLabel(view: string): string {
  if (view === "command-center") return "Command Center";
  for (const g of OPERATOR_NAV_GROUPS) {
    const item = g.items.find((i) => i.value === view);
    if (item) return item.label;
  }
  return "Command Center";
}

function renderOperatorView(view: string, onNavigate: (v: string) => void) {
  switch (view) {
    case "command-center":
      return <CommandCenter onNavigate={onNavigate} />;
    case "lifecycle":
      return <LifecycleCommandCenter />;
    case "conversion":
      return <ConversionPanel />;
    case "stuck-leads":
      return <StuckLeadsPanel />;
    case "vertical-coverage":
      return <VerticalCoveragePanel />;
    case "statement-upload":
      return <StatementUploadFailuresPanel />;
    case "lead-queue-health":
      return <LeadQueuePanel />;
    case "a-lead-queue":
      return <ALeadQueue />;
    case "sdr":
      return <SdrCommandCenter />;
    case "recent-sends":
      return <RecentSendsWidget />;
    case "send-monitoring":
      return <SendMonitoringPanel />;
    case "silent-sequences":
      return <SilentSequencesWidget />;
    case "pipeline-silence-thresholds":
      return <PipelineSilenceThresholdsPanel />;
    case "bounce-failure":
      return <BounceFailurePanel />;
    case "comm-health":
      return <CommHealthPanel />;
    case "ai-learning-center":
      return <AiLearningCenter />;
    case "ai-health":
      return <AiHealthPanel />;
    case "ai-activity":
      return <AiActivityPanel />;
    case "low-confidence":
      return <LowConfidencePanel />;
    case "subject-audit":
      return <SubjectAuditPanel />;
    case "content-organic":
      return <ContentOrganicKpiPanel />;
    case "ghl-deferred-queue":
      return <GhlDeferredQueuePanel />;
    case "save-cases":
      return <SaveCasesPanel />;
    case "ghl-connection":
      return <GhlConnectionPanel />;
    case "sync-conflicts":
      return <SyncConflictsPanel />;
    case "ghl-invalid-contacts":
      return <GhlInvalidContactsPanel />;
    case "serper-control":
      return <SerperControlPanel />;
    case "webhook-events":
      return <WebhookEventViewer />;
    case "registry-import":
      return <RegistryImportPanel />;
    case "kpis":
      return <OperatorKpiPanel />;
    case "readiness":
      return (
        <div className="space-y-4">
          <ReadinessChecklistWidget />
          <DeploymentReadinessCard />
        </div>
      );
    case "job-health":
      return <JobHealthPanel />;
    case "queue-metrics":
      return <QueueMetricsPanel />;
    case "worker-intervals":
      return <WorkerIntervalsPanel />;
    case "worker-heartbeats":
      return <WorkerHeartbeatPanel />;
    case "deleted-records":
      return <DeletedRecordsPanel />;
    case "launch-readiness":
      return <LaunchReadinessPage />;
    case "deliverability-settings":
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Activity className="w-12 h-12 text-muted-foreground" />
          <p className="text-lg font-medium">Deliverability Settings</p>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Configure warmup mode, send caps, bounce/complaint auto-pause thresholds, and no-prospect-send guard.
          </p>
          <a
            href="/dashboard/deliverability-settings"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open Deliverability Settings
          </a>
        </div>
      );
    case "outbound-preflight":
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <CheckCircle2 className="w-12 h-12 text-muted-foreground" />
          <p className="text-lg font-medium">Outbound Preflight Checklist</p>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            7-check pass/fail gate — GHL token, SMTP, global pause, mailing address, ZeroBounce, sequence status, and consent tier.
          </p>
          <a
            href="/dashboard/outbound-preflight"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open Outbound Preflight
          </a>
        </div>
      );
    case "queue-holds":
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Server className="w-12 h-12 text-muted-foreground" />
          <p className="text-lg font-medium">Queue Holds &amp; Backlog Preview</p>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Hold ledger with active logical job holds, coordinator state, and per-source
            bounded backlog risk preview (sequence enrollments, outbound messages, GHL deferrals,
            post-enrichment intents, and BullMQ queue depths).
          </p>
          <a
            href="/dashboard/queue-holds"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open Queue Holds
          </a>
        </div>
      );
    case "data-health":
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Database className="w-12 h-12 text-muted-foreground" />
          <p className="text-lg font-medium">Data Health</p>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            6-metric integrity dashboard — orphaned deals, null lifecycle contacts, enrollments without next_action_at, and more. Includes reconcile trigger.
          </p>
          <a
            href="/dashboard/data-health"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open Data Health
          </a>
        </div>
      );
    case "system-audit":
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Shield className="w-12 h-12 text-muted-foreground" />
          <p className="text-lg font-medium">Weekly AI System Audit</p>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            View probe results, health scores, and AI narratives for the full system audit.
          </p>
          <a
            href="/dashboard/system-audit"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open System Audit
          </a>
        </div>
      );
    case "data-quality":
      return <ZbBacklogPanel />;

    case "score-all":
      return <ScoreAllPanel />;
    case "bulk-enroll":
      return <BulkEnrollPanel />;
    case "stage-health":
      return <StageHealthPanel />;
    case "new-lead-enroll":
      return <NewLeadEnrollPanel />;
    default:
      return <CommandCenter onNavigate={onNavigate} />;
  }
}

function OperatorNavRail({
  view,
  onSelect,
  collapsedGroups,
  toggleGroup,
}: {
  view: string;
  onSelect: (v: string) => void;
  collapsedGroups: Record<string, boolean>;
  toggleGroup: (id: string) => void;
}) {
  return (
    <nav className="space-y-1" data-testid="operator-nav-rail">
      <button
        type="button"
        onClick={() => onSelect("command-center")}
        className={cn(
          "flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm font-medium transition-colors",
          view === "command-center"
            ? "bg-primary text-primary-foreground"
            : "hover-elevate text-foreground/80",
        )}
        data-testid="nav-command-center"
      >
        <LayoutDashboard className="w-4 h-4 shrink-0" />
        Command Center
      </button>

      {OPERATOR_NAV_GROUPS.map((group) => {
        const collapsed = collapsedGroups[group.id];
        const GroupIcon = group.icon;
        return (
          <div key={group.id} className="pt-2">
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`nav-group-${group.id}`}
              aria-expanded={!collapsed}
            >
              <GroupIcon className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1 text-left">{group.label}</span>
              {collapsed ? (
                <ChevronRight className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 shrink-0" />
              )}
            </button>
            {!collapsed && (
              <div className="space-y-0.5 mt-0.5">
                {group.items.map((item) => {
                  const ItemIcon = item.icon;
                  const active = item.value === view;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => onSelect(item.value)}
                      className={cn(
                        "flex items-center gap-2 w-full rounded-md pl-8 pr-3 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-primary/10 text-primary font-medium"
                          : "hover-elevate text-foreground/80",
                      )}
                      data-testid={`nav-item-${item.value}`}
                    >
                      {ItemIcon && <ItemIcon className="w-3.5 h-3.5 shrink-0" />}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function OperatorNavShell() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const view = systemState(search, true).view;

  const setView = (v: string) => {
    if (!(operatorViews as readonly string[]).includes(v)) return;
    navigate(systemUrl(search, window.location.hash, "monitor", v as typeof operatorViews[number]));
    setDrawerOpen(false);
  };

  const toggleGroup = (id: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));

  const railProps = { view, onSelect: setView, collapsedGroups, toggleGroup };

  return (
    <div className="flex gap-6 items-start">
      <aside
        className="hidden lg:block w-60 shrink-0 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto pr-1"
        data-testid="operator-rail-desktop"
      >
        <OperatorNavRail {...railProps} />
      </aside>

      <div className="flex-1 min-w-0">
        <div className="lg:hidden mb-4">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-operator-nav-toggle">
                <Menu className="w-4 h-4 mr-2" />
                {getOperatorViewLabel(view)}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 overflow-y-auto">
              <SheetHeader>
                <SheetTitle>Operator Views</SheetTitle>
              </SheetHeader>
              <div className="mt-4">
                <OperatorNavRail {...railProps} />
              </div>
            </SheetContent>
          </Sheet>
        </div>

        <div data-testid={`operator-view-${view}`}>
          {renderOperatorView(view, setView)}
        </div>
      </div>
    </div>
  );
}

// ─── IA Rebuild (#625): Command Center landing ─────────────────────────────────

type TileStatus = "ok" | "warn" | "error" | "loading" | "neutral";

function StatusTile({
  title,
  status,
  value,
  detail,
  icon: Icon,
  onClick,
  testId,
}: {
  title: string;
  status: TileStatus;
  value: string;
  detail: string;
  icon: any;
  onClick: () => void;
  testId: string;
}) {
  const valueColor =
    status === "error"
      ? "text-red-700 dark:text-red-400"
      : status === "warn"
        ? "text-yellow-700 dark:text-yellow-400"
        : status === "ok"
          ? "text-green-700 dark:text-green-400"
          : "text-foreground";
  const dot =
    status === "error"
      ? "bg-red-500"
      : status === "warn"
        ? "bg-yellow-500"
        : status === "ok"
          ? "bg-green-500"
          : "bg-muted-foreground/40";

  return (
    <Card className="hover-elevate cursor-pointer" onClick={onClick} data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className="w-3.5 h-3.5" />
            {title}
          </div>
          {status === "loading" ? (
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          ) : (
            <span className={cn("w-2 h-2 rounded-full", dot)} />
          )}
        </div>
        <div className={cn("text-xl font-bold leading-tight", valueColor)} data-testid={`${testId}-value`}>
          {value}
        </div>
        <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{detail}</div>
        <div className="text-xs text-primary mt-2 flex items-center gap-1">
          View details <ArrowRight className="w-3 h-3" />
        </div>
      </CardContent>
    </Card>
  );
}

interface AttentionItem {
  severity: "critical" | "warn" | "info";
  message: string;
  view: string;
}

function CommandCenter({ onNavigate }: { onNavigate: (v: string) => void }) {
  const readiness = useQuery<{
    ready: boolean;
    passCount: number;
    totalChecks: number;
    checks: { id: string; label: string; ok: boolean; detail: string }[];
  }>({ queryKey: ["/api/operator/readiness-checks"], refetchInterval: 60000, retry: false });

  const queue = useQuery<QueueMetricsData>({
    queryKey: ["/api/operator/queue-metrics"],
    refetchInterval: 30000,
    retry: false,
  });

  const dlq = useQuery<DlqResponse>({
    queryKey: ["/api/operator/queue-dlq"],
    refetchInterval: 30000,
    retry: false,
  });

  const circuit = useQuery<{
    circuitOpen: boolean;
    consecutiveFailures: number;
    threshold: number;
    lastTripReason?: string | null;
  }>({ queryKey: ["/api/ghl/circuit-status"], refetchInterval: 60000, retry: false });

  const sdr = useQuery<OperatorSdrStatsResponse>({
    queryKey: ["/api/operator/sdr-stats"],
    refetchInterval: 60000,
    retry: false,
  });

  const funnel = useQuery<{
    funnel: { stage: string; eventName: string; count: number }[];
    byEvent: Record<string, number>;
    days: number;
  }>({
    queryKey: ["/api/analytics/conversion-funnel", "command-center"],
    queryFn: () => fetch(`/api/analytics/conversion-funnel?days=30`).then((r) => r.json()),
    refetchInterval: 120000,
    retry: false,
  });

  const blocks = useQuery<{
    rows: { channel: string | null; blockReason: string | null; cnt: number }[];
    days: number;
  }>({
    queryKey: ["/api/analytics/channel-block-summary", "command-center"],
    queryFn: () => fetch(`/api/analytics/channel-block-summary?days=30`).then((r) => r.json()),
    refetchInterval: 120000,
    retry: false,
  });

  // Safe, array-guarded query data (never trust query data shape at runtime)
  const dlqList = Array.isArray(dlq.data?.items) ? dlq.data.items : [];
  const queueList = Array.isArray(queue.data?.queues) ? queue.data.queues : [];
  const readinessChecks = Array.isArray(readiness.data?.checks) ? readiness.data.checks : [];
  const senderUtilization = Array.isArray(sdr.data?.senderUtilization) ? sdr.data.senderUtilization : [];
  const sentTodayByChannel = Array.isArray(sdr.data?.sentTodayByChannel) ? sdr.data.sentTodayByChannel : [];
  const funnelRows = Array.isArray(funnel.data?.funnel) ? funnel.data.funnel : [];
  const blockRows = Array.isArray(blocks.data?.rows) ? blocks.data.rows : [];

  // Derived metrics
  const dlqCount = dlqList.length;
  const dlqTruthUnknown = dlq.isError || dlq.data?.status !== "ok" || dlq.data?.complete !== true;
  const totalFailed = queueList.reduce((s, q) => s + (q.failed || 0), 0);
  const anyPaused = queueList.some((q) => q.paused);
  const failedChecks = readinessChecks.filter((c) => !c.ok);
  const stuckCheck = readinessChecks.find((c) => c.id === "no_stuck_leads");
  const circuitOpen = !!circuit.data?.circuitOpen;
  const sendersOver = senderUtilization.filter(
    (s) => s.utilizationPct >= 95 || (s.status && s.status !== "active"),
  );
  const sdrWarnings = Array.isArray(sdr.data?.warnings) ? sdr.data.warnings : [];
  const totalSentToday = sentTodayByChannel.reduce((s, c) => s + c.count, 0);
  const totalBlocked = blockRows
    .filter((r) => r.blockReason)
    .reduce((s, r) => s + Number(r.cnt || 0), 0);
  const topBlock = blockRows
    .filter((r) => r.blockReason)
    .sort((a, b) => Number(b.cnt) - Number(a.cnt))[0];
  const funnelTop = funnelRows[0];
  const funnelTopCount = funnelTop?.count ?? 0;

  // Status tiles
  const readinessStatus: TileStatus = readiness.isLoading
    ? "loading"
    : readiness.isError
      ? "error"
      : readiness.data?.ready
        ? "ok"
        : "warn";
  const queueStatus: TileStatus = queue.isLoading
    ? "loading"
    : queue.isError
      ? "error"
      : dlqTruthUnknown
        ? "warn"
      : dlqCount > 0
        ? "error"
        : anyPaused || totalFailed > 0
          ? "warn"
          : "ok";
  const ghlStatus: TileStatus = circuit.isLoading
    ? "loading"
    : circuit.isError
      ? "error"
      : circuitOpen
        ? "error"
        : (circuit.data?.consecutiveFailures ?? 0) > 0
          ? "warn"
          : "ok";
  const sdrStatus: TileStatus = sdr.isLoading
    ? "loading"
    : sdr.isError
      ? "error"
      : sdrWarnings.length > 0 || sendersOver.length > 0
        ? "warn"
        : "ok";
  const conversionStatus: TileStatus = funnel.isLoading
    ? "loading"
    : funnel.isError
      ? "error"
      : funnelTopCount > 0
        ? "ok"
        : "warn";
  const blockStatus: TileStatus = blocks.isLoading
    ? "loading"
    : blocks.isError
      ? "error"
      : totalBlocked > 50
        ? "warn"
        : "ok";

  // Attention queue
  const attention: AttentionItem[] = [];
  if (circuitOpen)
    attention.push({ severity: "critical", message: "GHL circuit breaker is OPEN — sync is paused", view: "ghl-connection" });
  if (dlqCount > 0)
    attention.push({ severity: "critical", message: `${dlqCount} job${dlqCount === 1 ? "" : "s"} in the dead-letter queue`, view: "queue-metrics" });
  if (dlqTruthUnknown)
    attention.push({ severity: "warn", message: "DLQ state is unavailable or sampled; no healthy-empty conclusion can be drawn", view: "queue-metrics" });
  if (sendersOver.length > 0)
    attention.push({ severity: "warn", message: `${sendersOver.length} sending identit${sendersOver.length === 1 ? "y" : "ies"} over capacity or inactive`, view: "sdr" });
  if (totalBlocked > 50)
    attention.push({ severity: "warn", message: `${totalBlocked} blocked send attempts in last 30 days`, view: "comm-health" });
  if (stuckCheck && !stuckCheck.ok)
    attention.push({ severity: "warn", message: stuckCheck.detail || "Stuck leads detected", view: "stuck-leads" });
  if (readiness.data && !readiness.data.ready && failedChecks.length > 0)
    attention.push({ severity: "warn", message: `${failedChecks.length} readiness check${failedChecks.length === 1 ? "" : "s"} failing`, view: "readiness" });
  if (funnel.data && funnelTopCount === 0)
    attention.push({ severity: "info", message: "No conversion events recorded in the last 30 days", view: "conversion" });

  const sevRank = { critical: 0, warn: 1, info: 2 } as const;
  attention.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  const anyLoading =
    readiness.isLoading || queue.isLoading || circuit.isLoading || sdr.isLoading;

  return (
    <div className="space-y-6" data-testid="command-center">
      <div>
        <h2 className="text-lg font-semibold">Command Center</h2>
        <p className="text-sm text-muted-foreground">What needs attention right now</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="command-center-status-row">
        <StatusTile
          title="Readiness"
          status={readinessStatus}
          value={readiness.data ? `${readiness.data.passCount}/${readiness.data.totalChecks}` : readiness.isError ? "Error" : "—"}
          detail={readiness.isError ? "Failed to load readiness" : readiness.data?.ready ? "All preconditions met" : failedChecks[0]?.label ?? "Loading…"}
          icon={CheckCircle2}
          onClick={() => onNavigate("readiness")}
          testId="tile-readiness"
        />
        <StatusTile
          title="Jobs & Queue"
          status={queueStatus}
          value={queue.isError ? "Error" : dlqTruthUnknown ? "Unknown" : dlqCount > 0 ? `${dlqCount} sampled` : "Healthy"}
          detail={queue.isError ? "Failed to load queue metrics" : dlqTruthUnknown ? "DLQ data is unavailable or incomplete" : `${totalFailed} failed · ${queueList.length} queues${queue.data?.queueMode && queue.data.queueMode !== "bullmq_redis" ? ` · ${queue.data.queueMode}` : ""}`}
          icon={Server}
          onClick={() => onNavigate("queue-metrics")}
          testId="tile-queue"
        />
        <StatusTile
          title="GHL Sync"
          status={ghlStatus}
          value={circuit.isError ? "Error" : circuitOpen ? "Circuit OPEN" : "Circuit closed"}
          detail={circuit.isError ? "Failed to load circuit status" : `Circuit breaker only (not a connection, incoming-delivery or optional-sync check) · ${circuit.data?.consecutiveFailures ?? 0}/${circuit.data?.threshold ?? 0} consecutive failures`}
          icon={Zap}
          onClick={() => onNavigate("ghl-connection")}
          testId="tile-ghl"
        />
        <StatusTile
          title="SDR Health"
          status={sdrStatus}
          value={sdr.isError ? "Error" : `${totalSentToday} sent`}
          detail={sdr.isError ? "Failed to load SDR stats" : `${sdr.data?.blockedStepsLast24h ?? 0} blocked · ${sdr.data?.enrolledLeads ?? 0} enrolled`}
          icon={Bot}
          onClick={() => onNavigate("sdr")}
          testId="tile-sdr"
        />
        <StatusTile
          title="Conversion"
          status={conversionStatus}
          value={funnel.isError ? "Error" : `${funnelTopCount.toLocaleString()}`}
          detail={funnel.isError ? "Failed to load funnel" : funnelTop ? `Top stage: ${funnelTop.stage}` : "No funnel data"}
          icon={TrendingUp}
          onClick={() => onNavigate("conversion")}
          testId="tile-conversion"
        />
        <StatusTile
          title="Blocked Sends"
          status={blockStatus}
          value={blocks.isError ? "Error" : `${totalBlocked.toLocaleString()}`}
          detail={blocks.isError ? "Failed to load block summary" : topBlock ? `Top: ${topBlock.blockReason}` : "No blocks (30d)"}
          icon={Shield}
          onClick={() => onNavigate("comm-health")}
          testId="tile-blocks"
        />
      </div>

      <Card data-testid="attention-queue">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600" />
            Attention Queue
            {attention.length > 0 && (
              <Badge variant="secondary" data-testid="attention-count">{attention.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {anyLoading && attention.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking systems…
            </div>
          ) : attention.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2" data-testid="attention-empty">
              <CheckCircle2 className="w-4 h-4 text-green-600" />
              All clear — nothing needs attention right now.
            </div>
          ) : (
            <div className="space-y-2">
              {attention.map((a, i) => {
                const sevColor =
                  a.severity === "critical"
                    ? "bg-red-500"
                    : a.severity === "warn"
                      ? "bg-yellow-500"
                      : "bg-blue-500";
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onNavigate(a.view)}
                    className="flex items-center gap-3 w-full text-left rounded-md border p-3 hover-elevate"
                    data-testid={`attention-item-${i}`}
                  >
                    <span className={cn("w-2 h-2 rounded-full shrink-0", sevColor)} />
                    <span className="flex-1 text-sm">{a.message}</span>
                    <span className="text-xs text-primary flex items-center gap-1 shrink-0">
                      {getOperatorViewLabel(a.view)} <ArrowRight className="w-3 h-3" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="command-center-snapshots">
        <Card className="hover-elevate cursor-pointer" onClick={() => onNavigate("sdr")} data-testid="snapshot-sends">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Send className="w-4 h-4" /> Sends Today</CardTitle>
          </CardHeader>
          <CardContent>
            {sdr.isLoading ? (
              <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : sdr.isError ? (
              <div className="text-sm text-muted-foreground">Unavailable</div>
            ) : sentTodayByChannel.length === 0 ? (
              <div className="text-sm text-muted-foreground">No sends recorded today</div>
            ) : (
              <div className="space-y-1">
                {sentTodayByChannel.map((c) => (
                  <div key={c.channel} className="flex justify-between text-sm">
                    <span className="capitalize text-muted-foreground">{c.channel}</span>
                    <span className="font-medium">{c.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-primary mt-3 flex items-center gap-1">View details <ArrowRight className="w-3 h-3" /></div>
          </CardContent>
        </Card>

        <Card className="hover-elevate cursor-pointer" onClick={() => onNavigate("conversion")} data-testid="snapshot-funnel">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Funnel (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            {funnel.isLoading ? (
              <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : funnel.isError ? (
              <div className="text-sm text-muted-foreground">Unavailable</div>
            ) : funnelRows.length === 0 ? (
              <div className="text-sm text-muted-foreground">No funnel data</div>
            ) : (
              <div className="space-y-1">
                {funnelRows.slice(0, 5).map((row) => (
                  <div key={row.eventName} className="flex justify-between text-sm">
                    <span className="text-muted-foreground truncate mr-2">{row.stage}</span>
                    <span className="font-medium">{row.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-primary mt-3 flex items-center gap-1">View details <ArrowRight className="w-3 h-3" /></div>
          </CardContent>
        </Card>

        <Card className="hover-elevate cursor-pointer" onClick={() => onNavigate("queue-metrics")} data-testid="snapshot-queues">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4" /> Queue Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {queue.isLoading ? (
              <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : queue.isError ? (
              <div className="text-sm text-muted-foreground">Unavailable</div>
            ) : queueList.length === 0 ? (
              <div className="text-sm text-muted-foreground">No queues reporting</div>
            ) : (
              <div className="space-y-1">
                {queueList.slice(0, 5).map((q) => (
                  <div key={q.name} className="flex justify-between text-sm">
                    <span className="text-muted-foreground truncate mr-2">{q.name}</span>
                    <span className={cn("font-medium", q.failed > 0 ? "text-red-600" : "")}>
                      {q.waiting + q.active} active{q.failed > 0 ? ` · ${q.failed} failed` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-primary mt-3 flex items-center gap-1">View details <ArrowRight className="w-3 h-3" /></div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function OperatorDashboard() {
  const { toast } = useToast();

  const digestMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sdr/operator/send-daily-digest");
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Daily digest sent successfully" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to send digest", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operator Dashboard"
        subtitle="Pilot instrumentation — real-time send monitoring and alerts"
        testId="text-operator-title"
        actions={
          <Button
            onClick={() => digestMutation.mutate()}
            disabled={digestMutation.isPending}
            variant="outline"
            data-testid="button-send-digest"
          >
            {digestMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Mail className="w-4 h-4 mr-2" />}
            Send Daily Digest
          </Button>
        }
      />

      <OperatorNavShell />
    </div>
  );
}

interface ImportHistoryRow {
  import_id: string;
  source: string;
  state: string;
  total: string;
  matched: string;
  unmatched: string;
  skipped: string;
  created_at: string;
}

interface ImportSummary {
  importId: string;
  total: number;
  matched: number;
  updated: number;
  unmatched: number;
  skipped: number;
}

const PRIORITY_STATES = ["FL", "TX", "CA", "NY", "GA", "NC", "AZ", "IL"];
const LICENSE_BOARD_TYPES = ["dental", "medical", "cosmetology", "veterinary"];

const MAPPING_FIELD_LABELS: Record<string, string> = {
  businessName: "Business Name",
  legalName: "Legal Name",
  ownerFirstName: "Owner First Name",
  ownerLastName: "Owner Last Name",
  ownerName: "Owner Full Name",
  formationDate: "Formation / License Date",
  address: "Street Address",
  city: "City",
  state: "State",
  zip: "ZIP Code",
  phone: "Phone",
  licenseNumber: "License Number",
};

type ColumnMapping = Record<string, string>;

// ── Save Cases Panel (#1407) ─────────────────────────────────────────────────
interface SaveCase {
  id: number;
  contactId: number;
  dealId?: number | null;
  churnScore?: number | null;
  riskTier: string;
  triggerSignals: string[];
  status: string;
  assignedTo?: string | null;
  outcome?: string | null;
  outcomeNotes?: string | null;
  playbookDay: number;
  escalationLevel: number;
  day2EmailSent: boolean;
  day5ManagerNotified: boolean;
  day10ExecNotified: boolean;
  lastActivityAt?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  contact?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
}

const TIER_BADGE: Record<string, string> = {
  Critical: "bg-red-100 text-red-800 border-red-200",
  High:     "bg-orange-100 text-orange-800 border-orange-200",
  Medium:   "bg-yellow-100 text-yellow-800 border-yellow-200",
  Low:      "bg-green-100 text-green-800 border-green-200",
};

function SaveCasesPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("open");

  const { data, isLoading, refetch, isFetching } = useQuery<{ cases: SaveCase[] }>({
    queryKey: ["/api/save-cases", statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/save-cases?status=${statusFilter}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load save cases");
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const cases = data?.cases ?? [];

  const advanceMutation = useMutation({
    mutationFn: async (id: number) => {
      const csrf = getCsrfToken();
      const res = await fetch(`/api/save-cases/${id}/advance`, {
        method: "POST",
        credentials: "include",
        headers: { ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      });
      if (!res.ok) throw new Error("Advance failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Playbook advanced" });
      queryClient.invalidateQueries({ queryKey: ["/api/save-cases"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const closeMutation = useMutation({
    mutationFn: async ({ id, outcome }: { id: number; outcome: string }) => {
      const csrf = getCsrfToken();
      const res = await fetch(`/api/save-cases/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        body: JSON.stringify({ status: outcome === "retained" ? "retained" : "churned", outcome }),
      });
      if (!res.ok) throw new Error("Update failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Save case updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/save-cases"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const contactName = (sc: SaveCase) => {
    if (sc.contact?.firstName || sc.contact?.lastName) {
      return [sc.contact.firstName, sc.contact.lastName].filter(Boolean).join(" ");
    }
    return sc.contact?.email ?? `Contact #${sc.contactId}`;
  };

  return (
    <div className="space-y-4 mt-4" data-testid="panel-save-cases">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-semibold text-base">Churn Save Desk</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Open save cases for at-risk merchants. Advance the playbook daily; close when retained or churned.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="text-xs border rounded px-2 py-1"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            {["open", "retained", "churned", "escalated", "all"].map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh save cases">
            {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : cases.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No {statusFilter === "all" ? "" : statusFilter} save cases found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {cases.map(sc => (
            <Card key={sc.id} className={sc.escalationLevel >= 2 ? "border-red-300" : sc.escalationLevel >= 1 ? "border-orange-300" : ""}>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{contactName(sc)}</span>
                      <Badge className={`text-xs ${TIER_BADGE[sc.riskTier] ?? "bg-gray-100 text-gray-700"}`}>
                        {sc.riskTier}
                      </Badge>
                      {sc.churnScore != null && (
                        <Badge variant="outline" className="text-xs">Score: {sc.churnScore}</Badge>
                      )}
                      {sc.escalationLevel >= 2 && (
                        <Badge className="text-xs bg-red-100 text-red-700">Exec Escalated</Badge>
                      )}
                      {sc.escalationLevel === 1 && (
                        <Badge className="text-xs bg-orange-100 text-orange-700">Manager Notified</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Day {sc.playbookDay} · Assigned: {sc.assignedTo ?? "Unassigned"}
                      {sc.lastActivityAt && ` · Last activity: ${new Date(sc.lastActivityAt).toLocaleDateString()}`}
                    </div>
                    {Array.isArray(sc.triggerSignals) && sc.triggerSignals.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {sc.triggerSignals.slice(0, 3).map(sig => (
                          <Badge key={sig} variant="outline" className="text-xs border-amber-200 bg-amber-50 text-amber-700">
                            {String(sig).replace(/_/g, " ")}
                          </Badge>
                        ))}
                        {sc.triggerSignals.length > 3 && (
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            +{sc.triggerSignals.length - 3} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  {sc.status === "open" && (
                    <div className="flex gap-2 flex-shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => advanceMutation.mutate(sc.id)}
                        disabled={advanceMutation.isPending}
                        className="text-xs"
                      >
                        Advance Day
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => closeMutation.mutate({ id: sc.id, outcome: "retained" })}
                        disabled={closeMutation.isPending}
                        className="text-xs text-green-700 border-green-300 hover:bg-green-50"
                      >
                        Retained ✓
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => closeMutation.mutate({ id: sc.id, outcome: "churned" })}
                        disabled={closeMutation.isPending}
                        className="text-xs text-red-700 border-red-300 hover:bg-red-50"
                      >
                        Churned ✗
                      </Button>
                    </div>
                  )}
                  {sc.status !== "open" && (
                    <Badge className={sc.status === "retained" ? "bg-green-100 text-green-700" : sc.status === "churned" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-700"}>
                      {sc.status}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── GHL Deferred Enrollment Queue Panel (#1010) ──────────────────────────────
interface DeferredEnrollment {
  id: number;
  ghlContactId: string;
  workflowKey: string;
  metadata?: Record<string, unknown>;
  enqueuedAt: string;
  retryCount: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  status: "pending" | "failed";
}

function GhlDeferredQueuePanel() {
  const { toast } = useToast();
  const { data, isLoading, refetch, isFetching } = useQuery<{
    pending: DeferredEnrollment[];
    recentlyFailed: DeferredEnrollment[];
  }>({
    queryKey: ["/api/admin/ghl-deferred-queue"],
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const pending = data?.pending ?? [];
  const failed = data?.recentlyFailed ?? [];

  function fmt(iso: string | null | undefined) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString();
  }

  return (
    <div className="space-y-4 mt-4" data-testid="panel-ghl-deferred-queue">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-base">GHL Deferred Enrollment Queue</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            GHL workflow enrollments that failed and are pending automatic retry. Permanently failed rows trigger an admin email alert.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh deferred queue">
          {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-yellow-500" />
                Pending Retry
                <Badge variant="outline">{pending.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {pending.length === 0 ? (
                <p className="text-sm text-muted-foreground px-4 py-6 text-center">No pending deferred enrollments.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="border-b">
                      <tr className="text-left">
                        <th className="px-4 py-2 font-medium">GHL Contact</th>
                        <th className="px-4 py-2 font-medium">Workflow</th>
                        <th className="px-4 py-2 font-medium">Retries</th>
                        <th className="px-4 py-2 font-medium">Next Retry</th>
                        <th className="px-4 py-2 font-medium">Last Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pending.map((row) => (
                        <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-2 font-mono">{row.ghlContactId}</td>
                          <td className="px-4 py-2">{row.workflowKey}</td>
                          <td className="px-4 py-2 text-center">{row.retryCount}</td>
                          <td className="px-4 py-2 whitespace-nowrap">{fmt(row.nextRetryAt)}</td>
                          <td className="px-4 py-2 text-red-600 max-w-[200px] truncate" title={row.lastError ?? ""}>{row.lastError ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-500" />
                Permanently Failed (recent 50)
                <Badge variant="destructive">{failed.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {failed.length === 0 ? (
                <p className="text-sm text-muted-foreground px-4 py-6 text-center">No permanently failed enrollments.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="border-b">
                      <tr className="text-left">
                        <th className="px-4 py-2 font-medium">GHL Contact</th>
                        <th className="px-4 py-2 font-medium">Workflow</th>
                        <th className="px-4 py-2 font-medium">Retries</th>
                        <th className="px-4 py-2 font-medium">Enqueued</th>
                        <th className="px-4 py-2 font-medium">Last Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {failed.map((row) => (
                        <tr key={row.id} className="border-b last:border-0 hover:bg-red-50/40">
                          <td className="px-4 py-2 font-mono">{row.ghlContactId}</td>
                          <td className="px-4 py-2">{row.workflowKey}</td>
                          <td className="px-4 py-2 text-center">{row.retryCount}</td>
                          <td className="px-4 py-2 whitespace-nowrap">{fmt(row.enqueuedAt)}</td>
                          <td className="px-4 py-2 text-red-600 max-w-[200px] truncate" title={row.lastError ?? ""}>{row.lastError ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function RegistryImportPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [sourceType, setSourceType] = useState<"registry" | "license">("registry");
  const [state, setState] = useState("FL");
  const [subType, setSubType] = useState("dental");
  const [lastSummary, setLastSummary] = useState<ImportSummary | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({});
  const [mappingLoaded, setMappingLoaded] = useState(false);

  const { data: allMappings } = useQuery<{ registryMappings: Record<string, ColumnMapping>; licenseMappings: Record<string, ColumnMapping>; states: string[]; licenseBoardTypes: string[] }>({
    queryKey: ["/api/admin/registry-import/mappings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/registry-import/mappings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load mappings");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!allMappings) return;
    let defaultMapping: ColumnMapping = {};
    if (sourceType === "registry") {
      defaultMapping = allMappings.registryMappings[state] || {};
    } else {
      defaultMapping = allMappings.licenseMappings[subType] || {};
    }
    setColumnMapping({ ...defaultMapping });
    setMappingLoaded(true);
  }, [sourceType, state, subType, allMappings]);

  const { data: history = [], isLoading: historyLoading, refetch: refetchHistory } = useQuery<ImportHistoryRow[]>({
    queryKey: ["/api/admin/registry-import/history"],
    queryFn: async () => {
      const res = await fetch("/api/admin/registry-import/history", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch import history");
      return res.json();
    },
  });

  const handleUpload = async () => {
    if (!file) {
      toast({ title: "No file selected", variant: "destructive" });
      return;
    }
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("sourceType", sourceType);
      formData.append("state", state);
      if (sourceType === "license") formData.append("subType", subType);
      formData.append("columnMapping", JSON.stringify(columnMapping));

      // Multipart FormData upload — attach CSRF token for authenticated mutation.
      // Content-Type is intentionally omitted so the browser sets it with the
      // correct multipart boundary. Public/token-auth flows (MerchantApplication,
      // MerchantStatementUpload) do not use this path and remain unaffected.
      const _registryImportCsrf = getCsrfToken();
      const _registryImportHeaders: Record<string, string> = {};
      if (_registryImportCsrf) _registryImportHeaders["X-CSRF-Token"] = _registryImportCsrf;
      const res = await fetch("/api/admin/registry-import", {
        method: "POST",
        credentials: "include",
        headers: _registryImportHeaders,
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Upload failed");

      setLastSummary(data.summary);
      toast({ title: "Import complete", description: data.message });
      refetchHistory();
      setFile(null);
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const mappingEntries = Object.entries(MAPPING_FIELD_LABELS);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            Bulk Registry & License Board Import
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Upload state business registry CSVs or professional license board exports to enrich
            merchant records with legal names, owner names, formation dates, and license numbers.
            Matching uses fuzzy name similarity + address + phone fallback.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Source Type</label>
              <Select value={sourceType} onValueChange={(v) => setSourceType(v as "registry" | "license")} data-testid="select-source-type">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="registry">State Business Registry</SelectItem>
                  <SelectItem value="license">Professional License Board</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">State</label>
              <Select value={state} onValueChange={setState} data-testid="select-state">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_STATES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                  <SelectItem value="OTHER">Other (custom mapping)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {sourceType === "license" && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Board Type</label>
                <Select value={subType} onValueChange={setSubType} data-testid="select-sub-type">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LICENSE_BOARD_TYPES.map((b) => (
                      <SelectItem key={b} value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">CSV File</label>
            <div className="flex items-center gap-3">
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="max-w-sm"
                aria-label="Registry CSV file" data-testid="input-registry-csv"
              />
              {file && (
                <span className="text-sm text-muted-foreground">{file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Column Mapping</label>
              <span className="text-xs text-muted-foreground">Edit CSV header names to match your export</span>
            </div>
            <div className="border rounded-md overflow-hidden" data-testid="column-mapping-editor">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground w-1/2">Target Field</th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground w-1/2">CSV Column Header</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingEntries.map(([fieldKey, fieldLabel]) => (
                    <tr key={fieldKey} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-1.5 px-3 text-xs text-muted-foreground font-medium">{fieldLabel}</td>
                      <td className="py-1 px-2">
                        <Input
                          value={columnMapping[fieldKey] || ""}
                          onChange={(e) => setColumnMapping((prev) => ({ ...prev, [fieldKey]: e.target.value }))}
                          placeholder={`leave blank to skip`}
                          className="h-7 text-xs font-mono"
                          data-testid={`mapping-input-${fieldKey}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!mappingLoaded && (
              <p className="text-xs text-muted-foreground">Loading default mapping…</p>
            )}
          </div>

          <Button
            onClick={handleUpload}
            disabled={!file || isUploading}
            data-testid="button-run-registry-import"
          >
            {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
            Run Import
          </Button>
        </CardContent>
      </Card>

      {lastSummary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last Import Results</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {[
                { label: "Total Rows", value: lastSummary.total, color: "text-blue-600" },
                { label: "Matched", value: lastSummary.matched, color: "text-green-600" },
                { label: "Updated", value: lastSummary.updated, color: "text-emerald-600" },
                { label: "Unmatched", value: lastSummary.unmatched, color: "text-orange-600" },
                { label: "Skipped", value: lastSummary.skipped, color: "text-gray-500" },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center p-3 rounded border" data-testid={`stat-${label.toLowerCase().replace(" ", "-")}`}>
                  <div className={`text-2xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-muted-foreground mt-1">{label}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Import ID: <code className="bg-muted px-1 rounded">{lastSummary.importId}</code> — Unmatched rows are stored in the import log for review.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Import History</span>
            <Button variant="outline" size="sm" onClick={() => refetchHistory()} data-testid="button-refresh-history">
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {historyLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No imports yet. Upload a CSV above to get started.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-2 px-3">Date</th>
                    <th className="text-left py-2 px-3">Source</th>
                    <th className="text-left py-2 px-3">State</th>
                    <th className="text-right py-2 px-3">Total</th>
                    <th className="text-right py-2 px-3">Matched</th>
                    <th className="text-right py-2 px-3">Unmatched</th>
                    <th className="text-right py-2 px-3">Skipped</th>
                    <th className="text-right py-2 px-3">Match Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => {
                    const total = parseInt(row.total) || 0;
                    const matched = parseInt(row.matched) || 0;
                    const matchRate = total > 0 ? Math.round((matched / total) * 100) : 0;
                    return (
                      <tr key={row.import_id} className="border-b hover:bg-muted/50" data-testid={`row-import-${row.import_id}`}>
                        <td className="py-2 px-3 text-xs text-muted-foreground">
                          {new Date(row.created_at).toLocaleDateString()}
                        </td>
                        <td className="py-2 px-3">
                          <Badge variant={row.source === "registry" ? "default" : "secondary"} className="text-xs">
                            {row.source}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 font-mono text-xs">{row.state}</td>
                        <td className="py-2 px-3 text-right">{row.total}</td>
                        <td className="py-2 px-3 text-right text-green-600 font-medium">{row.matched}</td>
                        <td className="py-2 px-3 text-right text-orange-600">{row.unmatched}</td>
                        <td className="py-2 px-3 text-right text-gray-500">{row.skipped}</td>
                        <td className="py-2 px-3 text-right">
                          <Badge variant={matchRate >= 50 ? "default" : matchRate >= 20 ? "secondary" : "destructive"} className="text-xs">
                            {matchRate}%
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface VerticalCoverageRow {
  id: number;
  version:number;
  retiredAt:string|null;
  sequenceName: string;
  vertical: string;
  sequenceType: string;
  sequenceStatus: string;
  totalSteps: number;
  enrolled: number;
  step1Complete: number;
  step3Complete: number;
  completed: number;
  conversionRate: number;
  lastEnrolledAt: string | null;
  daysSinceEnrollment: number | null;
}

function VerticalCoveragePanel() {
  const sequenceIntents=useRetainedLocalIntent();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const { data: rows = [], isLoading, isError, refetch } = useQuery<VerticalCoverageRow[]>({
    queryKey: ["/api/sequences/vertical-coverage"],
    queryFn: async () => {
      const res = await fetch("/api/sequences/vertical-coverage", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch vertical coverage data");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const toggleMutation = useMutation({
    mutationFn: async (id: number) => {
      const row=rows.find(row=>row.id===id);
      if(!row?.version || row.retiredAt) throw new Error("Sequence unavailable or retired. Reload before changing its state.");
      const res = await apiRequest("PUT", `/api/sequences/${id}/toggle-status`,
        sequenceIntents.payload(`toggle:${id}`,{expectedVersion:row.version}));
      if (!res.ok) throw new Error("Failed to toggle sequence status");
      sequenceIntents.accepted(`toggle:${id}`);
      return res.json();
    },
    onSuccess: (updated: any) => {
      toast({ title: `Sequence ${updated.status}`, description: `"${updated.name}" is now ${updated.status}.` });
      queryClient.invalidateQueries({ queryKey: ["/api/sequences/vertical-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
    },
    onError: (err: Error) => toast({ title: "Toggle failed", description: err.message, variant: "destructive" }),
  });

  const filtered = rows.filter((r) =>
    r.vertical.toLowerCase().includes(search.toLowerCase()) ||
    r.sequenceType.toLowerCase().includes(search.toLowerCase())
  );

  const zeroEnrollment = filtered.filter((r) => r.enrolled === 0);
  const staleSequences = filtered.filter((r) => r.sequenceStatus === "active" && r.daysSinceEnrollment !== null && r.daysSinceEnrollment >= 7);
  const hasData = rows.length > 0;

  function exportCsv() {
    const headers = ["Vertical", "Sequence Type", "Status", "Steps", "Enrolled", "Step 1 ✓", "Step 3 ✓", "Completed", "Conv. Rate %"];
    const csvRows = [
      headers.join(","),
      ...filtered.map((r) =>
        [
          `"${r.vertical}"`,
          `"${r.sequenceType}"`,
          r.sequenceStatus,
          r.totalSteps,
          r.enrolled,
          r.step1Complete,
          r.step3Complete,
          r.completed,
          r.conversionRate,
        ].join(",")
      ),
    ];
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vertical-coverage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "CSV exported", description: `${filtered.length} rows exported.` });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3" data-testid="vertical-coverage-error">
        <AlertTriangle className="w-8 h-8 text-destructive" />
        <p className="text-muted-foreground">Failed to load vertical coverage data.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry-vertical-coverage">
          <RefreshCw className="w-4 h-4 mr-2" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-4" data-testid="vertical-coverage-panel">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div>
          <h2 className="text-lg font-semibold">Vertical Sequence Coverage</h2>
          <p className="text-sm text-muted-foreground">
            Enrollment stats per sequence — spot zero-enrollment verticals and step drop-off at a glance.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-vertical-coverage" aria-label="Refresh">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-export-vertical-coverage" disabled={filtered.length === 0}>
            <ArrowUpRight className="w-4 h-4 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      {zeroEnrollment.length > 0 && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700">
          <CardContent className="py-3 px-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  {zeroEnrollment.length} sequence{zeroEnrollment.length > 1 ? "s" : ""} with zero enrollments
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                  Auto-tagging may not be firing for: {zeroEnrollment.slice(0, 5).map((r) => r.vertical).join(", ")}
                  {zeroEnrollment.length > 5 ? ` +${zeroEnrollment.length - 5} more` : ""}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {staleSequences.length > 0 && (
        <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20 dark:border-orange-700">
          <CardContent className="py-3 px-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-600 dark:text-orange-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-orange-800 dark:text-orange-300">
                  {staleSequences.length} active sequence{staleSequences.length > 1 ? "s" : ""} with no new enrollments in 7+ days
                </p>
                <p className="text-xs text-orange-700 dark:text-orange-400 mt-0.5">
                  {staleSequences.slice(0, 3).map((r) => `${r.vertical} (${r.daysSinceEnrollment}d ago)`).join(", ")}
                  {staleSequences.length > 3 ? ` +${staleSequences.length - 3} more` : ""}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {hasData && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-bold">{rows.length}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Total Sequences</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-bold">{rows.reduce((s, r) => s + r.enrolled, 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Total Enrolled</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-bold text-amber-600">{zeroEnrollment.length}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Zero-Enrollment</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-bold text-green-600">{rows.reduce((s, r) => s + r.completed, 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Total Completed</div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter by vertical or type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm text-sm"
          data-testid="input-vertical-coverage-search"
        />
        {search && (
          <Button variant="ghost" size="sm" onClick={() => setSearch("")} data-testid="button-clear-vertical-search" aria-label="Clear search">
            <XCircle className="w-4 h-4" />
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm" data-testid="vertical-coverage-empty">
          {rows.length === 0 ? "No sequences found in database." : "No sequences match your filter."}
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-vertical-coverage">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Vertical</th>
                  <th className="text-left py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Sequence Type</th>
                  <th className="text-center py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Status</th>
                  <th className="text-right py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Enrolled</th>
                  <th className="text-right py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Step 1 ✓</th>
                  <th className="text-right py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Step 3 ✓</th>
                  <th className="text-right py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Completed</th>
                  <th className="text-right py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Conv. Rate</th>
                  <th className="text-right py-2.5 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap">Last Enrolled</th>
                  <th className="py-2.5 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                    data-testid={`row-vertical-coverage-${row.id}`}
                  >
                    <td className="py-2.5 px-3 font-medium max-w-[180px]">
                      <span className="truncate block" title={row.vertical}>{row.vertical}</span>
                    </td>
                    <td className="py-2.5 px-3 text-muted-foreground max-w-[160px]">
                      <span className="truncate block text-xs" title={row.sequenceType}>{row.sequenceType || "—"}</span>
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <Badge
                        variant="outline"
                        className={`text-xs ${
                          row.sequenceStatus === "active"
                            ? "border-green-500 text-green-700 dark:text-green-400"
                            : "border-muted text-muted-foreground"
                        }`}
                        data-testid={`status-vertical-${row.id}`}
                      >
                        {row.sequenceStatus}
                      </Badge>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <span className={`font-medium ${row.enrolled === 0 ? "text-amber-600" : ""}`} data-testid={`enrolled-vertical-${row.id}`}>
                        {row.enrolled.toLocaleString()}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right text-muted-foreground" data-testid={`step1-vertical-${row.id}`}>
                      {row.enrolled > 0 ? (
                        <>
                          {row.step1Complete.toLocaleString()}
                          <span className="text-xs ml-1">({row.enrolled > 0 ? Math.round((row.step1Complete / row.enrolled) * 100) : 0}%)</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right text-muted-foreground" data-testid={`step3-vertical-${row.id}`}>
                      {row.enrolled > 0 ? (
                        <>
                          {row.step3Complete.toLocaleString()}
                          <span className="text-xs ml-1">({row.enrolled > 0 ? Math.round((row.step3Complete / row.enrolled) * 100) : 0}%)</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right" data-testid={`completed-vertical-${row.id}`}>
                      {row.completed.toLocaleString()}
                    </td>
                    <td className="py-2.5 px-3 text-right" data-testid={`conv-rate-vertical-${row.id}`}>
                      {row.enrolled === 0 ? (
                        <span className="text-muted-foreground/50">—</span>
                      ) : (
                        <span className={`font-medium ${row.conversionRate >= 10 ? "text-green-600 dark:text-green-400" : row.conversionRate > 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}>
                          {row.conversionRate}%
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right text-xs text-muted-foreground whitespace-nowrap" data-testid={`last-enrolled-vertical-${row.id}`}>
                      {row.lastEnrolledAt ? (
                        <span className={row.daysSinceEnrollment !== null && row.daysSinceEnrollment >= 7 && row.sequenceStatus === "active" ? "text-orange-600 dark:text-orange-400 font-medium" : ""}>
                          {row.daysSinceEnrollment === 0 ? "today" : row.daysSinceEnrollment === 1 ? "1d ago" : `${row.daysSinceEnrollment}d ago`}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">never</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <Button
                        size="sm"
                        variant={row.sequenceStatus === "active" ? "outline" : "default"}
                        className={`text-xs h-7 px-2 ${row.sequenceStatus === "active" ? "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950/20" : "bg-green-600 hover:bg-green-700 text-white"}`}
                        disabled={toggleMutation.isPending}
                        onClick={() => toggleMutation.mutate(row.id)}
                        data-testid={`button-toggle-sequence-${row.id}`}
                        aria-label={row.sequenceStatus === "active" ? "Pause sequence" : "Activate sequence"}
                      >
                        {row.sequenceStatus === "active" ? "Pause" : "Activate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="text-xs text-muted-foreground text-right">
        Showing {filtered.length} of {rows.length} sequences · Auto-refreshes every 60s
      </p>
    </div>
  );
}

const AI_TRIGGER_LABELS: Record<string, string> = {
  "advisor-chat": "Advisor Chat",
  "insights": "Dashboard Insights",
  "compose-email": "Email Composer",
  "ticket-classify": "Ticket Classification",
  "statement-analysis": "Statement Analysis",
  "proposal": "Proposal Generator",
  "blueprint": "Deal Blueprint",
  "enrichment": "Lead Enrichment",
  "reply-classify": "Reply Classification",
  "outbound-copy": "Outbound Copy",
  "website-quality": "Website Quality",
  "nightly-discovery": "Nightly Discovery",
  "chargeback-copilot": "Chargeback Copilot",
  "auto-reply": "Auto Reply",
  "content-generation": "Content Generation",
  "social-generation": "Social Generation",
  "training-generation": "Training Generation",
};

interface AiHealthMetrics {
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  completionRate: number;
  avgLatencyMs: number;
  avgConfidenceScore: number;
  flaggedCount: number;
  flaggedRate: number;
  topErrors: Array<{ error: string; count: number }>;
  byTriggerType: Record<string, {
    calls: number; errors: number; avgConfidence: number; avgLatencyMs: number; flagged: number;
  }>;
  confidenceDistribution: { high: number; medium: number; low: number };
  totalCostCents: number;
  todayCostCents: number;
  monthCostCents: number;
  dailyRollup: Array<{ date: string; calls: number; costCents: number; promptTokens: number; completionTokens: number }>;
  confidenceThreshold: number;
}

function ConfidenceBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-xs text-muted-foreground">—</span>;
  const pct = Math.round(score * 100);
  if (pct >= 75) return <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">{pct}%</Badge>;
  if (pct >= 50) return <Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">{pct}%</Badge>;
  return <Badge variant="destructive" className="text-xs">{pct}%</Badge>;
}

interface ReplayResult {
  originalResponse: string | null;
  newResponse: string;
  originalLogId: number;
  model: string;
  durationMs: number;
  diff: { changed: boolean; originalLength: number; newLength: number };
}

interface AiLogDetail {
  id: number;
  triggerType: string;
  actorType: string;
  actorId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costCents: number;
  responseSummary: string | null;
  error: string | null;
  durationMs: number | null;
  promptHash: string | null;
  confidenceScore: number | null;
  flagged: boolean | null;
  rawPrompt: string | null;
  rawResponse: string | null;
  createdAt: string;
}

function AiLogDetailModal({ logId, open, onClose }: { logId: number | null; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);

  const { data: log, isLoading } = useQuery<AiLogDetail>({
    queryKey: ["/api/operator/ai-audit", logId],
    queryFn: () => fetch(`/api/operator/ai-audit/${logId}`, { credentials: "include" }).then(r => r.json()),
    enabled: open && logId != null,
  });

  async function handleReplay() {
    if (!logId) return;
    setReplaying(true);
    setReplayResult(null);
    try {
      const res = await apiRequest("POST", `/api/operator/ai-audit/${logId}/replay`, {});
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Replay failed");
      setReplayResult(data);
      toast({ title: "Replay complete", description: data.diff.changed ? "Response differs from original." : "Response matches original." });
    } catch (err: any) {
      toast({ title: "Replay failed", description: err.message, variant: "destructive" });
    } finally {
      setReplaying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { onClose(); setReplayResult(null); } }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-ai-log-detail">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="w-4 h-4" />
            AI Audit Log #{logId}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : !log ? (
          <div className="text-center py-8 text-muted-foreground">Log not found</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Trigger</div>
                <div className="font-medium">{AI_TRIGGER_LABELS[log.triggerType] || log.triggerType}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Model</div>
                <div className="font-medium">{log.model}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Confidence</div>
                <div><ConfidenceBadge score={log.confidenceScore} /></div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Duration</div>
                <div className="font-medium">{log.durationMs ? `${log.durationMs}ms` : "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Tokens</div>
                <div className="font-medium">{(log.promptTokens + log.completionTokens).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cost</div>
                <div className="font-medium">${(log.costCents / 100).toFixed(4)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Prompt Hash</div>
                <div className="font-mono text-xs">{log.promptHash || "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Flagged</div>
                <div>
                  {log.flagged
                    ? <Badge variant="destructive" className="text-xs"><Flag className="w-3 h-3 mr-1" />Flagged</Badge>
                    : <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">OK</Badge>}
                </div>
              </div>
            </div>

            {log.error && (
              <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded p-3">
                <div className="text-xs text-red-600 dark:text-red-400 font-medium mb-1">Error</div>
                <div className="text-sm text-red-700 dark:text-red-300 font-mono">{log.error}</div>
              </div>
            )}

            {log.rawPrompt && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Raw Prompt</div>
                <Textarea
                  readOnly
                  value={log.rawPrompt}
                  className="font-mono text-xs h-32 resize-none"
                  data-testid="textarea-raw-prompt"
                />
              </div>
            )}

            {log.rawResponse && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Original Response</div>
                <Textarea
                  readOnly
                  value={log.rawResponse}
                  className="font-mono text-xs h-32 resize-none"
                  data-testid="textarea-raw-response"
                />
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={handleReplay}
                disabled={replaying || !log.rawPrompt}
                variant="outline"
                size="sm"
                data-testid="button-replay-prompt"
                title={!log.rawPrompt ? "No prompt stored for this log entry" : "Re-run this exact prompt"}
              >
                {replaying
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Replaying…</>
                  : <><Play className="w-4 h-4 mr-2" /> Replay Prompt</>}
              </Button>
            </div>

            {replayResult && (
              <div className="space-y-3 border-t pt-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Replay Result</div>
                  <div className="flex items-center gap-2">
                    {replayResult.diff.changed
                      ? <Badge variant="destructive" className="text-xs">Response Changed</Badge>
                      : <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">Matches Original</Badge>}
                    <span className="text-xs text-muted-foreground">{replayResult.durationMs}ms</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">New Response</div>
                  <Textarea
                    readOnly
                    value={replayResult.newResponse}
                    className="font-mono text-xs h-32 resize-none"
                    data-testid="textarea-replay-response"
                  />
                </div>
                {replayResult.diff.changed && (
                  <div className="text-xs text-muted-foreground">
                    Original: {replayResult.diff.originalLength} chars → New: {replayResult.diff.newLength} chars
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AiHealthPanel() {
  const [range, setRange] = useState("7d");

  const { data: metrics, isLoading, isError, refetch } = useQuery<AiHealthMetrics>({
    queryKey: ["/api/operator/ai-health", range],
    queryFn: () => fetch(`/api/operator/ai-health?range=${range}`, { credentials: "include" }).then(async r => {
      if (!r.ok) throw new Error(`AI health metrics unavailable (${r.status})`);
      return r.json();
    }),
    refetchInterval: 30000,
  });

  const pieData = metrics ? [
    { name: "High (≥75%)", value: metrics.confidenceDistribution.high, color: "#22c55e" },
    { name: "Medium (50-74%)", value: metrics.confidenceDistribution.medium, color: "#f59e0b" },
    { name: "Low (<50%)", value: metrics.confidenceDistribution.low, color: "#ef4444" },
  ].filter(d => d.value > 0) : [];

  const triggerRows = metrics
    ? Object.entries(metrics.byTriggerType)
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 10)
    : [];

  return (
    <div className="space-y-6 mt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-blue-500" /> AI Health Monitor
        </h3>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="w-[140px]" data-testid="select-health-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="24h">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="30d">Last 30 Days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} aria-label="Refresh AI health metrics" data-testid="btn-refresh-ai-health">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      )}

      {isError && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <AlertTriangle className="w-8 h-8 text-red-500" />
          <p className="text-sm text-muted-foreground">Failed to load AI health metrics</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </div>
      )}

      {metrics && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card data-testid="card-completion-rate">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <CheckCircle2 className="w-3 h-3 text-green-500" /> Completion Rate
                </div>
                <div className="text-2xl font-bold text-green-600" data-testid="text-completion-rate">
                  {metrics.completionRate}%
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {metrics.successCalls} / {metrics.totalCalls} calls
                </div>
              </CardContent>
            </Card>
            <Card data-testid="card-avg-latency">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <Clock className="w-3 h-3 text-blue-500" /> Avg Latency
                </div>
                <div className="text-2xl font-bold" data-testid="text-avg-latency">
                  {metrics.avgLatencyMs > 0 ? `${metrics.avgLatencyMs}ms` : "—"}
                </div>
                <div className="text-xs text-muted-foreground mt-1">per call</div>
              </CardContent>
            </Card>
            <Card data-testid="card-avg-confidence">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <TrendingUp className="w-3 h-3 text-purple-500" /> Avg Confidence
                </div>
                <div className="text-2xl font-bold" data-testid="text-avg-confidence">
                  {metrics.avgConfidenceScore > 0 ? `${Math.round(metrics.avgConfidenceScore * 100)}%` : "—"}
                </div>
                <Progress
                  value={metrics.avgConfidenceScore * 100}
                  className="h-1 mt-2"
                />
              </CardContent>
            </Card>
            <Card data-testid="card-flagged-count">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <Flag className="w-3 h-3 text-red-500" /> Flagged for Review
                </div>
                <div className="text-2xl font-bold text-red-600" data-testid="text-flagged-count">
                  {metrics.flaggedCount}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{metrics.flaggedRate}% of calls</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Confidence Distribution</CardTitle>
              </CardHeader>
              <CardContent>
                {pieData.length === 0 ? (
                  <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">No confidence data yet</div>
                ) : (
                  <ResponsiveContainer width="100%" height={180} data-testid="chart-confidence-dist">
                    <PieChart>
                      <Pie data={pieData} dataKey="value" cx="50%" cy="50%" outerRadius={70} label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                        {pieData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(val: number) => [val, "calls"]} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {metrics.topErrors.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Top Error Types</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {metrics.topErrors.map((e, i) => (
                      <div key={i} className="flex items-start justify-between gap-2 text-sm" data-testid={`error-row-${i}`}>
                        <span className="text-muted-foreground text-xs flex-1 truncate" title={e.error}>{e.error}</span>
                        <Badge variant="destructive" className="text-xs shrink-0">{e.count}</Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card data-testid="card-cost-today">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <DollarSign className="w-3 h-3 text-green-500" /> Cost Today
                </div>
                <div className="text-2xl font-bold" data-testid="text-cost-today">
                  ${((metrics.todayCostCents ?? 0) / 100).toFixed(4)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">USD</div>
              </CardContent>
            </Card>
            <Card data-testid="card-cost-month">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <DollarSign className="w-3 h-3 text-blue-500" /> Cost This Month
                </div>
                <div className="text-2xl font-bold" data-testid="text-cost-month">
                  ${((metrics.monthCostCents ?? 0) / 100).toFixed(4)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">USD</div>
              </CardContent>
            </Card>
            <Card data-testid="card-confidence-threshold">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <ShieldCheck className="w-3 h-3 text-purple-500" /> Flag Threshold
                </div>
                <div className="text-2xl font-bold" data-testid="text-confidence-threshold">
                  {Math.round((metrics.confidenceThreshold ?? 0.5) * 100)}%
                </div>
                <div className="text-xs text-muted-foreground mt-1">min confidence to pass</div>
              </CardContent>
            </Card>
          </div>

          {metrics.dailyRollup && metrics.dailyRollup.some(d => d.calls > 0) && (
            <Card data-testid="card-completions-over-time">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">AI Completions Over Time (Last 30 Days)</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={metrics.dailyRollup.slice(-30)} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: string) => v.slice(5)}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip
                      formatter={(val: number, name: string) => [val, name === "calls" ? "Completions" : "Cost ($)"]}
                      labelFormatter={(label: string) => `Date: ${label}`}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="calls" name="Completions" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {triggerRows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Per-Trigger Health Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Trigger</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">Calls</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">Errors</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">Avg Confidence</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">Avg Latency</th>
                        <th className="text-right px-4 py-2 font-medium text-muted-foreground">Flagged</th>
                      </tr>
                    </thead>
                    <tbody>
                      {triggerRows.map(([tt, stats]) => (
                        <tr key={tt} className="border-b last:border-0 hover:bg-muted/20" data-testid={`health-row-${tt}`}>
                          <td className="px-4 py-2 text-muted-foreground">{AI_TRIGGER_LABELS[tt] || tt}</td>
                          <td className="px-4 py-2 text-right font-medium">{stats.calls}</td>
                          <td className="px-4 py-2 text-right">
                            {stats.errors > 0
                              ? <span className="text-red-600">{stats.errors}</span>
                              : <span className="text-green-600">0</span>}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <ConfidenceBadge score={stats.avgConfidence} />
                          </td>
                          <td className="px-4 py-2 text-right text-muted-foreground">
                            {stats.avgLatencyMs > 0 ? `${stats.avgLatencyMs}ms` : "—"}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {stats.flagged > 0
                              ? <Badge variant="destructive" className="text-xs">{stats.flagged}</Badge>
                              : <span className="text-muted-foreground">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

interface AiCostSummary {
  summary: {
    todayCostCents: number;
    todayCalls: number;
    monthCostCents: number;
    monthCalls: number;
    rangeCostCents: number;
    rangeCalls: number;
    byTriggerType: Record<string, { calls: number; costCents: number; promptTokens: number; completionTokens: number }>;
  };
  dailyRollup: Array<{ date: string; calls: number; costCents: number; promptTokens: number; completionTokens: number }>;
}

function AiCostPanel() {
  const { data, isLoading } = useQuery<AiCostSummary>({
    queryKey: ["/api/operator/ai-cost-summary"],
    queryFn: () => fetch("/api/operator/ai-cost-summary", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 60000,
  });

  const summary = data?.summary;
  const dailyRollup = Array.isArray(data?.dailyRollup) ? data.dailyRollup : [];

  const chartData = dailyRollup.map(d => ({
    date: d.date.slice(5),
    cost: parseFloat((d.costCents / 100).toFixed(4)),
    calls: d.calls,
  }));

  return (
    <div className="space-y-4 mb-6">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">AI Cost Overview</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <DollarSign className="w-3 h-3 text-green-600" /> Today's Spend
            </div>
            {isLoading ? (
              <div className="h-8 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-2xl font-bold text-green-700 dark:text-green-400" data-testid="text-today-ai-cost">
                  ${((summary?.todayCostCents || 0) / 100).toFixed(4)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{summary?.todayCalls || 0} calls today</div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <DollarSign className="w-3 h-3 text-blue-600" /> This Month
            </div>
            {isLoading ? (
              <div className="h-8 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-2xl font-bold text-blue-700 dark:text-blue-400" data-testid="text-month-ai-cost">
                  ${((summary?.monthCostCents || 0) / 100).toFixed(4)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{summary?.monthCalls || 0} calls this month</div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
            Trigger Type Breakdown (this month)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="h-24 bg-muted animate-pulse rounded m-4" />
          ) : Object.keys(summary?.byTriggerType || {}).length === 0 ? (
            <div className="py-6 text-center text-muted-foreground text-sm">No AI calls recorded this month</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Trigger Type</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Calls</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Cost</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Prompt Tokens</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Completion Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary?.byTriggerType || {})
                    .sort((a, b) => b[1].costCents - a[1].costCents)
                    .map(([type, stats]) => (
                      <tr key={type} className="border-b last:border-0 hover:bg-muted/40" data-testid={`row-cost-trigger-${type}`}>
                        <td className="px-4 py-2 text-muted-foreground">{AI_TRIGGER_LABELS[type] || type}</td>
                        <td className="px-4 py-2 text-right font-medium" data-testid={`text-calls-${type}`}>{stats.calls.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-medium text-green-700 dark:text-green-400" data-testid={`text-cost-${type}`}>${(stats.costCents / 100).toFixed(4)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{stats.promptTokens.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{stats.completionTokens.toLocaleString()}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
            30-Day AI Spend Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-48 bg-muted animate-pulse rounded" />
          ) : chartData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">No data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={180} data-testid="chart-ai-spend-trend">
              <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  interval={Math.floor(chartData.length / 6)}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  tickFormatter={v => `$${v}`}
                  width={48}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    name === "cost" ? `$${value.toFixed(4)}` : value,
                    name === "cost" ? "Daily Cost" : "Calls",
                  ]}
                  labelFormatter={label => `Date: ${label}`}
                />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  name="cost"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Deployment Readiness Card ─────────────────────────────────────────────────

interface PreDeployResult {
  ranAt: string;
  passed: boolean;
  passedCount: number;
  totalCount: number;
  skippedCount: number;
  suites: Array<{ name: string; passed: boolean; skipped: boolean; durationMs: number }>;
}

function DeploymentReadinessCard() {
  const { data, isLoading, isError, refetch } = useQuery<PreDeployResult | null>({
    queryKey: ["/api/admin/pre-deploy-result"],
    queryFn: async () => {
      const res = await fetch("/api/admin/pre-deploy-result", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch pre-deploy result");
      return res.json();
    },
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <Card data-testid="card-deployment-readiness">
        <CardContent className="p-6">
          <div className="h-32 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card data-testid="card-deployment-readiness-error">
        <CardContent className="p-6 flex flex-col items-center gap-3">
          <AlertTriangle className="w-8 h-8 text-red-500" />
          <p className="text-sm text-muted-foreground">Failed to load deployment readiness</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card data-testid="card-deployment-readiness-empty">
        <CardContent className="p-6 flex flex-col items-center gap-3 text-center">
          <Shield className="w-10 h-10 text-muted-foreground opacity-40" />
          <p className="text-sm font-medium">No gate result recorded yet</p>
          <p className="text-xs text-muted-foreground">
            Run the pre-deploy gate (<code className="font-mono">npx tsx scripts/pre-deploy.ts</code>) to populate this panel.
          </p>
        </CardContent>
      </Card>
    );
  }

  const failedSuites = data.suites.filter(s => !s.passed && !s.skipped);
  const passedSuites = data.suites.filter(s => s.passed);
  const skippedSuites = data.suites.filter(s => s.skipped);

  return (
    <Card
      data-testid="card-deployment-readiness"
      className={data.passed ? "border-green-500/50 bg-green-500/5" : "border-red-500/50 bg-red-500/5"}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            {data.passed ? (
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            ) : (
              <XCircle className="w-5 h-5 text-red-600" />
            )}
            Deployment Readiness Gate
          </CardTitle>
          <Badge variant={data.passed ? "default" : "destructive"} data-testid="badge-deploy-status">
            {data.passed ? "PASSED" : "FAILED"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Last run: {new Date(data.ranAt).toLocaleString()} ·{" "}
          {data.passedCount}/{data.totalCount} suites passed
          {data.skippedCount > 0 && `, ${data.skippedCount} skipped`}
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {failedSuites.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400" data-testid={`deploy-suite-failed-${i}`}>
              <XCircle className="w-3 h-3 shrink-0" />
              <span className="truncate">{s.name}</span>
              <span className="ml-auto text-muted-foreground shrink-0">{(s.durationMs / 1000).toFixed(1)}s</span>
            </div>
          ))}
          {passedSuites.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400" data-testid={`deploy-suite-passed-${i}`}>
              <CheckCircle2 className="w-3 h-3 shrink-0" />
              <span className="truncate">{s.name}</span>
              <span className="ml-auto text-muted-foreground shrink-0">{(s.durationMs / 1000).toFixed(1)}s</span>
            </div>
          ))}
          {skippedSuites.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`deploy-suite-skipped-${i}`}>
              <Clock className="w-3 h-3 shrink-0" />
              <span className="truncate">{s.name}</span>
              <span className="ml-auto shrink-0">skipped</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AiActivityPanel() {
  const [triggerType, setTriggerType] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const PAGE_SIZE = 50;

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (triggerType !== "all") params.set("triggerType", triggerType);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (flaggedOnly) params.set("flaggedOnly", "true");

  const { data, isLoading, refetch } = useQuery<{
    logs: Array<{
      id: number;
      triggerType: string;
      actorType: string;
      actorId: string | null;
      model: string;
      promptTokens: number;
      completionTokens: number;
      costCents: number;
      responseSummary: string | null;
      error: string | null;
      durationMs: number | null;
      confidenceScore: number | null;
      flagged: boolean | null;
      createdAt: string;
    }>;
    totals: {
      totalCalls: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      totalCostCents: number;
      byTriggerType: Record<string, { calls: number; promptTokens: number; completionTokens: number; costCents: number }>;
    };
  }>({
    queryKey: ["/api/operator/ai-audit", triggerType, startDate, endDate, page, flaggedOnly],
    queryFn: () => fetch(`/api/operator/ai-audit?${params}`, { credentials: "include" }).then(r => r.json()),
    refetchInterval: 30000,
  });

  const totals = data?.totals;
  const logs = Array.isArray(data?.logs) ? data.logs : [];

  return (
    <div className="space-y-4 mt-4">
      <AiLogDetailModal
        logId={selectedLogId}
        open={selectedLogId !== null}
        onClose={() => setSelectedLogId(null)}
      />
      <AiCostPanel />
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Trigger Type</label>
          <Select value={triggerType} onValueChange={v => { setTriggerType(v); setPage(0); }}>
            <SelectTrigger className="w-48" data-testid="select-trigger-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {Object.entries(AI_TRIGGER_LABELS).map(([val, label]) => (
                <SelectItem key={val} value={val}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Start Date</label>
          <Input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); setPage(0); }} className="w-40" aria-label="Start date" data-testid="input-start-date" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">End Date</label>
          <Input type="date" value={endDate} onChange={e => { setEndDate(e.target.value); setPage(0); }} className="w-40" aria-label="End date" data-testid="input-end-date" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Filter</label>
          <Button
            variant={flaggedOnly ? "default" : "outline"}
            size="sm"
            onClick={() => { setFlaggedOnly(v => !v); setPage(0); }}
            data-testid="button-toggle-flagged"
            className="flex items-center gap-1"
          >
            <Flag className="w-3.5 h-3.5" />
            {flaggedOnly ? "Flagged Only" : "All Calls"}
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-ai-audit">
          <RefreshCw className="w-4 h-4 mr-1" /> Refresh
        </Button>
      </div>

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Bot className="w-3 h-3" /> Total Calls</div>
              <div className="text-2xl font-bold" data-testid="text-total-calls">{totals.totalCalls.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Hash className="w-3 h-3" /> Prompt Tokens</div>
              <div className="text-2xl font-bold" data-testid="text-prompt-tokens">{totals.totalPromptTokens.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Hash className="w-3 h-3" /> Completion Tokens</div>
              <div className="text-2xl font-bold" data-testid="text-completion-tokens">{totals.totalCompletionTokens.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><DollarSign className="w-3 h-3" /> Est. Cost</div>
              <div className="text-2xl font-bold text-green-600" data-testid="text-total-cost">${(totals.totalCostCents / 100).toFixed(4)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {Object.keys(totals?.byTriggerType || {}).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cost by Trigger Type</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(totals!.byTriggerType).sort((a, b) => b[1].costCents - a[1].costCents).map(([type, stats]) => (
                <div key={type} className="flex justify-between items-center py-1 border-b last:border-0 text-sm" data-testid={`row-trigger-${type}`}>
                  <span className="text-muted-foreground">{AI_TRIGGER_LABELS[type] || type}</span>
                  <div className="text-right">
                    <div className="font-medium">{stats.calls} calls</div>
                    <div className="text-xs text-muted-foreground">${(stats.costCents / 100).toFixed(4)}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Recent AI Calls
            {flaggedOnly && <Badge variant="destructive" className="text-xs">Flagged Only</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : logs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {flaggedOnly ? "No flagged AI calls found." : "No AI calls recorded yet."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">Time</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">Trigger</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">Model</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Tokens</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Cost</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Duration</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">Confidence</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-center py-2 px-3 font-medium text-muted-foreground">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr
                      key={log.id}
                      className={`border-b last:border-0 hover:bg-muted/20 ${log.flagged ? "bg-red-50/50 dark:bg-red-950/10" : ""}`}
                      data-testid={`row-ai-log-${log.id}`}
                    >
                      <td className="py-2 px-3 text-muted-foreground whitespace-nowrap text-xs">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-1">
                          {log.flagged && <Flag className="w-3 h-3 text-red-500 shrink-0" />}
                          <Badge variant="outline" className="text-xs">{AI_TRIGGER_LABELS[log.triggerType] || log.triggerType}</Badge>
                        </div>
                      </td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">{log.model}</td>
                      <td className="py-2 px-3 text-right">
                        <span className="text-xs">{(log.promptTokens + log.completionTokens).toLocaleString()}</span>
                      </td>
                      <td className="py-2 px-3 text-right text-xs">${(log.costCents / 100).toFixed(4)}</td>
                      <td className="py-2 px-3 text-right text-xs text-muted-foreground">{log.durationMs ? `${log.durationMs}ms` : "—"}</td>
                      <td className="py-2 px-3 text-center">
                        <ConfidenceBadge score={log.confidenceScore} />
                      </td>
                      <td className="py-2 px-3">
                        {log.error ? (
                          <Badge variant="destructive" className="text-xs">Error</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">OK</Badge>
                        )}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => setSelectedLogId(log.id)}
                          data-testid={`button-view-log-${log.id}`}
                          aria-label="View log details"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {logs.length === PAGE_SIZE && (
            <div className="flex justify-center gap-2 py-3 border-t">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} data-testid="button-prev-page">Previous</Button>
              <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} data-testid="button-next-page">Next</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Statement Upload Failures Panel ─────────────────────────────────────────

interface UploadFailure {
  id: number;
  dealId: number | null;
  step: number | null;
  stepName: string | null;
  error: string | null;
  timestamp: string | null;
  createdAt: string | null;
}

const STEP_LABELS: Record<number, string> = {
  1: "Contact verified",
  2: "Company linked",
  3: "Deal created/advanced",
  4: "File attached",
  5: "AI analysis queued",
  6: "Rep notified",
  7: "GHL contact synced",
  8: "Pipeline stage set",
  9: "Merchant confirmation",
  10: "Proposal draft",
  11: "Follow-up enrolled",
};

function StatementUploadFailuresPanel() {
  const { data: failures = [], isLoading, refetch, isFetching } = useQuery<UploadFailure[]>({
    queryKey: ["/api/operator/statement-upload-failures"],
    staleTime: 30_000,
  });

  const stepCounts = failures.reduce<Record<string, number>>((acc, f) => {
    const key = f.stepName || `Step ${f.step}` || "Unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const stepBreakdown = Object.entries(stepCounts).sort((a, b) => b[1] - a[1]);

  function relativeTime(ts: string | null) {
    if (!ts) return "—";
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  return (
    <div className="space-y-4" data-testid="panel-statement-upload-failures">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-base">Statement Upload Chain Failures</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Logs individual step failures from the 11-step conversion chain. Uploads are never lost — these are background step failures only.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh statement upload failures" data-testid="button-refresh-upload-failures"
        >
          {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : failures.length === 0 ? (
        <Card data-testid="card-no-failures">
          <CardContent className="py-10 text-center">
            <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
            <p className="text-sm font-medium">All upload chain steps are passing</p>
            <p className="text-xs text-muted-foreground mt-1">No failures recorded in the last 500 audit log entries.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Step breakdown summary */}
          {stepBreakdown.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Failure Breakdown by Step</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stepBreakdown.map(([step, count]) => (
                  <div key={step} className="flex items-center gap-2" data-testid={`row-step-breakdown-${step.replace(/\s/g, "-")}`}>
                    <span className="text-xs text-muted-foreground w-44 truncate">{step}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-destructive"
                        style={{ width: `${Math.min(100, (count / failures.length) * 100)}%` }}
                      />
                    </div>
                    <Badge variant="destructive" className="text-xs shrink-0" data-testid={`badge-step-count-${step.replace(/\s/g, "-")}`}>
                      {count}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Recent failures table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                Recent Failures ({failures.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="table-upload-failures">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Step</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Error</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Deal</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.slice(0, 50).map((f) => (
                      <tr key={f.id} className="border-b hover:bg-muted/20 transition-colors" data-testid={`row-failure-${f.id}`}>
                        <td className="py-2 px-4">
                          <Badge variant="outline" className="text-xs border-destructive/40 text-destructive">
                            {f.stepName || (f.step ? STEP_LABELS[f.step] : "Unknown")}
                          </Badge>
                        </td>
                        <td className="py-2 px-4 max-w-xs">
                          <span className="text-destructive/80 truncate block max-w-xs" title={f.error || "—"}>
                            {f.error || "—"}
                          </span>
                        </td>
                        <td className="py-2 px-4">
                          {f.dealId ? (
                            <a
                              href={`/dashboard/deals/${f.dealId}`}
                              className="text-primary hover:underline"
                              data-testid={`link-deal-${f.dealId}`}
                            >
                              #{f.dealId}
                            </a>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 px-4 text-muted-foreground whitespace-nowrap">
                          {relativeTime(f.timestamp || f.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Wave 8: Conversion Panel ─────────────────────────────────────────────────
function ConversionPanel() {
  const [days, setDays] = useState(30);

  const { data: funnelData, isLoading: funnelLoading } = useQuery<{
    funnel: { stage: string; eventName: string; count: number }[];
    byEvent: Record<string, number>;
    days: number;
  }>({
    queryKey: ["/api/analytics/conversion-funnel", days],
    queryFn: () => fetch(`/api/analytics/conversion-funnel?days=${days}`).then(r => r.json()),
  });

  const { data: utmData, isLoading: utmLoading } = useQuery<{
    rows: { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; cnt: string }[];
    days: number;
  }>({
    queryKey: ["/api/analytics/utm-attribution", days],
    queryFn: () => fetch(`/api/analytics/utm-attribution?days=${days}`).then(r => r.json()),
  });

  const { data: eventsData, isLoading: eventsLoading } = useQuery<{
    events: {
      id: number;
      eventName: string;
      occurredAt: string;
      contactId: number | null;
      dealId: number | null;
      utmSource: string | null;
      channel: string | null;
      blockReason: string | null;
      dealStage: string | null;
      offerRoute: string | null;
    }[];
  }>({
    queryKey: ["/api/analytics/conversion-events", 7],
    queryFn: () => fetch(`/api/analytics/conversion-events?days=7&limit=100`).then(r => r.json()),
  });

  const funnelColors = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"];
  const funnelRows = Array.isArray(funnelData?.funnel) ? funnelData.funnel : [];
  const utmRows = Array.isArray(utmData?.rows) ? utmData.rows : [];
  const topUtm = utmRows.slice().sort((a, b) => Number(b.cnt) - Number(a.cnt)).slice(0, 10);
  const recentEvents = Array.isArray(eventsData?.events) ? eventsData.events : [];

  function relT(s: string) {
    const diff = Date.now() - new Date(s).getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    return `${Math.round(diff / 86400000)}d ago`;
  }

  return (
    <div className="space-y-6" data-testid="panel-conversion">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Conversion Attribution</h2>
        <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
          <SelectTrigger className="w-32" data-testid="select-conversion-days">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="14">Last 14 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card data-testid="card-conversion-funnel">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Conversion Funnel (last {days} days)</CardTitle>
        </CardHeader>
        <CardContent>
          {funnelLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading funnel…</div>
          ) : (
            <div className="space-y-3">
              {funnelRows.map((row, i) => {
                const topCount = funnelRows[0]?.count ?? 1;
                const pct = topCount > 0 ? Math.round((row.count / topCount) * 100) : 0;
                return (
                  <div key={row.eventName} data-testid={`funnel-row-${row.eventName}`}>
                    <div className="flex items-center justify-between mb-1 text-sm">
                      <span className="font-medium">{row.stage}</span>
                      <span className="text-muted-foreground">{row.count.toLocaleString()} <span className="text-xs">({pct}%)</span></span>
                    </div>
                    <Progress value={pct} className="h-2" />
                  </div>
                );
              })}
              {funnelRows.length === 0 && (
                <p className="text-sm text-muted-foreground">No conversion events recorded yet.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-utm-attribution">
        <CardHeader>
          <CardTitle className="text-sm font-medium">UTM Source Attribution (last {days} days)</CardTitle>
        </CardHeader>
        <CardContent>
          {utmLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : topUtm.length === 0 ? (
            <p className="text-sm text-muted-foreground">No UTM-tagged events yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 pr-4 font-medium">Source</th>
                    <th className="text-left py-2 pr-4 font-medium">Medium</th>
                    <th className="text-left py-2 pr-4 font-medium">Campaign</th>
                    <th className="text-right py-2 font-medium">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {topUtm.map((r, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30" data-testid={`utm-row-${i}`}>
                      <td className="py-2 pr-4">{r.utmSource ?? <span className="text-muted-foreground italic">(direct)</span>}</td>
                      <td className="py-2 pr-4">{r.utmMedium ?? "—"}</td>
                      <td className="py-2 pr-4">{r.utmCampaign ?? "—"}</td>
                      <td className="py-2 text-right font-medium">{Number(r.cnt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-recent-conversion-events">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Recent CRM Milestone Events (last 7 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {eventsLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : recentEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No milestone events recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 pr-4 font-medium">Event</th>
                    <th className="text-left py-2 pr-4 font-medium">Contact</th>
                    <th className="text-left py-2 pr-4 font-medium">Deal</th>
                    <th className="text-left py-2 pr-4 font-medium">Detail</th>
                    <th className="text-right py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEvents.slice(0, 50).map((ev) => (
                    <tr key={ev.id} className="border-b last:border-0 hover:bg-muted/30" data-testid={`event-row-${ev.id}`}>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className="text-xs font-mono">{ev.eventName}</Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {ev.contactId ? <a href={`/dashboard/contacts/${ev.contactId}`} className="text-primary hover:underline">#{ev.contactId}</a> : "—"}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {ev.dealId ? <a href={`/dashboard/deals/${ev.dealId}`} className="text-primary hover:underline">#{ev.dealId}</a> : "—"}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground text-xs">
                        {ev.channel ?? ev.dealStage ?? ev.blockReason ?? ev.offerRoute ?? "—"}
                      </td>
                      <td className="py-2 text-right text-muted-foreground text-xs whitespace-nowrap">{relT(ev.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Lifecycle Command Center ──────────────────────────────────────────────────

export function LifecycleCommandCenter() {
  const { data, isLoading, isError } = useQuery<LifecycleStageCountsResponse>({
    queryKey: ["/api/operator/lifecycle-stage-counts"],
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="lifecycle-loading">
        {[1, 2, 3].map(i => (
          <Card key={i}>
            <CardContent className="p-4">
              <div className="h-4 bg-muted animate-pulse rounded w-1/3 mb-2" />
              <div className="h-8 bg-muted animate-pulse rounded w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <Card data-testid="lifecycle-error">
        <CardContent className="p-6 flex flex-col items-center gap-2 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500" />
          <p className="font-medium">Unable to load lifecycle data</p>
          <p className="text-sm text-muted-foreground">Check that you have admin or manager access and the server is running.</p>
        </CardContent>
      </Card>
    );
  }

  const lifecycleStages = Array.isArray(data?.stages) ? data.stages : [];

  if (!data || lifecycleStages.length === 0) {
    return (
      <Card data-testid="lifecycle-empty">
        <CardContent className="p-8 text-center text-muted-foreground">
          No contacts in pipeline yet
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="lifecycle-command-center">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Lifecycle Stage Distribution</h3>
          <p className="text-xs text-muted-foreground">Total active pipeline: {data.totalActivePipeline.toLocaleString()} contacts · Updated {new Date(data.generatedAt).toLocaleTimeString()}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {lifecycleStages.map(stage => (
          <Card key={stage.stage} data-testid={`lifecycle-card-${stage.stage}`}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-blue-600" />
                <span className="text-xs text-muted-foreground truncate">{stage.label}</span>
              </div>
              <div className="text-2xl font-bold" data-testid={`lifecycle-count-${stage.stage}`}>{stage.count.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {stage.percentOfPipeline}% of pipeline
              </div>
              <div className="text-xs text-muted-foreground">
                Stuck: {stage.stuckCount !== null ? stage.stuckCount : "N/A"}
              </div>
              <a
                href={stage.filterUrl}
                className="text-xs text-primary hover:underline mt-2 inline-block"
                data-testid={`lifecycle-link-${stage.stage}`}
              >
                View contacts →
              </a>
            </CardContent>
          </Card>
        ))}
      </div>

      {data.warning && (
        <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded text-sm text-yellow-800 dark:text-yellow-300" data-testid="lifecycle-warning">
          <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
          <span>{data.warning}</span>
        </div>
      )}
    </div>
  );
}

// ─── Score All Contacts Panel ──────────────────────────────────────────────────

interface ScoringProgress {
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  total: number;
  processed: number;
  hot: number;
  warm: number;
  cold: number;
  unqualified: number;
  errors: number;
  lastProcessedContactId: number | null;
  rescore: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  error?: string | null;
  jobRunning?: boolean;
}

// ── ZeroBounce Backlog Panel ──────────────────────────────────────────────────

interface QualitySummary {
  unvalidated_email: number;
}

function ZbBacklogPanel() {
  const { data, isLoading } = useQuery<QualitySummary>({
    queryKey: ["/api/contacts/quality-summary"],
    queryFn: () => fetch("/api/contacts/quality-summary", { credentials: "include" }).then((r) => r.json()),
    staleTime: 60_000,
  });

  const backlog = data?.unvalidated_email ?? 0;

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">ZeroBounce Email Validation</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Contacts with unvalidated email addresses — cleared via the durable multi-day campaign on the Data Quality page.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading backlog stats…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Backlog</p>
              <p className="text-2xl font-bold mt-1">{backlog.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">unvalidated</p>
            </CardContent>
          </Card>
        </div>
      )}

      <a
        href="/dashboard/data-quality"
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        <Database className="h-4 w-4" />
        Open Data Quality Scanner &amp; Campaign
      </a>
    </div>
  );
}

interface ScoringPreview {
  totalUnscored: number;
  wouldProcess: number;
  estimatedBatches: number;
  paidAiRequired: boolean;
}

function ScoreAllPanel() {
  const { toast } = useToast();
  const [rescore, setRescore] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const { data: status, refetch: refetchStatus } = useQuery<ScoringProgress>({
    queryKey: ["/api/admin/contacts/score-all/status"],
    refetchInterval: (data) => (data?.state?.data?.jobRunning ? 3000 : false),
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/contacts/score-all/preview");
      return (await res.json()) as ScoringPreview;
    },
  });

  const startMutation = useMutation({
    mutationFn: async (payload: { confirmed: true; rescore: boolean; confirmationText?: string }) => {
      const res = await apiRequest("POST", "/api/admin/contacts/score-all", payload);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.message ?? "Failed to start job");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Scoring job started" });
      setShowConfirm(false);
      setConfirmText("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/score-all/status"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to start job", description: err.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/contacts/score-all/cancel");
      if (!res.ok) { const b = await res.json(); throw new Error(b.message); }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Cancel requested" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/score-all/status"] });
    },
    onError: (err: any) => toast({ title: "Cancel failed", description: err.message, variant: "destructive" }),
  });

  const isRunning = status?.jobRunning || status?.status === "running";
  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;

  const handleStartClick = () => {
    if (rescore) { setShowConfirm(true); return; }
    startMutation.mutate({ confirmed: true, rescore: false });
  };

  return (
    <div className="space-y-4" data-testid="panel-score-all">
      <div>
        <h3 className="text-lg font-semibold">Score All Contacts</h3>
        <p className="text-xs text-muted-foreground">
          Batch-scores contacts using deterministic signals only. No AI cost, no GHL sync, no deal changes.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Rescore all contacts</p>
              <p className="text-xs text-muted-foreground">Including contacts already scored. Requires typed confirmation.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={rescore}
              onClick={() => setRescore(v => !v)}
              aria-label="Rescore already scored contacts" data-testid="toggle-rescore"
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                rescore ? "bg-blue-600" : "bg-muted"
              )}
            >
              <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white transition-transform", rescore ? "translate-x-6" : "translate-x-1")} />
            </button>
          </div>

          {rescore && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-300">Type <code>SCORE CONTACTS</code> to confirm rescoring all contacts</p>
              <Input
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder="SCORE CONTACTS"
                data-testid="input-rescore-confirm"
                className="max-w-xs text-sm"
              />
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending || isRunning}
              data-testid="button-score-all-preview"
            >
              {previewMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
              Preview
            </Button>
            <Button
              size="sm"
              onClick={handleStartClick}
              disabled={startMutation.isPending || isRunning || (rescore && confirmText !== "SCORE CONTACTS")}
              data-testid="button-score-all-start"
            >
              {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              {rescore ? "Rescore All" : "Score Unscored"}
            </Button>
            {isRunning && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                data-testid="button-score-all-cancel"
              >
                {cancelMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <XCircle className="w-4 h-4 mr-2" />}
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {previewMutation.data && (
        <Card data-testid="card-score-all-preview">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Preview</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><p className="text-muted-foreground text-xs">Unscored</p><p className="font-semibold text-lg">{previewMutation.data.totalUnscored.toLocaleString()}</p></div>
            <div><p className="text-muted-foreground text-xs">Would Process</p><p className="font-semibold text-lg">{previewMutation.data.wouldProcess.toLocaleString()}</p></div>
            <div><p className="text-muted-foreground text-xs">Batches (~50)</p><p className="font-semibold text-lg">{previewMutation.data.estimatedBatches.toLocaleString()}</p></div>
            <div><p className="text-muted-foreground text-xs">Paid AI?</p><p className="font-semibold text-lg">{previewMutation.data.paidAiRequired ? "Yes" : "No"}</p></div>
          </CardContent>
        </Card>
      )}

      {status && status.status !== "idle" && (
        <Card data-testid="card-score-all-progress">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              Progress
              {status.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
              {status.status === "complete" && <CheckCircle2 className="w-4 h-4 text-green-600" />}
              {status.status === "cancelled" && <XCircle className="w-4 h-4 text-orange-600" />}
              {status.status === "failed" && <AlertTriangle className="w-4 h-4 text-red-600" />}
              <Badge variant={status.status === "complete" ? "default" : status.status === "failed" ? "destructive" : "secondary"} className="ml-auto text-xs">
                {status.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{status.processed.toLocaleString()} / {status.total.toLocaleString()}</span>
                <span>{pct}%</span>
              </div>
              <Progress value={pct} className="h-2" data-testid="progress-score-all" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-red-50 dark:bg-red-950/20 rounded p-2">
                <p className="text-muted-foreground">Hot</p>
                <p className="font-semibold text-base">{status.hot.toLocaleString()}</p>
              </div>
              <div className="bg-orange-50 dark:bg-orange-950/20 rounded p-2">
                <p className="text-muted-foreground">Warm</p>
                <p className="font-semibold text-base">{status.warm.toLocaleString()}</p>
              </div>
              <div className="bg-blue-50 dark:bg-blue-950/20 rounded p-2">
                <p className="text-muted-foreground">Cold</p>
                <p className="font-semibold text-base">{status.cold.toLocaleString()}</p>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <p className="text-muted-foreground">Unqualified</p>
                <p className="font-semibold text-base">{status.unqualified.toLocaleString()}</p>
              </div>
            </div>
            {status.errors > 0 && (
              <p className="text-xs text-red-600 dark:text-red-400" data-testid="text-score-all-errors">{status.errors} contact(s) failed to score</p>
            )}
            {status.error && (
              <p className="text-xs text-red-600 dark:text-red-400" data-testid="text-score-all-job-error">Error: {status.error}</p>
            )}
            {status.completedAt && (
              <p className="text-xs text-muted-foreground">Completed: {new Date(status.completedAt).toLocaleString()}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Bulk Enroll Panel ─────────────────────────────────────────────────────────

interface BulkEnrollStatus {
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  sequenceId: number;
  vertical: string;
  minScore: number;
  total: number;
  processed: number;
  enrolled: number;
  alreadyEnrolled: number;
  dncBlocked: number;
  optOutBlocked: number;
  contactabilityBlocked: number;
  pewcBlocked: number;
  missingContactMethod: number;
  eligibilityBlocked: number;
  errors: number;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  error?: string | null;
  jobRunning?: boolean;
}

interface BulkEnrollPreview {
  total: number;
  eligible: number;
  alreadyEnrolled: number;
  dncBlocked: number;
  optOutBlocked: number;
  contactabilityBlocked: number;
  pewcBlocked: number;
  missingContactMethod: number;
  eligibilityBlocked: number;
  sequenceChannelLabel: string;
  requiresTypedConfirmation: boolean;
}

interface SequenceOption {
  id: number;
  name: string;
  status: string;
  vertical?: string | null;
  sequenceFamily?: string | null;
}

function BulkEnrollPanel() {
  const { toast } = useToast();
  const [vertical, setVertical] = useState("");
  const [minScore, setMinScore] = useState(70);
  const [sequenceId, setSequenceId] = useState<number | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<BulkEnrollPreview | null>(null);

  const { data: status, refetch: refetchStatus } = useQuery<BulkEnrollStatus>({
    queryKey: ["/api/admin/contacts/bulk-enroll/status"],
    refetchInterval: (data) => (data?.state?.data?.jobRunning ? 3000 : false),
  });

  const { data: sequences } = useQuery<SequenceOption[]>({
    queryKey: ["/api/sequences"],
  });

  const activeSequences = (sequences ?? []).filter(s => s.status === "active");

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!vertical.trim()) throw new Error("Vertical is required.");
      if (!sequenceId) throw new Error("Select a sequence.");
      const res = await apiRequest("POST", "/api/admin/contacts/bulk-enroll/preview", {
        vertical: vertical.trim(),
        minScore,
        sequenceId,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? "Preview failed");
      return body as BulkEnrollPreview;
    },
    onSuccess: (data) => setPreview(data),
    onError: (err: any) => toast({ title: "Preview failed", description: err.message, variant: "destructive" }),
  });

  const enrollMutation = useMutation({
    mutationFn: async () => {
      if (!vertical.trim()) throw new Error("Vertical is required.");
      if (!sequenceId) throw new Error("Select a sequence.");
      const res = await apiRequest("POST", "/api/admin/contacts/bulk-enroll", {
        vertical: vertical.trim(),
        minScore,
        sequenceId,
        confirmed: true,
        confirmationText: confirmText || undefined,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? "Enrollment failed");
      return body;
    },
    onSuccess: (data) => {
      toast({ title: "Bulk enrollment started", description: `Enrolling ${data.eligible ?? ""} contacts` });
      setConfirmText("");
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/bulk-enroll/status"] });
    },
    onError: (err: any) => toast({ title: "Enrollment failed", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/contacts/bulk-enroll/cancel");
      if (!res.ok) { const b = await res.json(); throw new Error(b.message); }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Cancel requested" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/bulk-enroll/status"] });
    },
    onError: (err: any) => toast({ title: "Cancel failed", description: err.message, variant: "destructive" }),
  });

  const isRunning = status?.jobRunning || status?.status === "running";
  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  const needsTypedConfirm = preview?.requiresTypedConfirmation ?? false;
  const canEnroll = !!(vertical.trim() && sequenceId && (!needsTypedConfirm || confirmText === "ENROLL") && !isRunning);

  return (
    <div className="space-y-4" data-testid="panel-bulk-enroll">
      <div>
        <h3 className="text-lg font-semibold">Bulk Enroll Hot/Warm Contacts</h3>
        <p className="text-xs text-muted-foreground">
          Enroll scored contacts into a sequence by vertical. DNC, opt-out, PEWC, and contactability gates are enforced. No deals created. No outbound sends triggered directly.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className="text-xs font-medium">Vertical</p>
              <Input
                value={vertical}
                onChange={e => { setVertical(e.target.value); setPreview(null); }}
                placeholder="e.g. restaurant, dental, retail"
                data-testid="input-bulk-enroll-vertical"
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">Min Lead Score</p>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={e => { setMinScore(Number(e.target.value)); setPreview(null); }}
                  className="w-24"
                  data-testid="input-bulk-enroll-minscore"
                />
                <span className="text-xs text-muted-foreground">0–100 (default 70 = Hot+Warm)</span>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">Sequence</p>
            {activeSequences.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active sequences found. Activate a sequence first.</p>
            ) : (
              <Select value={sequenceId?.toString() ?? ""} onValueChange={v => { setSequenceId(Number(v)); setPreview(null); }}>
                <SelectTrigger data-testid="select-bulk-enroll-sequence">
                  <SelectValue placeholder="Select sequence…" />
                </SelectTrigger>
                <SelectContent>
                  {activeSequences.map(s => (
                    <SelectItem key={s.id} value={s.id.toString()} data-testid={`option-sequence-${s.id}`}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">Campaign enrollment is not supported. Sequences only.</p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !vertical.trim() || !sequenceId}
            data-testid="button-bulk-enroll-preview"
          >
            {previewMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
            Preview Enrollment
          </Button>
        </CardContent>
      </Card>

      {preview && (
        <Card data-testid="card-bulk-enroll-preview">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              Preview
              <Badge variant="secondary" className="ml-auto text-xs">{preview.sequenceChannelLabel}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-green-50 dark:bg-green-950/20 rounded p-2">
                <p className="text-muted-foreground">Eligible</p>
                <p className="font-semibold text-base text-green-700 dark:text-green-400">{preview.eligible.toLocaleString()}</p>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <p className="text-muted-foreground">Total Found</p>
                <p className="font-semibold text-base">{preview.total.toLocaleString()}</p>
              </div>
              <div className="bg-yellow-50 dark:bg-yellow-950/20 rounded p-2">
                <p className="text-muted-foreground">Already Enrolled</p>
                <p className="font-semibold text-base">{preview.alreadyEnrolled.toLocaleString()}</p>
              </div>
              <div className="bg-red-50 dark:bg-red-950/20 rounded p-2">
                <p className="text-muted-foreground">DNC Blocked</p>
                <p className="font-semibold text-base">{preview.dncBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">Opt-Out</p>
                <p className="font-semibold text-base">{preview.optOutBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">Contactability</p>
                <p className="font-semibold text-base">{preview.contactabilityBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">PEWC Required</p>
                <p className="font-semibold text-base">{preview.pewcBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">No Email</p>
                <p className="font-semibold text-base">{preview.missingContactMethod.toLocaleString()}</p>
              </div>
            </div>

            {preview.sequenceChannelLabel === "SMS/Voice/Ringless requires PEWC" && (
              <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-300" data-testid="alert-pewc-required">
                <Shield className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                <span>This sequence contains SMS/Voice/Ringless steps. Only contacts with PEWC full automation will be enrolled.</span>
              </div>
            )}

            {needsTypedConfirm && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  {preview.eligible.toLocaleString()} contacts will be enrolled. Type <code>ENROLL</code> to confirm.
                </p>
                <Input
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder="ENROLL"
                  data-testid="input-bulk-enroll-confirm"
                  className="max-w-xs text-sm"
                />
              </div>
            )}

            <Button
              size="sm"
              onClick={() => enrollMutation.mutate()}
              disabled={enrollMutation.isPending || !canEnroll || preview.eligible === 0}
              data-testid="button-bulk-enroll-start"
            >
              {enrollMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Confirm & Enroll {preview.eligible > 0 ? `${preview.eligible.toLocaleString()} Contacts` : "(none eligible)"}
            </Button>
          </CardContent>
        </Card>
      )}

      {isRunning && (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => cancelMutation.mutate()}
          disabled={cancelMutation.isPending}
          data-testid="button-bulk-enroll-cancel"
        >
          {cancelMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <XCircle className="w-4 h-4 mr-2" />}
          Cancel Job
        </Button>
      )}

      {status && status.status !== "idle" && (
        <Card data-testid="card-bulk-enroll-progress">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              Progress
              {status.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
              {status.status === "complete" && <CheckCircle2 className="w-4 h-4 text-green-600" />}
              {status.status === "cancelled" && <XCircle className="w-4 h-4 text-orange-600" />}
              {status.status === "failed" && <AlertTriangle className="w-4 h-4 text-red-600" />}
              <Badge variant={status.status === "complete" ? "default" : status.status === "failed" ? "destructive" : "secondary"} className="ml-auto text-xs">
                {status.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{status.processed.toLocaleString()} / {status.total.toLocaleString()}</span>
                <span>{pct}%</span>
              </div>
              <Progress value={pct} className="h-2" data-testid="progress-bulk-enroll" />
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="bg-green-50 dark:bg-green-950/20 rounded p-2">
                <p className="text-muted-foreground">Enrolled</p>
                <p className="font-semibold text-base text-green-700 dark:text-green-400">{status.enrolled.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">Skipped</p>
                <p className="font-semibold text-base">{(status.alreadyEnrolled + status.dncBlocked + status.optOutBlocked + status.contactabilityBlocked + status.pewcBlocked + status.missingContactMethod + status.eligibilityBlocked).toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-red-50 dark:bg-red-950/20">
                <p className="text-muted-foreground">Errors</p>
                <p className="font-semibold text-base">{status.errors.toLocaleString()}</p>
              </div>
            </div>
            {status.error && (
              <p className="text-xs text-red-600 dark:text-red-400" data-testid="text-bulk-enroll-error">Error: {status.error}</p>
            )}
            {status.completedAt && (
              <p className="text-xs text-muted-foreground">Completed: {new Date(status.completedAt).toLocaleString()}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Stage Health Panel ────────────────────────────────────────────────────────

interface VerticalBreakdownRow {
  vertical: string | null;
  label: string;
  totalDeals: number;
  enrolled: number;
  noActiveEnrollment: number;
  noSequenceMapped: number;
  noEmail: number;
  dncBlocked: number;
  optedOutBlocked: number;
  suppressed: number;
  mappedSequenceId: number | null;
  mappedSequenceName: string | null;
  sequenceMappingSource?: "explicit" | "default" | "none";
}

interface StageHealthData {
  totalNewLeadDeals: number;
  newLeadNoMovement7d: number;
  newLeadNoActiveEnrollment: number;
  newLeadAutoEnrollmentSuppressed: number;
  autoEnrollNewLeadDeals: boolean;
  lastStageProgressionSweepAt: string | null;
  lastSequenceWorkerTickAt: string | null;
  staleness_proxy: string;
  staleDeals: Array<{
    dealId: number;
    contactId: number | null;
    vertical: string | null;
    updatedAt: string | null;
    createdAt: string | null;
  }>;
  breakdownByVertical?: VerticalBreakdownRow[];
  verticalSequenceMap?: Record<string, number | null>;
  defaultSequenceId?: number | null;
}

interface VerticalDetailRow {
  dealId: number;
  contactId?: number | null;
  contactName?: string | null;
  companyName?: string | null;
  email?: string | null;
  vertical?: string | null;
  leadScore?: number | null;
  mappedSequenceId?: number | null;
  mappedSequenceName?: string | null;
  blockReason: string;
  blockReasonLabel: string;
  daysInStage?: number | null;
}

interface VerticalDetailData {
  verticalDetail: {
    vertical: string | null;
    label: string;
    total: number;
    limit?: number;
    offset?: number;
    blockReason?: string;
    rows: VerticalDetailRow[];
  };
}

const BLOCK_REASON_COLORS: Record<string, string> = {
  DNC: "text-red-700 bg-red-50 dark:bg-red-950/30",
  suppressed: "text-orange-700 bg-orange-50 dark:bg-orange-950/30",
  opted_out: "text-pink-700 bg-pink-50 dark:bg-pink-950/30",
  no_email: "text-gray-600 bg-gray-100 dark:bg-gray-800/40",
  no_sequence_mapped: "text-amber-700 bg-amber-50 dark:bg-amber-950/30",
  sequence_inactive: "text-amber-700 bg-amber-50 dark:bg-amber-950/30",
  already_enrolled: "text-blue-700 bg-blue-50 dark:bg-blue-950/30",
  contactability_blocked: "text-purple-700 bg-purple-50 dark:bg-purple-950/30",
  unknown: "text-muted-foreground bg-muted/40",
};

const BLOCK_REASON_LABEL_MAP: Record<string, string> = {
  all: "All reasons",
  DNC: "Do Not Contact (DNC)",
  suppressed: "Auto-enrollment suppressed",
  opted_out: "Opted out of email",
  no_email: "No email address",
  no_sequence_mapped: "No sequence mapped",
  sequence_inactive: "Sequence inactive",
  already_enrolled: "Already enrolled",
  contactability_blocked: "Contactability blocked",
  unknown: "Unknown",
};

const BLOCK_REASON_OPTIONS = [
  "all",
  "DNC",
  "suppressed",
  "opted_out",
  "no_email",
  "no_sequence_mapped",
  "sequence_inactive",
  "already_enrolled",
  "contactability_blocked",
  "unknown",
] as const;

function VerticalDetailPanel({
  verticalKey,
  limit = 50,
}: {
  verticalKey: string;
  limit?: number;
}) {
  const [offset, setOffset] = useState(0);
  const [allRows, setAllRows] = useState<VerticalDetailRow[]>([]);
  const [blockReason, setBlockReason] = useState<string>("all");

  const url = `/api/admin/pipeline/stage-health/vertical-detail?vertical=${encodeURIComponent(verticalKey)}&limit=${limit}&offset=${offset}${blockReason !== "all" ? `&blockReason=${blockReason}` : ""}`;

  const { data, isLoading, isError } = useQuery<VerticalDetailData>({
    queryKey: ["/api/admin/pipeline/stage-health/vertical-detail", verticalKey, blockReason, offset],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      return res.json();
    },
  });

  useEffect(() => {
    setOffset(0);
    setAllRows([]);
  }, [blockReason]);

  useEffect(() => {
    if (data?.verticalDetail?.rows) {
      if (offset === 0) {
        setAllRows(data.verticalDetail.rows);
      } else {
        setAllRows((prev) => [...prev, ...data.verticalDetail.rows]);
      }
    }
  }, [data, offset]);

  const total = data?.verticalDetail?.total ?? 0;
  const canLoadMore = allRows.length < total && !isLoading;

  if (isLoading && offset === 0 && allRows.length === 0) {
    return (
      <div className="flex items-center gap-2 py-3 px-4 text-xs text-muted-foreground" data-testid="vertical-detail-loading">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading blocked deals…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-3 px-4 text-xs text-red-600" data-testid="vertical-detail-error">
        Failed to load detail rows.
      </div>
    );
  }

  return (
    <div className="bg-muted/20 border-t px-4 py-3" data-testid="vertical-detail-panel">
      <div className="flex items-center gap-3 mb-2">
        <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">Filter by reason:</label>
        <select
          className="text-xs border rounded px-2 py-1 bg-background text-foreground"
          value={blockReason}
          onChange={(e) => setBlockReason(e.target.value)}
          data-testid="select-block-reason-filter"
        >
          {BLOCK_REASON_OPTIONS.map((key) => (
            <option key={key} value={key}>
              {BLOCK_REASON_LABEL_MAP[key]}
            </option>
          ))}
        </select>
      </div>
      {allRows.length === 0 && !isLoading ? (
        <div className="py-2 text-xs text-muted-foreground" data-testid="vertical-detail-empty">
          No blocked deals found for this filter.
        </div>
      ) : (
        <>
      <p className="text-xs font-medium text-muted-foreground mb-2">
        {blockReason !== "all"
          ? `Showing ${BLOCK_REASON_LABEL_MAP[blockReason] ?? blockReason} blockers — ${allRows.length} of ${total}`
          : `Showing ${allRows.length} of ${total} blocked deal${total !== 1 ? "s" : ""}`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="table-vertical-detail">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="text-left py-1 pr-2 font-medium">Deal</th>
              <th className="text-left py-1 pr-2 font-medium">Contact</th>
              <th className="text-left py-1 pr-2 font-medium">Email</th>
              <th className="text-left py-1 pr-2 font-medium">Block Reason</th>
              <th className="text-left py-1 pr-2 font-medium">Mapped Sequence</th>
              <th className="text-right py-1 font-medium">Days in Stage</th>
            </tr>
          </thead>
          <tbody>
            {allRows.map((row) => (
              <tr
                key={row.dealId}
                className="border-b last:border-0 hover:bg-muted/30"
                data-testid={`detail-row-${row.dealId}`}
              >
                <td className="py-1 pr-2 font-mono text-muted-foreground">#{row.dealId}</td>
                <td className="py-1 pr-2">
                  <div className="font-medium">{row.contactName || <span className="italic text-muted-foreground">No contact</span>}</div>
                  {row.companyName && <div className="text-muted-foreground truncate max-w-[140px]">{row.companyName}</div>}
                </td>
                <td className="py-1 pr-2 text-muted-foreground font-mono truncate max-w-[140px]">
                  {row.email || <span className="italic">—</span>}
                </td>
                <td className="py-1 pr-2">
                  <span
                    className={cn(
                      "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
                      BLOCK_REASON_COLORS[row.blockReason] ?? "text-muted-foreground bg-muted/40"
                    )}
                    data-testid={`block-reason-${row.dealId}`}
                  >
                    {row.blockReasonLabel}
                  </span>
                </td>
                <td className="py-1 pr-2 text-muted-foreground truncate max-w-[120px]">
                  {row.mappedSequenceName || <span className="italic">—</span>}
                </td>
                <td className="py-1 text-right text-muted-foreground">
                  {row.daysInStage != null ? `${row.daysInStage}d` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canLoadMore && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7"
            onClick={() => setOffset((o) => o + limit)}
            disabled={isLoading}
            data-testid="button-load-more-vertical-detail"
          >
            {isLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Load more ({total - allRows.length} remaining)
          </Button>
        </div>
      )}
        </>
      )}
    </div>
  );
}

function StageHealthPanel() {
  const [, navigate] = useLocation();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [expandedVertical, setExpandedVertical] = useState<string | null>(null);
  const { data, isLoading, isError, refetch } = useQuery<StageHealthData>({
    queryKey: ["/api/admin/pipeline/stage-health"],
    refetchInterval: 60000,
  });

  return (
    <div className="space-y-4" data-testid="panel-stage-health">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Pipeline Stage Health</h3>
          <p className="text-xs text-muted-foreground">
            New Lead deal coverage, staleness, and enrollment gaps. Staleness uses <code>updatedAt</code> as proxy (no <code>stageEnteredAt</code> column).
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate("/dashboard/operator?view=new-lead-enroll")}
          data-testid="button-go-to-enroll-panel"
        >
          <ListChecks className="w-4 h-4 mr-1" />
          New Lead Enrollment
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <Card key={i}><CardContent className="p-4"><div className="h-4 bg-muted animate-pulse rounded w-1/3 mb-2" /><div className="h-8 bg-muted animate-pulse rounded w-1/2" /></CardContent></Card>
          ))}
        </div>
      )}

      {isError && (
        <Card><CardContent className="p-4 text-sm text-red-600">Failed to load stage health data. <Button variant="ghost" size="sm" onClick={() => refetch()}>Retry</Button></CardContent></Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">Total New Lead Deals</p>
                <p className="text-2xl font-bold" data-testid="kpi-total-new-lead">{data.totalNewLeadDeals.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">Stale 7+ Days</p>
                <p className={`text-2xl font-bold ${data.newLeadNoMovement7d > 0 ? "text-amber-600" : "text-green-600"}`} data-testid="kpi-stale-7d">{data.newLeadNoMovement7d.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">No Active Enrollment</p>
                <p className={`text-2xl font-bold ${data.newLeadNoActiveEnrollment > 0 ? "text-red-600" : "text-green-600"}`} data-testid="kpi-no-enrollment">{data.newLeadNoActiveEnrollment.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">Auto-Enroll Suppressed</p>
                <p className={`text-2xl font-bold ${(data.newLeadAutoEnrollmentSuppressed ?? 0) > 0 ? "text-orange-600" : "text-green-600"}`} data-testid="kpi-suppressed">{(data.newLeadAutoEnrollmentSuppressed ?? 0).toLocaleString()}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground mb-3">Enrollment Suppression Breakdown</p>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                    DNC / Do Not Contact
                  </span>
                  <Badge variant="destructive" data-testid="badge-dnc-count">
                    blocked by contactability
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                    Auto-enrollment suppressed
                  </span>
                  <Badge variant={(data.newLeadAutoEnrollmentSuppressed ?? 0) > 0 ? "secondary" : "outline"} className={(data.newLeadAutoEnrollmentSuppressed ?? 0) > 0 ? "text-orange-700 border-orange-300" : ""} data-testid="badge-suppressed-count">
                    {(data.newLeadAutoEnrollmentSuppressed ?? 0).toLocaleString()}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />
                    No active enrollment
                  </span>
                  <Badge variant={data.newLeadNoActiveEnrollment > 0 ? "secondary" : "outline"} data-testid="badge-no-enrollment-count">
                    {data.newLeadNoActiveEnrollment.toLocaleString()}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {data.autoEnrollNewLeadDeals && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-300" data-testid="alert-auto-enroll-live">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <span>Auto-enrollment is <strong>ON</strong>. Eligible New Lead contacts are being enrolled automatically each hourly sweep. Configure in the New Lead Enrollment tab.</span>
            </div>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Worker Last Run</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-muted-foreground">
              <div>
                <p className="font-medium text-foreground">Stage Progression Sweep</p>
                <p>{data.lastStageProgressionSweepAt ? new Date(data.lastStageProgressionSweepAt).toLocaleString() : "Never"}</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Sequence Worker</p>
                <p>{data.lastSequenceWorkerTickAt ? new Date(data.lastSequenceWorkerTickAt).toLocaleString() : "Never"}</p>
              </div>
            </CardContent>
          </Card>

          {data.staleDeals.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  Stale New Lead Deals (up to 25)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left py-1.5 pr-3">Deal ID</th>
                        <th className="text-left py-1.5 pr-3">Contact ID</th>
                        <th className="text-left py-1.5 pr-3">Vertical</th>
                        <th className="text-left py-1.5">Last Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.staleDeals.map(d => (
                        <tr key={d.dealId} className="border-b last:border-0" data-testid={`stale-deal-${d.dealId}`}>
                          <td className="py-1.5 pr-3 font-mono">{d.dealId}</td>
                          <td className="py-1.5 pr-3 font-mono">{d.contactId ?? "—"}</td>
                          <td className="py-1.5 pr-3">{d.vertical ?? "—"}</td>
                          <td className="py-1.5 text-muted-foreground">{d.updatedAt ? new Date(d.updatedAt).toLocaleDateString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {data.breakdownByVertical && data.breakdownByVertical.length > 0 && (
            <Card data-testid="card-vertical-breakdown">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-blue-600" />
                    Enrollment Coverage by Vertical
                    <Badge variant="secondary" className="text-xs">{data.breakdownByVertical.length} verticals</Badge>
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setBreakdownOpen(v => !v)}
                    data-testid="button-toggle-vertical-breakdown"
                    aria-label={breakdownOpen ? "Collapse vertical breakdown" : "Expand vertical breakdown"}
                  >
                    {breakdownOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    {breakdownOpen ? "Collapse" : "Expand"}
                  </Button>
                </div>
                {!breakdownOpen && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {data.breakdownByVertical.filter(r => r.noActiveEnrollment > 0 && r.noSequenceMapped > 0).length} vertical(s) have uncovered deals with no sequence mapping.
                  </p>
                )}
              </CardHeader>
              {breakdownOpen && (
                <CardContent className="pt-0">
                  <div className="overflow-x-auto" data-testid="table-vertical-breakdown">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="text-left py-1.5 pr-2 font-medium w-5" />
                          <th className="text-left py-1.5 pr-2 font-medium">Vertical</th>
                          <th className="text-right py-1.5 pr-2 font-medium">Total</th>
                          <th className="text-right py-1.5 pr-2 font-medium">Enrolled</th>
                          <th className="text-right py-1.5 pr-2 font-medium text-red-600">Uncovered</th>
                          <th className="text-left py-1.5 pr-2 font-medium">Mapped Sequence</th>
                          <th className="text-right py-1.5 pr-2 font-medium">No Mapping</th>
                          <th className="text-right py-1.5 pr-2 font-medium">No Email</th>
                          <th className="text-right py-1.5 pr-2 font-medium">DNC / Opted Out</th>
                          <th className="text-right py-1.5 font-medium">Suppressed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.breakdownByVertical.map((row, i) => {
                          const isGap = row.noActiveEnrollment > 0 && row.noSequenceMapped > 0;
                          const vKey = row.vertical ?? "__unknown__";
                          const isExpanded = expandedVertical === vKey;
                          const hasBlocked = row.noActiveEnrollment > 0;
                          return (
                            <>
                              <tr
                                key={vKey}
                                className={cn(
                                  "border-b",
                                  isGap ? "bg-amber-50 dark:bg-amber-950/20" : "",
                                  hasBlocked ? "cursor-pointer hover:bg-muted/40" : ""
                                )}
                                onClick={hasBlocked ? () => setExpandedVertical(isExpanded ? null : vKey) : undefined}
                                data-testid={`vertical-row-${i}`}
                                aria-expanded={hasBlocked ? isExpanded : undefined}
                              >
                                <td className="py-1.5 pr-1 pl-1 text-muted-foreground">
                                  {hasBlocked && (
                                    isExpanded
                                      ? <ChevronDown className="w-3 h-3" aria-hidden="true" />
                                      : <ChevronRight className="w-3 h-3" aria-hidden="true" />
                                  )}
                                </td>
                                <td className="py-1.5 pr-2 font-medium">
                                  <span className="flex items-center gap-1">
                                    {isGap && <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" aria-label="Gap: uncovered deals with no mapping" />}
                                    <span className={row.vertical ? "" : "italic text-muted-foreground"}>
                                      {row.label}
                                    </span>
                                  </span>
                                </td>
                                <td className="py-1.5 pr-2 text-right">{row.totalDeals}</td>
                                <td className="py-1.5 pr-2 text-right text-green-700 dark:text-green-400">{row.enrolled}</td>
                                <td className={cn("py-1.5 pr-2 text-right font-semibold", row.noActiveEnrollment > 0 ? "text-red-600" : "text-muted-foreground")}>
                                  {row.noActiveEnrollment}
                                </td>
                                <td className="py-1.5 pr-2 max-w-[160px] truncate">
                                  {row.mappedSequenceName ? (
                                    <span className="text-blue-700 dark:text-blue-400" title={row.mappedSequenceName}>
                                      {row.mappedSequenceName}
                                    </span>
                                  ) : (
                                    <span className="italic text-muted-foreground">None</span>
                                  )}
                                </td>
                                <td className={cn("py-1.5 pr-2 text-right", row.noSequenceMapped > 0 ? "text-amber-600 font-semibold" : "text-muted-foreground")}>
                                  {row.noSequenceMapped}
                                </td>
                                <td className="py-1.5 pr-2 text-right text-muted-foreground">{row.noEmail}</td>
                                <td className="py-1.5 pr-2 text-right text-muted-foreground">{row.dncBlocked + row.optedOutBlocked}</td>
                                <td className="py-1.5 text-right text-muted-foreground">{row.suppressed}</td>
                              </tr>
                              {isExpanded && (
                                <tr key={`${vKey}-detail`} data-testid={`vertical-detail-row-${i}`}>
                                  <td colSpan={10} className="p-0">
                                    <VerticalDetailPanel verticalKey={vKey} />
                                  </td>
                                </tr>
                              )}
                            </>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-amber-500" /> Warning</span> = vertical has uncovered deals AND no sequence mapped. Configure mappings in the <button className="underline text-blue-600 hover:text-blue-800" onClick={() => navigate("/dashboard/operator?view=new-lead-enroll")}>New Lead Enrollment</button> tab.
                  </p>
                </CardContent>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── New Lead Enroll Panel ─────────────────────────────────────────────────────

interface NewLeadEnrollStatus {
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  total: number;
  processed: number;
  enrolled: number;
  alreadyEnrolled: number;
  dncBlocked: number;
  optOutBlocked: number;
  contactabilityBlocked: number;
  pewcBlocked: number;
  missingContactMethod: number;
  eligibilityBlocked: number;
  noSequenceBlocked: number;
  inactiveSequenceBlocked: number;
  noContactBlocked: number;
  errors: number;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  error?: string | null;
  jobRunning?: boolean;
}

interface NewLeadEnrollPreview {
  total: number;
  eligible: number;
  alreadyEnrolled: number;
  dncBlocked: number;
  optOutBlocked: number;
  contactabilityBlocked: number;
  pewcBlocked: number;
  missingContactMethod: number;
  eligibilityBlocked: number;
  noSequenceBlocked: number;
  inactiveSequenceBlocked: number;
  noContactBlocked: number;
  sequenceChannelLabel: string;
  requiresTypedConfirmation: boolean;
  defaultSequenceId: number | null;
  verticalMap: Record<string, number>;
}

function NewLeadEnrollPanel() {
  const { toast } = useToast();
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<NewLeadEnrollPreview | null>(null);
  const [verticalMapInput, setVerticalMapInput] = useState("");
  const [defaultSeqId, setDefaultSeqId] = useState("");
  const [showAdvancedJson, setShowAdvancedJson] = useState(false);
  const [localVerticalMap, setLocalVerticalMap] = useState<Record<string, number | null>>({});
  const [rowSaveStates, setRowSaveStates] = useState<Record<string, { status: "idle" | "saving" | "success" | "error"; error?: string }>>({});

  const { data: stageHealth } = useQuery<StageHealthData>({
    queryKey: ["/api/admin/pipeline/stage-health"],
    refetchInterval: 60000,
  });
  const autoEnabled = stageHealth?.autoEnrollNewLeadDeals ?? false;

  const toggleAutoEnroll = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("POST", "/api/admin/pipeline/auto-enroll-toggle", { enabled });
      if (!res.ok) { const b = await res.json(); throw new Error(b.message); }
      return res.json();
    },
    onSuccess: (_, enabled) => {
      toast({ title: enabled ? "Auto-enrollment enabled" : "Auto-enrollment disabled" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pipeline/stage-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pipeline/new-leads/enroll-status"] });
    },
    onError: (err: any) => toast({ title: "Failed to toggle", description: err.message, variant: "destructive" }),
  });

  const { data: status, refetch: refetchStatus } = useQuery<NewLeadEnrollStatus>({
    queryKey: ["/api/admin/pipeline/new-leads/enroll-status"],
    refetchInterval: (data) => (data?.state?.data?.jobRunning ? 2000 : false),
  });

  const { data: sequences } = useQuery<SequenceOption[]>({
    queryKey: ["/api/sequences"],
  });

  const activeSequences = (sequences ?? []).filter(s => s.status === "active");

  useEffect(() => {
    if (stageHealth?.verticalSequenceMap !== undefined) {
      const hasPendingEdits = Object.values(rowSaveStates).some(
        s => s.status === "saving" || s.status === "error"
      );
      if (!hasPendingEdits) {
        const serverMap = stageHealth.verticalSequenceMap ?? {};
        setLocalVerticalMap(serverMap);
        setVerticalMapInput(JSON.stringify(serverMap, null, 2));
      }
    }
    if (stageHealth?.defaultSequenceId !== undefined && !defaultSeqId) {
      setDefaultSeqId(stageHealth.defaultSequenceId ? String(stageHealth.defaultSequenceId) : "");
    }
  }, [stageHealth?.verticalSequenceMap, stageHealth?.defaultSequenceId]);

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/pipeline/new-leads/enroll-preview");
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? "Preview failed");
      return body as NewLeadEnrollPreview;
    },
    onSuccess: (data) => setPreview(data),
    onError: (err: any) => toast({ title: "Preview failed", description: err.message, variant: "destructive" }),
  });

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/pipeline/new-leads/enroll", {
        confirmed: true,
        confirmationText: confirmText || undefined,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? "Enrollment failed");
      return body;
    },
    onSuccess: (data) => {
      toast({ title: "Enrollment job started", description: `Enrolling ${data.eligible ?? ""} deals` });
      setConfirmText("");
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pipeline/new-leads/enroll-status"] });
    },
    onError: (err: any) => toast({ title: "Enrollment failed", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/pipeline/new-leads/enroll-cancel");
      if (!res.ok) { const b = await res.json(); throw new Error(b.message); }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Cancel requested" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pipeline/new-leads/enroll-status"] });
    },
    onError: (err: any) => toast({ title: "Cancel failed", description: err.message, variant: "destructive" }),
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      let verticalMap: Record<string, number> | undefined;
      if (verticalMapInput.trim()) {
        try { verticalMap = JSON.parse(verticalMapInput); }
        catch { throw new Error("Vertical map must be valid JSON. Example: {\"restaurant\": 4, \"dental\": 7}"); }
      }
      const res = await apiRequest("POST", "/api/admin/pipeline/vertical-sequence-map", {
        verticalMap,
        defaultSequenceId: defaultSeqId ? Number(defaultSeqId) : undefined,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? "Save failed");
      return body;
    },
    onSuccess: () => {
      toast({ title: "Settings saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pipeline/new-leads/enroll-status"] });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const isRunning = status?.jobRunning || status?.status === "running";
  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  const needsTypedConfirm = preview?.requiresTypedConfirmation ?? false;
  const canEnroll = !!((!needsTypedConfirm || confirmText === "ENROLL") && !isRunning && (preview?.eligible ?? 0) > 0);

  return (
    <div className="space-y-4" data-testid="panel-new-lead-enroll">
      <div>
        <h3 className="text-lg font-semibold">New Lead Enrollment</h3>
        <p className="text-xs text-muted-foreground">
          Enroll contacts linked to "New Lead" sales deals into a sequence. DNC, opt-out, PEWC, contactability, and eligibility gates enforced. No deals created, no outbound sends triggered directly.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Auto-Enrollment Switch
            {autoEnabled ? (
              <Badge className="ml-auto text-xs bg-green-600 hover:bg-green-600">ON</Badge>
            ) : (
              <Badge variant="secondary" className="ml-auto text-xs">OFF</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            When ON, the SLA worker automatically enrolls eligible New Lead deal contacts into their resolved sequence every hour.
            When OFF, candidates are detected and logged but no enrollments are created.
          </p>
          {autoEnabled && (
            <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <span>Auto-enrollment is live. Eligible New Lead contacts will be enrolled each hourly sweep.</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={autoEnabled}
              onClick={() => toggleAutoEnroll.mutate(!autoEnabled)}
              disabled={toggleAutoEnroll.isPending}
              aria-label="Automatically enroll new leads" data-testid="toggle-auto-enroll"
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                autoEnabled ? "bg-blue-600" : "bg-muted"
              )}
            >
              <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white transition-transform", autoEnabled ? "translate-x-6" : "translate-x-1")} />
            </button>
            <span className="text-sm">{autoEnabled ? "Auto-enroll ON" : "Auto-enroll OFF (candidates logged only)"}</span>
            {toggleAutoEnroll.isPending && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Enrollment Routing Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs font-medium">Default Sequence</p>
            <p className="text-xs text-muted-foreground mb-1">Used when no vertical-specific sequence is mapped.</p>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={defaultSeqId || "none"} onValueChange={v => setDefaultSeqId(v === "none" ? "" : v)}>
                <SelectTrigger data-testid="select-default-sequence" className="max-w-xs">
                  <SelectValue placeholder="None — vertical map required" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {activeSequences.map(s => (
                    <SelectItem key={s.id} value={s.id.toString()} data-testid={`option-seq-${s.id}`}>{s.name} ({s.id})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => saveSettingsMutation.mutate()}
                disabled={saveSettingsMutation.isPending}
                data-testid="button-save-settings"
              >
                {saveSettingsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Settings className="w-4 h-4 mr-2" />}
                Save Default
              </Button>
            </div>
          </div>

          {stageHealth?.breakdownByVertical && stageHealth.breakdownByVertical.length > 0 && (
            <div className="space-y-2" data-testid="vertical-breakdown-prefill">
              <div>
                <p className="text-xs font-medium">Vertical → Sequence Mapping</p>
                <p className="text-xs text-muted-foreground">Select an active sequence per vertical. Rows flagged with ⚠ have uncovered deals. Changes save immediately per row.</p>
              </div>
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-xs" data-testid="table-vertical-mapping-editor">
                  <thead>
                    <tr className="border-b text-muted-foreground bg-muted/40">
                      <th className="text-left py-1.5 px-2 font-medium">Vertical</th>
                      <th className="text-right py-1.5 px-2 font-medium">Uncovered</th>
                      <th className="text-left py-2 px-2 font-medium">Sequence</th>
                      <th className="py-1.5 px-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageHealth.breakdownByVertical.map((row, i) => {
                      const canonicalKey = row.vertical ?? "__unknown__";
                      const isUnknownRow = row.vertical === null;
                      const isGap = row.noActiveEnrollment > 0 && row.noSequenceMapped > 0;
                      const currentSeqId = isUnknownRow ? null : (localVerticalMap[canonicalKey] ?? null);
                      const rowState = isUnknownRow ? { status: "idle" as const } : (rowSaveStates[canonicalKey] ?? { status: "idle" as const });
                      return (
                        <tr
                          key={canonicalKey}
                          className={cn("border-b last:border-0", isGap ? "bg-amber-50 dark:bg-amber-950/20" : "")}
                          data-testid={`mapping-row-${i}`}
                        >
                          <td className="py-1.5 px-2 font-medium whitespace-nowrap">
                            {isGap && <span className="mr-1" aria-label="Gap: no mapping">⚠</span>}
                            <span className={row.vertical ? "" : "italic text-muted-foreground"}>{row.label}</span>
                          </td>
                          <td className={cn("py-1.5 px-2 text-right whitespace-nowrap", row.noActiveEnrollment > 0 ? "text-red-600 font-semibold" : "text-muted-foreground")}>
                            {row.noActiveEnrollment}
                          </td>
                          <td className="py-1.5 px-2 min-w-[180px]">
                            {isUnknownRow ? (
                              <span className="text-xs italic text-muted-foreground">
                                {row.sequenceMappingSource === "default"
                                  ? `${row.mappedSequenceName} · Using default`
                                  : "Set via Default Sequence above"}
                              </span>
                            ) : (
                              <>
                              <Select
                                value={currentSeqId !== null ? String(currentSeqId) : "unmapped"}
                                onValueChange={(v) => {
                                  const newSeqId = v === "unmapped" ? null : Number(v);
                                  const newMap = { ...localVerticalMap };
                                  if (newSeqId === null) {
                                    delete newMap[canonicalKey];
                                  } else {
                                    newMap[canonicalKey] = newSeqId;
                                  }
                                  setLocalVerticalMap(newMap);
                                  setVerticalMapInput(JSON.stringify(newMap, null, 2));
                                }}
                              >
                                <SelectTrigger
                                  className="h-7 text-xs"
                                  data-testid={`select-vertical-seq-${canonicalKey}`}
                                >
                                  <SelectValue placeholder="Unmapped" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="unmapped">
                                    <span className="italic text-muted-foreground">Unmapped</span>
                                  </SelectItem>
                                  {activeSequences.map(s => (
                                    <SelectItem key={s.id} value={s.id.toString()}>
                                      {s.name}
                                      {s.sequenceFamily && (
                                        <span className="text-muted-foreground ml-1 text-xs">· {s.sequenceFamily}</span>
                                      )}
                                      <span className="text-muted-foreground ml-1 text-xs">(#{s.id})</span>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {row.sequenceMappingSource === "default" && (
                                <span className="text-xs italic text-muted-foreground mt-0.5 block">Using default</span>
                              )}
                              </>
                            )}
                          </td>
                          <td className="py-1.5 px-2 whitespace-nowrap">
                            {!isUnknownRow && (
                              <div className="flex items-center gap-1.5">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  data-testid={`btn-save-vertical-${canonicalKey}`}
                                  disabled={rowState.status === "saving"}
                                  onClick={async () => {
                                    setRowSaveStates(prev => ({ ...prev, [canonicalKey]: { status: "saving" } }));
                                    try {
                                      const fullMap: Record<string, number | null> = { ...localVerticalMap };
                                      const res = await apiRequest("POST", "/api/admin/pipeline/vertical-sequence-map", {
                                        verticalMap: fullMap,
                                      });
                                      const body = await res.json();
                                      if (!res.ok) throw new Error(body.message ?? "Save failed");
                                      setRowSaveStates(prev => ({ ...prev, [canonicalKey]: { status: "success" } }));
                                      queryClient.invalidateQueries({ queryKey: ["/api/admin/pipeline/stage-health"] });
                                      queryClient.invalidateQueries({ queryKey: ["/api/admin/pipeline/new-leads/enroll-status"] });
                                      setTimeout(() => {
                                        setRowSaveStates(prev => ({ ...prev, [canonicalKey]: { status: "idle" } }));
                                      }, 2500);
                                    } catch (err: any) {
                                      setRowSaveStates(prev => ({ ...prev, [canonicalKey]: { status: "error", error: err.message } }));
                                    }
                                  }}
                                >
                                  {rowState.status === "saving" ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                                </Button>
                                {rowState.status === "success" && (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" aria-label="Saved" />
                                )}
                                {rowState.status === "error" && (
                                  <span className="text-red-600 text-xs" title={rowState.error}>✗</span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowAdvancedJson(v => !v)}
              data-testid="toggle-advanced-json"
              aria-expanded={showAdvancedJson}
            >
              {showAdvancedJson ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Advanced JSON editor
            </button>
            {showAdvancedJson && (
              <div className="space-y-2 pt-1">
                <p className="text-xs text-muted-foreground">Edit the full vertical → sequence ID map as JSON. Changes here sync to the inline dropdowns. Example: <code>{`{"restaurant": 4, "dental": 7}`}</code></p>
                <Textarea
                  value={verticalMapInput}
                  onChange={e => {
                    setVerticalMapInput(e.target.value);
                    try {
                      const parsed = JSON.parse(e.target.value);
                      if (typeof parsed === "object" && !Array.isArray(parsed)) {
                        setLocalVerticalMap(parsed);
                      }
                    } catch {}
                  }}
                  placeholder={`{"restaurant": 4, "dental": 7}`}
                  data-testid="input-vertical-map"
                  className="font-mono text-xs h-24 max-w-md"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => saveSettingsMutation.mutate()}
                  disabled={saveSettingsMutation.isPending}
                  data-testid="button-save-json-settings"
                >
                  {saveSettingsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Settings className="w-4 h-4 mr-2" />}
                  Save JSON Map
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Manual Enrollment Run</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Run a one-off enrollment sweep of all current New Lead deals. Preview first to review eligibility breakdown.</p>

          {/* Enroll Backlog quick-action — shows the live unenrolled count from stage health */}
          {(stageHealth?.newLeadNoActiveEnrollment ?? 0) > 0 && !isRunning && (
            <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  {stageHealth!.newLeadNoActiveEnrollment.toLocaleString()} unenrolled New Lead contact{stageHealth!.newLeadNoActiveEnrollment !== 1 ? "s" : ""} detected
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                  Preview the backlog to see eligibility details, then enroll. DNC, opt-out, PEWC, and contactability gates enforced. Safe to run multiple times.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 text-xs h-7 border-amber-300 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/50"
                  onClick={() => { setPreview(null); previewMutation.mutate(); }}
                  disabled={previewMutation.isPending || isRunning}
                  data-testid="button-enroll-backlog"
                >
                  {previewMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <Play className="w-3 h-3 mr-1.5" />}
                  Enroll Backlog ({stageHealth!.newLeadNoActiveEnrollment.toLocaleString()} unenrolled)
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPreview(null); previewMutation.mutate(); }}
              disabled={previewMutation.isPending || isRunning}
              data-testid="button-new-lead-enroll-preview"
            >
              {previewMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
              Preview
            </Button>
          </div>
        </CardContent>
      </Card>

      {preview && (
        <Card data-testid="card-new-lead-enroll-preview">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              Preview
              <Badge variant="secondary" className="ml-auto text-xs">{preview.sequenceChannelLabel}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-green-50 dark:bg-green-950/20 rounded p-2">
                <p className="text-muted-foreground">Eligible</p>
                <p className="font-semibold text-base text-green-700 dark:text-green-400">{preview.eligible.toLocaleString()}</p>
              </div>
              <div className="bg-muted/40 rounded p-2">
                <p className="text-muted-foreground">Total Deals</p>
                <p className="font-semibold text-base">{preview.total.toLocaleString()}</p>
              </div>
              <div className="bg-yellow-50 dark:bg-yellow-950/20 rounded p-2">
                <p className="text-muted-foreground">Already Enrolled</p>
                <p className="font-semibold text-base">{preview.alreadyEnrolled.toLocaleString()}</p>
              </div>
              <div className="bg-red-50 dark:bg-red-950/20 rounded p-2">
                <p className="text-muted-foreground">DNC</p>
                <p className="font-semibold text-base">{preview.dncBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">Opt-Out</p>
                <p className="font-semibold text-base">{preview.optOutBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">No Sequence</p>
                <p className="font-semibold text-base">{preview.noSequenceBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">Inactive Seq</p>
                <p className="font-semibold text-base">{preview.inactiveSequenceBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">No Email</p>
                <p className="font-semibold text-base">{preview.missingContactMethod.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">PEWC</p>
                <p className="font-semibold text-base">{preview.pewcBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">Eligibility</p>
                <p className="font-semibold text-base">{preview.eligibilityBlocked.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">No Contact</p>
                <p className="font-semibold text-base">{preview.noContactBlocked.toLocaleString()}</p>
              </div>
            </div>

            {needsTypedConfirm && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  {preview.eligible.toLocaleString()} deals eligible. Type <code>ENROLL</code> to confirm.
                </p>
                <Input
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder="ENROLL"
                  data-testid="input-new-lead-enroll-confirm"
                  className="max-w-xs text-sm"
                />
              </div>
            )}

            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={() => enrollMutation.mutate()}
                disabled={enrollMutation.isPending || !canEnroll}
                data-testid="button-new-lead-enroll-start"
              >
                {enrollMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                {preview.eligible === 0 ? "No Eligible Deals" : `Enroll ${preview.eligible.toLocaleString()} Deals`}
              </Button>
              {isRunning && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => cancelMutation.mutate()}
                  disabled={cancelMutation.isPending}
                  data-testid="button-new-lead-enroll-cancel"
                >
                  {cancelMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <XCircle className="w-4 h-4 mr-2" />}
                  Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {status && status.status !== "idle" && (
        <Card data-testid="card-new-lead-enroll-progress">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              Progress
              {status.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
              {status.status === "complete" && <CheckCircle2 className="w-4 h-4 text-green-600" />}
              {status.status === "cancelled" && <XCircle className="w-4 h-4 text-orange-600" />}
              {status.status === "failed" && <AlertTriangle className="w-4 h-4 text-red-600" />}
              <Badge variant={status.status === "complete" ? "default" : status.status === "failed" ? "destructive" : "secondary"} className="ml-auto text-xs">
                {status.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{status.processed.toLocaleString()} / {status.total.toLocaleString()}</span>
                <span>{pct}%</span>
              </div>
              <Progress value={pct} className="h-2" data-testid="progress-new-lead-enroll" />
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="bg-green-50 dark:bg-green-950/20 rounded p-2">
                <p className="text-muted-foreground">Enrolled</p>
                <p className="font-semibold text-base text-green-700 dark:text-green-400">{status.enrolled.toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-muted/40">
                <p className="text-muted-foreground">Skipped</p>
                <p className="font-semibold text-base">{(status.alreadyEnrolled + status.dncBlocked + status.optOutBlocked + status.contactabilityBlocked + status.pewcBlocked + status.missingContactMethod + status.eligibilityBlocked + status.noSequenceBlocked + status.inactiveSequenceBlocked + status.noContactBlocked).toLocaleString()}</p>
              </div>
              <div className="rounded p-2 bg-red-50 dark:bg-red-950/20">
                <p className="text-muted-foreground">Errors</p>
                <p className="font-semibold text-base">{status.errors.toLocaleString()}</p>
              </div>
            </div>
            {status.error && (
              <p className="text-xs text-red-600 dark:text-red-400" data-testid="text-new-lead-enroll-error">Error: {status.error}</p>
            )}
            {status.completedAt && (
              <p className="text-xs text-muted-foreground">Completed: {new Date(status.completedAt).toLocaleString()}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── SDR Command Center ────────────────────────────────────────────────────────

export function SdrCommandCenter() {
  const { data, isLoading, isError } = useQuery<OperatorSdrStatsResponse>({
    queryKey: ["/api/operator/sdr-stats"],
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="sdr-loading">
        {[1, 2, 3].map(i => (
          <Card key={i}>
            <CardContent className="p-4">
              <div className="h-4 bg-muted animate-pulse rounded w-1/3 mb-2" />
              <div className="h-8 bg-muted animate-pulse rounded w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <Card data-testid="sdr-error">
        <CardContent className="p-6 flex flex-col items-center gap-2 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500" />
          <p className="font-medium">Unable to load SDR stats</p>
          <p className="text-sm text-muted-foreground">Check that you have admin or manager access and the server is running.</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card data-testid="sdr-empty">
        <CardContent className="p-8 text-center text-muted-foreground">No SDR data available</CardContent>
      </Card>
    );
  }

  const sdrSentTodayByChannel = Array.isArray(data.sentTodayByChannel) ? data.sentTodayByChannel : [];
  const sdrActiveSequencesByFamily = Array.isArray(data.activeSequencesByFamily) ? data.activeSequencesByFamily : [];
  const sdrSenderUtilization = Array.isArray(data.senderUtilization) ? data.senderUtilization : [];
  const sdrWarnings = Array.isArray(data.warnings) ? data.warnings : [];
  const totalSentToday = sdrSentTodayByChannel.reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="space-y-4" data-testid="sdr-command-center">
      <div>
        <h3 className="text-lg font-semibold">SDR Command Center</h3>
        <p className="text-xs text-muted-foreground">Updated {new Date(data.generatedAt).toLocaleTimeString()}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Enrolled Leads" value={data.enrolledLeads} icon={Users} color="text-blue-600" />
        <KpiCard label="Sent Today" value={totalSentToday} icon={Send} color="text-purple-600" subtext="all channels" />
        <KpiCard label="Tasks Due" value={data.manualCallsDueToday} icon={Clock} color="text-orange-600" subtext="not calls placed" />
        <KpiCard label="Blocked Steps 24h" value={data.blockedStepsLast24h} icon={Shield} color="text-red-600" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Sequences by Family</CardTitle>
          </CardHeader>
          <CardContent>
            {sdrActiveSequencesByFamily.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active sequences</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="pb-1">Family</th>
                      <th className="pb-1 text-right">Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sdrActiveSequencesByFamily.map(f => (
                      <tr key={f.family} className="border-b last:border-0" data-testid={`sdr-family-${f.family}`}>
                        <td className="py-1.5">{f.family}</td>
                        <td className="py-1.5 text-right"><Badge variant="secondary">{f.count}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Sent Today by Channel</CardTitle>
          </CardHeader>
          <CardContent>
            {sdrSentTodayByChannel.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sends recorded today</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="pb-1">Channel</th>
                      <th className="pb-1 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sdrSentTodayByChannel.map(c => (
                      <tr key={c.channel} className="border-b last:border-0" data-testid={`sdr-channel-${c.channel}`}>
                        <td className="py-1.5 capitalize">{c.channel}</td>
                        <td className="py-1.5 text-right font-medium">{c.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Sender Utilization</CardTitle>
        </CardHeader>
        <CardContent>
          {sdrSenderUtilization.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sending identities configured</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-1">Sender</th>
                    <th className="pb-1 text-right">Sent</th>
                    <th className="pb-1 text-right">Limit</th>
                    <th className="pb-1 w-24">Utilization</th>
                    <th className="pb-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sdrSenderUtilization.map((s, idx) => (
                    <tr key={idx} className="border-b last:border-0" data-testid={`sdr-sender-${idx}`}>
                      <td className="py-1.5">{s.senderName}</td>
                      <td className="py-1.5 text-right">{s.sentToday}</td>
                      <td className="py-1.5 text-right">{s.dailyLimit}</td>
                      <td className="py-1.5">
                        <div className="flex items-center gap-1">
                          <Progress value={s.utilizationPct} className="h-1.5 flex-1" />
                          <span className="text-xs text-muted-foreground w-8">{s.utilizationPct}%</span>
                        </div>
                      </td>
                      <td className="py-1.5">
                        <Badge variant={s.status === "active" ? "default" : "secondary"} className="text-xs">{s.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <KpiCard label="Bounce Rate (30d)" value={data.bounceRate !== null ? data.bounceRate : "N/A"} icon={XCircle} color="text-red-600" suffix={data.bounceRate !== null ? "%" : ""} />
        <KpiCard label="Opt-Out Rate (30d)" value={data.optOutRate !== null ? data.optOutRate : "N/A"} icon={AlertTriangle} color="text-orange-600" suffix={data.optOutRate !== null ? "%" : ""} />
      </div>

      {sdrWarnings.length > 0 && (
        <div className="space-y-1" data-testid="sdr-warnings">
          {sdrWarnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 p-2 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded text-xs text-yellow-800 dark:text-yellow-300">
              <AlertTriangle className="w-3 h-3 text-yellow-600 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <Card data-testid="card-processor-intelligence-operator">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-purple-600" />
            Processor Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ProcessorIntelligence />
        </CardContent>
      </Card>
    </div>
  );
}
