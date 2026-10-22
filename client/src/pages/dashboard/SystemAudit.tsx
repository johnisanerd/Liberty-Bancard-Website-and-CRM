import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  RefreshCw, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle,
  XCircle, Clock, Activity, Send, Calendar, BarChart3,
} from "lucide-react";

interface ProbeResult {
  subsystem: string;
  status: "ok" | "warn" | "error";
  summary: string;
  details: Record<string, unknown>;
}

interface AuditRun {
  id: number;
  triggered_by: string;
  ran_at: string;
  overall_score: number | null;
  probe_results: ProbeResult[] | null;
  claude_narrative: string | null;
  slack_status: string;
  created_at: string;
}

function StatusIcon({ status }: { status: ProbeResult["status"] | "ok" | "warn" | "error" | "running" | "failed" }) {
  if (status === "ok") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "warn") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  if (status === "error" || status === "failed") return <XCircle className="h-4 w-4 text-red-500" />;
  return <Clock className="h-4 w-4 text-blue-500 animate-spin" />;
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    ok: "bg-green-100 text-green-800 border-green-200",
    completed: "bg-green-100 text-green-800 border-green-200",
    warn: "bg-amber-100 text-amber-800 border-amber-200",
    error: "bg-red-100 text-red-800 border-red-200",
    failed: "bg-red-100 text-red-800 border-red-200",
    running: "bg-blue-100 text-blue-800 border-blue-200",
    skipped: "bg-gray-100 text-gray-700 border-gray-200",
    sent: "bg-green-100 text-green-800 border-green-200",
    not_configured: "bg-gray-100 text-gray-700 border-gray-200",
  };
  const cls = variants[status] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function overallStatus(probes: ProbeResult[]): "ok" | "warn" | "error" {
  if (probes.some(p => p.status === "error")) return "error";
  if (probes.some(p => p.status === "warn")) return "warn";
  return "ok";
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  const color = score >= 90 ? "text-green-600" : score >= 60 ? "text-amber-600" : "text-red-600";
  return (
    <span className={`font-bold text-lg ${color}`} data-testid="overall-score">
      {score}%
    </span>
  );
}

/** Maps each subsystem name to the dashboard page where an admin can investigate or fix it. */
const SUBSYSTEM_FIX_URL: Record<string, string> = {
  "database":               "/dashboard/admin",
  "ghl-auth":               "/dashboard/settings",
  "ghl-sync":               "/dashboard/settings",
  "queues":                 "/dashboard/queues",
  "sequences":              "/dashboard/sequences",
  "enrichment":             "/dashboard/admin",
  "inbox-health":           "/dashboard/inbox",
  "ai-ops":                 "/dashboard/ai-command-center",
  "ghl-fields":             "/dashboard/settings",
  "compliance-engine":      "/dashboard/admin",
  "sdr-pipeline":           "/dashboard/sdr-command",
  "contactability":         "/dashboard/admin",
  "onboarding-pipeline":    "/dashboard/pipeline-board",
  "mid-ingestion":          "/dashboard/admin",
  "role-guards":            "/dashboard/admin/users",
  "ai-advisor":             "/dashboard/chat",
  "ghl-workflow-registry":  "/dashboard/settings",
  "anomaly-detection":      "/dashboard/admin",
  "public-form-endpoints":  "/dashboard/admin",
};

