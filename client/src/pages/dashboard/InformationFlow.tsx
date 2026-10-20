import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CheckCircle2, AlertTriangle, XCircle, RefreshCw, ArrowRight,
  Activity, Database, Globe, Mail, MessageSquare, Shield,
  GitMerge, Webhook, BarChart3, Wifi,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StageMetric {
  id: string;
  label: string;
  description: string;
  count: number;
  countLabel: string;
  lastEventAt: string | null;
  health: "ok" | "warn" | "error";
  metrics: Record<string, unknown>;
  warnings: string[];
  bySource?: { source: string; count: number }[];
}

interface SystemState {
  outboundGlobalPaused: boolean;
  outboundGlobalPausedReason: string | null;
  smsA2pStatus: string;
  emailOnlyMode: boolean;
  ghlConfigured: boolean;
  ghlSyncHealth: "ok" | "warn" | "error";
  circuitBreakerState: string;
  overallHealth: "ok" | "warn" | "error";
}

interface FlowData {
  generatedAt: string;
  systemState: SystemState;
  stages: StageMetric[];
  leadSourceFields: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function HealthIcon({ health }: { health: "ok" | "warn" | "error" }) {
  if (health === "ok") return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />;
  if (health === "warn") return <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />;
  return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
}

function HealthBadge({ health }: { health: "ok" | "warn" | "error" }) {
  if (health === "ok") return <Badge className="bg-green-100 text-green-800 border border-green-200 text-xs">OK</Badge>;
  if (health === "warn") return <Badge className="bg-yellow-100 text-yellow-800 border border-yellow-200 text-xs">WARN</Badge>;
  return <Badge className="bg-red-100 text-red-800 border border-red-200 text-xs">ERROR</Badge>;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const STAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  lead_source: Globe,
  crm_contact: Database,
  ghl_sync: GitMerge,
  sequence_enrollment: Activity,
  send_gate: Shield,
  ghl_transport: Mail,
  ghl_reply: Webhook,
  crm_audit: BarChart3,
};

// ─── Stage Card ───────────────────────────────────────────────────────────────

function StageCard({ stage, isLast }: { stage: StageMetric; isLast: boolean }) {
  const Icon = STAGE_ICONS[stage.id] ?? Activity;
  const m = stage.metrics as Record<string, number | string | Record<string, number>>;

  return (
    <div className="flex flex-col md:flex-row items-stretch gap-0">
      <Card
        className={`flex-1 border-2 transition-colors ${
          stage.health === "ok"
            ? "border-green-200 dark:border-green-900"
            : stage.health === "warn"
            ? "border-yellow-200 dark:border-yellow-900"
            : "border-red-200 dark:border-red-900"
        }`}
      >
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
              <CardTitle className="text-sm truncate">{stage.label}</CardTitle>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <HealthIcon health={stage.health} />
              <HealthBadge health={stage.health} />
            </div>
          </div>
          <CardDescription className="text-xs">{stage.description}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-3 pt-0">
          {/* Count + last event */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold">{stage.count.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">{stage.countLabel}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Last event</p>
              <p className="text-sm font-medium">{fmtTime(stage.lastEventAt)}</p>
            </div>
          </div>

          {/* Stage-specific metrics */}
          {stage.id === "lead_source" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">UTM captured</span>
                <span className="font-medium">{(m.withUtm as number)?.toLocaleString()} ({String(m.utmCaptureRate)}%)</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Google Ads (gclid)</span>
                <span className="font-medium">{(m.withGclid as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Landing page captured</span>
                <span className="font-medium">{(m.withLandingPage as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Recent imports (7d)</span>
                <span className="font-medium">{m.recentImports as number}</span>
              </div>
              {stage.bySource && stage.bySource.length > 0 && (
                <div className="mt-2 pt-2 border-t space-y-1">
                  {stage.bySource.slice(0, 5).map(s => (
                    <div key={s.source} className="flex justify-between text-xs">
                      <span className="text-muted-foreground truncate max-w-[120px]">{s.source}</span>
                      <span className="font-medium">{s.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {stage.id === "crm_contact" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Total contacts</span>
                <span className="font-medium">{(m.totalContacts as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">New this week</span>
                <span className="font-medium">{(m.newLast7d as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">New this month</span>
                <span className="font-medium">{(m.newLast30d as number)?.toLocaleString()}</span>
              </div>
            </div>
          )}

          {stage.id === "ghl_sync" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Synced to GHL</span>
                <span className="font-medium">{(m.syncedToGhl as number)?.toLocaleString()} ({String(m.syncRate)}%)</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Pending sync</span>
                <span className={`font-medium ${(m.unsyncedToGhl as number) > 50 ? "text-yellow-600" : ""}`}>
                  {(m.unsyncedToGhl as number)?.toLocaleString()}
                </span>
              </div>
            </div>
          )}

          {stage.id === "sequence_enrollment" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Active enrollments</span>
                <span className="font-medium text-green-600">{(m.active as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Paused</span>
                <span className="font-medium text-yellow-600">{(m.paused as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Completed (30d)</span>
                <span className="font-medium">{(m.completed as number)?.toLocaleString()}</span>
              </div>
            </div>
          )}

          {stage.id === "send_gate" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Contactability blocks</span>
                <span className="font-medium">{((m.byReason as Record<string, number>)?.["sequence_step_blocked_contactability"] || 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Bad email blocks</span>
                <span className="font-medium">{((m.byReason as Record<string, number>)?.["sequence_enrollment_skipped_bad_email"] || 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Daily cap deferrals</span>
                <span className="font-medium">{((m.byReason as Record<string, number>)?.["sequence_step_deferred_daily_cap"] || 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Global pause blocks</span>
                <span className="font-medium">{((m.byReason as Record<string, number>)?.["sequence_step_skipped_global_pause"] || 0).toLocaleString()}</span>
              </div>
            </div>
          )}

          {stage.id === "ghl_transport" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Emails sent (30d)</span>
                <span className="font-medium">{(m.emailsSent as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">SMS sent (30d)</span>
                <span className="font-medium">{(m.smsSent as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Last email</span>
                <span className="font-medium">{fmtTime(m.lastEmailAt as string | null)}</span>
              </div>
            </div>
          )}

          {stage.id === "ghl_reply" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Inbound replies (30d)</span>
                <span className="font-medium text-green-600">{(m.replies as number)?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Bounces (30d)</span>
                <span className={`font-medium ${(m.bounces as number) > 5 ? "text-red-600" : ""}`}>
                  {(m.bounces as number)?.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Unsubscribes (30d)</span>
                <span className="font-medium">{(m.unsubscribes as number)?.toLocaleString()}</span>
              </div>
            </div>
          )}

          {stage.id === "crm_audit" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Audit events (30d)</span>
                <span className="font-medium">{(m.auditEvents30d as number)?.toLocaleString()}</span>
              </div>
            </div>
          )}

          {/* Warnings */}
          {stage.warnings.length > 0 && (
            <div className="space-y-1">
              {stage.warnings.map((w, i) => (
                <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400 flex items-start gap-1">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  {w}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connector arrow */}
      {!isLast && (
        <div className="hidden md:flex items-center px-1 text-muted-foreground/40">
          <ArrowRight className="w-5 h-5" />
        </div>
      )}
    </div>
  );
}

// ─── System State Bar ─────────────────────────────────────────────────────────

function SystemStateBar({ state }: { state: SystemState }) {
  const items = [
    {
      label: "Global Outbound",
      value: state.outboundGlobalPaused ? "PAUSED" : "Running",
      health: state.outboundGlobalPaused ? "warn" : "ok",
      icon: Activity,
    },
    {
      label: "SMS Channel",
      value: state.smsA2pStatus === "registered" ? "A2P Registered" : state.smsA2pStatus || "Not configured",
      health: state.smsA2pStatus === "registered" ? "ok" : "warn",
      icon: MessageSquare,
    },
    {
      label: "Email Mode",
      value: state.emailOnlyMode ? "Email Only" : "Multi-channel",
      health: state.emailOnlyMode ? "warn" : "ok",
      icon: Mail,
    },
    {
      label: "GHL Integration",
      value: state.ghlConfigured ? "Connected" : "Not configured",
      health: state.ghlConfigured ? (state.ghlSyncHealth === "ok" ? "ok" : "warn") : "error",
      icon: Wifi,
    },
    {
      label: "Circuit Breaker",
      value: state.circuitBreakerState === "open" ? "OPEN (GHL failing)" : state.circuitBreakerState === "half_open" ? "Half-open" : "Closed",
      health: state.circuitBreakerState === "open" ? "error" : state.circuitBreakerState === "half_open" ? "warn" : "ok",
      icon: Shield,
    },
  ] as const;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {items.map(item => {
        const Icon = item.icon;
        return (
          <Card key={item.label} className={`border ${
            item.health === "ok" ? "border-green-200 dark:border-green-900" :
            item.health === "warn" ? "border-yellow-200 dark:border-yellow-900" :
            "border-red-200 dark:border-red-900"
          }`}>
            <CardContent className="p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Icon className="w-3 h-3 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">{item.label}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <HealthIcon health={item.health as "ok" | "warn" | "error"} />
                <p className="text-xs font-semibold">{item.value}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Lead Source Fields ───────────────────────────────────────────────────────

function LeadSourceFieldsCard({ fields }: { fields: Record<string, unknown> }) {
  const fieldList = [
    { key: "hasLeadSource", label: "lead_source" },
    { key: "hasUtmSource", label: "utm_source" },
    { key: "hasUtmMedium", label: "utm_medium" },
    { key: "hasUtmCampaign", label: "utm_campaign" },
    { key: "hasUtmContent", label: "utm_content" },
    { key: "hasUtmTerm", label: "utm_term" },
    { key: "hasGclid", label: "gclid" },
    { key: "hasLandingPage", label: "landing_page" },
    { key: "hasImportBatchId", label: "import_batch_id" },
    { key: "hasSourceCategory", label: "source_category" },
  ];

  const sources = (fields.supportedSources as string[]) ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Lead Source Tracking Fields</CardTitle>
        <CardDescription className="text-xs">
          All fields confirmed present on the contacts schema and preserved through the import pipeline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {fieldList.map(f => (
            <div
              key={f.key}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-mono border ${
                fields[f.key]
                  ? "bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-300"
                  : "bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-300"
              }`}
            >
              {fields[f.key] ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
              {f.label}
            </div>
          ))}
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-2">Supported source values</p>
          <div className="flex flex-wrap gap-1.5">
            {sources.map(s => (
              <Badge key={s} variant="outline" className="text-xs font-mono">{s}</Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InformationFlowPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, dataUpdatedAt } = useQuery<FlowData>({
    queryKey: ["/api/information-flow"],
    refetchInterval: 60_000, // auto-refresh every 60s
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/information-flow"] });
  };

  return (
    <>
      <Helmet>
        <title>Information Flow — Liberty Bancard Admin</title>
        <meta name="robots" content="noindex" />
      </Helmet>

      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" />
              Information Flow
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              Live view of how data moves through the system — from lead capture to CRM to GHL to audit.
              {dataUpdatedAt ? ` Updated ${fmtTime(new Date(dataUpdatedAt).toISOString())}` : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {isError && (
          <Alert variant="destructive">
            <AlertDescription>Failed to load information flow data. Try refreshing.</AlertDescription>
          </Alert>
        )}

        {isLoading && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {[...Array(5)].map((_, i) => <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />)}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {[...Array(8)].map((_, i) => <div key={i} className="h-52 bg-muted rounded-lg animate-pulse" />)}
            </div>
          </div>
        )}

        {data && (
          <>
            {/* System State Bar */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Current System State</p>
              <SystemStateBar state={data.systemState} />
            </div>

            {/* Global pause banner */}
            {data.systemState.outboundGlobalPaused && (
              <Alert className="border-yellow-300 bg-yellow-50 dark:bg-yellow-950">
                <AlertTriangle className="h-4 w-4 text-yellow-600" />
                <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                  <strong>Global outbound is paused.</strong>{" "}
                  {data.systemState.outboundGlobalPausedReason || "No reason recorded."}
                  {" "}Sequences are queued but not sending.
                </AlertDescription>
              </Alert>
            )}

            {/* Pipeline stages */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Pipeline Stages</p>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                {data.stages.map((stage, idx) => (
                  <StageCard
                    key={stage.id}
                    stage={stage}
                    isLast={idx === data.stages.length - 1}
                  />
                ))}
              </div>
            </div>

            {/* Lead Source Fields */}
            <LeadSourceFieldsCard fields={data.leadSourceFields} />
          </>
        )}
      </div>
    </>
  );
}
