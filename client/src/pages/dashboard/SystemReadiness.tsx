import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { apiRequest } from "@/lib/queryClient";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Zap,
  Mail,
  Brain,
  Database,
  Bot,
  Send,
  Server,
  ShieldAlert,
  FlaskConical,
  ClipboardList,
  Activity,
  Clock,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";

interface ReadinessData {
  ghl: {
    status: "ok" | "expired" | "unconfigured";
    configured: boolean;
    locationName?: string;
    workflowIdsConfigured: number;
    workflowIdsTotal: number;
    workflowReadiness?: {
      supportedTotal: number; supportedConfigured: number; referenceOnlyTotal: number; referenceOnlyConfigured: number;
      missingSupported: Array<{ id: string; effect: string }>; needsAttention: boolean;
    };
  };
  smtp: {
    configured: boolean;
    host: string | null;
    port: number;
    user: string | null;
    from: string | null;
  };
  openai: { configured: boolean };
  redis: { real: boolean; url: string };
  sdr: {
    sdrEnabled: boolean;
    orchestratorEnabled: boolean;
    legacyOutreachEnabled: boolean;
    voiceAiEnabled: boolean;
    smsEnabled: boolean;
    nightlyDiscoveryEnabled: boolean;
  };
  sendingIdentities: { activeCount: number };
  env: Record<string, boolean>;
  actions: string[];
  overallHealthy: boolean;
  criticalIssues: number;
}

interface TestEmailResult {
  sequenceId: number;
  sequenceName: string;
  stepOrder: number;
  stepType: string;
  subject: string;
  status: "sent" | "failed" | "skipped";
  detail: string;
  route: string;
  sentAt: string | null;
}

interface TestEmailsResponse {
  ok: boolean;
  testRecipient: string;
  route: string;
  outboundGlobalPaused: boolean;
  activeSequences: number;
  summary: { total: number; sent: number; failed: number; skipped: number };
  results: TestEmailResult[];
}

interface GoNoGoGate {
  gate: string;
  status: "go" | "no_go" | "blocked" | "warning";
  notes: string;
}

interface GoNoGoReport {
  generatedAt: string;
  lastFlowAuditAt: string | null;
  lastInternalTestEmailsAt: string | null;
  lastTestSummary: Record<string, unknown> | null;
  outboundGlobalPaused: boolean;
  activeSequences: number;
  gates: GoNoGoGate[];
  overallGo: boolean;
}

interface FlowStageResult {
  stage: string;
  description: string;
  severity: "blocker" | "warning" | "informational";
  found: boolean;
  lastSeenAt: string | null;
  note: string;
}

interface FlowAuditResponse {
  ok: boolean;
  ranAt: string;
  blockers: number;
  warnings: number;
  pipelineStages: FlowStageResult[];
  additionalChecks: Array<{
    check: string;
    ok: boolean;
    severity: "blocker" | "warning" | "informational";
    note: string;
  }>;
}

function StatusIcon({ ok, warn }: { ok: boolean; warn?: boolean }) {
  if (ok) return <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />;
  if (warn) return <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0" />;
  return <XCircle className="w-5 h-5 text-red-500 shrink-0" />;
}

function StatusBadge({ status }: { status: "ok" | "warning" | "error" }) {
  if (status === "ok") return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">Connected</Badge>;
  if (status === "warning") return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">Warning</Badge>;
  return <Badge variant="destructive">Not Configured</Badge>;
}

function FlagRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {enabled
        ? <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-xs">Enabled</Badge>
        : <Badge variant="outline" className="text-xs text-muted-foreground">Disabled</Badge>}
    </div>
  );
}

function EnvRow({ label, present }: { label: string; present: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <StatusIcon ok={present} />
      <span className="text-sm font-mono">{label}</span>
      {!present && <span className="text-xs text-muted-foreground ml-auto">Not set</span>}
    </div>
  );
}

function GoNoGoBadge({ status }: { status: "go" | "no_go" | "blocked" | "warning" }) {
  if (status === "go")
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 font-mono text-xs">✅ GO</Badge>;
  if (status === "blocked")
    return <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 font-mono text-xs">🚫 BLOCKED</Badge>;
  if (status === "warning")
    return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 font-mono text-xs">⚠️ REVIEW</Badge>;
  return <Badge variant="destructive" className="font-mono text-xs">❌ NO-GO</Badge>;
}

