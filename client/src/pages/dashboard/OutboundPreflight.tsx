import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2, RefreshCw,
  Rocket, ShieldCheck, Pause, Play, Zap, BarChart2, TrendingUp, Mail, MessageSquareOff,
} from "lucide-react";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────────

interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "blocked";
  detail: string;
}

interface PreflightReport {
  verdict: "GO" | "NO-GO" | "BLOCKED";
  timestamp: string;
  checks: PreflightCheck[];
  summary: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
    blocked: number;
  };
}

interface CohortLaunchResult {
  launched: boolean;
  cohortSize: number;
  sequenceId: number | null;
  timestamp: string;
  message: string;
}

interface CohortMetrics {
  sendsPerHour: number;
  sends24h: number;
  sends7d: number;
  bounceRate7d: number;
  replyRate7d: number;
  optOutRate7d: number;
  bounces7d: number;
  replies7d: number;
  optouts7d: number;
}

interface ZeroBounceUsage {
  usedToday: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function CheckIcon({ status }: { status: PreflightCheck["status"] }) {
  if (status === "pass") return <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />;
  if (status === "warn") return <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />;
  if (status === "blocked") return <Pause className="h-5 w-5 text-blue-500 shrink-0" />;
  return <XCircle className="h-5 w-5 text-red-500 shrink-0" />;
}

function StatusBadge({ status }: { status: PreflightCheck["status"] }) {
  const styles: Record<PreflightCheck["status"], string> = {
    pass: "bg-green-50 text-green-700 border-green-200",
    warn: "bg-amber-50 text-amber-700 border-amber-200",
    fail: "bg-red-50 text-red-700 border-red-200",
    blocked: "bg-blue-50 text-blue-700 border-blue-200",
  };
  const labels: Record<PreflightCheck["status"], string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
    blocked: "BLOCKED",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

// ── Links from check ID to the relevant settings page ─────────────────────────

const CHECK_LINKS: Record<string, { label: string; href: string }> = {
  ghl_token: { label: "GHL Settings", href: "/dashboard/settings" },
  active_sequences: { label: "Sequences", href: "/dashboard/outbound-center?tab=sequences" },
  global_pause: { label: "Outbound Readiness", href: "/dashboard/outbound-readiness" },
  sending_identity: { label: "Outbound Readiness", href: "/dashboard/outbound-readiness" },
  daily_cap: { label: "Outbound Settings", href: "/dashboard/outbound-readiness" },
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function OutboundPreflight() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [cohortSize, setCohortSize] = useState<string>("100");
  const [confirmed, setConfirmed] = useState(false);
  const [launchResult, setLaunchResult] = useState<CohortLaunchResult | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<PreflightReport>({
    queryKey: ["/api/admin/outbound-preflight"],
    refetchInterval: 60_000,
  });

  const { data: metrics } = useQuery<CohortMetrics>({
    queryKey: ["/api/admin/outbound/cohort-metrics"],
    refetchInterval: 5 * 60_000,
  });

  const { data: zbUsage, isLoading: zbUsageLoading } = useQuery<ZeroBounceUsage>({
    queryKey: ["/api/admin/settings/zerobounce-usage"],
    refetchInterval: 60_000,
  });

  const launchMutation = useMutation({
    mutationFn: async () => {
      const size = Math.max(1, Math.min(500, parseInt(cohortSize, 10) || 100));
      const result = await apiRequest("POST", "/api/admin/outbound/cohort-launch", { cohortSize: size });
      return result.json() as Promise<CohortLaunchResult>;
    },
    onSuccess: (result) => {
      setLaunchResult(result);
      setConfirmed(false);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/outbound-preflight"] });
      toast({
        title: "Cohort launch initiated",
        description: result.message,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Launch failed",
        description: err?.message ?? "Server error — check logs.",
        variant: "destructive",
      });
    },
  });

  const verdict = data?.verdict ?? null;
  const verdictStyle = verdict === "GO"
    ? { bg: "bg-green-50 border-green-200", text: "text-green-700", icon: <Rocket className="h-6 w-6 text-green-600" /> }
    : verdict === "BLOCKED"
      ? { bg: "bg-blue-50 border-blue-200", text: "text-blue-700", icon: <Pause className="h-6 w-6 text-blue-600" /> }
      : { bg: "bg-red-50 border-red-200", text: "text-red-700", icon: <ShieldCheck className="h-6 w-6 text-red-600" /> };

  // Cohort launch is available when: verdict is GO (global pause off + no blockers)
  // or verdict is BLOCKED but only the global_pause check is blocking (user chose to launch now)
  const onlyPauseBlocking = verdict === "BLOCKED" &&
    data?.checks.every(c => c.status === "pass" || c.status === "warn" || c.id === "global_pause") === true;
  const canLaunch = verdict === "GO" || onlyPauseBlocking;

  const parsedSize = Math.max(1, Math.min(500, parseInt(cohortSize, 10) || 100));

  return (
    <>
      <Helmet>
        <title>Outbound Preflight — Liberty Bancard</title>
      </Helmet>

      <div className="p-6 max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <PageTitle className="text-2xl font-bold flex items-center gap-2">
              <Rocket className="h-6 w-6 text-primary" />
              Outbound Preflight
            </PageTitle>
            <p className="text-sm text-muted-foreground mt-1">
              7-point launch gate. All checks must pass before enabling live outbound sends.
              {data && (
                <span className="ml-2 text-xs">
                  Checked at {new Date(data.timestamp).toLocaleTimeString()}
                </span>
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>

        {/* Verdict banner */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Running preflight checks…
          </div>
        ) : isError ? (
          <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            Failed to load preflight report. Check server logs.
          </div>
        ) : verdict && (
          <div className={`flex items-center gap-4 p-5 rounded-lg border ${verdictStyle.bg}`}>
            {verdictStyle.icon}
            <div>
              <p className={`text-xl font-bold ${verdictStyle.text}`}>
                {verdict === "GO" ? "✅ GO — Ready to launch" :
                 verdict === "BLOCKED" ? "⏸ BLOCKED — Outbound paused (safe state)" :
                 "🚫 NO-GO — Issues must be resolved"}
              </p>
              {data?.summary && (
                <p className="text-sm mt-1 text-muted-foreground">
                  {data.summary.pass} pass · {data.summary.warn} warn · {data.summary.fail} fail · {data.summary.blocked} blocked
                </p>
              )}
            </div>
          </div>
        )}

        {/* Check table */}
        {data?.checks && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Launch Gate Checks</CardTitle>
              <CardDescription>
                Each check maps to a platform subsystem. Click the fix link to navigate directly to the relevant settings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {data.checks.map((check) => (
                  <div key={check.id} className="flex items-start gap-3 py-3">
                    <CheckIcon status={check.status} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium">{check.label}</p>
                        <StatusBadge status={check.status} />
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{check.detail}</p>
                      {check.status !== "pass" && CHECK_LINKS[check.id] && (
                        <Link
                          href={CHECK_LINKS[check.id].href}
                          className="text-xs text-primary underline mt-1 inline-block"
                        >
                          → Fix: {CHECK_LINKS[check.id].label}
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Controlled Cohort Launch ── */}
        {canLaunch && !launchResult && (
          <Card className="border-amber-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                Controlled Cohort Launch
              </CardTitle>
              <CardDescription>
                Start outbound with a capped cohort. Maximum 500 contacts per launch cycle.
                The global pause will be removed and the sequence worker will begin processing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="cohort-size" className="text-sm font-medium">
                    Cohort size (max 500)
                  </Label>
                  <Input
                    id="cohort-size"
                    type="number"
                    min={1}
                    max={500}
                    value={cohortSize}
                    onChange={e => {
                      setCohortSize(e.target.value);
                      setConfirmed(false);
                    }}
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Will be capped at {Math.min(parsedSize, 500)} contacts.
                  </p>
                </div>
              </div>

              {/* Kill switch reminder */}
              <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-amber-800">Before you launch</p>
                  <p className="text-amber-700 mt-0.5">
                    Keep the{" "}
                    <Link href="/dashboard/activation" className="underline font-medium">
                      kill switch
                    </Link>{" "}
                    and{" "}
                    <Link href="/dashboard/operator" className="underline font-medium">
                      Send Monitoring
                    </Link>{" "}
                    open in another tab. The global pause can be re-enabled instantly from Go-Live Controls.
                  </p>
                </div>
              </div>

              {/* Confirm checkbox */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={e => setConfirmed(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <span className="text-sm">
                  I confirm I want to enable outbound and launch {parsedSize} contact{parsedSize !== 1 ? "s" : ""} from active sequences.
                </span>
              </label>

              <Button
                onClick={() => launchMutation.mutate()}
                disabled={!confirmed || launchMutation.isPending}
                className="w-full"
              >
                {launchMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Launching…</>
                ) : (
                  <><Play className="h-4 w-4 mr-2" />Launch Cohort ({parsedSize} contacts)</>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Launch success confirmation */}
        {launchResult && (
          <Card className="border-green-200 bg-green-50">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-green-800">Cohort launched successfully</p>
                  <p className="text-sm text-green-700 mt-1">{launchResult.message}</p>
                  <p className="text-xs text-green-600 mt-1">
                    Launched at {new Date(launchResult.timestamp).toLocaleString()} · Cohort size: {launchResult.cohortSize}
                  </p>
                  <div className="flex gap-2 mt-3">
                    <Link href="/dashboard/operator">
                      <Button size="sm" variant="outline" className="text-green-700 border-green-300">
                        → Open Send Monitoring
                      </Button>
                    </Link>
                    <Link href="/dashboard/activation">
                      <Button size="sm" variant="outline" className="text-green-700 border-green-300">
                        → Kill Switch
                      </Button>
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => setLaunchResult(null)}>
                      Launch another cohort
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Live Send Monitoring */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              Live Send Monitoring
            </CardTitle>
            <CardDescription>
              Cohort metrics from the past 7 days. Refreshes every 5 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {metrics ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="rounded-lg border bg-card p-3 text-center">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Sends / hr</p>
                  <p className="text-2xl font-bold mt-1">{metrics.sendsPerHour}</p>
                  <p className="text-xs text-muted-foreground">{metrics.sends24h} in 24h</p>
                </div>
                <div className={`rounded-lg border p-3 text-center ${metrics.bounceRate7d > 5 ? "border-red-200 bg-red-50" : "bg-card"}`}>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center justify-center gap-1">
                    <TrendingUp className="h-3 w-3" /> Bounce Rate
                  </p>
                  <p className={`text-2xl font-bold mt-1 ${metrics.bounceRate7d > 5 ? "text-red-600" : ""}`}>
                    {metrics.bounceRate7d}%
                  </p>
                  <p className="text-xs text-muted-foreground">{metrics.bounces7d} bounces / 7d</p>
                </div>
                <div className="rounded-lg border bg-card p-3 text-center">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center justify-center gap-1">
                    <Mail className="h-3 w-3" /> Reply Rate
                  </p>
                  <p className="text-2xl font-bold mt-1">{metrics.replyRate7d}%</p>
                  <p className="text-xs text-muted-foreground">{metrics.replies7d} replies / 7d</p>
                </div>
                <div className={`rounded-lg border p-3 text-center ${metrics.optOutRate7d > 1 ? "border-amber-200 bg-amber-50" : "bg-card"}`}>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center justify-center gap-1">
                    <MessageSquareOff className="h-3 w-3" /> Opt-Out Rate
                  </p>
                  <p className={`text-2xl font-bold mt-1 ${metrics.optOutRate7d > 1 ? "text-amber-700" : ""}`}>
                    {metrics.optOutRate7d}%
                  </p>
                  <p className="text-xs text-muted-foreground">{metrics.optouts7d} opt-outs / 7d</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading metrics…
              </div>
            )}
            {metrics && metrics.sends7d === 0 && (
              <p className="text-xs text-muted-foreground text-center mt-3">
                No outbound sends recorded in the past 7 days. Metrics will populate once sends are active.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── ZeroBounce Usage ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-violet-600" />
              ZeroBounce Usage
            </CardTitle>
            <CardDescription>
              Daily email validation usage reported by the application.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {zbUsageLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : zbUsage ? (
              <div className="rounded-md border px-4 py-3">
                <span className="text-2xl font-bold font-mono">{zbUsage.usedToday.toLocaleString()}</span>
                <p className="text-xs text-muted-foreground mt-1">validation attempts today (UTC)</p>
                <p className="text-xs text-muted-foreground mt-2">Reported usage only; no application-local daily ceiling is applied.</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Usage data unavailable.</p>
            )}
          </CardContent>
        </Card>

        {/* Explainer */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">How to use this page</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-1.5">
            <p>
              <span className="font-medium text-green-600">PASS</span> — Check is satisfied. No action needed.
            </p>
            <p>
              <span className="font-medium text-amber-600">WARN</span> — Not required to launch, but recommended (e.g. daily cap).
            </p>
            <p>
              <span className="font-medium text-red-600">FAIL</span> — Blocking issue. Outbound sends will not work until resolved.
            </p>
            <p>
              <span className="font-medium text-blue-600">BLOCKED</span> — Global outbound pause is active (normal safe state before launch).
              Use the Controlled Cohort Launch above to enable outbound, or toggle manually on the{" "}
              <Link href="/dashboard/outbound-readiness" className="underline text-primary">Outbound Readiness</Link> page.
            </p>
            <p className="pt-1">
              This page auto-refreshes every 60 seconds. Run the pre-deploy gate for a full 27-suite compliance check before enabling live traffic.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
