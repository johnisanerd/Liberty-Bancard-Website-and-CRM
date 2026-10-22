import { PageTitle } from "@/components/ui/page-header";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { Loader2, Play, Square, Pause, Shield, Activity, Server, Mail, AlertTriangle, CheckCircle2, XCircle, Zap, RefreshCw, Radio, ArrowRightLeft, Plus, Pencil, ListChecks, Circle, Phone, MessageSquare, Mic, Voicemail, Search, Lock, ShieldCheck, ChevronDown, ChevronRight, History, Download, FileText, BanIcon, Gauge, Database, Users } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState, useEffect, lazy, Suspense } from "react";
import { useToast } from "@/hooks/use-toast";
import { EnrichmentActivationPanel } from "./EnrichmentActivationPanel";

// Lazy-loaded to avoid bundling the enrichment panel into the main ActivationPanel chunk
function EnrichmentActivationPanelLazy() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
      <EnrichmentActivationPanel />
    </Suspense>
  );
}

interface OutboundSettings {
  outboundGlobalPaused: boolean;
  outboundGlobalPausedReason: string | null;
  outboundDailyEmailCap: number;
  coldEmailSendsToday: number;
  coldEmailRemainingToday: number;
}

interface AppHealthData {
  ok: boolean;
  uptime: number;
  db: string;
  session: string;
  timestamp: string;
}

interface GhlHealthData {
  configured: boolean;
  authTest: boolean;
  hasWebhookSecret: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  threshold: number;
}

interface SdrHealthData {
  globalPaused: boolean;
  globalPauseReason: string;
  sendingIdentityCount: number;
  activeIdentityCount: number;
  eligibleLeadCount: number;
  recentFailures24h: number;
  orchestratorRunning: boolean;
  lastSweepTime: string | null;
  webhookLastReceived: string | null;
}

interface FeatureFlagsData {
  [key: string]: boolean | number | string;
}

interface SendingIdentity {
  id: number;
  label: string;
  emailAddress: string;
  status: string;
  dailyLimit: number;
  sentToday: number;
  healthScore: number | null;
  warmupStatus?: string | null;
  warmupStartedAt?: string | null;
}

interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface ReadinessData {
  ready: boolean;
  passCount: number;
  totalChecks: number;
  checks: ReadinessCheck[];
}

interface ComplianceChannel {
  key: string;
  name: string;
  icon: string;
  status: "safe" | "warning" | "blocked" | "off";
  flagKey: string | null;
  flagEnabled: boolean;
  regulation: string;
  consentRequired: boolean;
  summary: string;
  requirements: string[];
  blockers: string[];
  stats: Record<string, unknown> | null;
}

interface ComplianceChannelStatus {
  strictStates: string[];
  lastUpdated: string;
  channels: ComplianceChannel[];
}

interface ChannelSafetySummary {
  generatedAt: string;
  sourceConsentMatrix: Array<{
    sourceCategory: string;
    cold_no_consent: number;
    warm_no_pewc: number;
    pewc_full_automation: number;
    opted_out: number;
    do_not_contact: number;
    total: number;
  }>;
  channelEligibility: Array<{
    channel: "email" | "manual_call" | "sms" | "voice_ai" | "ringless_vm";
    eligibleCount: number;
    blockedCount: number;
    topBlockReason: string | null;
    featureFlag: string | null;
    featureFlagEnabled: boolean | null;
    status: "eligible" | "flag_gated" | "blocked" | "unknown";
  }>;
  blockedAttempts24h: {
    total: number;
    lastBlockedAt: string | null;
    byReason: Array<{ reason: string; count: number }>;
    byChannel: Array<{ channel: string; count: number }>;
  };
  floridaBreakdown: {
    total: number;
    byConsentTier: Array<{ consentTier: string; count: number }>;
  };
  featureFlags: Array<{
    key: string;
    enabled: boolean | null;
    status: "enabled" | "disabled" | "unknown";
  }>;
  warnings: string[];
}

interface QueueMetric {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
  repeatEveryMs: number | null;
  lastCompletedAt: string | null;
  lastRetainedRedisCompletedAt?: string | null;
  lastFailedAt: string | null;
  workerSelected?: boolean;
  workerActive?: boolean;
  avgDurationMs: number | null;
  throughputPerHour: number | null;
  lastError?: string | null;
}

interface QueueMetricsData {
  queues: QueueMetric[];
  queueMode: "bullmq_redis" | "legacy_interval_partial" | "unavailable";
}

interface ChannelAttempt {
  id: number;
  sentAt: string | null;
  channel: string;
  status: string;
  leadStateId: number;
  subject: string | null;
  body: string | null;
}

interface LeadEvent {
  id: number;
  createdAt: string | null;
  eventType: string;
  leadStateId: number;
  decisionReason: string | null;
}

interface StuckLead {
  id: number;
  companyName: string | null;
  stage: string;
  nextActionType: string | null;
  nextActionAt: string | null;
  updatedAt: string | null;
}

interface DailyChannelLimit {
  sent?: number;
  made?: number;
  limit: number;
}

interface OrchestratorStatusData {
  running: boolean;
  enabled: boolean;
  webhookFailures: number;
  dailyLimits: {
    email?: DailyChannelLimit;
    sms?: DailyChannelLimit;
    call?: DailyChannelLimit;
  };
}

interface BridgeResultItem {
  id: number | string;
  name: string;
  status: string;
  reason?: string;
  vertical?: string;
}

interface BridgeResponse {
  dryRun: boolean;
  source: string;
  totalProcessed: number;
  created: number;
  deduped: number;
  skipped: number;
  errors: number;
  results: BridgeResultItem[];
}

interface IdentityFormState {
  label: string;
  emailAddress: string;
  dailyLimit: string;
  status: string;
}

const emptyIdentityForm: IdentityFormState = { label: "", emailAddress: "", dailyLimit: "50", status: "active" };

interface ActivationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface ActivationStatus {
  ready: boolean;
  checks: ActivationCheck[];
  heartbeat: { sequenceRunner: any; slaWorker: any; stageProgression: any };
  activeIdentities: number;
  totalIdentities: number;
  activeEnrollments: number;
  flags: Record<string, boolean>;
}

interface WizardProps {
  identities: SendingIdentity[];
  ghlHealth: GhlHealthData | undefined;
  onTestGhl: () => void;
  ghlTesting: boolean;
}

interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  ghlProbe: { ok: boolean; detail: string };
}