function SeverityBadge({ severity }: { severity: "blocker" | "warning" | "informational" }) {
  if (severity === "blocker")
    return <Badge variant="destructive" className="text-xs shrink-0">Blocker</Badge>;
  if (severity === "warning")
    return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 text-xs shrink-0">Warning</Badge>;
  return <Badge variant="outline" className="text-xs shrink-0 text-muted-foreground">Info</Badge>;
}

function TestResultRow({ r }: { r: TestEmailResult }) {
  return (
    <div className={`flex items-start gap-3 rounded-md px-3 py-2 text-sm ${
      r.status === "sent" ? "bg-green-50 dark:bg-green-950/20"
        : r.status === "failed" ? "bg-red-50 dark:bg-red-950/20"
        : "bg-muted/40"
    }`}>
      {r.status === "sent"
        ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
        : r.status === "failed"
        ? <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
        : <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium truncate">{r.sequenceName} — Step {r.stepOrder}</p>
        <p className="text-xs text-muted-foreground truncate">{r.subject}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{r.detail}</p>
      </div>
      <div className="text-right shrink-0">
        <Badge variant="outline" className="text-xs">{r.route}</Badge>
      </div>
    </div>
  );
}

export default function SystemReadiness() {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery<ReadinessData>({
    queryKey: ["/api/admin/system-readiness"],
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const { data: goNoGo, refetch: refetchGoNoGo } = useQuery<GoNoGoReport>({
    queryKey: ["/api/wizard/gonogo-report"],
    staleTime: 60_000,
  });

  const [testEmailsResult, setTestEmailsResult] = useState<TestEmailsResponse | null>(null);
  const [showAllResults, setShowAllResults] = useState(false);
  const [flowAuditResult, setFlowAuditResult] = useState<FlowAuditResponse | null>(null);

  const testEmailsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/wizard/test-sequence-emails", {});
      return res.json() as Promise<TestEmailsResponse>;
    },
    onSuccess: (data) => {
      setTestEmailsResult(data);
      refetchGoNoGo();
    },
  });

  const flowAuditMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/wizard/flow-audit", {});
      return res.json() as Promise<FlowAuditResponse>;
    },
    onSuccess: (data) => {
      setFlowAuditResult(data);
      refetchGoNoGo();
    },
  });

  const ghlStatus = data?.ghl.status === "ok" ? "ok" : data?.ghl.status === "expired" ? "warning" : "error";
  const smtpStatus = data?.smtp.configured ? "ok" : data?.smtp.host ? "warning" : "error";

  const displayedResults = showAllResults ? (testEmailsResult?.results ?? []) : (testEmailsResult?.results ?? []).slice(0, 5);

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="System Readiness"
        subtitle="Full health check of all integrations and pipeline dependencies. Resolving all action items ensures every pipeline runs smoothly once configured."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-readiness">
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="h-32" />
            </Card>
          ))}
        </div>
      ) : data ? (
        <>
          {/* Overall Banner */}
          <div
            data-testid="banner-overall-health"
            className={`flex items-center gap-4 rounded-lg border px-5 py-4 ${
              data.overallHealthy
                ? "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800"
                : data.criticalIssues > 0
                ? "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800"
                : "bg-yellow-50 border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800"
            }`}
          >
            {data.overallHealthy ? (
              <CheckCircle2 className="w-7 h-7 text-green-600 shrink-0" />
            ) : data.criticalIssues > 0 ? (
              <XCircle className="w-7 h-7 text-red-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-7 h-7 text-yellow-600 shrink-0" />
            )}
            <div>
              <p className="font-semibold text-sm">
                {data.overallHealthy
                  ? "All systems go — every pipeline is configured and ready."
                  : data.criticalIssues > 0
                  ? `${data.criticalIssues} critical issue${data.criticalIssues > 1 ? "s" : ""} detected — pipelines are silently failing. Resolve action items below.`
                  : `${data.actions.length} action item${data.actions.length > 1 ? "s" : ""} — system is partially configured.`}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Auto-refreshes every 30 seconds</p>
            </div>
          </div>

          {/* Action Items */}
          {data.actions.length > 0 && (
            <Card className="border-orange-200 dark:border-orange-800">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-orange-500" />
                  Action Items ({data.actions.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.actions.map((action, i) => {
                  const isCritical = action.toLowerCase().includes("silently failing") || action.toLowerCase().includes("fail") || action.toLowerCase().includes("security");
                  return (
                    <div key={i} data-testid={`action-item-${i}`} className={`flex items-start gap-3 rounded-md px-3 py-2 ${isCritical ? "bg-red-50 dark:bg-red-950/20" : "bg-yellow-50 dark:bg-yellow-950/20"}`}>
                      {isCritical
                        ? <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                        : <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />}
                      <p className="text-sm">{action}</p>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Integration Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

            {/* GHL */}
            <Card data-testid="card-ghl-status">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-primary" />
                    GoHighLevel CRM
                  </div>
                  <StatusBadge status={ghlStatus} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.ghl.configured} />
                  <span>Integration Token</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.env.ghlLocationId} />
                  <span>Location ID</span>
                </div>
                {data.ghl.locationName && (
                  <p className="text-xs text-muted-foreground pl-7">📍 {data.ghl.locationName}</p>
                )}
                <Separator />
                {data.ghl.workflowReadiness ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Supported handoff workflow IDs</span>
                      <span className={`font-mono font-semibold text-xs ${data.ghl.workflowReadiness.needsAttention ? "text-amber-600 dark:text-amber-400" : "text-green-600"}`}>
                        {data.ghl.workflowReadiness.supportedConfigured}/{data.ghl.workflowReadiness.supportedTotal}
                      </span>
                    </div>
                    {data.ghl.workflowReadiness.missingSupported.map(m => (
                      <p key={m.id} className="text-xs text-amber-700 dark:text-amber-400">{m.id}: {m.effect}</p>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      Reference-only workflow IDs: {data.ghl.workflowReadiness.referenceOnlyConfigured}/{data.ghl.workflowReadiness.referenceOnlyTotal} saved.
                      These do not affect readiness or sequence sending.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Workflow ID readiness unavailable.</p>
                )}
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.env.ghlWebhookSecret} />
                  <span>Webhook Secret</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.env.ghlBookingLink} warn={!data.env.ghlBookingLink} />
                  <span>Default Booking Link</span>
                </div>
              </CardContent>
            </Card>

            {/* SMTP */}
            <Card data-testid="card-smtp-status">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-primary" />
                    SMTP Email Fallback
                  </div>
                  <StatusBadge status={smtpStatus} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.env.smtpHost} />
                  <span>SMTP_HOST</span>
                  {data.smtp.host && <span className="text-xs text-muted-foreground ml-auto font-mono">{data.smtp.host}:{data.smtp.port}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.env.smtpUser} />
                  <span>SMTP_USER</span>
                  {data.smtp.user && <span className="text-xs text-muted-foreground ml-auto font-mono truncate max-w-[120px]">{data.smtp.user}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.env.smtpPass} />
                  <span>SMTP_PASS</span>
                  {!data.env.smtpPass && <span className="text-xs text-red-600 dark:text-red-400 ml-auto">Required for delivery</span>}
                </div>
                {!data.smtp.configured && (
                  <>
                    <Separator />
                    <p className="text-xs text-red-600 dark:text-red-400">
                      Without SMTP, transactional emails (proposals, merchant welcome, rep alerts, digests) rely solely on GHL and will silently fail when GHL is down.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            {/* OpenAI */}
            <Card data-testid="card-openai-status">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4 text-primary" />
                    OpenAI / AI Engine
                  </div>
                  <StatusBadge status={data.openai.configured ? "ok" : "error"} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.openai.configured} />
                  <span>AI_INTEGRATIONS_OPENAI_API_KEY</span>
                </div>
                {!data.openai.configured && (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    AI enrichment, intent classification, deal blueprints, and proposal generation will all fail without this key.
                  </p>
                )}
                {data.openai.configured && (
                  <p className="text-xs text-muted-foreground">
                    Powers: enrichment, reply classification, blueprints, proposals, conversation AI, campaign content.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Redis / Queue */}
            <Card data-testid="card-redis-status">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-primary" />
                    Redis / Job Queue
                  </div>
                  <StatusBadge status={data.redis.real ? "ok" : "warning"} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.redis.real} warn={!data.redis.real} />
                  <span>REDIS_URL</span>
                </div>
                {!data.redis.real ? (
                  <p className="text-xs text-yellow-600 dark:text-yellow-400">
                    REDIS_URL is not configured. BullMQ queues are unavailable; no in-memory queue is used.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Durable BullMQ queues active: GHL sync (45s), SLA checks (5m), sequences (30s), enrichment (10m), discovery (daily).
                  </p>
                )}
              </CardContent>
            </Card>

            {/* SDR Feature Flags */}
            <Card data-testid="card-sdr-flags">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary" />
                  SDR Feature Flags
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FlagRow label="SDR Pipeline" enabled={data.sdr.sdrEnabled} />
                <FlagRow label="Orchestrator" enabled={data.sdr.orchestratorEnabled} />
                <FlagRow label="Legacy Outreach" enabled={data.sdr.legacyOutreachEnabled} />
                <FlagRow label="Voice AI" enabled={data.sdr.voiceAiEnabled} />
                <FlagRow label="SMS" enabled={data.sdr.smsEnabled} />
                <FlagRow label="Nightly Discovery" enabled={data.sdr.nightlyDiscoveryEnabled} />
                <Separator className="my-2" />
                <p className="text-xs text-muted-foreground">Manage flags in the Activation Panel</p>
              </CardContent>
            </Card>

            {/* Sending Identities */}
            <Card data-testid="card-sending-identities">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Send className="w-4 h-4 text-primary" />
                    Sending Identities
                  </div>
                  <StatusBadge status={data.sendingIdentities.activeCount >= 3 ? "ok" : data.sendingIdentities.activeCount > 0 ? "warning" : "error"} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Active identities</span>
                  <span className={`font-mono font-semibold ${data.sendingIdentities.activeCount >= 3 ? "text-green-600" : "text-yellow-600"}`}>
                    {data.sendingIdentities.activeCount}
                  </span>
                </div>
                {data.sendingIdentities.activeCount < 3 ? (
                  <p className="text-xs text-yellow-600 dark:text-yellow-400">
                    Recommend 3+ for inbox rotation and deliverability protection. Add identities in Email Health.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Inbox rotation active. Monitor bounce rates and health scores in Inbox Health.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <StatusIcon ok={data.env.adminEmail} />
                  <span>ADMIN_DIGEST_EMAIL</span>
                </div>
              </CardContent>
            </Card>

          </div>

          {/* Enrichment APIs */}
          <Card data-testid="card-enrichment-apis">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Server className="w-4 h-4 text-primary" />
                Enrichment & Discovery APIs
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              <EnvRow label="SERPER_API_KEY" present={data.env.serperApiKey} />
              <EnvRow label="APOLLO_API_KEY" present={data.env.apolloApiKey} />
              <EnvRow label="APIFY_API_TOKEN" present={data.env.apifyToken} />
              <EnvRow label="OUTSCRAPER_API_KEY" present={data.env.outscraperKey} />
              <EnvRow label="APP_URL" present={data.env.appUrl} />
              <EnvRow label="NMI_SECURITY_KEY" present={data.env.nmiKey} />
            </CardContent>
          </Card>

          {/* ── Internal Test Email Sends ─────────────────────────────────────── */}
          <Card data-testid="card-internal-test-emails">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FlaskConical className="w-4 h-4 text-primary" />
                  Internal Test Email Sends
                </div>
                <Button
                  size="sm"
                  onClick={() => testEmailsMutation.mutate()}
                  disabled={testEmailsMutation.isPending}
                  data-testid="button-send-test-emails"
                >
                  {testEmailsMutation.isPending
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
                    : <><Send className="w-4 h-4 mr-2" />Send Internal Test Emails</>}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md bg-muted/50 px-4 py-3 text-sm space-y-1">
                <p className="font-medium">What this does</p>
                <p className="text-muted-foreground text-xs">
                  Renders and sends a <code className="text-xs bg-muted px-1 rounded">[TEST]</code>-labeled email for every email step across all active sequences.
                  All sends go to <strong>scott@libertybancard.com only</strong> — no prospects receive anything.
                  SMS stays closed. Each test email includes the cadence name, step number, route used, sender policy applied, and the current outboundGlobalPaused status.
                </p>
              </div>

              {testEmailsMutation.isError && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/20 rounded-md px-3 py-2">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>{(testEmailsMutation.error as Error)?.message ?? "Send failed"}</span>
                </div>
              )}

              {testEmailsResult && (
                <div className="space-y-3">
                  {/* Summary bar */}
                  <div className="flex flex-wrap gap-3 text-sm">
                    <div className="flex items-center gap-1.5">
                      <Mail className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{testEmailsResult.summary.total}</span>
                      <span className="text-muted-foreground">steps across {testEmailsResult.activeSequences} active sequences</span>
                    </div>
                    <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                      {testEmailsResult.summary.sent} sent
                    </Badge>
                    {testEmailsResult.summary.failed > 0 && (
                      <Badge variant="destructive">{testEmailsResult.summary.failed} failed</Badge>
                    )}
                    {testEmailsResult.summary.skipped > 0 && (
                      <Badge variant="outline" className="text-muted-foreground">{testEmailsResult.summary.skipped} skipped</Badge>
                    )}
                    <Badge variant="outline" className="font-mono text-xs">via {testEmailsResult.route}</Badge>
                    <Badge variant="outline" className={`font-mono text-xs ${testEmailsResult.outboundGlobalPaused ? "text-green-700" : "text-red-700"}`}>
                      outboundGlobalPaused: {String(testEmailsResult.outboundGlobalPaused)}
                    </Badge>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    <strong>Recipient:</strong> {testEmailsResult.testRecipient}
                  </p>

                  {testEmailsResult.results.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No active sequences with email steps found. Activate a sequence first.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {displayedResults.map((r, i) => <TestResultRow key={i} r={r} />)}
                      {testEmailsResult.results.length > 5 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full text-muted-foreground"
                          onClick={() => setShowAllResults(v => !v)}
                        >
                          {showAllResults
                            ? <><ChevronUp className="w-4 h-4 mr-1" />Show fewer</>
                            : <><ChevronDown className="w-4 h-4 mr-1" />Show all {testEmailsResult.results.length} results</>}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!testEmailsResult && !testEmailsMutation.isPending && (
                <p className="text-sm text-muted-foreground italic">
                  No test run yet. Click "Send Internal Test Emails" to begin the internal audit send.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── End-to-End Flow Audit ──────────────────────────────────────────── */}
          <Card data-testid="card-flow-audit">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-primary" />
                  End-to-End Flow Audit
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => flowAuditMutation.mutate()}
                  disabled={flowAuditMutation.isPending}
                  data-testid="button-run-flow-audit"
                >
                  {flowAuditMutation.isPending
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Auditing…</>
                    : <><ClipboardList className="w-4 h-4 mr-2" />Run Flow Audit</>}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Inspects audit log records at every pipeline stage: inbound form → contact created → GHL sync → sequence eligibility → send gate → email dispatch → reply/bounce handling.
                Reports gaps as <strong>Blocker</strong>, <strong>Warning</strong>, or <strong>Info</strong>.
              </p>

              {flowAuditMutation.isError && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/20 rounded-md px-3 py-2">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>{(flowAuditMutation.error as Error)?.message ?? "Audit failed"}</span>
                </div>
              )}

              {flowAuditResult && (
                <div className="space-y-3">
                  {/* Summary */}
                  <div className="flex flex-wrap gap-3 items-center text-sm">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <span className="text-muted-foreground text-xs">{new Date(flowAuditResult.ranAt).toLocaleString()}</span>
                    </div>
                    {flowAuditResult.blockers > 0
                      ? <Badge variant="destructive">{flowAuditResult.blockers} blocker{flowAuditResult.blockers > 1 ? "s" : ""}</Badge>
                      : <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">No blockers</Badge>}
                    {flowAuditResult.warnings > 0 && (
                      <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
                        {flowAuditResult.warnings} warning{flowAuditResult.warnings > 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>

                  {/* Pipeline stages */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Pipeline Stages</p>
                    {flowAuditResult.pipelineStages.map((s, i) => (
                      <div key={i} className={`flex items-start gap-3 rounded-md px-3 py-2 text-sm ${
                        s.found ? "bg-green-50 dark:bg-green-950/20"
                          : s.severity === "blocker" ? "bg-red-50 dark:bg-red-950/20"
                          : s.severity === "warning" ? "bg-yellow-50 dark:bg-yellow-950/20"
                          : "bg-muted/40"
                      }`}>
                        {s.found
                          ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                          : s.severity === "blocker"
                          ? <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                          : s.severity === "warning"
                          ? <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                          : <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">{s.stage}</p>
                          <p className="text-xs text-muted-foreground">{s.note}</p>
                        </div>
                        {!s.found && <SeverityBadge severity={s.severity} />}
                      </div>
                    ))}
                  </div>

                  {/* Additional checks */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">System Checks</p>
                    {flowAuditResult.additionalChecks.map((c, i) => (
                      <div key={i} className={`flex items-start gap-3 rounded-md px-3 py-2 text-sm ${
                        c.ok ? "bg-green-50 dark:bg-green-950/20"
                          : c.severity === "blocker" ? "bg-red-50 dark:bg-red-950/20"
                          : c.severity === "warning" ? "bg-yellow-50 dark:bg-yellow-950/20"
                          : "bg-muted/40"
                      }`}>
                        {c.ok
                          ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                          : c.severity === "blocker"
                          ? <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                          : <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">{c.check}</p>
                          <p className="text-xs text-muted-foreground">{c.note}</p>
                        </div>
                        {!c.ok && <SeverityBadge severity={c.severity} />}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!flowAuditResult && !flowAuditMutation.isPending && (
                <p className="text-sm text-muted-foreground italic">
                  No audit run yet. Click "Run Flow Audit" to inspect the full pipeline log trail.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── Go/No-Go Report ───────────────────────────────────────────────── */}
          <Card data-testid="card-gonogo-report">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-primary" />
                  Go / No-Go Launch Report
                </div>
                {goNoGo && (
                  <Badge className={goNoGo.overallGo
                    ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 font-mono"
                    : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 font-mono"
                  }>
                    {goNoGo.overallGo ? "✅ OVERALL GO" : "❌ NOT READY"}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {goNoGo ? (
                <>
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    {goNoGo.lastInternalTestEmailsAt && (
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>Last test send: {new Date(goNoGo.lastInternalTestEmailsAt).toLocaleString()}</span>
                      </div>
                    )}
                    {goNoGo.lastFlowAuditAt && (
                      <div className="flex items-center gap-1">
                        <Activity className="w-3 h-3" />
                        <span>Last flow audit: {new Date(goNoGo.lastFlowAuditAt).toLocaleString()}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <span className={`font-mono font-semibold ${goNoGo.outboundGlobalPaused ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                        outboundGlobalPaused: {String(goNoGo.outboundGlobalPaused)}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {goNoGo.gates.map((gate, i) => (
                      <div key={i} className={`flex items-start gap-3 rounded-md border px-4 py-3 ${
                        gate.status === "go" ? "border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20"
                          : gate.status === "blocked" ? "border-gray-200 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-900/20"
                          : gate.status === "warning" ? "border-yellow-200 bg-yellow-50/50 dark:border-yellow-800 dark:bg-yellow-950/20"
                          : "border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20"
                      }`}>
                        <GoNoGoBadge status={gate.status} />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{gate.gate}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{gate.notes}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="text-xs text-muted-foreground pt-1">
                    Report generated: {new Date(goNoGo.generatedAt).toLocaleString()} · {goNoGo.activeSequences} active sequence{goNoGo.activeSequences !== 1 ? "s" : ""} queued
                  </p>
                </>
              ) : (
                <div className="space-y-2 animate-pulse">
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} className="h-14 rounded-md bg-muted" />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Failed to load system readiness data.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