function ProbeCard({ probe }: { probe: ProbeResult }) {
  const [open, setOpen] = useState(false);
  const fixUrl = SUBSYSTEM_FIX_URL[probe.subsystem];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          data-testid={`probe-row-${probe.subsystem}`}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors rounded-md text-left"
        >
          <StatusIcon status={probe.status} />
          <span className="font-medium text-sm capitalize flex-1">{probe.subsystem.replace(/-/g, " ")}</span>
          {probe.status !== "ok" && fixUrl && (
            <a
              href={fixUrl}
              data-testid={`probe-fix-link-${probe.subsystem}`}
              className="text-xs text-primary underline-offset-2 hover:underline mr-2 shrink-0"
              onClick={e => e.stopPropagation()}
            >
              Quick Fix →
            </a>
          )}
          <StatusBadge status={probe.status} />
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4 space-y-3">
          <p className="text-sm text-muted-foreground">{probe.summary}</p>
          <pre
            data-testid={`probe-details-${probe.subsystem}`}
            className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-48 font-mono"
          >
            {JSON.stringify(probe.details, null, 2)}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AuditRunCard({ run, expanded }: { run: AuditRun; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded ?? false);
  const probes = run.probe_results ?? [];
  const overall = probes.length > 0 ? overallStatus(probes) : "ok";

  const ranAt = new Date(run.ran_at).toLocaleString("en-US", {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });

  const passCount = probes.filter(p => p.status === "ok").length;

  return (
    <Card data-testid={`audit-run-${run.id}`} className="mb-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer select-none pb-3">
            <div className="flex items-center gap-3">
              <StatusIcon status={overall} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-sm">Run #{run.id}</CardTitle>
                  <StatusBadge status={overall} />
                  <Badge variant="outline" className="text-xs capitalize">
                    {run.triggered_by}
                  </Badge>
                  {run.overall_score !== null && (
                    <Badge variant="outline" className="text-xs font-semibold">
                      {run.overall_score}% passing
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs mt-0.5">
                  {ranAt}
                  {probes.length > 0 && ` · ${passCount}/${probes.length} probes passing`}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {run.slack_status === "sent" && (
                  <Send className="h-3.5 w-3.5 text-green-500" />
                )}
                {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            {run.claude_narrative && (
              <div className="p-4 bg-muted/50 rounded-md">
                <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">AI Narrative</p>
                <p data-testid={`narrative-${run.id}`} className="text-sm leading-relaxed whitespace-pre-wrap">{run.claude_narrative}</p>
              </div>
            )}

            {probes.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                  Subsystem Probes ({passCount}/{probes.length} passing)
                </p>
                <div className="border rounded-md divide-y">
                  {probes.map(probe => (
                    <ProbeCard key={probe.subsystem} probe={probe} />
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span>Slack: <StatusBadge status={run.slack_status} /></span>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export default function SystemAuditPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: runs = [], isLoading } = useQuery<AuditRun[]>({
    queryKey: ["/api/system-audit/runs"],
  });

  const { data: latest } = useQuery<AuditRun | null>({
    queryKey: ["/api/system-audit/latest"],
  });

  const runNow = useMutation({
    mutationFn: () => apiRequest("POST", "/api/system-audit/run-now"),
    onSuccess: () => {
      toast({ title: "Audit started", description: "Results will appear within 90 seconds." });
      [5000, 30000, 60000, 90000].forEach(delay => {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/system-audit/runs"] });
          queryClient.invalidateQueries({ queryKey: ["/api/system-audit/latest"] });
        }, delay);
      });
    },
    onError: (err: any) => {
      toast({ title: "Failed to start audit", description: err.message, variant: "destructive" });
    },
  });

  const latestProbes = latest?.probe_results ?? [];
  const latestOverall = latestProbes.length > 0 ? overallStatus(latestProbes) : null;
  const latestPassPct = latest?.overall_score ?? (
    latestProbes.length > 0
      ? Math.round((latestProbes.filter(p => p.status === "ok").length / latestProbes.length) * 100)
      : null
  );

  return (
    <>
      <Helmet>
        <title>System Audit — Liberty Bancard</title>
        <meta name="description" content="Weekly AI-powered system health audit covering all major subsystems." />
      </Helmet>

      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <PageTitle className="text-2xl font-bold flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" />
              Weekly AI System Audit
            </PageTitle>
            <p className="text-muted-foreground text-sm mt-1">
              Automated health check across all 18 major subsystems. Scheduled Monday 8 AM UTC — delivers Slack summary with AI narrative.
            </p>
          </div>
          <Button
            data-testid="button-run-audit-now"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            className="shrink-0"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${runNow.isPending ? "animate-spin" : ""}`} />
            Run Now
          </Button>
        </div>

        {/* Summary cards */}
        {latest && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Health Score</p>
                <div className="flex items-center gap-1.5">
                  {latestOverall && <StatusIcon status={latestOverall} />}
                  <ScoreBadge score={latestPassPct} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Last Audit</p>
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  {new Date(latest.ran_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Probes</p>
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  {latestProbes.filter(p => p.status === "ok").length}/{latestProbes.length} OK
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Slack</p>
                <StatusBadge status={latest.slack_status} />
              </CardContent>
            </Card>
          </div>
        )}

        {/* Latest run */}
        {latest && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Latest Run</p>
            <AuditRunCard run={latest} expanded />
          </div>
        )}

        {/* Run history */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Run History</p>
            <Button
              variant="ghost"
              size="sm"
              data-testid="button-refresh-audit-runs"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/system-audit/runs"] });
                queryClient.invalidateQueries({ queryKey: ["/api/system-audit/latest"] });
              }}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Refresh
            </Button>
          </div>

          {isLoading && (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-16 bg-muted/50 rounded-md animate-pulse" />
              ))}
            </div>
          )}

          {!isLoading && runs.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <Activity className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">No audit runs yet.</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Click <strong>Run Now</strong> to trigger the first audit, or wait for the Monday 8 AM schedule.
                </p>
              </CardContent>
            </Card>
          )}

          {!isLoading && runs.map((run) => {
            if (latest && run.id === latest.id) return null;
            return <AuditRunCard key={run.id} run={run} />;
          })}
        </div>
      </div>
    </>
  );
}