function SendingIdentityWizard({ identities, ghlHealth, onTestGhl, ghlTesting }: WizardProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<IdentityFormState>(emptyIdentityForm);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const hasIdentity = identities.length > 0;
  const firstIdentity = identities[0];

  const ghlReady = !!ghlHealth?.configured && !!ghlHealth?.authTest;

  const validateMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/operator/validate-identity", {
        label: form.label,
        emailAddress: form.emailAddress,
      });
      return r.json() as Promise<ValidationResult>;
    },
    onSuccess: (data) => {
      setValidation(data);
      if (!data.ok) toast({ title: "Validation failed", description: data.errors[0], variant: "destructive" });
    },
    onError: (err: Error) => toast({ title: "Validation error", description: err.message, variant: "destructive" }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      // Always re-validate server-side immediately before saving so the GHL
      // sender check is the gate, not the client state.
      const v = await apiRequest("POST", "/api/operator/validate-identity", {
        label: form.label,
        emailAddress: form.emailAddress,
      });
      const vData = await v.json() as ValidationResult;
      setValidation(vData);
      if (!vData.ok) {
        throw new Error(vData.errors[0] || "Identity validation failed");
      }
      const r = await apiRequest("POST", "/api/sdr/sending-identities", {
        label: form.label,
        emailAddress: form.emailAddress,
        dailyLimit: parseInt(form.dailyLimit, 10),
        status: form.status,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operator/activation-status"] });
      toast({ title: "Sending identity created", description: "Warmup schedule started" });
      setForm(emptyIdentityForm);
      setValidation(null);
    },
    onError: (err: Error) => toast({ title: "Failed to create identity", description: err.message, variant: "destructive" }),
  });

  const step1Done = ghlReady;
  const step2Done = hasIdentity;
  const step3Done = hasIdentity && (firstIdentity?.warmupStatus === "warm" || firstIdentity?.healthScore !== null);

  const warmupSchedule = [
    { day: "Day 1-3", limit: 10, label: "Initial warmup" },
    { day: "Day 4-7", limit: 25, label: "Ramp-up" },
    { day: "Day 8-14", limit: 50, label: "Mid warmup" },
    { day: "Day 15+", limit: form.dailyLimit ? parseInt(form.dailyLimit, 10) : 50, label: "Full daily limit" },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Mail className="w-4 h-4" /> First Sending Identity Wizard
            <Badge variant={hasIdentity ? "default" : "secondary"}>
              {hasIdentity ? "Identity active" : "Action required"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Step 1 — GHL validation */}
          <div className="border rounded p-3" data-testid="wizard-step-ghl">
            <div className="flex items-start gap-3">
              <div className="flex items-center justify-center w-6 h-6 rounded-full border text-xs font-bold">1</div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {step1Done ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <Circle className="w-4 h-4 text-muted-foreground" />}
                  <span className="font-medium text-sm">Validate GHL connection</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Configured: <Badge variant={ghlHealth?.configured ? "default" : "destructive"}>{ghlHealth?.configured ? "Yes" : "No"}</Badge>
                  {" "}Auth: <Badge variant={ghlHealth?.authTest ? "default" : "secondary"}>{ghlHealth?.authTest ? "Pass" : "Pending"}</Badge>
                  {" "}Webhook: <Badge variant={ghlHealth?.hasWebhookSecret ? "default" : "secondary"}>{ghlHealth?.hasWebhookSecret ? "Set" : "Missing"}</Badge>
                </div>
                <Button size="sm" variant="outline" className="mt-2" onClick={onTestGhl} disabled={ghlTesting} data-testid="button-wizard-test-ghl">
                  {ghlTesting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
                  Test &amp; bootstrap GHL
                </Button>
              </div>
            </div>
          </div>

          {/* Step 2 — Identity form */}
          <div className="border rounded p-3" data-testid="wizard-step-identity">
            <div className="flex items-start gap-3">
              <div className="flex items-center justify-center w-6 h-6 rounded-full border text-xs font-bold">2</div>
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  {step2Done ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <Circle className="w-4 h-4 text-muted-foreground" />}
                  <span className="font-medium text-sm">Add your first sending identity</span>
                </div>
                {!hasIdentity ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                    <div>
                      <Label className="text-xs">Label</Label>
                      <Input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Main Sales" data-testid="input-wizard-label" />
                    </div>
                    <div>
                      <Label className="text-xs">Email Address</Label>
                      <Input type="email" value={form.emailAddress} onChange={e => setForm(f => ({ ...f, emailAddress: e.target.value }))} placeholder="sales@example.com" data-testid="input-wizard-email" />
                    </div>
                    <div>
                      <Label className="text-xs">Daily Limit (post-warmup)</Label>
                      <Input type="number" value={form.dailyLimit} onChange={e => setForm(f => ({ ...f, dailyLimit: e.target.value }))} min={1} max={200} data-testid="input-wizard-limit" />
                    </div>
                    <div>
                      <Label className="text-xs">Status</Label>
                      <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
                        <SelectTrigger data-testid="select-wizard-status"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="warming">Warming</SelectItem>
                          <SelectItem value="paused">Paused</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="md:col-span-2 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => validateMutation.mutate()}
                        disabled={validateMutation.isPending || !form.label || !form.emailAddress}
                        data-testid="button-wizard-validate"
                      >
                        {validateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Shield className="w-4 h-4 mr-1" />}
                        Validate sender in GHL
                      </Button>
                      <Button
                        onClick={() => createMutation.mutate()}
                        disabled={!step1Done || !validation?.ok || createMutation.isPending || !form.label || !form.emailAddress}
                        data-testid="button-wizard-create"
                      >
                        {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
                        Create identity &amp; start warmup
                      </Button>
                    </div>
                    {!step1Done && <p className="text-xs text-yellow-600 md:col-span-2">Pass step 1 (GHL connection) before validating the sender.</p>}
                    {validation && (
                      <div className={`md:col-span-2 text-xs p-2 rounded border ${validation.ok ? "border-green-500/50 bg-green-500/5" : "border-red-500/50 bg-red-500/5"}`} data-testid="text-wizard-validation">
                        <div className="font-medium flex items-center gap-1">
                          {validation.ok ? <CheckCircle2 className="w-3 h-3 text-green-600" /> : <XCircle className="w-3 h-3 text-red-600" />}
                          {validation.ok ? "Sender validated — ready to save" : "Sender validation failed"}
                        </div>
                        {validation.errors.map((e, i) => <div key={`e${i}`} className="text-red-600 ml-4">• {e}</div>)}
                        {validation.warnings.map((w, i) => <div key={`w${i}`} className="text-yellow-600 ml-4">⚠ {w}</div>)}
                        {validation.ghlProbe && <div className="text-muted-foreground ml-4">GHL probe: {validation.ghlProbe.detail}</div>}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground" data-testid="text-identity-summary">
                    {firstIdentity.label} &lt;{firstIdentity.emailAddress}&gt; · status {firstIdentity.status}
                    {firstIdentity.warmupStatus ? ` · warmup ${firstIdentity.warmupStatus}` : ""}
                    {firstIdentity.healthScore !== null ? ` · health ${firstIdentity.healthScore}` : ""}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Step 3 — Warmup schedule */}
          <div className="border rounded p-3" data-testid="wizard-step-warmup">
            <div className="flex items-start gap-3">
              <div className="flex items-center justify-center w-6 h-6 rounded-full border text-xs font-bold">3</div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {step3Done ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <Circle className="w-4 h-4 text-muted-foreground" />}
                  <span className="font-medium text-sm">Warmup schedule</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  New identities are throttled in stages to protect deliverability. The system enforces these caps automatically — review the schedule below.
                </p>
                <div className="overflow-x-auto mt-2">
                  <table className="w-full text-xs border" data-testid="table-warmup-schedule">
                    <thead>
                      <tr className="border-b bg-muted/30 text-left">
                        <th className="py-1 px-2">Window</th>
                        <th className="py-1 px-2">Send cap / day</th>
                        <th className="py-1 px-2">Stage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {warmupSchedule.map(w => (
                        <tr key={w.day} className="border-b">
                          <td className="py-1 px-2">{w.day}</td>
                          <td className="py-1 px-2">{w.limit}</td>
                          <td className="py-1 px-2">{w.label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {firstIdentity?.warmupStartedAt && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Warmup started: {new Date(firstIdentity.warmupStartedAt).toLocaleString()} · Current status: <strong>{firstIdentity.warmupStatus || "warming"}</strong>
                  </p>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface ScoringProgressResponse {
  status: "idle" | "running" | "complete" | "cancelled" | "failed" | "interrupted";
  runId: string | null;
  mode: "backfill" | "rescore";
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  hot: number;
  warm: number;
  cold: number;
  unqualified: number;
  errors: number;
  lastProcessedContactId: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error?: string | null;
  jobRunning: boolean;
}

interface ScoringPreviewResponse {
  totalEligible: number;
  estimatedBatches: number;
  sampleIds: number[];
  breakdown: { nullLastScoredAt: number; staleLastScoredAt: number };
  preflightToken?: string;
}

function ContactScoringPanel() {
  const { toast } = useToast();
  const [rescoreConfirm, setRescoreConfirm] = useState("");
  const [rescoreDialogOpen, setRescoreDialogOpen] = useState(false);
  const [lastPreview, setLastPreview] = useState<ScoringPreviewResponse | null>(null);
  const [rescorePreview, setRescorePreview] = useState<ScoringPreviewResponse | null>(null);

  const statusQuery = useQuery<ScoringProgressResponse>({
    queryKey: ["/api/admin/contacts/score-all/status"],
    refetchInterval: (query) => {
      const data = query.state.data as ScoringProgressResponse | undefined;
      return data?.status === "running" ? 5000 : false;
    },
  });

  const previewMutation = useMutation({
    mutationFn: async (mode: "backfill" | "rescore") => {
      const r = await apiRequest("POST", "/api/admin/contacts/score-all/preview", { mode });
      return r.json() as Promise<ScoringPreviewResponse>;
    },
    onSuccess: (data, mode) => {
      if (mode === "rescore") {
        setRescorePreview(data);
        toast({ title: "Rescore preview ready", description: `${data.totalEligible.toLocaleString()} contacts eligible. You may now confirm.` });
      } else {
        setLastPreview(data);
        toast({ title: "Preview ready", description: `${data.totalEligible.toLocaleString()} contacts eligible` });
      }
    },
    onError: (err: Error) => toast({ title: "Preview failed", description: err.message, variant: "destructive" }),
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/contacts/score-all", { confirmed: true, mode: "backfill" });
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Backfill started", description: "Scoring job is running. Progress updates every 5s." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/score-all/status"] });
    },
    onError: (err: Error) => toast({ title: "Start failed", description: err.message, variant: "destructive" }),
  });

  const rescoreMutation = useMutation({
    mutationFn: async () => {
      if (!rescorePreview?.preflightToken) {
        throw new Error("Run 'Preview Rescore' first to obtain a preflight token.");
      }
      const r = await apiRequest("POST", "/api/admin/contacts/score-all", {
        confirmed: true,
        mode: "rescore",
        confirmationText: "RE-SCORE ALL CONTACTS",
        preflightToken: rescorePreview.preflightToken,
      });
      return r.json();
    },
    onSuccess: () => {
      setRescoreDialogOpen(false);
      setRescoreConfirm("");
      setRescorePreview(null);
      toast({ title: "Re-score started", description: "Re-scoring all active contacts. Progress updates every 5s." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/score-all/status"] });
    },
    onError: (err: Error) => toast({ title: "Re-score failed", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/contacts/score-all/cancel", {});
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Cancel requested", description: "Job will stop after the current batch." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/score-all/status"] });
    },
    onError: (err: Error) => toast({ title: "Cancel failed", description: err.message, variant: "destructive" }),
  });

  const progress = statusQuery.data;
  const isRunning = progress?.status === "running";
  const pct = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <Card data-testid="card-contact-scoring">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Users className="w-4 h-4" /> Contact Scoring
          {progress && (
            <Badge variant={
              progress.status === "complete" ? "default" :
              progress.status === "running" ? "secondary" :
              progress.status === "failed" ? "destructive" : "outline"
            } data-testid="badge-scoring-status">
              {progress.status}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {statusQuery.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading status…
          </div>
        )}

        {progress && (
          <div className="space-y-2 text-xs">
            {isRunning && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Progress</span>
                  <span data-testid="text-scoring-progress">{progress.processed.toLocaleString()} / {progress.total.toLocaleString()} ({pct}%)</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-500"
                    style={{ width: `${pct}%` }}
                    data-testid="bar-scoring-progress"
                  />
                </div>
              </div>
            )}
            {progress.status === "complete" && (
              <div className="grid grid-cols-4 gap-1 text-center text-xs border rounded p-2" data-testid="div-scoring-distribution">
                <div><div className="font-semibold text-green-600">{progress.hot}</div><div className="text-muted-foreground">Hot</div></div>
                <div><div className="font-semibold text-amber-600">{progress.warm}</div><div className="text-muted-foreground">Warm</div></div>
                <div><div className="font-semibold text-blue-600">{progress.cold}</div><div className="text-muted-foreground">Cold</div></div>
                <div><div className="font-semibold text-muted-foreground">{progress.unqualified}</div><div className="text-muted-foreground">Unqualified</div></div>
              </div>
            )}
            {progress.status !== "idle" && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                <span>Mode: <strong>{progress.mode}</strong></span>
                {progress.processed > 0 && <span>Updated: <strong>{progress.updated}</strong> Skipped: <strong>{progress.skipped}</strong> Errors: <strong>{progress.errors}</strong></span>}
                {progress.startedAt && <span>Started: {new Date(progress.startedAt).toLocaleString()}</span>}
              </div>
            )}
            {progress.error && (
              <div className="text-xs text-destructive" data-testid="text-scoring-error">{progress.error}</div>
            )}
          </div>
        )}

        {lastPreview && (
          <div className="text-xs border rounded p-2 bg-muted/30 space-y-1" data-testid="div-scoring-preview">
            <div className="font-medium">Last Preview</div>
            <div className="text-muted-foreground">{lastPreview.totalEligible.toLocaleString()} eligible · {lastPreview.estimatedBatches} batches</div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => previewMutation.mutate("backfill")}
            disabled={previewMutation.isPending || isRunning}
            data-testid="button-scoring-preview"
          >
            {previewMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Search className="w-3 h-3 mr-1" />}
            Preview
          </Button>
          <Button
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending || isRunning}
            data-testid="button-run-backfill"
          >
            {backfillMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
            Run Backfill
          </Button>
          {isRunning && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              data-testid="button-cancel-scoring"
            >
              <Square className="w-3 h-3 mr-1" /> Cancel
            </Button>
          )}
          <Dialog open={rescoreDialogOpen} onOpenChange={(open) => {
            setRescoreDialogOpen(open);
            if (!open) { setRescoreConfirm(""); setRescorePreview(null); }
          }}>
            <DialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={isRunning}
                data-testid="button-rescore-all"
              >
                Re-score All
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Re-score All Active Contacts</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  This will re-score every active contact (including already-scored contacts). Requires admin role.
                  First run a preflight preview, then type <strong>RE-SCORE ALL CONTACTS</strong> to confirm.
                </p>
                {/* Step 1: Preflight preview — must be completed before confirmation is enabled */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => previewMutation.mutate("rescore")}
                    disabled={previewMutation.isPending}
                    data-testid="button-rescore-preview"
                  >
                    {previewMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Search className="w-3 h-3 mr-1" />}
                    Preview Rescore
                  </Button>
                  {rescorePreview && (
                    <span className="text-xs text-green-600 font-medium">
                      ✓ {rescorePreview.totalEligible.toLocaleString()} eligible — preflight token ready
                    </span>
                  )}
                </div>
                {/* Step 2: Confirmation text — only enabled after preview */}
                <Input
                  value={rescoreConfirm}
                  onChange={e => setRescoreConfirm(e.target.value)}
                  placeholder="RE-SCORE ALL CONTACTS"
                  disabled={!rescorePreview}
                  data-testid="input-rescore-confirm"
                />
                <div className="flex gap-2 justify-end">
                  <DialogClose asChild>
                    <Button variant="outline" size="sm" onClick={() => { setRescoreConfirm(""); setRescorePreview(null); }}>Cancel</Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!rescorePreview || rescoreConfirm !== "RE-SCORE ALL CONTACTS" || rescoreMutation.isPending}
                    onClick={() => rescoreMutation.mutate()}
                    data-testid="button-rescore-confirm"
                  >
                    {rescoreMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    Re-score All Contacts
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-xs text-muted-foreground">
          Backfill scores contacts with no <code>lastScoredAt</code>. Re-score overwrites all active contacts (admin only). No GHL sync, no enrollment, no outbound triggered.
        </p>
      </CardContent>
    </Card>
  );
}

function Day1Runbook() {
  const { toast } = useToast();
  const { data, isLoading, refetch } = useQuery<ActivationStatus>({
    queryKey: ["/api/operator/activation-status"],
    refetchInterval: 30000,
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/operator/backfill-stages", { limit: 1000 });
      return r.json();
    },
    onSuccess: (res: any) => {
      toast({ title: "Stage backfill complete", description: `Evaluated ${res.evaluated}, progressed ${res.progressed}` });
      refetch();
    },
    onError: (err: Error) => toast({ title: "Backfill failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ListChecks className="w-4 h-4" /> Day-1 Activation Checklist
            <Badge variant={data.ready ? "default" : "secondary"} data-testid="badge-runbook-ready">
              {data.ready ? "READY" : "NOT READY"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {data.checks.map((check, idx) => (
              <li key={check.id} className="flex items-start gap-3 p-2 border rounded" data-testid={`runbook-check-${check.id}`}>
                <div className="flex items-center justify-center w-6 h-6 rounded-full border text-xs font-bold mt-0.5">{idx + 1}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {check.ok ? (
                      <CheckCircle2 className="w-4 h-4 text-green-600" data-testid={`runbook-ok-${check.id}`} />
                    ) : (
                      <Circle className="w-4 h-4 text-muted-foreground" data-testid={`runbook-pending-${check.id}`} />
                    )}
                    <span className={check.ok ? "text-sm" : "text-sm font-medium"}>{check.label}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 ml-6">{check.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Worker Heartbeats</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span>SLA worker last tick</span>
            <span data-testid="text-sla-heartbeat">{data.heartbeat.slaWorker?.at ? new Date(data.heartbeat.slaWorker.at).toLocaleString() : "never"}</span>
          </div>
          <div className="flex justify-between">
            <span>Sequence runner last tick</span>
            <span data-testid="text-sequence-heartbeat">{data.heartbeat.sequenceRunner?.at ? new Date(data.heartbeat.sequenceRunner.at).toLocaleString() : "never"}</span>
          </div>
          <div className="flex justify-between">
            <span>Last sequence batch</span>
            <span>processed {data.heartbeat.sequenceRunner?.processed ?? 0}, sent {data.heartbeat.sequenceRunner?.sent ?? 0}</span>
          </div>
          <div className="flex justify-between">
            <span>Stage progression last run</span>
            <span data-testid="text-stage-heartbeat">{data.heartbeat.stageProgression?.at ? `${new Date(data.heartbeat.stageProgression.at).toLocaleString()} (progressed ${data.heartbeat.stageProgression.progressed})` : "never"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">One-shot Operations</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            data-testid="button-backfill-stages"
          >
            {backfillMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
            Backfill stuck deal stages
          </Button>
          <p className="text-xs text-muted-foreground mt-2">
            Walks every active sales deal, infers the correct stage from existing signals (statement, review, proposal, app), and advances. Safe to re-run.
          </p>
        </CardContent>
      </Card>

      <ContactScoringPanel />
    </div>
  );
}

export default function ActivationPanel() {
  const { toast } = useToast();
  const [bridgeSource, setBridgeSource] = useState("contacts");
  const [bridgeLimit, setBridgeLimit] = useState("50");
  const [bridgeDryRun, setBridgeDryRun] = useState(true);
  const [bridgeVertical, setBridgeVertical] = useState("");
  const [bridgeGeo, setBridgeGeo] = useState("");
  const [bridgeResults, setBridgeResults] = useState<BridgeResponse | null>(null);
  const [identityForm, setIdentityForm] = useState<IdentityFormState>(emptyIdentityForm);
  const [editingIdentityId, setEditingIdentityId] = useState<number | null>(null);
  const [identityDialogOpen, setIdentityDialogOpen] = useState(false);

  const healthQuery = useQuery<SdrHealthData>({ queryKey: ["/api/sdr/health"] });
  const ghlHealthQuery = useQuery<GhlHealthData>({ queryKey: ["/api/ghl/health"] });
  const appHealthQuery = useQuery<AppHealthData>({ queryKey: ["/api/health"] });
  const flagsQuery = useQuery<FeatureFlagsData>({ queryKey: ["/api/sdr/flags"] });
  const identitiesQuery = useQuery<SendingIdentity[]>({ queryKey: ["/api/sdr/sending-identities"] });
  const attemptsQuery = useQuery<ChannelAttempt[]>({ queryKey: ["/api/sdr/activation/recent-attempts"] });
  const eventsQuery = useQuery<LeadEvent[]>({ queryKey: ["/api/sdr/activation/recent-events"] });
  const stuckQuery = useQuery<StuckLead[]>({ queryKey: ["/api/sdr/activation/stuck-leads"] });
  const orchestratorQuery = useQuery<OrchestratorStatusData>({ queryKey: ["/api/sdr/orchestrator/status"] });
  const readinessQuery = useQuery<ReadinessData>({ queryKey: ["/api/operator/readiness-checks"] });
  const complianceQuery = useQuery<ComplianceChannelStatus>({ queryKey: ["/api/sdr/compliance-channel-status"] });
  const channelSafetyQuery = useQuery<ChannelSafetySummary>({ queryKey: ["/api/admin/channel-safety-summary"], refetchInterval: 60000 });
  const queueMetricsQuery = useQuery<QueueMetricsData>({ queryKey: ["/api/operator/queue-metrics"], refetchInterval: 30000 });

  const pauseMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sdr/pause-all", { reason: "Manual pause from activation panel" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/orchestrator/status"] });
      toast({ title: "All outbound paused" });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sdr/resume-all"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/orchestrator/status"] });
      toast({ title: "Outbound resumed" });
    },
  });

  const startOrchestratorMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sdr/orchestrator/start"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/orchestrator/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      toast({ title: "Orchestrator started" });
    },
    onError: (err: Error) => toast({ title: "Failed to start", description: err.message, variant: "destructive" }),
  });

  const stopOrchestratorMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sdr/orchestrator/stop"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/orchestrator/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      toast({ title: "Orchestrator stopped" });
    },
  });

  const ghlTestMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sdr/bootstrap-ghl"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ghl/health"] });
      toast({ title: "GHL connection tested & bootstrapped" });
    },
    onError: (err: Error) => toast({ title: "GHL test failed", description: err.message, variant: "destructive" }),
  });

  const circuitResetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ghl/circuit-reset"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ghl/health"] });
      toast({ title: "GHL circuit reset", description: "Consecutive failure count cleared. Sync will resume on next tick." });
    },
    onError: (err: Error) => toast({ title: "Circuit reset failed", description: err.message, variant: "destructive" }),
  });

  const bridgeMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", "/api/sdr/bridge", {
        source: bridgeSource,
        limit: parseInt(bridgeLimit, 10),
        dryRun: bridgeDryRun,
        vertical: bridgeVertical || undefined,
        geography: bridgeGeo || undefined,
      });
      return resp.json() as Promise<BridgeResponse>;
    },
    onSuccess: (data) => {
      setBridgeResults(data);
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      toast({ title: data.dryRun ? "Dry run complete" : "Bridge complete", description: `${data.created} created, ${data.deduped} deduped, ${data.skipped} skipped` });
    },
    onError: (err: Error) => toast({ title: "Bridge failed", description: err.message, variant: "destructive" }),
  });

  const createIdentityMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sdr/sending-identities", {
      label: identityForm.label,
      emailAddress: identityForm.emailAddress,
      dailyLimit: parseInt(identityForm.dailyLimit, 10),
      status: identityForm.status,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      setIdentityDialogOpen(false);
      setIdentityForm(emptyIdentityForm);
      toast({ title: "Identity created" });
    },
    onError: (err: Error) => toast({ title: "Failed to create identity", description: err.message, variant: "destructive" }),
  });

  const updateIdentityMutation = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/sdr/sending-identities/${editingIdentityId}`, {
      label: identityForm.label,
      emailAddress: identityForm.emailAddress,
      dailyLimit: parseInt(identityForm.dailyLimit, 10),
      status: identityForm.status,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/health"] });
      setIdentityDialogOpen(false);
      setEditingIdentityId(null);
      setIdentityForm(emptyIdentityForm);
      toast({ title: "Identity updated" });
    },
    onError: (err: Error) => toast({ title: "Failed to update identity", description: err.message, variant: "destructive" }),
  });

  const health = healthQuery.data;
  const ghlHealth = ghlHealthQuery.data;
  const appHealth = appHealthQuery.data;
  const flags = flagsQuery.data;
  const identities = identitiesQuery.data || [];
  const attempts = attemptsQuery.data || [];
  const events = eventsQuery.data || [];
  const stuckLeads = stuckQuery.data || [];
  const orchestratorStatus = orchestratorQuery.data;

  const refreshAll = () => {
    ["/api/sdr/health", "/api/ghl/health", "/api/health", "/api/sdr/flags", "/api/sdr/sending-identities", "/api/sdr/activation/recent-attempts", "/api/sdr/activation/recent-events", "/api/sdr/activation/stuck-leads", "/api/sdr/orchestrator/status", "/api/operator/readiness-checks"]
      .forEach(key => queryClient.invalidateQueries({ queryKey: [key] }));
  };

  const openCreateIdentity = () => {
    setEditingIdentityId(null);
    setIdentityForm(emptyIdentityForm);
    setIdentityDialogOpen(true);
  };

  const openEditIdentity = (identity: SendingIdentity) => {
    setEditingIdentityId(identity.id);
    setIdentityForm({
      label: identity.label,
      emailAddress: identity.emailAddress,
      dailyLimit: String(identity.dailyLimit),
      status: identity.status,
    });
    setIdentityDialogOpen(true);
  };

  const handleIdentitySave = () => {
    if (editingIdentityId) {
      updateIdentityMutation.mutate();
    } else {
      createIdentityMutation.mutate();
    }
  };

  const identitySaving = createIdentityMutation.isPending || updateIdentityMutation.isPending;

  return (
    <div className="space-y-6" data-testid="activation-panel">
      <div className="flex items-center justify-between">
        <div>
          <PageTitle className="text-2xl font-bold" data-testid="text-page-title">Activation Control Panel</PageTitle>
          <p className="text-muted-foreground">Day 1 Go-Live Command Center</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refreshAll} data-testid="button-refresh-all">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh All
          </Button>
          {health?.globalPaused ? (
            <Button variant="default" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending} data-testid="button-resume-all">
              <Play className="w-4 h-4 mr-1" /> Resume All
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending} data-testid="button-pause-all">
              <Pause className="w-4 h-4 mr-1" /> Pause All Outbound
            </Button>
          )}
        </div>
      </div>

      {health?.globalPaused && (
        <Card className="border-destructive bg-destructive/10">
          <CardContent className="py-3 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            <span className="font-medium text-destructive" data-testid="text-pause-reason">GLOBAL PAUSE ACTIVE: {health.globalPauseReason}</span>
          </CardContent>
        </Card>
      )}

      {ghlHealth && ghlHealth.configured && !ghlHealth.authTest && (
        <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950/20" data-testid="banner-ghl-token-invalid">
          <CardContent className="py-3 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-800 dark:text-amber-400">GHL Token Invalid — All GHL Syncs Are Failing</p>
              <p className="text-sm text-amber-700 dark:text-amber-500 mt-0.5">
                The GoHighLevel Private Integration Token returned a 401 Unauthorized error. Contact sync, opportunity updates, workflow enrollment, and calendar bookings are all blocked until a valid token is set.
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-600 mt-1 font-mono">
                Fix: GHL → Settings → Integrations → Private Integrations → regenerate token → set <strong>GHL_PRIVATE_INTEGRATION_TOKEN</strong> env var → restart server.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue={identities.length === 0 ? "wizard" : "status"}>
        <TabsList className="flex-wrap h-auto gap-1" data-testid="tabs-activation">
          <TabsTrigger value="runbook" data-testid="tab-runbook">Day-1 Runbook</TabsTrigger>
          <TabsTrigger value="wizard" data-testid="tab-identity-wizard">Identity Wizard</TabsTrigger>
          <TabsTrigger value="status" data-testid="tab-status">System Status</TabsTrigger>
          <TabsTrigger value="readiness" data-testid="tab-readiness">Readiness</TabsTrigger>
          <TabsTrigger value="bridge" data-testid="tab-bridge">Bridge</TabsTrigger>
          <TabsTrigger value="orchestrator" data-testid="tab-orchestrator">Orchestrator</TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">Activity</TabsTrigger>
          <TabsTrigger value="stuck" data-testid="tab-stuck">Stuck Leads</TabsTrigger>
          <TabsTrigger value="deal-backfill" data-testid="tab-deal-backfill">
            <Database className="w-3.5 h-3.5 mr-1" />
            Deal Backfill
          </TabsTrigger>
          <TabsTrigger value="compliance" data-testid="tab-compliance">
            <ShieldCheck className="w-3.5 h-3.5 mr-1" />
            Compliance
          </TabsTrigger>
          <TabsTrigger value="kill-switch" data-testid="tab-kill-switch">
            <BanIcon className="w-3.5 h-3.5 mr-1" />
            Kill Switch
          </TabsTrigger>
          <TabsTrigger value="enrichment-activation" data-testid="tab-enrichment-activation">
            <Zap className="w-3.5 h-3.5 mr-1" />
            Enrichment
          </TabsTrigger>
        </TabsList>

        <TabsContent value="runbook" className="space-y-4">
          <Day1Runbook />
        </TabsContent>

        <TabsContent value="wizard" className="space-y-4">
          <SendingIdentityWizard
            identities={identities}
            ghlHealth={ghlHealth}
            onTestGhl={() => ghlTestMutation.mutate()}
            ghlTesting={ghlTestMutation.isPending}
          />
        </TabsContent>

        <TabsContent value="status" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><Server className="w-4 h-4" /> App Health</CardTitle>
              </CardHeader>
              <CardContent>
                {appHealth ? (
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between"><span>Database</span><Badge variant={appHealth.db === "connected" ? "default" : "destructive"} data-testid="badge-db-status">{appHealth.db}</Badge></div>
                    <div className="flex justify-between"><span>Session Store</span><Badge variant={appHealth.session === "connected" ? "default" : "destructive"} data-testid="badge-session-status">{appHealth.session}</Badge></div>
                    <div className="flex justify-between"><span>Uptime</span><span data-testid="text-uptime">{Math.floor((appHealth.uptime || 0) / 60)}m</span></div>
                  </div>
                ) : <Loader2 className="w-4 h-4 animate-spin" />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><Radio className="w-4 h-4" /> GHL Connection</CardTitle>
              </CardHeader>
              <CardContent>
                {ghlHealth ? (
                  <div className="space-y-1 text-sm">
                    {ghlHealth.circuitOpen && (
                      <div className="flex items-start gap-2 rounded-md border border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 dark:border-yellow-600 px-3 py-2 mb-2" data-testid="banner-ghl-circuit-open">
                        <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="font-medium text-yellow-800 dark:text-yellow-300">GHL Circuit Breaker Open</p>
                          <p className="text-xs text-yellow-700 dark:text-yellow-400">{ghlHealth.consecutiveFailures} consecutive failures — sync is paused until reset.</p>
                        </div>
                      </div>
                    )}
                    <div className="flex justify-between"><span>Configured</span><Badge variant={ghlHealth.configured ? "default" : "destructive"} data-testid="badge-ghl-configured">{ghlHealth.configured ? "Yes" : "No"}</Badge></div>
                    <div className="flex justify-between"><span>Auth Test</span><Badge variant={ghlHealth.authTest ? "default" : "secondary"} data-testid="badge-ghl-auth">{ghlHealth.authTest ? "Pass" : "N/A"}</Badge></div>
                    <div className="flex justify-between"><span>Webhook Secret</span><Badge variant={ghlHealth.hasWebhookSecret ? "default" : "secondary"} data-testid="badge-ghl-webhook">{ghlHealth.hasWebhookSecret ? "Set" : "Missing"}</Badge></div>
                    <div className="flex justify-between items-center"><span>Circuit Breaker</span><Badge variant={ghlHealth.circuitOpen ? "destructive" : "default"} data-testid="badge-ghl-circuit">{ghlHealth.circuitOpen ? `Open (${ghlHealth.consecutiveFailures}/${ghlHealth.threshold})` : `Closed (${ghlHealth.consecutiveFailures}/${ghlHealth.threshold})`}</Badge></div>
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => ghlTestMutation.mutate()} disabled={ghlTestMutation.isPending} data-testid="button-test-ghl">
                        {ghlTestMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
                        Test & Bootstrap
                      </Button>
                      {ghlHealth.circuitOpen && (
                        <Button size="sm" variant="outline" className="flex-1 border-yellow-400 text-yellow-700 hover:bg-yellow-50 dark:border-yellow-600 dark:text-yellow-400" onClick={() => circuitResetMutation.mutate()} disabled={circuitResetMutation.isPending} data-testid="button-reset-circuit">
                          {circuitResetMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                          Reset Circuit
                        </Button>
                      )}
                    </div>
                  </div>
                ) : <Loader2 className="w-4 h-4 animate-spin" />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4" /> SDR Health</CardTitle>
              </CardHeader>
              <CardContent>
                {health ? (
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between"><span>Sending Identities</span><span data-testid="text-identity-count">{health.activeIdentityCount}/{health.sendingIdentityCount}</span></div>
                    <div className="flex justify-between"><span>Eligible Leads</span><span data-testid="text-eligible-leads">{health.eligibleLeadCount}</span></div>
                    <div className="flex justify-between"><span>Failures (24h)</span><Badge variant={health.recentFailures24h > 10 ? "destructive" : "secondary"} data-testid="badge-failures">{health.recentFailures24h}</Badge></div>
                    <div className="flex justify-between"><span>Orchestrator</span><Badge variant={health.orchestratorRunning ? "default" : "secondary"} data-testid="badge-orchestrator">{health.orchestratorRunning ? "Running" : "Stopped"}</Badge></div>
                    <div className="flex justify-between"><span>Last Sweep</span><span className="text-xs" data-testid="text-last-sweep">{health.lastSweepTime ? new Date(health.lastSweepTime).toLocaleTimeString() : "Never"}</span></div>
                    <div className="flex justify-between"><span>Webhook Heartbeat</span><span className="text-xs" data-testid="text-webhook-heartbeat">{health.webhookLastReceived ? new Date(health.webhookLastReceived).toLocaleString() : "None"}</span></div>
                  </div>
                ) : <Loader2 className="w-4 h-4 animate-spin" />}
              </CardContent>
            </Card>
          </div>

          {/* ── Feature Flag Risk Matrix ─────────────────────────── */}
          {(() => {
            const FLAG_META: Record<string, {
              risk: "high" | "medium" | "low";
              killLine: string;
              prerequisites: string;
              verifyCmd: string;
              defaultWarning?: string;
            }> = {
              SDR_ENABLED: {
                risk: "medium",
                killLine: "sequences + GHL outbound",
                prerequisites: "GHL token valid, SMS_ENABLED=false confirmed",
                verifyCmd: "npx tsx scripts/test-contactability.ts",
                defaultWarning: "Defaults to TRUE — disable before go-live if not ready to send",
              },
              ORCHESTRATOR_ENABLED: {
                risk: "medium",
                killLine: "orchestrator batch sends",
                prerequisites: "SDR_ENABLED=true, ORCHESTRATOR_REVIEW_MODE=true for first run",
                verifyCmd: "Activation Panel → Orchestrator tab",
              },
              SMS_ENABLED: {
                risk: "high",
                killLine: "ALL SMS channel sends",
                prerequisites: "PEWC evidence tier required for every recipient",
                verifyCmd: "npx tsx scripts/test-contactability.ts",
              },
              VOICE_AI_ENABLED: {
                risk: "high",
                killLine: "voice AI dials",
                prerequisites: "PEWC + verified phone number per contact",
                verifyCmd: "npx tsx scripts/compliance-scan.ts",
              },
              RINGLESS_VM_ENABLED: {
                risk: "high",
                killLine: "ringless voicemail drops",
                prerequisites: "PEWC full automation tier",
                verifyCmd: "npx tsx scripts/compliance-scan.ts",
              },
              NIGHTLY_DISCOVERY_ENABLED: {
                risk: "low",
                killLine: "nightly lead discovery",
                prerequisites: "Serper / Outscraper API keys configured",
                verifyCmd: "Operator Dashboard → Discovery Controls",
              },
              LEGACY_OUTREACH_ENABLED: {
                risk: "medium",
                killLine: "legacy outreach engine",
                prerequisites: "Replaces SDR engine — do not enable both simultaneously",
                verifyCmd: "Operator Dashboard",
              },
              SUNBIZ_ENRICHMENT_ENABLED: {
                risk: "low",
                killLine: "Sunbiz entity enrichment",
                prerequisites: "None — public data source",
                verifyCmd: "Operator Dashboard → Enrichment tab",
              },
              ORCHESTRATOR_REVIEW_MODE: {
                risk: "low",
                killLine: "none (safety flag — queues work for human review)",
                prerequisites: "ORCHESTRATOR_ENABLED=true",
                verifyCmd: "Activation Panel → Orchestrator tab",
              },
            };

            const riskColor = (r: string) =>
              r === "high" ? "text-red-600 dark:text-red-400" :
              r === "medium" ? "text-amber-600 dark:text-amber-400" :
              "text-green-600 dark:text-green-400";

            const riskBg = (r: string) =>
              r === "high" ? "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30" :
              r === "medium" ? "border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30" :
              "border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30";

            return (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Shield className="w-4 h-4" /> Feature Flag Risk Matrix
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* SDR_ENABLED=true default warning banner */}
                  {flags && flags.SDR_ENABLED === true && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-3" data-testid="flag-sdr-default-warning">
                      <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                      <div className="text-xs text-amber-800 dark:text-amber-300">
                        <strong>SDR_ENABLED is ON (default)</strong> — outbound sequences are active. Verify GHL token, confirm SMS_ENABLED=false, and run <code className="font-mono bg-amber-100 dark:bg-amber-900 px-1 rounded">test-contactability.ts</code> before scaling acquisition.
                      </div>
                    </div>
                  )}

                  {flags ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {Object.entries(flags).map(([key, value]) => {
                        const meta = FLAG_META[key];
                        const isEnabled = value === true;
                        const isNumeric = typeof value === "number";

                        return (
                          <div
                            key={key}
                            className={`rounded-md border p-2.5 ${meta ? riskBg(meta.risk) : "border-border bg-muted/30"}`}
                            data-testid={`flag-${key}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-xs font-mono font-semibold break-all">{key}</span>
                              <Badge
                                variant={isEnabled ? "default" : isNumeric ? "outline" : "secondary"}
                                className="shrink-0 text-xs"
                              >
                                {String(value)}
                              </Badge>
                            </div>

                            {meta && (
                              <div className="mt-1.5 space-y-0.5">
                                <div className={`text-xs font-medium ${riskColor(meta.risk)}`}>
                                  Risk: {meta.risk.toUpperCase()}
                                  {meta.defaultWarning && (
                                    <span className="ml-1 font-normal text-amber-700 dark:text-amber-300">— {meta.defaultWarning}</span>
                                  )}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  Kill line: <span className="font-medium">{meta.killLine}</span>
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  Prerequisites: {meta.prerequisites}
                                </div>
                                <div className="text-[10px] text-muted-foreground font-mono bg-background/60 rounded px-1 py-0.5 mt-1 overflow-hidden text-ellipsis whitespace-nowrap">
                                  {meta.verifyCmd}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading flags…
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          {/* ── Queue Health (all 8 queues — Wave 12) ───────────── */}
          {(() => {
            // Critical queues: failures here block go-live. Shown first.
            const CRITICAL_QUEUES = ["ghl-sync", "sequences", "onboarding-reminder", "mid-ingestion", "sla-checks"];
            // Non-critical queues: failures degrade features but don't block operations.
            const NON_CRITICAL_QUEUES = ["enrichment", "discovery", "digests"];
            // Expected interval in ms for stale-active detection (active > 2× interval = stale)
            const QUEUE_INTERVALS: Record<string, number> = {
              "ghl-sync": 45_000,
              "sla-checks": 300_000,
              "sequences": 30_000,
              "enrichment": 600_000,
              "discovery": 86_400_000,
              "digests": 3_600_000,
              "mid-ingestion": 86_400_000,
              "onboarding-reminder": 14_400_000,
            };
            const queueData = queueMetricsQuery.data;

            function redactError(msg: string | null | undefined): string {
              if (!msg) return "";
              const stripped = msg
                .replace(/Bearer\s+\S+/gi, "[TOKEN]")
                .replace(/\b[A-Za-z0-9+/]{40,}\b/g, "[REDACTED]")
                .replace(/key[=:\s]+[A-Za-z0-9+/=]{10,}/gi, "[KEY]")
                .replace(/password[=:\s]+\S+/gi, "[PASS]")
                .replace(/secret[=:\s]+\S+/gi, "[SECRET]")
                .replace(/token[=:\s]+\S+/gi, "[TOKEN]")
                .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]")
                .replace(/\b\d{2}-\d{7}\b/g, "[EIN]")
                .replace(/\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CARD]")
                .replace(/"body"\s*:\s*"[^"]{40,}"/g, '"body":"[REDACTED]"');
              return stripped.length > 120 ? stripped.slice(0, 117) + "…" : stripped;
            }

            function formatAge(isoStr: string | null | undefined): string {
              if (!isoStr) return "";
              const ms = Date.now() - new Date(isoStr).getTime();
              if (ms < 60_000) return "just now";
              if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
              if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
              return `${Math.floor(ms / 86_400_000)}d ago`;
            }

            function isStaleActive(q: QueueMetric): boolean {
              if (q.active <= 0) return false;
              const interval = QUEUE_INTERVALS[q.name];
              if (!interval || !q.lastCompletedAt) return false;
              const msSinceLast = Date.now() - new Date(q.lastCompletedAt).getTime();
              return msSinceLast > 2 * interval;
            }

            // Color: green=no failures, amber=failed+retrying (waiting/active>0), red=failed+exhausted
            function queueColor(q: QueueMetric): { dot: string; text: string; bg: string } {
              if (q.paused) return { dot: "bg-amber-400", text: "text-amber-700 dark:text-amber-400", bg: "" };
              if (q.workerSelected === false) return { dot: "bg-gray-300", text: "text-muted-foreground", bg: "" };
              if (q.workerActive === false) return { dot: "bg-red-500", text: "text-red-700 dark:text-red-400", bg: "bg-red-50/40 dark:bg-red-950/20" };
              if (q.failed === 0) return { dot: "bg-green-500", text: "text-green-700 dark:text-green-400", bg: "" };
              const hasRetrying = q.waiting > 0 || q.active > 0;
              if (hasRetrying) return { dot: "bg-amber-400", text: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50/50 dark:bg-amber-950/20" };
              return { dot: "bg-red-500", text: "text-red-700 dark:text-red-400", bg: "bg-red-50/40 dark:bg-red-950/20" };
            }

            function queueLabel(q: QueueMetric): string {
              if (q.paused) return "PAUSED";
              if (q.workerSelected === false) return "NOT SELECTED";
              if (q.workerActive === false) return "WORKER OFFLINE";
              if (q.workerActive === true && !q.lastCompletedAt) return "AWAITING LOCAL TICK";
              if (isStaleActive(q)) return "STALE";
              if (q.failed > 0 && q.waiting === 0 && q.active === 0) return "EXHAUSTED";
              if (q.failed > 0) return "RETRYING";
              if (q.active > 0) return "RUNNING";
              return "IDLE";
            }

            function QueueRow({ qName, isCritical }: { qName: string; isCritical: boolean }) {
              const q = queueData?.queues.find(x => x.name === qName);
              const colors = q ? queueColor(q) : { dot: "bg-gray-300", text: "text-muted-foreground", bg: "" };
              return (
                <div
                  key={qName}
                  className={`py-1.5 border-b last:border-0 rounded px-1 ${colors.bg}`}
                  data-testid={`queue-row-${qName}`}
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`} />
                    <span className="font-mono font-medium flex-1">{qName}</span>
                    {isCritical && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 border-red-300 text-red-600">Critical</Badge>
                    )}
                    {q ? (
                      <span className={`font-semibold text-xs ${colors.text}`}>{queueLabel(q)}</span>
                    ) : (
                      <Badge variant="secondary" className="text-[9px]">not registered</Badge>
                    )}
                  </div>
                  {q && (
                    <>
                      <div className="flex gap-3 mt-0.5 ml-3 text-[10px] text-muted-foreground">
                        <span>wait:<strong className="ml-0.5">{q.waiting}</strong></span>
                        <span>active:<strong className={`ml-0.5 ${isStaleActive(q) ? "text-amber-600" : ""}`}>{q.active}{isStaleActive(q) ? " ⚠" : ""}</strong></span>
                        <span>failed:<strong className={`ml-0.5 ${q.failed > 0 ? colors.text : ""}`}>{q.failed}</strong></span>
                        <span>retained done:<strong className="ml-0.5">{q.completed}</strong></span>
                      </div>
                      {q.lastCompletedAt && (
                        <div className="ml-3 text-[10px] text-muted-foreground">
                          current process last completed: {formatAge(q.lastCompletedAt)}
                        </div>
                      )}
                      {!q.lastCompletedAt && q.lastRetainedRedisCompletedAt && (
                        <div className="ml-3 text-[10px] text-amber-700 dark:text-amber-400">
                          Redis retains a completion from {formatAge(q.lastRetainedRedisCompletedAt)}; current process has not completed this queue since restart.
                        </div>
                      )}
                      {q.lastFailedAt && q.failed > 0 && (
                        <div className={`ml-3 text-[10px] ${colors.text}`}>
                          last failed: {formatAge(q.lastFailedAt)}
                        </div>
                      )}
                      {q.lastError && (
                        <div className="ml-3 mt-0.5 text-[10px] text-red-600 dark:text-red-400 font-mono bg-red-50 dark:bg-red-950/30 rounded px-1.5 py-0.5 break-all">
                          {redactError(q.lastError)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            }

            return (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-sm flex items-center gap-2 flex-1">
                      <Activity className="w-4 h-4" /> Queue Health
                      <span className="text-[10px] font-normal text-muted-foreground">(all 8)</span>
                    </CardTitle>
                    {queueData?.queueMode && queueData.queueMode !== "bullmq_redis" && (
                      <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
                        queue mode: {queueData?.queueMode ?? "unavailable"}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => queueMetricsQuery.refetch()}
                      data-testid="btn-refresh-queue-metrics"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-0">
                  {queueMetricsQuery.isLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading queue metrics…
                    </div>
                  ) : queueMetricsQuery.isError ? (
                    <div className="text-sm text-muted-foreground py-2">
                      Queue metrics unavailable — check <a href="/dashboard/operator" className="underline">Operator Dashboard → Job Queue</a>.
                    </div>
                  ) : queueData ? (
                    <div className="space-y-0.5">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide pt-1 pb-0.5">Critical</p>
                      {CRITICAL_QUEUES.map(n => <QueueRow key={n} qName={n} isCritical={true} />)}
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide pt-2 pb-0.5">Non-Critical</p>
                      {NON_CRITICAL_QUEUES.map(n => <QueueRow key={n} qName={n} isCritical={false} />)}
                      <div className="pt-2 text-[10px] text-muted-foreground">
                        Dead-letter queue:{" "}
                        <a href="/review-queue" className="underline text-primary">
                          /review-queue
                        </a>
                        {" "}— review failed jobs, retry or discard.
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground py-2">No queue data available.</div>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2"><Mail className="w-4 h-4" /> Sending Identities</CardTitle>
                <Dialog open={identityDialogOpen} onOpenChange={setIdentityDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" onClick={openCreateIdentity} data-testid="button-add-identity">
                      <Plus className="w-3 h-3 mr-1" /> Add Identity
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{editingIdentityId ? "Edit Sending Identity" : "Add Sending Identity"}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div className="space-y-2">
                        <Label>Label</Label>
                        <Input
                          value={identityForm.label}
                          onChange={e => setIdentityForm(f => ({ ...f, label: e.target.value }))}
                          placeholder="e.g. Main Sales"
                          data-testid="input-identity-label"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Email Address</Label>
                        <Input
                          type="email"
                          value={identityForm.emailAddress}
                          onChange={e => setIdentityForm(f => ({ ...f, emailAddress: e.target.value }))}
                          placeholder="sales@example.com"
                          data-testid="input-identity-email"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Daily Limit</Label>
                          <Input
                            type="number"
                            value={identityForm.dailyLimit}
                            onChange={e => setIdentityForm(f => ({ ...f, dailyLimit: e.target.value }))}
                            min={1}
                            max={200}
                            data-testid="input-identity-limit"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Status</Label>
                          <Select value={identityForm.status} onValueChange={v => setIdentityForm(f => ({ ...f, status: v }))}>
                            <SelectTrigger data-testid="select-identity-status"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="active">Active</SelectItem>
                              <SelectItem value="paused">Paused</SelectItem>
                              <SelectItem value="warming">Warming</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 pt-2">
                        <DialogClose asChild>
                          <Button variant="outline" data-testid="button-identity-cancel">Cancel</Button>
                        </DialogClose>
                        <Button
                          onClick={handleIdentitySave}
                          disabled={identitySaving || !identityForm.label || !identityForm.emailAddress}
                          data-testid="button-identity-save"
                        >
                          {identitySaving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                          {editingIdentityId ? "Update" : "Create"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {identitiesQuery.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="py-1 pr-4">Label</th>
                        <th className="py-1 pr-4">Email</th>
                        <th className="py-1 pr-4">Status</th>
                        <th className="py-1 pr-4">Daily Limit</th>
                        <th className="py-1 pr-4">Today Sent</th>
                        <th className="py-1 pr-4">Health</th>
                        <th className="py-1">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {identities.length === 0 ? (
                        <tr><td colSpan={7} className="py-4 text-center text-muted-foreground">No sending identities configured</td></tr>
                      ) : identities.map((id) => (
                        <tr key={id.id} className="border-b" data-testid={`identity-row-${id.id}`}>
                          <td className="py-1 pr-4">{id.label}</td>
                          <td className="py-1 pr-4 font-mono text-xs">{id.emailAddress}</td>
                          <td className="py-1 pr-4"><Badge variant={id.status === "active" ? "default" : "secondary"}>{id.status}</Badge></td>
                          <td className="py-1 pr-4">{id.dailyLimit}</td>
                          <td className="py-1 pr-4">{id.sentToday || 0}</td>
                          <td className="py-1 pr-4">{id.healthScore ?? "N/A"}</td>
                          <td className="py-1">
                            <Button size="sm" variant="ghost" onClick={() => openEditIdentity(id)} data-testid={`button-edit-identity-${id.id}`}>
                              <Pencil className="w-3 h-3" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="readiness" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <ListChecks className="w-4 h-4" /> Go-Live Readiness Checklist
                  </CardTitle>
                  {readinessQuery.data && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {readinessQuery.data.passCount} of {readinessQuery.data.totalChecks} checks passing
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {readinessQuery.data && (
                    <Badge
                      variant={readinessQuery.data.ready ? "default" : "destructive"}
                      data-testid="badge-readiness-status"
                    >
                      {readinessQuery.data.ready ? "Ready" : "Not Ready"}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/operator/readiness-checks"] })}
                    disabled={readinessQuery.isFetching}
                    data-testid="button-recheck-readiness"
                  >
                    {readinessQuery.isFetching ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                    Re-check
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {readinessQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Running checks…
                </div>
              ) : readinessQuery.data ? (
                <div className="space-y-2">
                  {readinessQuery.data.checks.map((check) => (
                    <div
                      key={check.id}
                      className="flex items-start gap-3 p-3 rounded border"
                      data-testid={`readiness-check-${check.id}`}
                    >
                      {check.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{check.label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{check.detail}</div>
                      </div>
                      <Badge variant={check.ok ? "default" : "destructive"} className="shrink-0 text-xs">
                        {check.ok ? "Pass" : "Fail"}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Failed to load readiness checks.</div>
              )}
            </CardContent>
          </Card>
          <LaunchReadinessChecklist />
          <SalesRepOpsCard />
        </TabsContent>

        <TabsContent value="bridge" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2"><ArrowRightLeft className="w-4 h-4" /> Bridge Script</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Source</Label>
                  <Select value={bridgeSource} onValueChange={setBridgeSource}>
                    <SelectTrigger data-testid="select-bridge-source"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contacts">Contacts</SelectItem>
                      <SelectItem value="sunbiz">Sunbiz Entities</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Limit</Label>
                  <Input type="number" value={bridgeLimit} onChange={e => setBridgeLimit(e.target.value)} min={1} max={500} data-testid="input-bridge-limit" />
                </div>
                <div className="space-y-2">
                  <Label>Vertical Filter</Label>
                  <Input placeholder="e.g. Auto, Healthcare..." value={bridgeVertical} onChange={e => setBridgeVertical(e.target.value)} data-testid="input-bridge-vertical" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Geography Filter</Label>
                  <Input placeholder="e.g. Miami, FL..." value={bridgeGeo} onChange={e => setBridgeGeo(e.target.value)} data-testid="input-bridge-geo" />
                </div>
                <div className="flex items-end gap-4">
                  <div className="flex items-center gap-2">
                    <Switch checked={bridgeDryRun} onCheckedChange={setBridgeDryRun} data-testid="switch-dry-run" />
                    <Label>Dry Run</Label>
                  </div>
                  <Button onClick={() => bridgeMutation.mutate()} disabled={bridgeMutation.isPending} data-testid="button-run-bridge">
                    {bridgeMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Play className="w-4 h-4 mr-1" />}
                    {bridgeDryRun ? "Preview" : "Run Bridge"}
                  </Button>
                </div>
              </div>

              {bridgeResults && (
                <div className="mt-4 space-y-3">
                  <div className="flex gap-3 flex-wrap">
                    <Badge variant="outline">Source: {bridgeResults.source}</Badge>
                    <Badge variant={bridgeResults.dryRun ? "secondary" : "default"}>{bridgeResults.dryRun ? "DRY RUN" : "LIVE"}</Badge>
                    <Badge variant="outline">Processed: {bridgeResults.totalProcessed}</Badge>
                    <Badge className="bg-green-500/20 text-green-700">Created: {bridgeResults.created}</Badge>
                    <Badge className="bg-yellow-500/20 text-yellow-700">Deduped: {bridgeResults.deduped}</Badge>
                    <Badge className="bg-gray-500/20">Skipped: {bridgeResults.skipped}</Badge>
                    {bridgeResults.errors > 0 && <Badge variant="destructive">Errors: {bridgeResults.errors}</Badge>}
                  </div>
                  <div className="max-h-64 overflow-auto border rounded">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-background">
                        <tr className="border-b text-left">
                          <th className="py-1 px-2">ID</th>
                          <th className="py-1 px-2">Name</th>
                          <th className="py-1 px-2">Status</th>
                          <th className="py-1 px-2">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bridgeResults.results.map((r, i) => (
                          <tr key={i} className="border-b">
                            <td className="py-1 px-2">{r.id}</td>
                            <td className="py-1 px-2">{r.name}</td>
                            <td className="py-1 px-2">
                              <Badge variant={r.status === "created" || r.status === "would_create" ? "default" : r.status === "error" ? "destructive" : "secondary"} className="text-xs">
                                {r.status}
                              </Badge>
                            </td>
                            <td className="py-1 px-2 text-muted-foreground">{r.reason || r.vertical || ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orchestrator" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2"><Zap className="w-4 h-4" /> Orchestrator Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {orchestratorStatus ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div className="p-3 border rounded">
                      <div className="text-xs text-muted-foreground">Status</div>
                      <Badge variant={orchestratorStatus.running ? "default" : "secondary"} className="mt-1" data-testid="badge-orchestrator-status">
                        {orchestratorStatus.running ? "Running" : "Stopped"}
                      </Badge>
                    </div>
                    <div className="p-3 border rounded">
                      <div className="text-xs text-muted-foreground">Emails Today</div>
                      <div className="text-lg font-bold" data-testid="text-emails-today">{orchestratorStatus.dailyLimits?.email?.sent || 0} / {orchestratorStatus.dailyLimits?.email?.limit || 200}</div>
                    </div>
                    <div className="p-3 border rounded">
                      <div className="text-xs text-muted-foreground">SMS Today</div>
                      <div className="text-lg font-bold" data-testid="text-sms-today">{orchestratorStatus.dailyLimits?.sms?.sent || 0} / {orchestratorStatus.dailyLimits?.sms?.limit || 100}</div>
                    </div>
                    <div className="p-3 border rounded">
                      <div className="text-xs text-muted-foreground">Calls Today</div>
                      <div className="text-lg font-bold" data-testid="text-calls-today">{orchestratorStatus.dailyLimits?.call?.made || 0} / {orchestratorStatus.dailyLimits?.call?.limit || 50}</div>
                    </div>
                    <div className="p-3 border rounded">
                      <div className="text-xs text-muted-foreground">Webhook Failures</div>
                      <div className="text-lg font-bold" data-testid="text-webhook-failures">
                        <Badge variant={orchestratorStatus.webhookFailures > 10 ? "destructive" : "secondary"}>
                          {orchestratorStatus.webhookFailures}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  {!orchestratorStatus.enabled && (
                    <div className="p-2 border border-yellow-500/50 bg-yellow-500/10 rounded text-sm text-yellow-700">
                      <AlertTriangle className="w-4 h-4 inline mr-1" />
                      Orchestrator is disabled via ORCHESTRATOR_ENABLED feature flag. Enable it in environment variables to allow starting.
                    </div>
                  )}
                  <div className="flex gap-2">
                    {orchestratorStatus.running ? (
                      <Button variant="destructive" size="sm" onClick={() => stopOrchestratorMutation.mutate()} disabled={stopOrchestratorMutation.isPending} data-testid="button-stop-orchestrator">
                        <Square className="w-4 h-4 mr-1" /> Stop
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => startOrchestratorMutation.mutate()} disabled={startOrchestratorMutation.isPending || !orchestratorStatus.enabled} data-testid="button-start-orchestrator">
                        <Play className="w-4 h-4 mr-1" /> Start
                      </Button>
                    )}
                  </div>
                </>
              ) : <Loader2 className="w-4 h-4 animate-spin" />}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Recent Outbound Attempts (50)</CardTitle>
              </CardHeader>
              <CardContent>
                {attemptsQuery.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-background">
                        <tr className="border-b text-left">
                          <th className="py-1 px-1">Time</th>
                          <th className="py-1 px-1">Channel</th>
                          <th className="py-1 px-1">Status</th>
                          <th className="py-1 px-1">Lead</th>
                          <th className="py-1 px-1">Subject</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attempts.length === 0 ? (
                          <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">No recent attempts</td></tr>
                        ) : attempts.map((a) => (
                          <tr key={a.id} className="border-b" data-testid={`attempt-row-${a.id}`}>
                            <td className="py-1 px-1">{a.sentAt ? new Date(a.sentAt).toLocaleTimeString() : "-"}</td>
                            <td className="py-1 px-1"><Badge variant="outline" className="text-xs">{a.channel}</Badge></td>
                            <td className="py-1 px-1">
                              {a.status === "sent" ? <CheckCircle2 className="w-3 h-3 text-green-500" /> : <XCircle className="w-3 h-3 text-red-500" />}
                            </td>
                            <td className="py-1 px-1">{a.leadStateId}</td>
                            <td className="py-1 px-1 max-w-32 truncate">{a.subject || a.body?.slice(0, 40) || "-"}</td>
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
                <CardTitle className="text-sm">Recent Webhook Events (50)</CardTitle>
              </CardHeader>
              <CardContent>
                {eventsQuery.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-background">
                        <tr className="border-b text-left">
                          <th className="py-1 px-1">Time</th>
                          <th className="py-1 px-1">Type</th>
                          <th className="py-1 px-1">Lead</th>
                          <th className="py-1 px-1">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.length === 0 ? (
                          <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">No recent events</td></tr>
                        ) : events.map((e) => (
                          <tr key={e.id} className="border-b" data-testid={`event-row-${e.id}`}>
                            <td className="py-1 px-1">{e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : "-"}</td>
                            <td className="py-1 px-1"><Badge variant="outline" className="text-xs">{e.eventType}</Badge></td>
                            <td className="py-1 px-1">{e.leadStateId}</td>
                            <td className="py-1 px-1 max-w-48 truncate">{e.decisionReason || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="stuck" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Stuck Leads</CardTitle>
            </CardHeader>
            <CardContent>
              {stuckQuery.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <div className="max-h-96 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b text-left">
                        <th className="py-1 px-2">ID</th>
                        <th className="py-1 px-2">Company</th>
                        <th className="py-1 px-2">Stage</th>
                        <th className="py-1 px-2">Next Action</th>
                        <th className="py-1 px-2">Due At</th>
                        <th className="py-1 px-2">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stuckLeads.length === 0 ? (
                        <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">No stuck leads</td></tr>
                      ) : stuckLeads.map((l) => (
                        <tr key={l.id} className="border-b" data-testid={`stuck-row-${l.id}`}>
                          <td className="py-1 px-2">{l.id}</td>
                          <td className="py-1 px-2">{l.companyName || "Unknown"}</td>
                          <td className="py-1 px-2"><Badge variant="outline">{l.stage}</Badge></td>
                          <td className="py-1 px-2">{l.nextActionType || "-"}</td>
                          <td className="py-1 px-2 text-muted-foreground">{l.nextActionAt ? new Date(l.nextActionAt).toLocaleString() : "-"}</td>
                          <td className="py-1 px-2 text-muted-foreground">{l.updatedAt ? new Date(l.updatedAt).toLocaleString() : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="deal-backfill" className="space-y-4">
          <DealBackfillPanel />
        </TabsContent>

        <TabsContent value="compliance" className="space-y-4">
          <ComplianceChannelTab data={complianceQuery.data} isLoading={complianceQuery.isLoading} />
          <ChannelSafetyMatrix query={channelSafetyQuery} />
          <BlockReasonSummaryCard />
          <ChannelApprovalGate />
        </TabsContent>

        <TabsContent value="kill-switch" className="space-y-4">
          <OutboundKillSwitchPanel />
        </TabsContent>

        <TabsContent value="enrichment-activation" className="space-y-4">
          <EnrichmentActivationPanelLazy />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Deal Backfill Panel ─────────────────────────────────────────────────────────
interface BackfillPreviewResult {
  totalOrphanContacts: number;
  wouldCreateDeals: number;
  skippedCold: number;
  skippedExistingDeal: number;
  skippedMissingIdentity: number;
  skippedDuplicateBusiness: number;
  skippedPlaceholderEmailOnly: number;
  skippedSuppressedOrDnc: number;
  skippedAnonymous: number;
  sampleCandidates: Array<{ id: number; firstName: string; lastName: string; email: string; companyName: string | null; leadScore: number | null }>;
}

interface BackfillProgress {
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  processed: number;
  total: number;
  dealsCreated: number;
  skipped: number;
  skippedBreakdown: { cold: number; existingDeal: number; missingIdentity: number; duplicateBusiness: number; placeholderEmailOnly: number; suppressedOrDnc: number; anonymous: number };
  lastProcessedContactId: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  cancelRequested: boolean;
  error: string | null;
}

function DealBackfillPanel() {
  const { toast } = useToast();
  const [minScore, setMinScore] = useState("45");
  const [source, setSource] = useState("");
  const [vertical, setVertical] = useState("");
  const [preview, setPreview] = useState<BackfillPreviewResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [isPreviewing, setIsPreviewing] = useState(false);

  const statusQuery = useQuery<BackfillProgress>({
    queryKey: ["/api/admin/contacts/backfill-deals/status"],
    refetchInterval: (data) => {
      const d = data?.state?.data as BackfillProgress | undefined;
      return d?.status === "running" ? 3000 : 30000;
    },
  });

  const autoCreateQuery = useQuery<{ autoCreateDealsForWarmContacts: boolean }>({
    queryKey: ["/api/admin/settings/auto-create-deals-for-warm-contacts"],
  });

  const autoCreateMutation = useMutation({
    mutationFn: (enabled: boolean) => apiRequest("PUT", "/api/admin/settings/auto-create-deals-for-warm-contacts", { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/settings/auto-create-deals-for-warm-contacts"] });
      toast({ title: "Setting saved" });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err?.message, variant: "destructive" }),
  });

  const startMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/contacts/backfill-deals", {
      confirmed: true,
      confirmationText: confirmText,
      minScore: Number(minScore),
      batchSize: 200,
      source: source || undefined,
      vertical: vertical || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/backfill-deals/status"] });
      toast({ title: "Backfill started", description: "Processing contacts in background batches." });
      setPreview(null);
      setConfirmText("");
    },
    onError: (err: any) => toast({ title: "Start failed", description: err?.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/contacts/backfill-deals/cancel", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts/backfill-deals/status"] });
      toast({ title: "Cancel requested", description: "Backfill will stop after its current batch." });
    },
    onError: (err: any) => toast({ title: "Cancel failed", description: err?.message, variant: "destructive" }),
  });

  const handlePreview = async () => {
    setIsPreviewing(true);
    try {
      const res = await apiRequest("POST", "/api/admin/contacts/backfill-deals/preview", {
        minScore: Number(minScore),
        source: source || undefined,
        vertical: vertical || undefined,
        limit: 5000,
      });
      const result = await res.json();
      setPreview(result as BackfillPreviewResult);
    } catch (err: any) {
      toast({ title: "Preview failed", description: err?.message, variant: "destructive" });
    } finally {
      setIsPreviewing(false);
    }
  };

  const progress = statusQuery.data;
  const isRunning = progress?.status === "running";
  const pct = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const needsConfirmation = preview && preview.wouldCreateDeals >= 100;

  return (
    <div className="space-y-4">
      {/* Future-Orphan Guard Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Shield className="w-4 h-4" />
            Future Orphan Guard
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            When enabled, the SDR orchestrator will automatically create a CRM deal the moment a contact scores warm (≥45) or hot (≥70) and has no linked deal. When disabled, orphan candidates are logged to the audit trail but no deal is created.
          </p>
          {autoCreateQuery.isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <div className="flex items-center gap-3">
              <Switch
                data-testid="switch-auto-create-deals"
                checked={autoCreateQuery.data?.autoCreateDealsForWarmContacts ?? false}
                onCheckedChange={(v) => autoCreateMutation.mutate(v)}
                disabled={autoCreateMutation.isPending}
              />
              <Label className="text-sm">
                {autoCreateQuery.data?.autoCreateDealsForWarmContacts ? "Auto-create ON" : "Auto-create OFF (log only)"}
              </Label>
              {autoCreateMutation.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>
          )}
        </CardContent>
      </Card>

      {/* One-time Backfill */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="w-4 h-4" />
            One-Time Deal Backfill
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Creates CRM deals for existing contacts that have a lead score ≥ 45 but no linked deal. No outreach or sequences are triggered.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs mb-1">Min Lead Score</Label>
              <Input
                data-testid="input-backfill-min-score"
                value={minScore}
                onChange={(e) => setMinScore(e.target.value)}
                type="number"
                min="45"
                max="100"
                className="h-8 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs mb-1">Source Filter (optional)</Label>
              <Input
                data-testid="input-backfill-source"
                placeholder="e.g. sunbiz"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs mb-1">Vertical Filter (optional)</Label>
              <Input
                data-testid="input-backfill-vertical"
                placeholder="e.g. restaurant"
                value={vertical}
                onChange={(e) => setVertical(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
          </div>

          <Button
            data-testid="button-backfill-preview"
            variant="outline"
            size="sm"
            onClick={handlePreview}
            disabled={isPreviewing || isRunning}
            className="w-full"
          >
            {isPreviewing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />}
            Preview Eligible Contacts
          </Button>

          {preview && (
            <div className="border rounded-md p-3 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <div className="text-center p-2 bg-muted/50 rounded">
                  <div className="text-lg font-bold text-green-600" data-testid="text-preview-would-create">{preview.wouldCreateDeals.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Would Create</div>
                </div>
                <div className="text-center p-2 bg-muted/50 rounded">
                  <div className="text-lg font-bold">{preview.totalOrphanContacts.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Orphan Contacts</div>
                </div>
                <div className="text-center p-2 bg-muted/50 rounded">
                  <div className="text-lg font-bold text-amber-600">{preview.skippedCold.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Too Cold</div>
                </div>
                <div className="text-center p-2 bg-muted/50 rounded">
                  <div className="text-lg font-bold text-muted-foreground">{(preview.skippedAnonymous + preview.skippedMissingIdentity + preview.skippedPlaceholderEmailOnly + preview.skippedSuppressedOrDnc + preview.skippedDuplicateBusiness).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Other Skips</div>
                </div>
              </div>

              {preview.sampleCandidates.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-1 text-muted-foreground">Sample candidates:</p>
                  <div className="space-y-1">
                    {preview.sampleCandidates.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 text-xs border rounded px-2 py-1" data-testid={`row-sample-contact-${c.id}`}>
                        <Users className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="font-medium">{c.firstName} {c.lastName}</span>
                        {c.companyName && <span className="text-muted-foreground">({c.companyName})</span>}
                        <Badge variant="outline" className="ml-auto text-xs">Score: {c.leadScore}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {needsConfirmation && (
                <div className="space-y-2">
                  <p className="text-xs text-amber-600 font-medium">
                    {preview.wouldCreateDeals.toLocaleString()} deals will be created. Type <code className="bg-muted px-1 rounded">CREATE DEALS</code> to confirm:
                  </p>
                  <Input
                    data-testid="input-backfill-confirm"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder='Type "CREATE DEALS"'
                    className="h-8 text-sm font-mono"
                  />
                </div>
              )}

              <Button
                data-testid="button-backfill-start"
                variant="default"
                size="sm"
                className="w-full"
                onClick={() => startMutation.mutate()}
                disabled={
                  startMutation.isPending ||
                  isRunning ||
                  preview.wouldCreateDeals === 0 ||
                  !!(needsConfirmation && confirmText !== "CREATE DEALS")
                }
              >
                {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                {isRunning ? "Already Running…" : `Create ${preview.wouldCreateDeals.toLocaleString()} Deals`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live Status */}
      {progress && progress.status !== "idle" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="w-4 h-4" />
              Backfill Status
              {statusQuery.isFetching && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              {progress.status === "running" && <Badge variant="default" className="bg-blue-600" data-testid="badge-backfill-running">Running</Badge>}
              {progress.status === "completed" && <Badge variant="default" className="bg-green-600" data-testid="badge-backfill-completed">Completed</Badge>}
              {progress.status === "failed" && <Badge variant="destructive" data-testid="badge-backfill-failed">Failed</Badge>}
              {progress.status === "cancelled" && <Badge variant="outline" data-testid="badge-backfill-cancelled">Cancelled</Badge>}
              {progress.status === "running" && (
                <span className="text-xs text-muted-foreground">{pct}% — {progress.processed.toLocaleString()} / {progress.total.toLocaleString()}</span>
              )}
            </div>

            {progress.status === "running" && progress.total > 0 && (
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} data-testid="bar-backfill-progress" />
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="text-center p-2 bg-muted/50 rounded">
                <div className="font-bold text-green-600" data-testid="text-deals-created">{progress.dealsCreated.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Created</div>
              </div>
              <div className="text-center p-2 bg-muted/50 rounded">
                <div className="font-bold">{progress.skipped.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Skipped</div>
              </div>
              <div className="text-center p-2 bg-muted/50 rounded">
                <div className="font-bold">{progress.processed.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Processed</div>
              </div>
            </div>

            {progress.error && (
              <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2" data-testid="text-backfill-error">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>{progress.error}</span>
              </div>
            )}

            {progress.startedAt && (
              <p className="text-xs text-muted-foreground">
                Started: {new Date(progress.startedAt).toLocaleString()}
                {progress.completedAt && <> · Completed: {new Date(progress.completedAt).toLocaleString()}</>}
                {progress.updatedAt && progress.status === "running" && <> · Last update: {new Date(progress.updatedAt).toLocaleString()}</>}
              </p>
            )}

            {progress.status === "running" && (
              <Button
                data-testid="button-backfill-cancel"
                variant="outline"
                size="sm"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending || progress.cancelRequested}
                className="w-full"
              >
                {cancelMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Square className="w-4 h-4 mr-2" />}
                {progress.cancelRequested ? "Cancel Requested…" : "Cancel Backfill"}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Outbound Kill Switch & Daily Cap Panel (Task #792) ─────────────────────────
function OutboundKillSwitchPanel() {
  const { toast } = useToast();
  const [reasonDraft, setReasonDraft] = useState<string>("");
  const [capDraft, setCapDraft] = useState<string>("");
  const [capEditing, setCapEditing] = useState(false);

  const settingsQuery = useQuery<OutboundSettings>({
    queryKey: ["/api/system/outbound-settings"],
    refetchInterval: 30_000,
  });

  const data = settingsQuery.data;

  useEffect(() => {
    if (data && !capEditing) {
      setCapDraft(String(data.outboundDailyEmailCap));
    }
    if (data && data.outboundGlobalPausedReason !== null && reasonDraft === "") {
      setReasonDraft(data.outboundGlobalPausedReason ?? "");
    }
  }, [data]);

  const patchMutation = useMutation({
    mutationFn: (body: Partial<OutboundSettings & { outboundGlobalPausedReason: string | null }>) =>
      apiRequest("PATCH", "/api/system/outbound-settings", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/system/outbound-settings"] });
      toast({ title: "Outbound settings saved", description: "Changes take effect on the next worker tick." });
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const togglePause = () => {
    if (!data) return;
    patchMutation.mutate({
      outboundGlobalPaused: !data.outboundGlobalPaused,
      outboundGlobalPausedReason: reasonDraft || null,
    });
  };

  const saveCap = () => {
    const val = parseInt(capDraft, 10);
    if (!isNaN(val) && val > 0) {
      patchMutation.mutate({ outboundDailyEmailCap: val });
      setCapEditing(false);
    }
  };

  const isPaused = data?.outboundGlobalPaused ?? false;
  const sendsToday = data?.coldEmailSendsToday ?? 0;
  const cap = data?.outboundDailyEmailCap ?? 200;
  const remaining = data?.coldEmailRemainingToday ?? cap;
  const usePct = cap > 0 ? Math.round((sendsToday / cap) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Global Pause Banner */}
      {isPaused && (
        <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-700 p-4" data-testid="banner-global-paused">
          <BanIcon className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-red-800 dark:text-red-300">Global Outbound Pause Is Active</p>
            <p className="text-sm text-red-700 dark:text-red-400 mt-0.5">
              All sequence email steps are blocked. The sequence worker will pause each enrollment until this is turned off.
            </p>
            {data?.outboundGlobalPausedReason && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1 font-mono">Reason: {data.outboundGlobalPausedReason}</p>
            )}
          </div>
        </div>
      )}

      {/* Kill Switch Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BanIcon className="w-4 h-4 text-red-500" />
            Global Outbound Kill Switch
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {settingsQuery.isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <Label className="font-medium">Pause All Outbound Sends</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Checked → the sequence worker halts every cold-outreach email step on the next tick. Uncheck to resume.
                  </p>
                </div>
                <Switch
                  checked={isPaused}
                  onCheckedChange={togglePause}
                  disabled={patchMutation.isPending}
                  data-testid="switch-global-pause"
                  aria-label="Toggle global outbound pause"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pause-reason">Pause Reason <span className="text-muted-foreground text-xs">(optional, logged in audit trail)</span></Label>
                <div className="flex gap-2">
                  <Input
                    id="pause-reason"
                    value={reasonDraft}
                    onChange={e => setReasonDraft(e.target.value)}
                    placeholder="e.g. Compliance review — hold until 2026-07-15"
                    className="flex-1"
                    data-testid="input-pause-reason"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => patchMutation.mutate({ outboundGlobalPausedReason: reasonDraft || null })}
                    disabled={patchMutation.isPending}
                    data-testid="button-save-pause-reason"
                  >
                    Save
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Daily Email Cap Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Gauge className="w-4 h-4 text-blue-500" />
            Daily Cold Email Cap
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {settingsQuery.isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              {/* Send gauge */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">{sendsToday.toLocaleString()} sent today</span>
                  <span className="text-muted-foreground">{remaining.toLocaleString()} remaining / {cap.toLocaleString()} cap</span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${usePct >= 100 ? "bg-red-500" : usePct >= 80 ? "bg-amber-500" : "bg-green-500"}`}
                    style={{ width: `${Math.min(usePct, 100)}%` }}
                    data-testid="bar-daily-cap-progress"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {usePct}% of daily cap used. Resets at midnight UTC.
                </p>
              </div>

              {/* Cap editor */}
              <div className="space-y-1.5">
                <Label htmlFor="daily-cap">Daily Cap (emails / day)</Label>
                <div className="flex gap-2">
                  <Input
                    id="daily-cap"
                    type="number"
                    min={1}
                    max={2000}
                    value={capDraft}
                    onChange={e => { setCapDraft(e.target.value); setCapEditing(true); }}
                    className="w-36"
                    data-testid="input-daily-cap"
                  />
                  <Button
                    size="sm"
                    onClick={saveCap}
                    disabled={patchMutation.isPending || !capEditing}
                    data-testid="button-save-daily-cap"
                  >
                    {patchMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    Apply Cap
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  When today's cold outreach email count reaches this number, new enrollments are deferred to tomorrow.
                  Only cold-outreach sequence emails are counted — transactional emails (onboarding, merchant welcome) are not capped.
                </p>
              </div>

              {/* Status summary */}
              <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-xs" data-testid="outbound-status-summary">
                <div className="flex justify-between">
                  <span>Kill switch</span>
                  <Badge variant={isPaused ? "destructive" : "default"} data-testid="badge-kill-switch-status">
                    {isPaused ? "PAUSED" : "Active"}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span>Sends today (cold email)</span>
                  <span className="font-mono" data-testid="text-sends-today">{sendsToday}</span>
                </div>
                <div className="flex justify-between">
                  <span>Daily cap</span>
                  <span className="font-mono" data-testid="text-daily-cap">{cap}</span>
                </div>
                <div className="flex justify-between">
                  <span>Remaining today</span>
                  <span className={`font-mono ${remaining === 0 ? "text-red-600" : ""}`} data-testid="text-remaining-today">{remaining}</span>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function channelIcon(icon: string) {
  const cls = "w-5 h-5 shrink-0";
  switch (icon) {
    case "mail": return <Mail className={cls} />;
    case "phone": return <Phone className={cls} />;
    case "message-square": return <MessageSquare className={cls} />;
    case "mic": return <Mic className={cls} />;
    case "voicemail": return <Voicemail className={cls} />;
    case "search": return <Search className={cls} />;
    default: return <Radio className={cls} />;
  }
}

function statusConfig(status: ComplianceChannel["status"]) {
  switch (status) {
    case "safe":    return { label: "Safe to Use",   variant: "default"     as const, color: "text-green-700 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800",  icon: <CheckCircle2 className="w-4 h-4 text-green-600" /> };
    case "warning": return { label: "Use With Care", variant: "secondary"   as const, color: "text-amber-700 dark:text-amber-400",   bg: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-700",  icon: <AlertTriangle className="w-4 h-4 text-amber-600" /> };
    case "blocked": return { label: "Blocked",       variant: "destructive" as const, color: "text-red-700 dark:text-red-400",       bg: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",          icon: <XCircle className="w-4 h-4 text-red-600" /> };
    case "off":     return { label: "Off",           variant: "outline"     as const, color: "text-muted-foreground",                bg: "bg-muted/30 border-border",                                                   icon: <Circle className="w-4 h-4 text-muted-foreground" /> };
  }
}

function ComplianceChannelTab({ data, isLoading }: { data?: ComplianceChannelStatus; isLoading: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) return <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading compliance status…</div>;
  if (!data) return <div className="py-8 text-center text-muted-foreground">Unable to load compliance data.</div>;

  const blockedCount = data.channels.filter(c => c.status === "blocked").length;
  const warningCount = data.channels.filter(c => c.status === "warning").length;
  const safeCount   = data.channels.filter(c => c.status === "safe").length;

  return (
    <div className="space-y-4" data-testid="compliance-channel-tab">
      <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/20">
        <CardContent className="py-3 px-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-blue-800 dark:text-blue-300 text-sm">Outbound Channel Compliance — {data.strictStates.join(", ")} Strict-Consent State(s) Active</p>
            <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
              Each channel below shows whether it is legal to use, what regulation governs it, and any blockers that must be resolved before enabling.
              Strict-consent states ({data.strictStates.join(", ")}) require Express Written Consent (PEWC) for automated SMS and calls.
            </p>
          </div>
          <div className="flex gap-2 shrink-0 text-xs font-medium">
            <span className="text-green-700 dark:text-green-400">{safeCount} Safe</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-amber-700 dark:text-amber-400">{warningCount} Caution</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-red-700 dark:text-red-400">{blockedCount} Blocked</span>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {data.channels.map((ch) => {
          const sc = statusConfig(ch.status);
          const isOpen = expanded === ch.key;
          return (
            <Card key={ch.key} className={`border ${sc.bg}`} data-testid={`compliance-card-${ch.key}`}>
              <CardContent className="py-0">
                <button
                  className="w-full flex items-center gap-3 py-3 text-left"
                  onClick={() => setExpanded(isOpen ? null : ch.key)}
                  data-testid={`compliance-expand-${ch.key}`}
                >
                  <span className={sc.color}>{channelIcon(ch.icon)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{ch.name}</span>
                      <Badge variant={sc.variant} className="text-xs">{sc.label}</Badge>
                      <span className="text-xs text-muted-foreground">{ch.regulation}</span>
                      {ch.consentRequired && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 font-medium">
                          <Lock className="w-3 h-3" /> Consent required
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{ch.summary}</p>
                  </div>
                  {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>

                {isOpen && (
                  <div className="pb-4 space-y-3 border-t pt-3">
                    <p className="text-sm">{ch.summary}</p>

                    {ch.blockers.length > 0 && (
                      <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 p-3">
                        <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1.5 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" /> Blockers</p>
                        <ul className="space-y-1">
                          {ch.blockers.map((b, i) => (
                            <li key={i} className="text-xs text-red-700 dark:text-red-400 flex gap-1.5"><span>•</span><span>{b}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div>
                      <p className="text-xs font-semibold text-muted-foreground mb-1.5 flex items-center gap-1"><ListChecks className="w-3.5 h-3.5" /> Compliance Requirements</p>
                      <ul className="space-y-1">
                        {ch.requirements.map((r, i) => (
                          <li key={i} className="text-xs flex gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" /><span>{r}</span></li>
                        ))}
                      </ul>
                    </div>

                    {ch.stats && (
                      <div className="rounded-md border bg-muted/30 p-3">
                        <p className="text-xs font-semibold text-muted-foreground mb-1.5">Live Stats</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          {Object.entries(ch.stats).map(([k, v]) => {
                            if (Array.isArray(v)) return (
                              <div key={k} className="col-span-2 flex gap-1"><span className="text-muted-foreground capitalize">{k.replace(/([A-Z])/g, ' $1')}:</span><span className="font-medium">{(v as string[]).join(", ") || "None"}</span></div>
                            );
                            return (
                              <div key={k} className="flex gap-1"><span className="text-muted-foreground capitalize">{k.replace(/([A-Z])/g, ' $1')}:</span><span className="font-medium">{String(v)}</span></div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {ch.flagKey && (
                      <p className="text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1">
                        Feature flag: <strong>{ch.flagKey}</strong> = {ch.flagEnabled ? "true ✓" : "false — set in Replit Secrets to enable"}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground text-right">
        Last updated: {new Date(data.lastUpdated).toLocaleString()} · Strict-consent states: {data.strictStates.join(", ")}
      </p>
    </div>
  );
}

interface ChannelChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface ChannelChecklistResult {
  channel: "sms" | "voice_ai" | "ringless_vm";
  passed: boolean;
  items: ChannelChecklistItem[];
  currentlyEnabled: boolean;
  evaluatedAt: string;
}

const CHANNEL_GATE_LABELS: Record<ChannelChecklistResult["channel"], { name: string; icon: JSX.Element; envFlag: string }> = {
  sms: { name: "SMS", icon: <MessageSquare className="w-5 h-5" />, envFlag: "SMS_ENABLED" },
  voice_ai: { name: "AI Voice", icon: <Mic className="w-5 h-5" />, envFlag: "VOICE_AI_ENABLED" },
  ringless_vm: { name: "Ringless Voicemail", icon: <Voicemail className="w-5 h-5" />, envFlag: "RINGLESS_VM_ENABLED" },
};

interface ChannelTestBatchCandidate {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  consentTier: string;
  reason: string;
}

interface ChannelTestBatchResult {
  channel: string;
  dryRun: boolean;
  sent: boolean;
  auditId: number;
  scannedCount: number;
  candidateCount: number;
  candidates: ChannelTestBatchCandidate[];
  note: string;
}

interface ChannelAuditLogEntry {
  id: number;
  channel: string;
  action: string;
  checklistSnapshot: unknown;
  actorUserId: string | null;
  actorEmail: string | null;
  notes: string | null;
  createdAt: string;
}

const CHANNEL_AUDIT_ACTION_LABELS: Record<string, string> = {
  checklist_viewed: "Checklist viewed",
  enable_approved: "Approved to enable",
  disabled_recorded: "Disable recorded",
  test_batch_preview: "Test batch previewed",
};

function ChannelHistoryDialog({ channel, open, onOpenChange }: { channel: ChannelChecklistResult["channel"]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const meta = CHANNEL_GATE_LABELS[channel];
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<string>("");
  const [actorFilterDebounced, setActorFilterDebounced] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const { toast } = useToast();
  const PAGE_SIZE = 25;

  useEffect(() => {
    const t = setTimeout(() => setActorFilterDebounced(actorFilter), 300);
    return () => clearTimeout(t);
  }, [actorFilter]);

  const buildFilterParams = () => {
    const params = new URLSearchParams();
    if (actionFilter !== "all") params.set("action", actionFilter);
    if (actorFilterDebounced.trim()) params.set("actor", actorFilterDebounced.trim());
    if (startDate) params.set("startDate", new Date(startDate).toISOString());
    if (endDate) {
      const d = new Date(endDate);
      d.setHours(23, 59, 59, 999);
      params.set("endDate", d.toISOString());
    }
    return params;
  };

  const historyQuery = useQuery({
    queryKey: [`/api/activation/channel-audit-log/${channel}`, actionFilter, actorFilterDebounced, startDate, endDate, page],
    queryFn: async () => {
      const params = buildFilterParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const res = await apiRequest("GET", `/api/activation/channel-audit-log/${channel}?${params.toString()}`);
      return res.json() as Promise<{ channel: string; entries: ChannelAuditLogEntry[]; total: number; limit: number; offset: number }>;
    },
    enabled: open,
  });

  const resetFilters = () => {
    setActionFilter("all");
    setActorFilter("");
    setActorFilterDebounced("");
    setStartDate("");
    setEndDate("");
    setPage(0);
  };

  const handleExport = async (format: "csv" | "pdf") => {
    setExporting(format);
    try {
      const params = buildFilterParams();
      params.set("format", format);
      const res = await apiRequest("GET", `/api/activation/channel-audit-log/${channel}/export?${params.toString()}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `channel-audit-${channel}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    } finally {
      setExporting(null);
    }
  };

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const total = historyQuery.data?.total ?? 0;
  const hasNextPage = (page + 1) * PAGE_SIZE < total;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid={`dialog-channel-history-${channel}`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="w-4 h-4" /> {meta.name} Approval History
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2 border-b pb-3 mb-1">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-muted-foreground">Action</Label>
              <Select value={actionFilter} onValueChange={(v) => { setActionFilter(v); setPage(0); }}>
                <SelectTrigger className="h-8 text-xs" data-testid={`select-filter-action-${channel}`}>
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {Object.entries(CHANNEL_AUDIT_ACTION_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">Actor (email or ID)</Label>
              <Input
                className="h-8 text-xs"
                placeholder="Search actor…"
                value={actorFilter}
                onChange={(e) => { setActorFilter(e.target.value); setPage(0); }}
                data-testid={`input-filter-actor-${channel}`}
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">From</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setPage(0); }}
                data-testid={`input-filter-start-date-${channel}`}
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">To</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setPage(0); }}
                data-testid={`input-filter-end-date-${channel}`}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={resetFilters} data-testid={`button-reset-filters-${channel}`}>
              Clear filters
            </Button>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={() => handleExport("csv")}
                disabled={exporting !== null}
                data-testid={`button-export-csv-${channel}`}
              >
                {exporting === "csv" ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Download className="w-3 h-3 mr-1" />}
                CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={() => handleExport("pdf")}
                disabled={exporting !== null}
                data-testid={`button-export-pdf-${channel}`}
              >
                {exporting === "pdf" ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <FileText className="w-3 h-3 mr-1" />}
                PDF
              </Button>
            </div>
          </div>
        </div>

        {historyQuery.isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading history…
          </div>
        ) : historyQuery.isError ? (
          <p className="text-sm text-destructive py-4">Failed to load history.</p>
        ) : !historyQuery.data?.entries?.length ? (
          <p className="text-sm text-muted-foreground py-4" data-testid={`text-no-history-${channel}`}>
            No approval-gate activity matches the current filters.
          </p>
        ) : (
          <ul className="space-y-2">
            {historyQuery.data.entries.map((entry) => {
              const snapshot = entry.checklistSnapshot as ChannelChecklistResult | null;
              const isExpanded = expandedIds.has(entry.id);
              return (
                <li key={entry.id} className="rounded-md border p-3 text-xs space-y-1" data-testid={`history-entry-${channel}-${entry.id}`}>
                  <div className="flex items-center justify-between">
                    <Badge variant={entry.action === "enable_approved" ? "default" : "outline"}>
                      {CHANNEL_AUDIT_ACTION_LABELS[entry.action] || entry.action}
                    </Badge>
                    <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-muted-foreground">
                    Actor: {entry.actorEmail || entry.actorUserId || "unknown"}
                  </p>
                  {entry.notes && <p className="text-muted-foreground">Notes: {entry.notes}</p>}
                  {snapshot && (
                    <div>
                      <button
                        type="button"
                        onClick={() => toggleExpanded(entry.id)}
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        data-testid={`button-toggle-snapshot-${channel}-${entry.id}`}
                      >
                        {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        Checklist snapshot at this time ({snapshot.passed ? "Passed" : "Incomplete"})
                      </button>
                      {isExpanded && (
                        <div className="mt-2 rounded-md border bg-muted/30 p-2 space-y-1.5" data-testid={`snapshot-${channel}-${entry.id}`}>
                          {snapshot.items?.map((item) => (
                            <div key={item.key} className="flex items-start gap-1.5">
                              {item.ok ? <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0 mt-0.5" /> : <XCircle className="w-3 h-3 text-red-600 shrink-0 mt-0.5" />}
                              <div>
                                <span className="font-medium">{item.label}</span>
                                <p className="text-muted-foreground">{item.detail}</p>
                              </div>
                            </div>
                          ))}
                          <p className="text-[11px] text-muted-foreground pt-1">
                            Currently enabled at that time: {snapshot.currentlyEnabled ? "Yes" : "No"}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground">
            <span data-testid={`text-pagination-summary-${channel}`}>
              Showing {Math.min(page * PAGE_SIZE + 1, total)}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || historyQuery.isFetching}
                data-testid={`button-history-prev-page-${channel}`}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasNextPage || historyQuery.isFetching}
                data-testid={`button-history-next-page-${channel}`}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelApprovalCard({ channel }: { channel: ChannelChecklistResult["channel"] }) {
  const { toast } = useToast();
  const meta = CHANNEL_GATE_LABELS[channel];
  const [lastResult, setLastResult] = useState<ChannelChecklistResult | null>(null);
  const [lastAction, setLastAction] = useState<{ type: string; message: string } | null>(null);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const [approvalModalData, setApprovalModalData] = useState<{ auditId: number; manualStep: string; envFlag: string } | null>(null);
  const [testBatchResult, setTestBatchResult] = useState<ChannelTestBatchResult | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const checklistMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", `/api/activation/channel-checklist/${channel}`);
      return res.json() as Promise<ChannelChecklistResult>;
    },
    onSuccess: (data) => { setLastResult(data); setLastAction(null); },
    onError: (err: any) => toast({ title: "Failed to load checklist", description: err.message, variant: "destructive" }),
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/activation/channel-enable/${channel}`, {});
      return res.json();
    },
    onSuccess: (data) => {
      if (data.approvedToEnable) {
        setLastAction({ type: "approved", message: data.manualStep });
        setApprovalModalData({ auditId: data.auditId, manualStep: data.manualStep, envFlag: meta.envFlag });
        setApprovalModalOpen(true);
        toast({ title: "Approval recorded", description: `Audit #${data.auditId} — manual Replit Secret change still required.` });
      } else {
        setLastResult(data.checklist);
        toast({ title: "Not approved", description: data.message, variant: "destructive" });
      }
    },
    onError: (err: any) => toast({ title: "Approval failed", description: err.message, variant: "destructive" }),
  });

  const testBatchMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/activation/channel-test-batch/${channel}`, {});
      return res.json() as Promise<ChannelTestBatchResult>;
    },
    onSuccess: (data) => {
      setTestBatchResult(data);
      setLastAction({ type: "test_batch", message: `Dry-run preview of ${data.candidateCount} eligible candidate(s) out of ${data.scannedCount} scanned — no messages were sent.` });
      toast({ title: "Dry-run preview generated", description: `Audit #${data.auditId} — ${data.candidateCount} candidate(s) previewed, nothing sent.` });
    },
    onError: (err: any) => toast({ title: "Preview failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Card data-testid={`channel-gate-card-${channel}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          {meta.icon} {meta.name} Go-Live Approval
          {lastResult && (
            <Badge variant={lastResult.passed ? "default" : "destructive"} className="ml-1">
              {lastResult.passed ? "Checklist Passed" : "Checklist Incomplete"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          This panel only records an audited approval decision. It never sets <span className="font-mono">{meta.envFlag}</span> —
          that remains a manual Replit Secret change plus app restart.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => checklistMutation.mutate()}
            disabled={checklistMutation.isPending}
            data-testid={`button-run-checklist-${channel}`}
          >
            {checklistMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <ListChecks className="w-3.5 h-3.5 mr-1" />}
            Run Checklist
          </Button>
          <Button
            size="sm"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending || !lastResult?.passed}
            data-testid={`button-approve-enable-${channel}`}
          >
            {approveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <ShieldCheck className="w-3.5 h-3.5 mr-1" />}
            Approve to Enable
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => testBatchMutation.mutate()}
            disabled={testBatchMutation.isPending}
            data-testid={`button-test-batch-${channel}`}
          >
            {testBatchMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Play className="w-3.5 h-3.5 mr-1" />}
            Preview Test Batch (Dry Run)
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setHistoryOpen(true)}
            data-testid={`button-view-history-${channel}`}
          >
            <History className="w-3.5 h-3.5 mr-1" />
            View History
          </Button>
        </div>

        <ChannelHistoryDialog channel={channel} open={historyOpen} onOpenChange={setHistoryOpen} />

        {lastResult && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            {lastResult.items.map((item) => (
              <div key={item.key} className="flex items-start gap-2 text-xs" data-testid={`checklist-item-${channel}-${item.key}`}>
                {item.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0 mt-0.5" />}
                <div>
                  <span className="font-medium">{item.label}</span>
                  <p className="text-muted-foreground">{item.detail}</p>
                </div>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground pt-1">
              Currently enabled: {lastResult.currentlyEnabled ? "Yes" : "No"} · Evaluated {new Date(lastResult.evaluatedAt).toLocaleString()}
            </p>
          </div>
        )}

        {lastAction && (
          <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 p-3 text-xs text-blue-800 dark:text-blue-300">
            {lastAction.message}
          </div>
        )}

        {testBatchResult && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2" data-testid={`test-batch-preview-${channel}`}>
            <p className="text-[11px] font-medium">
              Eligible test candidates ({testBatchResult.candidateCount} of {testBatchResult.scannedCount} scanned) — preview only, nothing sent
            </p>
            {testBatchResult.candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">No eligible candidates found for this channel right now.</p>
            ) : (
              <ul className="space-y-1.5">
                {testBatchResult.candidates.map((c) => (
                  <li key={c.id} className="text-xs flex flex-col gap-0.5 border-b last:border-b-0 pb-1.5 last:pb-0" data-testid={`test-batch-candidate-${channel}-${c.id}`}>
                    <span className="font-medium">{c.firstName} {c.lastName} <span className="text-muted-foreground font-normal">({c.phone || c.email || "no contact info"})</span></span>
                    <span className="text-muted-foreground">Consent tier: {c.consentTier} · {c.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={approvalModalOpen} onOpenChange={setApprovalModalOpen}>
        <DialogContent data-testid={`dialog-approval-instructions-${channel}`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-green-600" /> {meta.name} Approval Recorded
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Audit #{approvalModalData?.auditId} has been recorded. This approval does <span className="font-semibold">not</span> enable
              the channel by itself.
            </p>
            <div className="rounded-md border bg-muted/40 p-3 text-xs">
              {approvalModalData?.manualStep}
            </div>
            <p className="text-xs text-muted-foreground">
              To finish activating {meta.name}, an operator must manually set the Replit Secret{" "}
              <span className="font-mono">{approvalModalData?.envFlag}=true</span> and restart the app.
            </p>
          </div>
          <DialogClose asChild>
            <Button size="sm" className="w-full mt-2" data-testid={`button-close-approval-dialog-${channel}`}>
              Got it
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ChannelApprovalGate() {
  return (
    <div className="space-y-3" data-testid="channel-approval-gate">
      <div>
        <h3 className="text-sm font-semibold">Voice / SMS / Ringless Go-Live Approval Gate</h3>
        <p className="text-xs text-muted-foreground">
          Audit-only approval workflow. Approving a channel here records a compliance decision — it does not flip any feature flag.
          Enabling the channel still requires an operator to manually set the corresponding Replit Secret and restart the app.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <ChannelApprovalCard channel="sms" />
        <ChannelApprovalCard channel="voice_ai" />
        <ChannelApprovalCard channel="ringless_vm" />
      </div>
    </div>
  );
}

function ChannelSafetyMatrix({ query }: { query: ReturnType<typeof useQuery<ChannelSafetySummary>> }) {
  const { data, isLoading, isError, dataUpdatedAt, refetch, isFetching } = query;

  const channelLabel: Record<string, string> = {
    email: "Email",
    manual_call: "Manual Call Task",
    sms: "SMS",
    voice_ai: "AI Voice",
    ringless_vm: "Ringless Voicemail",
  };

  const channelStatusColor = (status: string) => {
    if (status === "eligible") return "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800";
    if (status === "flag_gated") return "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800";
    if (status === "blocked") return "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800";
    return "bg-muted/30";
  };

  const channelStatusIcon = (status: string) => {
    if (status === "eligible") return <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />;
    if (status === "flag_gated") return <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />;
    if (status === "blocked") return <XCircle className="w-4 h-4 text-red-600 shrink-0" />;
    return <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0" />;
  };

  const flagBadgeVariant = (status: string) => {
    if (status === "enabled") return "default";
    if (status === "disabled") return "destructive";
    return "secondary";
  };

  const flagBadgeClass = (status: string) => {
    if (status === "enabled") return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-300";
    if (status === "disabled") return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-300";
    return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-300";
  };

  if (isLoading) {
    return (
      <Card data-testid="channel-safety-matrix-loading">
        <CardContent className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading Channel Safety Matrix…
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="border-red-200 dark:border-red-800" data-testid="channel-safety-matrix-error">
        <CardContent className="py-4 flex items-center gap-2 text-red-700 dark:text-red-400">
          <XCircle className="w-5 h-5 shrink-0" />
          <div>
            <p className="font-semibold text-sm">Channel Safety Matrix unavailable</p>
            <p className="text-xs text-muted-foreground mt-0.5">Could not load summary data. This endpoint requires admin or manager access.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card data-testid="channel-safety-matrix-empty">
        <CardContent className="py-8 text-center text-muted-foreground text-sm">
          No channel safety data available yet.
        </CardContent>
      </Card>
    );
  }

  const lastRefreshed = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : "—";
  const isStale = dataUpdatedAt ? Date.now() - dataUpdatedAt > 90000 : false;

  const consentTierCols: Array<keyof typeof data.sourceConsentMatrix[0]> = [
    "cold_no_consent", "warm_no_pewc", "pewc_full_automation", "opted_out", "do_not_contact", "total"
  ];
  const consentTierLabels: Record<string, string> = {
    cold_no_consent: "Cold",
    warm_no_pewc: "Warm",
    pewc_full_automation: "PEWC",
    opted_out: "Opted Out",
    do_not_contact: "DNC",
    total: "Total",
  };

  const matrixTotals = consentTierCols.reduce((acc, col) => {
    acc[col as string] = data.sourceConsentMatrix.reduce((s, r) => s + (Number(r[col]) || 0), 0);
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-4" data-testid="channel-safety-matrix">
      {/* Header */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-2 flex-1">
              <Shield className="w-5 h-5 text-primary shrink-0" />
              <div>
                <CardTitle className="text-base">Channel Safety Matrix</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Operational visibility · Wave 1B ·{" "}
                  <span className="font-mono">
                    {isStale ? <Badge variant="secondary" className="text-xs ml-1">stale</Badge> : `refreshed at ${lastRefreshed}`}
                  </span>
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh-channel-safety"
              className="shrink-0"
            >
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-md border border-amber-200 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 flex gap-3 items-start">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 dark:text-amber-300">
              Summary counts are operational visibility based on Wave 1A canonical fields. Every actual send or workflow enrollment is still evaluated by <span className="font-mono font-semibold">evaluateContactability()</span> at execution time.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Feature Flag Risk Matrix — Wave 12 */}
      {(() => {
        const FLAG_MATRIX: Array<{
          key: string;
          risk: "HIGH" | "MEDIUM" | "LOW";
          riskColor: string;
          borderColor: string;
          what: string;
          prerequisites: string[];
          killLines: string[];
          verifyCmd: string;
          queueDep: string;
          specialNote?: string;
        }> = [
          {
            key: "SDR_ENABLED",
            risk: "MEDIUM",
            riskColor: "text-amber-700 dark:text-amber-400",
            borderColor: "border-amber-300 dark:border-amber-700",
            what: "Enables email sequences and manual contact task creation. SMS/Voice/RVM flags still block mass outbound, but email sequences CAN run without those flags.",
            prerequisites: ["All sequence content reviewed and approved", "No ACTIVE sequences pointing to unapproved content"],
            killLines: ["Sequence engine reviewed", "No unapproved sequences in ACTIVE state"],
            verifyCmd: "npx tsx scripts/test-sequence-compliance.ts",
            queueDep: "sequences (30s)",
            specialNote: "SDR defaults to ON. Verify all active sequences are approved before go-live.",
          },
          {
            key: "ORCHESTRATOR_ENABLED",
            risk: "HIGH",
            riskColor: "text-red-700 dark:text-red-400",
            borderColor: "border-red-300 dark:border-red-700",
            what: "Enables the autonomous orchestrator that selects next outreach actions for all SDR merchants on a schedule.",
            prerequisites: ["SMS_ENABLED and VOICE_AI_ENABLED reviewed", "Contactability engine smoke tests pass", "Daily volume limits configured (SDR_DAILY_SMS_LIMIT)"],
            killLines: ["evaluateContactability() gates all sends", "compliance-scan passes (exit 0)"],
            verifyCmd: "npx tsx scripts/compliance-scan.ts",
            queueDep: "sequences (30s)",
          },
          {
            key: "SMS_ENABLED",
            risk: "HIGH",
            riskColor: "text-red-700 dark:text-red-400",
            borderColor: "border-red-300 dark:border-red-700",
            what: "Allows automated SMS outreach to PEWC-consented contacts. TCPA/Florida rules still apply.",
            prerequisites: ["PEWC consent flows verified (test-forms.ts passes)", "Contactability gate verified for SMS channel", "FL mini-TCPA rule understood and accepted"],
            killLines: ["Only contacts with pewc_full_automation consent tier receive SMS", "evaluateContactability blocks all others"],
            verifyCmd: "npx tsx scripts/test-contactability.ts",
            queueDep: "sequences (30s)",
          },
          {
            key: "VOICE_AI_ENABLED",
            risk: "HIGH",
            riskColor: "text-red-700 dark:text-red-400",
            borderColor: "border-red-300 dark:border-red-700",
            what: "Enables AI voice call outreach. Requires PEWC consent and respects TCPA quiet hours.",
            prerequisites: ["VOICE_AI provider credentials configured", "PEWC consent tier required for all AI voice targets", "Quiet hours check verified"],
            killLines: ["triggerAiCall gated by evaluateContactability", "No calls outside 9 AM–5 PM local time"],
            verifyCmd: "npx tsx scripts/test-contactability.ts",
            queueDep: "sequences (30s)",
          },
          {
            key: "RINGLESS_VM_ENABLED",
            risk: "HIGH",
            riskColor: "text-red-700 dark:text-red-400",
            borderColor: "border-red-300 dark:border-red-700",
            what: "Enables ringless voicemail drops. Requires PEWC consent and mobile phone type on contact.",
            prerequisites: ["PEWC consent tier required", "Contact phoneType=mobile required", "enrollContactInGhlWorkflow gated by evaluateContactability"],
            killLines: ["compliance-scan passes (exit 0)", "contactability blocks all non-PEWC contacts for ringless_vm"],
            verifyCmd: "npx tsx scripts/test-contactability.ts",
            queueDep: "sequences (30s) / GHL workflow",
          },
          {
            key: "NIGHTLY_DISCOVERY_ENABLED",
            risk: "MEDIUM",
            riskColor: "text-amber-700 dark:text-amber-400",
            borderColor: "border-amber-300 dark:border-amber-700",
            what: "Runs the nightly lead discovery engine (Serper, Outscraper, Apify, Apollo) to import new prospect contacts.",
            prerequisites: ["At least one discovery API key configured (SERPER_API_KEY or OUTSCRAPER_API_KEY)", "Provider enablement and circuit controls reviewed"],
            killLines: ["All discovered leads start as cold_no_consent — no outreach until consent tier updated", "NIGHTLY_DISCOVERY_ENABLED=false by default"],
            verifyCmd: "npx tsx scripts/compliance-scan.ts",
            queueDep: "discovery (24h)",
          },
        ];

        const flagMap = Object.fromEntries((data.featureFlags ?? []).map(f => [f.key, f]));

        return (
          <Card data-testid="channel-safety-flags">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Feature Flag Risk Matrix</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/20 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
                <strong>Read-only.</strong> To enable or disable a flag, set the environment variable in Replit Secrets, then restart the server. No toggle controls exist by design.
              </div>
              {FLAG_MATRIX.map(fm => {
                const live = flagMap[fm.key];
                const isOn = live?.enabled === true || live?.status === "enabled";
                const stateLabel = live ? (isOn ? "ON" : "OFF") : "UNKNOWN";
                const stateCls = isOn
                  ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-300"
                  : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-300";
                return (
                  <div
                    key={fm.key}
                    className={`rounded-md border ${fm.borderColor} p-3 space-y-1.5`}
                    data-testid={`flag-card-${fm.key}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-semibold text-sm">{fm.key}</span>
                      <Badge variant="outline" className={`text-xs border ${stateCls}`} data-testid={`flag-badge-${fm.key}`}>
                        {stateLabel}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${fm.riskColor} border-current`}>
                        {fm.risk} RISK
                      </Badge>
                    </div>
                    {fm.key === "SDR_ENABLED" && isOn && (
                      <div className="flex gap-1.5 items-start rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                        <span>{fm.specialNote}</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{fm.what}</p>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Prerequisites / Kill Lines</p>
                      <ul className="mt-0.5 space-y-0.5">
                        {fm.killLines.map((kl, i) => (
                          <li key={i} className="text-xs flex gap-1"><span className="text-red-500 shrink-0">⚑</span>{kl}</li>
                        ))}
                        {fm.prerequisites.map((pr, i) => (
                          <li key={`p${i}`} className="text-xs flex gap-1"><span className="text-muted-foreground shrink-0">•</span>{pr}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground pt-0.5">
                      <span><strong>Queue:</strong> {fm.queueDep}</span>
                      <span className="font-mono"><strong>Verify:</strong> {fm.verifyCmd}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground border-t border-dashed pt-1">
                      <strong>Enable:</strong> Set <code className="font-mono bg-muted px-1 rounded">{fm.key}=true</code> in Replit Secrets → restart server.
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })()}

      {/* Blocked Attempts 24h */}
      <Card data-testid="channel-safety-blocked-24h">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <XCircle className="w-4 h-4 text-red-500" />
            Blocked Contactability Attempts — Last 24h
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="flex items-center gap-4 text-sm">
            <span className="font-bold text-2xl">{data.blockedAttempts24h.total}</span>
            <span className="text-muted-foreground text-xs">total blocked enforcement attempts</span>
            {data.blockedAttempts24h.lastBlockedAt && (
              <span className="text-xs text-muted-foreground ml-auto">
                Last: {new Date(data.blockedAttempts24h.lastBlockedAt).toLocaleString()}
              </span>
            )}
          </div>
          {data.blockedAttempts24h.byReason.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1">By Reason</p>
              <div className="space-y-1">
                {data.blockedAttempts24h.byReason.slice(0, 5).map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs" data-testid={`blocked-reason-${i}`}>
                    <span className="flex-1 truncate text-muted-foreground">{r.reason}</span>
                    <Badge variant="secondary" className="shrink-0">{r.count}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.blockedAttempts24h.byChannel.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1">By Channel</p>
              <div className="flex flex-wrap gap-2">
                {data.blockedAttempts24h.byChannel.map((c, i) => (
                  <Badge key={i} variant="outline" className="text-xs" data-testid={`blocked-channel-${i}`}>
                    {channelLabel[c.channel] ?? c.channel}: {c.count}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {data.blockedAttempts24h.total === 0 && (
            <p className="text-xs text-muted-foreground">No blocked attempts in the last 24 hours.</p>
          )}
        </CardContent>
      </Card>

      {/* Channel Eligibility Cards */}
      <div>
        <p className="text-sm font-semibold mb-2">Channel Eligibility (SQL Aggregate)</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.channelEligibility.map((ch) => (
            <Card key={ch.channel} className={`border ${channelStatusColor(ch.status)}`} data-testid={`channel-card-${ch.channel}`}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-2 mb-2">
                  {channelStatusIcon(ch.status)}
                  <span className="font-semibold text-sm">{channelLabel[ch.channel] ?? ch.channel}</span>
                  {ch.featureFlag && (
                    <Badge variant="outline" className={`text-xs ml-auto ${flagBadgeClass(ch.featureFlagEnabled ? "enabled" : "disabled")}`}>
                      {ch.featureFlag}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-2 text-xs">
                  <span className="text-muted-foreground">Eligible</span>
                  <span className="font-medium text-green-700 dark:text-green-400">{ch.eligibleCount.toLocaleString()}</span>
                  <span className="text-muted-foreground">Blocked</span>
                  <span className="font-medium text-red-700 dark:text-red-400">{ch.blockedCount.toLocaleString()}</span>
                </div>
                {ch.topBlockReason && (
                  <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{ch.topBlockReason}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Source × Consent Matrix Table */}
      <Card data-testid="channel-safety-source-consent-matrix">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Source × Consent Tier Matrix</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data.sourceConsentMatrix.length === 0 ? (
            <p className="text-xs text-muted-foreground">No contact data available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1.5 pr-3 font-semibold text-muted-foreground">Source</th>
                    {consentTierCols.map((col) => (
                      <th key={col as string} className="text-right py-1.5 px-2 font-semibold text-muted-foreground whitespace-nowrap">
                        {consentTierLabels[col as string]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.sourceConsentMatrix.map((row) => (
                    <tr key={row.sourceCategory} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-1.5 pr-3 font-mono">{row.sourceCategory}</td>
                      {consentTierCols.map((col) => (
                        <td key={col as string} className="text-right py-1.5 px-2">
                          {(Number(row[col]) || 0).toLocaleString()}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="border-t bg-muted/20 font-semibold">
                    <td className="py-1.5 pr-3">Total</td>
                    {consentTierCols.map((col) => (
                      <td key={col as string} className="text-right py-1.5 px-2">
                        {(matrixTotals[col as string] || 0).toLocaleString()}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Florida Breakdown */}
      <Card data-testid="channel-safety-florida-breakdown">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Florida (FL) Contact Breakdown
            <Badge variant="secondary" className="text-xs">{data.floridaBreakdown.total.toLocaleString()} total</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {data.floridaBreakdown.byConsentTier.length === 0 ? (
            <p className="text-xs text-muted-foreground">No Florida contacts found.</p>
          ) : (
            <div className="space-y-1">
              {data.floridaBreakdown.byConsentTier.map((t) => (
                <div key={t.consentTier} className="flex items-center gap-2 text-xs">
                  <span className="font-mono flex-1">{t.consentTier}</span>
                  <span className="font-medium">{t.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground border-t pt-2 mt-2">
            Florida contacts with <span className="font-mono font-semibold">pewc_full_automation</span> tier require verified PEWC audit evidence (express written consent with <span className="font-mono">consentedPhone</span> + <span className="font-mono">disclosureVersion</span>) before any automated phone or SMS outreach can proceed.
          </p>
        </CardContent>
      </Card>

      {/* Warnings */}
      {data.warnings && data.warnings.length > 0 && (
        <Card className="border-amber-200 dark:border-amber-700" data-testid="channel-safety-warnings">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1">
              <AlertTriangle className="w-4 h-4 text-amber-500" /> Operational Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="space-y-1.5">
              {data.warnings.map((w, i) => (
                <li key={i} className="text-xs text-muted-foreground flex gap-2">
                  <span className="shrink-0 mt-0.5">•</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Block Reason Summary Card (Wave 9 — Channel Safety Extension) ─────────────
interface BlockReasonRow {
  channel: string | null;
  blockReason: string | null;
  cnt: number;
}

interface ChannelBlockSummaryResponse {
  rows: BlockReasonRow[];
  days: number;
}

const BLOCK_REASON_LABELS: Record<string, string> = {
  blocked_due_to_no_pewc: "No PEWC Consent",
  blocked_due_to_dnc: "Do Not Contact",
  blocked_due_to_quiet_hours: "Quiet Hours",
  blocked_due_to_feature_flag: "Feature Flag Off",
  unsafe_attempts_blocked: "Unsafe Attempt",
};

function BlockReasonSummaryCard() {
  const { data, isLoading, isError } = useQuery<ChannelBlockSummaryResponse>({
    queryKey: ["/api/analytics/channel-block-summary", 1],
    queryFn: async () => {
      const res = await fetch("/api/analytics/channel-block-summary?days=1", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch block summary");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const blockedRows = (data?.rows || []).filter(r => r.blockReason !== null);

  return (
    <Card data-testid="block-reason-summary-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Shield className="w-4 h-4 text-red-500" />
          Block Reason Breakdown — Last 24 Hours
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading block data…
          </div>
        )}
        {isError && (
          <div className="flex items-center gap-2 text-sm text-red-600 py-4">
            <XCircle className="w-4 h-4" /> Failed to load block summary
          </div>
        )}
        {!isLoading && !isError && blockedRows.length === 0 && (
          <div className="flex items-center gap-2 py-4 text-sm text-green-700 dark:text-green-400" data-testid="no-blocks-message">
            <CheckCircle2 className="w-4 h-4" /> No blocked attempts in the last 24 hours
          </div>
        )}
        {!isLoading && !isError && blockedRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-1">Block Reason</th>
                  <th className="pb-1">Channel</th>
                  <th className="pb-1 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {blockedRows.map((row, idx) => (
                  <tr key={idx} className="border-b last:border-0" data-testid={`block-row-${idx}`}>
                    <td className="py-1.5">{BLOCK_REASON_LABELS[row.blockReason!] || row.blockReason}</td>
                    <td className="py-1.5 capitalize">{row.channel || "—"}</td>
                    <td className="py-1.5 text-right font-medium">{row.cnt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 p-2 bg-muted/30 rounded text-xs text-muted-foreground" data-testid="fl-breakdown-unavailable">
          Florida-specific consent-tier breakdown unavailable — contact state is not tracked in analytics events.
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Launch Readiness Checklist (Wave 9 — ActivationPanel Readiness tab) ────
interface ReadinessItem {
  key: string;
  label: string;
  status: "green" | "yellow" | "red";
  value: string;
  description: string;
  remediation: string | null;
  source: string;
}

interface ActivationReadinessResponse {
  generatedAt: string;
  overallStatus: "green" | "yellow" | "red";
  items: ReadinessItem[];
  warnings: string[];
}

function LaunchReadinessChecklist() {
  const { data, isLoading, isError } = useQuery<ActivationReadinessResponse>({
    queryKey: ["/api/activation/readiness"],
    refetchInterval: 60000,
  });

  const statusColor = (s: "green" | "yellow" | "red") =>
    s === "green" ? "default" : s === "yellow" ? "secondary" : "destructive";

  const statusIcon = (s: "green" | "yellow" | "red") => {
    if (s === "green") return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />;
    if (s === "yellow") return <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />;
    return <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />;
  };

  return (
    <Card data-testid="launch-readiness-checklist">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Launch Readiness Checklist (Wave 9)
          </CardTitle>
          {data && (
            <Badge variant={statusColor(data.overallStatus)} data-testid="badge-launch-readiness-status">
              {data.overallStatus === "green" ? "Go" : data.overallStatus === "yellow" ? "Caution" : "No-Go"}
            </Badge>
          )}
        </div>
        {data && (
          <p className="text-xs text-muted-foreground mt-1">
            Updated {new Date(data.generatedAt).toLocaleTimeString()}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-10 bg-muted animate-pulse rounded" />
            ))}
          </div>
        )}
        {isError && (
          <div className="flex items-center gap-2 text-sm text-red-600 py-4">
            <XCircle className="w-4 h-4" /> Failed to load launch readiness checks
          </div>
        )}
        {!isLoading && !isError && data && (
          <div className="space-y-2">
            {data.items.map(item => (
              <div
                key={item.key}
                className="flex items-start gap-3 p-3 rounded border"
                data-testid={`launch-readiness-${item.key}`}
              >
                {statusIcon(item.status)}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{item.label}</span>
                    <span className="text-xs text-muted-foreground">{item.value}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{item.description}</div>
                  {item.remediation && item.status !== "green" && (
                    <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">{item.remediation}</div>
                  )}
                </div>
                <Badge variant={statusColor(item.status)} className="shrink-0 text-xs capitalize">
                  {item.status}
                </Badge>
              </div>
            ))}
            {data.warnings.length > 0 && (
              <div className="mt-2 space-y-1">
                {data.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sales Rep Operations Readiness Card ───────────────────────────────────────

interface SalesRepOpsData {
  ok: boolean;
  card: string;
  featureFlags: { CALL_ASSIST_ENABLED: boolean; FIELD_SALES_ENABLED: boolean; expectedState: string };
  knowledgeReadiness: { approvedIndexedRevisions: number; ready: boolean };
  repBinding: { activeAgents: number; bindingConflicts: number; healthy: boolean };
  certification: {
    runId: string;
    aggregateVerdict: string;
    completedAt: string;
    migrationHead: string;
    releaseSha: string | null;
    currentReleaseSha: string | null;
    shaMatches: boolean | null;
    stale: boolean;
    configFingerprint: string;
    configFingerprintMatch: boolean;
    populationFingerprint: string | null;
    populationFingerprintNote: string;
    gateResults: Array<{ gate: string; status: string; reason_code: string; detail: string }>;
  } | null;
  blockers: string[];
  rollbackChecklist: Array<{ step: string; description: string }>;
}

function SalesRepOpsCard() {
  // Cohort inputs: comma-separated rep user IDs, contact IDs, location IDs
  const [repIdsInput, setRepIdsInput] = useState("");
  const [contactIdsInput, setContactIdsInput] = useState("");
  const [locationIdsInput, setLocationIdsInput] = useState("");
  const [showCohortForm, setShowCohortForm] = useState(false);

  // Provision Rep form
  const [showProvisionForm, setShowProvisionForm] = useState(false);
  const [provisionEmail, setProvisionEmail] = useState("");
  const [provisionFirst, setProvisionFirst] = useState("");
  const [provisionLast, setProvisionLast] = useState("");

  // Resend Invite form
  const [showResendForm, setShowResendForm] = useState(false);
  const [resendUserId, setResendUserId] = useState("");

  // Assign Cohort form
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [assignRepUserId, setAssignRepUserId] = useState("");
  const [assignContactIds, setAssignContactIds] = useState("");
  const [assignLocationIds, setAssignLocationIds] = useState("");

  const repOpsQuery = useQuery<SalesRepOpsData>({
    queryKey: ["/api/activation/sales-rep-ops-readiness"],
    refetchInterval: 60000,
  });

  const runMutation = useMutation({
    mutationFn: () => {
      // Parse comma-separated cohort IDs; these are required for a non-BLOCKED_EXTERNAL verdict
      const pilotRepIds = repIdsInput.split(",").map(s => s.trim()).filter(Boolean);
      const pilotContactIds = contactIdsInput.split(",").map(s => Number(s.trim())).filter(n => n > 0);
      const pilotLocationIds = locationIdsInput.split(",").map(s => Number(s.trim())).filter(n => n > 0);
      return apiRequest("POST", "/api/activation/sales-rep-ops-readiness/run", {
        pilotRepIds,
        pilotContactIds,
        pilotLocationIds,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/activation/sales-rep-ops-readiness"] });
      setShowCohortForm(false);
    },
  });

  const { toast } = useToast();

  const provisionMutation = useMutation<any, Error>({
    mutationFn: async () => {
      // apiRequest throws on non-2xx via throwIfResNotOk; no manual ok-check needed.
      const res = await apiRequest("POST", "/api/activation/provision-rep", {
        email: provisionEmail.trim(),
        firstName: provisionFirst.trim(),
        lastName: provisionLast.trim(),
      });
      return res.json();
    },
    onSuccess: (data) => {
      const inviteNote = data.inviteDisposition === "sent"
        ? "Invitation email sent."
        : (data.inviteDetail ?? "Invite not sent — use Resend Invite when SMTP is available.");
      toast({
        title: "Rep provisioned",
        description: `User ${data.email} created (agent ID ${data.agentId}). ${inviteNote}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/activation/sales-rep-ops-readiness"] });
      setShowProvisionForm(false);
      setProvisionEmail("");
      setProvisionFirst("");
      setProvisionLast("");
    },
    onError: (err) => {
      toast({ title: "Provision failed", description: err?.message ?? "See server logs.", variant: "destructive" });
    },
  });

  const assignCohortMutation = useMutation<any, Error>({
    mutationFn: async () => {
      // apiRequest throws on non-2xx via throwIfResNotOk; no manual ok-check needed.
      const res = await apiRequest("POST", "/api/activation/assign-cohort", {
        repUserId: assignRepUserId.trim(),
        contactIds: assignContactIds.split(",").map(s => Number(s.trim())).filter(n => n > 0),
        locationIds: assignLocationIds.split(",").map(s => Number(s.trim())).filter(n => n > 0),
      });
      return res.json();
    },
    onSuccess: (data) => {
      const blockedNote = data.blockedCount > 0 ? ` ${data.blockedCount} blocked by eligibility gates — see details below.` : "";
      toast({
        title: "Cohort assigned",
        description: `${data.assignedCount} contact(s) assigned to ${data.agentEmail}.${blockedNote} Verdict: ${data.readiness?.aggregateVerdict ?? "re-running"}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/activation/sales-rep-ops-readiness"] });
      // Keep form open if some contacts/locations were blocked so the admin can review details
      if (!data.blockedCount) setShowAssignForm(false);
    },
    onError: (err) => {
      toast({ title: "Cohort assignment failed", description: err?.message ?? "See server logs.", variant: "destructive" });
    },
  });

  const resendInviteMutation = useMutation<any, Error>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/activation/resend-rep-invite", { userId: resendUserId.trim() });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Invite resent", description: `Invitation email sent to ${data.email}.` });
      setShowResendForm(false);
      setResendUserId("");
    },
    onError: (err) => {
      toast({ title: "Resend failed", description: err?.message ?? "See server logs.", variant: "destructive" });
    },
  });

  const data = repOpsQuery.data;
  const cert = data?.certification;
  const blocked = (data?.blockers ?? []).length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Sales Rep Operations Readiness
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {data && (
              <Badge variant={blocked ? "destructive" : "default"} className="text-xs">
                {blocked ? "Not Certified" : cert?.aggregateVerdict === "PASS" ? "Certified" : "Pending"}
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowProvisionForm(v => !v); setShowAssignForm(false); setShowCohortForm(false); }}
              title="Provision a new rep account (creates user + agent record + sends invite)"
            >
              <Plus className="w-3 h-3 mr-1" />
              {showProvisionForm ? "Cancel" : "Provision Rep"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowResendForm(v => !v); setShowProvisionForm(false); setShowAssignForm(false); setShowCohortForm(false); }}
              title="Re-issue invite email for a passwordless provisioned rep"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              {showResendForm ? "Cancel" : "Resend Invite"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowAssignForm(v => !v); setShowProvisionForm(false); setShowResendForm(false); setShowCohortForm(false); }}
              title="Assign contacts to a rep's pilot cohort"
            >
              <Users className="w-3 h-3 mr-1" />
              {showAssignForm ? "Cancel" : "Assign Cohort"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowCohortForm(v => !v); setShowProvisionForm(false); setShowAssignForm(false); }}
              title="Enter pilot cohort IDs and run all 20 readiness gates"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              {showCohortForm ? "Cancel" : "Run Check"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/activation/sales-rep-ops-readiness"] })}
              disabled={repOpsQuery.isFetching}
            >
              {repOpsQuery.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Provision Rep form */}
        {showProvisionForm && (
          <div className="rounded border p-3 space-y-3 bg-muted/40">
            <div className="text-xs font-medium">Provision Rep Account</div>
            <p className="text-xs text-muted-foreground">Creates a user with role=agent, an active agent record, and sends an invitation email. No automated outbound is triggered.</p>
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Email</Label>
                <Input
                  className="text-xs h-7 mt-0.5"
                  type="email"
                  placeholder="rep@example.com"
                  value={provisionEmail}
                  onChange={e => setProvisionEmail(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">First Name</Label>
                  <Input
                    className="text-xs h-7 mt-0.5"
                    placeholder="Jane"
                    value={provisionFirst}
                    onChange={e => setProvisionFirst(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs">Last Name</Label>
                  <Input
                    className="text-xs h-7 mt-0.5"
                    placeholder="Smith"
                    value={provisionLast}
                    onChange={e => setProvisionLast(e.target.value)}
                  />
                </div>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => provisionMutation.mutate()}
              disabled={provisionMutation.isPending || !provisionEmail.trim() || !provisionFirst.trim() || !provisionLast.trim()}
              className="w-full"
            >
              {provisionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
              {provisionMutation.isPending ? "Provisioning…" : "Provision Rep"}
            </Button>
            {provisionMutation.isError && (
              <div className="text-xs text-destructive">{(provisionMutation.error as any)?.message ?? "Provision failed — see server logs."}</div>
            )}
          </div>
        )}

        {/* Resend Invite form */}
        {showResendForm && (
          <div className="rounded border p-3 space-y-3 bg-muted/40">
            <div className="text-xs font-medium">Resend Rep Invite</div>
            <p className="text-xs text-muted-foreground">Issues a new 72-hour activation link for an already-provisioned rep who has not yet set a password (e.g. SMTP was down at provisioning time or the link expired).</p>
            <div>
              <Label className="text-xs">Rep User ID</Label>
              <Input
                className="text-xs h-7 mt-0.5"
                placeholder="uuid of the provisioned user"
                value={resendUserId}
                onChange={e => setResendUserId(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              onClick={() => resendInviteMutation.mutate()}
              disabled={resendInviteMutation.isPending || !resendUserId.trim()}
              className="w-full"
            >
              {resendInviteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              {resendInviteMutation.isPending ? "Sending…" : "Send New Invite"}
            </Button>
            {resendInviteMutation.isError && (
              <div className="text-xs text-destructive">{(resendInviteMutation.error as any)?.message ?? "Resend failed — see server logs."}</div>
            )}
          </div>
        )}

        {/* Assign Cohort form */}
        {showAssignForm && (
          <div className="rounded border p-3 space-y-3 bg-muted/40">
            <div className="text-xs font-medium">Assign Pilot Cohort</div>
            <p className="text-xs text-muted-foreground">Validates contacts against pilot eligibility gates, updates <code className="font-mono">contacts.assignedTo</code>, and re-runs readiness. No automated outbound is triggered.</p>
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Rep User ID</Label>
                <Input
                  className="text-xs h-7 mt-0.5"
                  placeholder="user-abc123"
                  value={assignRepUserId}
                  onChange={e => setAssignRepUserId(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Contact IDs (comma-separated integers)</Label>
                <Input
                  className="text-xs h-7 mt-0.5"
                  placeholder="1001, 1002, 1003"
                  value={assignContactIds}
                  onChange={e => setAssignContactIds(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Location IDs (optional, comma-separated integers)</Label>
                <Input
                  className="text-xs h-7 mt-0.5"
                  placeholder="2001, 2002"
                  value={assignLocationIds}
                  onChange={e => setAssignLocationIds(e.target.value)}
                />
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => assignCohortMutation.mutate()}
              disabled={assignCohortMutation.isPending || !assignRepUserId.trim() || !assignContactIds.trim()}
              className="w-full"
            >
              {assignCohortMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Users className="w-3 h-3 mr-1" />}
              {assignCohortMutation.isPending ? "Assigning…" : "Assign Cohort"}
            </Button>
            {assignCohortMutation.isError && (
              <div className="text-xs text-destructive">{(assignCohortMutation.error as any)?.message ?? "Assignment failed — see server logs."}</div>
            )}
            {assignCohortMutation.isSuccess && (assignCohortMutation.data as any)?.blocked?.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-amber-600">
                  {(assignCohortMutation.data as any).blockedCount} candidate(s) blocked by eligibility gates
                </summary>
                <div className="mt-1 space-y-0.5">
                  {(assignCohortMutation.data as any).blocked.map((b: any, i: number) => (
                    <div key={`${b.kind}-${b.id}-${i}`} className="text-muted-foreground capitalize">
                      {b.kind} {b.id}: {b.reason}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Cohort input form — shown when admin clicks Run Check */}
        {showCohortForm && (
          <div className="rounded border p-3 space-y-3 bg-muted/40">
            <div className="text-xs font-medium">Enter pilot cohort (required for a PASS verdict)</div>
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Rep User IDs (comma-separated)</Label>
                <Input
                  className="text-xs h-7 mt-0.5"
                  placeholder="user-abc123, user-def456"
                  value={repIdsInput}
                  onChange={e => setRepIdsInput(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Contact IDs (comma-separated integers)</Label>
                <Input
                  className="text-xs h-7 mt-0.5"
                  placeholder="1001, 1002, 1003"
                  value={contactIdsInput}
                  onChange={e => setContactIdsInput(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Business/Location IDs (comma-separated integers)</Label>
                <Input
                  className="text-xs h-7 mt-0.5"
                  placeholder="2001, 2002"
                  value={locationIdsInput}
                  onChange={e => setLocationIdsInput(e.target.value)}
                />
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending || !repIdsInput.trim() || !contactIdsInput.trim() || !locationIdsInput.trim()}
              className="w-full"
            >
              {runMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              {runMutation.isPending ? "Running gates…" : "Run All 20 Readiness Gates"}
            </Button>
            {runMutation.isError && (
              <div className="text-xs text-destructive">Check failed — see server logs for details.</div>
            )}
          </div>
        )}

        {repOpsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : !data ? (
          <div className="text-sm text-muted-foreground">Failed to load Sales Rep Ops readiness.</div>
        ) : (
          <>
            {/* Feature flags (both must be OFF) */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center justify-between rounded border p-2">
                <span className="text-muted-foreground">Call Assist flag</span>
                <Badge variant={data.featureFlags.CALL_ASSIST_ENABLED ? "destructive" : "default"} className="text-xs">
                  {data.featureFlags.CALL_ASSIST_ENABLED ? "ON ⚠" : "OFF ✓"}
                </Badge>
              </div>
              <div className="flex items-center justify-between rounded border p-2">
                <span className="text-muted-foreground">Field Sales flag</span>
                <Badge variant={data.featureFlags.FIELD_SALES_ENABLED ? "destructive" : "default"} className="text-xs">
                  {data.featureFlags.FIELD_SALES_ENABLED ? "ON ⚠" : "OFF ✓"}
                </Badge>
              </div>
            </div>

            {/* Knowledge + Rep Binding */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center justify-between rounded border p-2">
                <span className="text-muted-foreground">Knowledge revisions</span>
                <Badge variant={data.knowledgeReadiness.ready ? "default" : "destructive"} className="text-xs">
                  {data.knowledgeReadiness.approvedIndexedRevisions} approved
                </Badge>
              </div>
              <div className="flex items-center justify-between rounded border p-2">
                <span className="text-muted-foreground">Agent binding conflicts</span>
                <Badge variant={data.repBinding.healthy ? "default" : "destructive"} className="text-xs">
                  {data.repBinding.bindingConflicts === 0 ? "None ✓" : `${data.repBinding.bindingConflicts} conflict(s)`}
                </Badge>
              </div>
            </div>

            {/* Certification receipt */}
            {cert ? (
              <div className="rounded border p-3 space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Last Certification</span>
                  <Badge variant={cert.aggregateVerdict === "PASS" ? "default" : "destructive"} className="text-xs">
                    {cert.aggregateVerdict}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  Completed: {cert.completedAt ? new Date(cert.completedAt).toLocaleString() : "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Migration head: {cert.migrationHead}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  SHA match:{" "}
                  {cert.shaMatches === null ? (
                    <span className="text-amber-500">unknown (RELEASE_SHA not set)</span>
                  ) : cert.shaMatches ? (
                    <span className="text-green-600">✓</span>
                  ) : (
                    <span className="text-destructive">STALE ⚠</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  Config match:{" "}
                  {cert.configFingerprintMatch ? (
                    <span className="text-green-600">✓</span>
                  ) : (
                    <span className="text-destructive">MISMATCH — re-run ⚠</span>
                  )}
                </div>
                {cert.populationFingerprint && (
                  <div className="text-xs text-muted-foreground">
                    Population fingerprint: <code className="font-mono">{cert.populationFingerprint.slice(0, 16)}…</code>
                    <span className="ml-1 text-amber-600">(verify cohort unchanged)</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded border p-3 text-sm text-muted-foreground">
                No admin-triggered certification run found. Use "Run Check" to certify.
              </div>
            )}

            {/* Blockers */}
            {data.blockers.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-destructive">Blockers ({data.blockers.length})</div>
                {data.blockers.map((b, i) => (
                  <div key={i} className="flex items-start gap-1 text-xs text-destructive">
                    <XCircle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>{b}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Gate results (collapsed summary) */}
            {cert?.gateResults && cert.gateResults.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Gate results ({cert.gateResults.filter(g => g.status === "PASS").length}/{cert.gateResults.length} passed)
                </summary>
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                  {cert.gateResults.map((g, i) => (
                    <div key={i} className="flex items-center gap-2 rounded border p-1.5">
                      {g.status === "PASS" ? (
                        <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                      ) : g.status === "NOT_APPLICABLE" ? (
                        <span className="w-3 h-3 shrink-0 text-muted-foreground">—</span>
                      ) : (
                        <XCircle className="w-3 h-3 text-destructive shrink-0" />
                      )}
                      <span className="font-mono">{g.gate}</span>
                      <Badge variant={g.status === "PASS" ? "default" : g.status === "NOT_APPLICABLE" ? "secondary" : "destructive"} className="text-xs ml-auto">
                        {g.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Rollback checklist */}
            {data.rollbackChecklist && data.rollbackChecklist.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Rollback checklist ({data.rollbackChecklist.length} steps)
                </summary>
                <ol className="mt-2 space-y-1 list-decimal list-inside">
                  {data.rollbackChecklist.map((s, i) => (
                    <li key={i} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{s.step}</span> — {s.description}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
