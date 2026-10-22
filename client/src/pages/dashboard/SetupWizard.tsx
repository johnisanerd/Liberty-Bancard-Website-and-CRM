import { PageTitle } from "@/components/ui/page-header";
import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {useRetainedLocalIntent} from "@/hooks/use-retained-local-intent";
import { apiRequest, getCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Wifi,
  User,
  Mail,
  MessageSquare,
  Phone,
  Voicemail,
  Layers,
  FileText,
  Calendar,
  ClipboardList,
  Activity,
  ToggleLeft,
  ToggleRight,
  ExternalLink,
  Trash2,
  Play,
  X as XIcon,
  Upload,
  MapPin,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";

type StatusDot = "idle" | "loading" | "ok" | "warn" | "error";

function StatusIndicator({ status }: { status: StatusDot }) {
  if (status === "loading") return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />;
  if (status === "ok") return <CheckCircle2 className="w-4 h-4 text-green-500" />;
  if (status === "warn") return <AlertCircle className="w-4 h-4 text-yellow-500" />;
  if (status === "error") return <XCircle className="w-4 h-4 text-red-500" />;
  return <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/30" />;
}

function PhaseCard({
  phase,
  title,
  description,
  status,
  children,
}: {
  phase: number;
  title: string;
  description: string;
  status: StatusDot;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(phase === 1);

  return (
    <Card className="mb-4" data-testid={`card-phase-${phase}`}>
      <CardHeader
        className="cursor-pointer select-none pb-3"
        onClick={() => setOpen((o) => !o)}
        data-testid={`header-phase-${phase}`}
      >
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
            {phase}
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <StatusIndicator status={status} />
              {title}
            </CardTitle>
            <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
          </div>
          <div className="flex-shrink-0 text-muted-foreground">
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </div>
      </CardHeader>
      {open && <CardContent className="pt-0">{children}</CardContent>}
    </Card>
  );
}

function ConnectivityRow({
  label,
  data,
}: {
  label: string;
  data?: { ok: boolean; detail: string; latencyMs?: number; queueMode?: "bullmq_redis" | "legacy_interval_partial" | "unavailable"; configured?: boolean };
}) {
  if (!data) return null;
  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0" data-testid={`row-connectivity-${label.toLowerCase()}`}>
      <StatusIndicator status={data.ok ? "ok" : "warn"} />
      <span className="font-medium text-sm w-28 shrink-0">{label}</span>
      <span className="text-sm text-muted-foreground flex-1">{data.detail}</span>
      {data.latencyMs !== undefined && data.ok && (
        <span className="text-xs text-muted-foreground shrink-0">{data.latencyMs}ms</span>
      )}
      {data.queueMode && data.queueMode !== "bullmq_redis" && (
        <Badge variant="outline" className="text-yellow-600 border-yellow-400 text-xs shrink-0">{data.queueMode}</Badge>
      )}
    </div>
  );
}

// ─── Phase 1 ──────────────────────────────────────────────────────────────────
function Phase1Connectivity() {
  const { data, isLoading, isError, refetch } = useQuery<{
    ghl: { ok: boolean; latencyMs: number; detail: string };
    redis: { ok: boolean; queueMode: "bullmq_redis" | "legacy_interval_partial" | "unavailable"; detail: string };
    openai: { ok: boolean; detail: string };
    smtp: { ok: boolean; configured: boolean; detail: string };
    webhookSecret: { ok: boolean; detail: string };
  }>({
    queryKey: ["/api/wizard/connectivity"],
    staleTime: 30_000,
    retry: false,
  });

  const overallStatus: StatusDot = isLoading
    ? "loading"
    : isError
    ? "error"
    : data
    ? Object.values(data).every((v: any) => v.ok)
      ? "ok"
      : Object.values(data).some((v: any) => v.ok)
      ? "warn"
      : "error"
    : "idle";

  return (
    <PhaseCard
      phase={1}
      title="Connectivity"
      description="Auto-runs on load — checks GHL, Redis, OpenAI, SMTP, and webhook secret."
      status={overallStatus}
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Running connectivity checks…
        </div>
      )}
      {isError && (
        <p className="text-sm text-destructive py-2">Connectivity check failed. Is the server running?</p>
      )}
      {data && (
        <div className="divide-y">
          <ConnectivityRow label="GHL" data={data.ghl} />
          <ConnectivityRow label="Redis" data={data.redis} />
          <ConnectivityRow label="OpenAI" data={data.openai} />
          <ConnectivityRow label="SMTP" data={data.smtp} />
          <ConnectivityRow label="Webhook" data={data.webhookSecret} />
        </div>
      )}
      {data?.redis?.queueMode !== "bullmq_redis" && (
        <div className="mt-3 p-3 rounded-md bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 text-sm text-yellow-800 dark:text-yellow-200">
          ⚠ BullMQ queue mode: {data?.redis?.queueMode}. Set <code className="text-xs bg-yellow-100 dark:bg-yellow-900 px-1 rounded">REDIS_URL</code> to enable durable queues.
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={() => refetch()}
        disabled={isLoading}
        data-testid="button-recheck-connectivity"
      >
        {isLoading ? <><Loader2 className="w-3 h-3 animate-spin mr-1" />Checking…</> : "Re-check"}
      </Button>
    </PhaseCard>
  );
}

// ─── Phase 2 ──────────────────────────────────────────────────────────────────
function Phase2TestContact({
  testContactId,
  setTestContactId,
}: {
  testContactId: number | null;
  setTestContactId: (id: number | null) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState((user as any)?.email ?? "");
  const [phone, setPhone] = useState("");

  const createMutation = useMutation({
    mutationFn: async (body: { email: string; phone?: string }) => {
      const res = await apiRequest("POST", "/api/wizard/test-contact", body);
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestContactId(data.contactId);
      toast({
        title: data.alreadyExisted ? "Test contact already exists" : "Test contact created",
        description: `Contact ID: ${data.contactId} — ${data.email}`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Failed to create test contact", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (contactId: number) =>
      apiRequest("DELETE", `/api/wizard/test-contact/${contactId}`),
    onSuccess: () => {
      setTestContactId(null);
      toast({ title: "Test contact deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const status: StatusDot = testContactId ? "ok" : "idle";

  return (
    <PhaseCard
      phase={2}
      title="Test Contact Setup"
      description="Create a tagged test contact to use for all live-fire tests below."
      status={status}
    >
      {testContactId ? (
        <div className="flex items-center gap-3 p-3 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 mb-3">
          <CheckCircle2 className="w-4 h-4 text-green-600" />
          <div className="flex-1 text-sm">
            <span className="font-medium">Test contact active</span>
            <span className="text-muted-foreground ml-2">ID: {testContactId}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive border-destructive/30 hover:bg-destructive/5"
            onClick={() => deleteMutation.mutate(testContactId)}
            disabled={deleteMutation.isPending}
            data-testid="button-delete-test-contact"
          >
            {deleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            <span className="ml-1">Delete</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-3 mb-4">
          <div className="space-y-1">
            <Label htmlFor="wizard-email" className="text-sm">Email (admin email pre-filled)</Label>
            <Input
              id="wizard-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              data-testid="input-wizard-email"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wizard-phone" className="text-sm">Test phone (optional, for SMS/voice tests)</Label>
            <Input
              id="wizard-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+15555550100"
              data-testid="input-wizard-phone"
            />
          </div>
        </div>
      )}

      {!testContactId && (
        <Button
          size="sm"
          onClick={() => createMutation.mutate({ email, phone: phone || undefined })}
          disabled={!email || createMutation.isPending}
          data-testid="button-create-test-contact"
        >
          {createMutation.isPending ? <><Loader2 className="w-3 h-3 animate-spin mr-1" />Creating…</> : "Create Test Contact"}
        </Button>
      )}
    </PhaseCard>
  );
}

// ─── Phase 3 ──────────────────────────────────────────────────────────────────
function ChannelTestCard({
  icon: Icon,
  label,
  channel,
  contactId,
  flagEnabled,
  flagName,
  onResult,
}: {
  icon: any;
  label: string;
  channel: string;
  contactId: number | null;
  flagEnabled: boolean;
  flagName: string;
  onResult?: (channel: string, ok: boolean) => void;
}) {
  const { toast } = useToast();
  const [result, setResult] = useState<{ ok: boolean; detail: string; blocked?: boolean } | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/wizard/test-send/${channel}`, { contactId });
      return res.json();
    },
    onSuccess: (data: any) => {
      setResult(data);
      onResult?.(channel, !!data.ok);
      toast({
        title: data.ok ? `${label} test sent` : `${label} test failed`,
        description: data.detail || data.reason,
        variant: data.ok ? "default" : "destructive",
      });
    },
    onError: (err: any) => {
      setResult({ ok: false, detail: err.message });
      onResult?.(channel, false);
      toast({ title: "Send error", description: err.message, variant: "destructive" });
    },
  });

  const disabled = !contactId || !flagEnabled;
  const tooltipMsg = !contactId
    ? "Create a test contact first (Phase 2)"
    : !flagEnabled
    ? `${flagName} is off — enable in Phase 6`
    : "";

  return (
    <div className="border rounded-lg p-4 space-y-2" data-testid={`card-channel-${channel}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium text-sm">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={flagEnabled ? "default" : "outline"}
            className={flagEnabled ? "bg-green-100 text-green-800 border-green-300" : "text-muted-foreground"}
          >
            {flagEnabled ? "ON" : "OFF"}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={() => mutation.mutate()}
            disabled={disabled || mutation.isPending}
            title={tooltipMsg}
            data-testid={`button-send-${channel}`}
          >
            {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            <span className="ml-1">Send Test</span>
          </Button>
        </div>
      </div>

      {result && (
        <div
          className={`flex items-start gap-2 text-xs p-2 rounded ${
            result.ok
              ? "bg-green-50 dark:bg-green-950 text-green-800 dark:text-green-200"
              : result.blocked
              ? "bg-yellow-50 dark:bg-yellow-950 text-yellow-800 dark:text-yellow-200"
              : "bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200"
          }`}
          data-testid={`result-channel-${channel}`}
        >
          {result.ok ? <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" /> :
           result.blocked ? <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /> :
           <XCircle className="w-3 h-3 mt-0.5 shrink-0" />}
          <span>{result.detail ?? result.blocked}</span>
        </div>
      )}
    </div>
  );
}

function Phase3LiveChannelTests({
  testContactId,
  flagStates,
}: {
  testContactId: number | null;
  flagStates: Record<string, { enabled: boolean }>;
}) {
  const channels = [
    { icon: Mail, label: "Email", channel: "email", flagName: "EMAIL", flagEnabled: true },
    { icon: MessageSquare, label: "SMS", channel: "sms", flagName: "SMS_ENABLED", flagEnabled: flagStates.SMS_ENABLED?.enabled ?? false },
    { icon: Phone, label: "Voice AI", channel: "voice", flagName: "VOICE_AI_ENABLED", flagEnabled: flagStates.VOICE_AI_ENABLED?.enabled ?? false },
    { icon: Voicemail, label: "Ringless VM", channel: "voicemail", flagName: "RINGLESS_VM_ENABLED", flagEnabled: flagStates.RINGLESS_VM_ENABLED?.enabled ?? false },
  ];

  const [channelResults, setChannelResults] = useState<Record<string, boolean | null>>({});
  const anyOk = Object.values(channelResults).some((v) => v === true);
  const anyFail = Object.values(channelResults).some((v) => v === false);
  const status: StatusDot = !testContactId ? "idle" : anyOk ? "ok" : anyFail ? "warn" : "idle";

  return (
    <PhaseCard
      phase={3}
      title="Live Channel Tests"
      description="Send live test messages to your test contact. Email always available; SMS/voice require their flags to be ON."
      status={status}
    >
      {!testContactId && (
        <div className="text-sm text-muted-foreground mb-3 p-2 rounded bg-muted/40">
          ← Create a test contact in Phase 2 first
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {channels.map((ch) => (
          <ChannelTestCard
            key={ch.channel}
            {...ch}
            contactId={testContactId}
            onResult={(channel, ok) => setChannelResults((prev) => ({ ...prev, [channel]: ok }))}
          />
        ))}
      </div>
    </PhaseCard>
  );
}

// ─── Phase 4 ──────────────────────────────────────────────────────────────────
function Phase4AutomationTests({ testContactId }: { testContactId: number | null }) {
  const { toast } = useToast();
  const [enrollmentResult, setEnrollmentResult] = useState<any>(null);
  const [appResult, setAppResult] = useState<any>(null);
  const [statementResult, setStatementResult] = useState<any>(null);
  const [appEmail, setAppEmail] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const sequenceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/wizard/test-sequence", { contactId: testContactId });
      return res.json();
    },
    onSuccess: (data: any) => {
      setEnrollmentResult(data);
      toast({
        title: data.ok ? "Enrolled in sequence" : "Sequence enrollment failed",
        description: data.ok ? `Enrolled in "${data.sequenceName}"` : (data.error ?? "Unknown error"),
        variant: data.ok ? "default" : "destructive",
      });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const cancelEnrollmentMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/wizard/test-sequence/${id}`),
    onSuccess: () => {
      setEnrollmentResult(null);
      toast({ title: "Enrollment cancelled" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const applicationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/wizard/test-application", { email: appEmail });
      return res.json();
    },
    onSuccess: (data: any) => {
      setAppResult(data);
      toast({ title: data.ok ? "Test application created" : "Failed", description: data.ok ? `Deal #${data.dealId} created` : "Error" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const [bookingLinks, setBookingLinks] = useState<any>(null);
  const [bookingLoading, setBookingLoading] = useState(false);

  const loadBookingLinks = async () => {
    setBookingLoading(true);
    try {
      const res = await fetch("/api/wizard/booking-links", { credentials: "include" });
      setBookingLinks(await res.json());
    } catch (err: any) {
      toast({ title: "Error loading booking links", description: err.message, variant: "destructive" });
    } finally {
      setBookingLoading(false);
    }
  };

  const analyzeFile = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const csrfToken = getCsrfToken();
    try {
      const res = await fetch("/api/wizard/test-statement", {
        method: "POST",
        credentials: "include",
        headers: csrfToken ? { "X-CSRF-Token": csrfToken } : {},
        body: form,
      });
      const data = await res.json();
      setStatementResult(data);
      toast({ title: "Statement analyzed", description: `${data.processorDetected ?? "Unknown processor"} — ${data.effectiveRate ?? "N/A"}` });
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) analyzeFile(file);
  }, []);

  const overallStatus: StatusDot =
    enrollmentResult?.ok || appResult?.ok || statementResult?.processorDetected
      ? "ok"
      : "idle";

  return (
    <PhaseCard
      phase={4}
      title="Automation Tests"
      description="Verify sequence enrollment, AI statement analysis, booking links, and deal creation."
      status={overallStatus}
    >
      {/* 4A: Sequence Enrollment */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-2">
          <Layers className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm">4A — Sequence Enrollment</span>
        </div>
        {!testContactId && (
          <p className="text-xs text-muted-foreground mb-2">← Create a test contact in Phase 2 first</p>
        )}
        {enrollmentResult?.ok ? (
          <div className="p-3 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-green-800 dark:text-green-200">
                Enrolled in "{enrollmentResult.sequenceName}"
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive h-7"
                onClick={() => cancelEnrollmentMutation.mutate(enrollmentResult.enrollmentId)}
                disabled={cancelEnrollmentMutation.isPending}
                data-testid="button-cancel-enrollment"
              >
                <XIcon className="w-3 h-3 mr-1" />Cancel
              </Button>
            </div>
            <div className="text-xs text-green-700 dark:text-green-300 space-y-1">
              {enrollmentResult.steps?.slice(0, 3).map((s: any, i: number) => (
                <div key={i}>
                  Step {s.stepNumber}: {s.type} — {s.delayHours}h delay{s.subject ? ` — "${s.subject}"` : ""}
                </div>
              ))}
              {enrollmentResult.steps?.length > 3 && (
                <div>…and {enrollmentResult.steps.length - 3} more steps</div>
              )}
            </div>
          </div>
        ) : enrollmentResult && !enrollmentResult.ok ? (
          <div className="p-3 rounded-md bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 text-sm text-yellow-800 dark:text-yellow-200 mb-2" data-testid="result-sequence">
            {enrollmentResult.error}
          </div>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => sequenceMutation.mutate()}
          disabled={!testContactId || sequenceMutation.isPending || !!enrollmentResult?.ok}
          data-testid="button-test-sequence"
        >
          {sequenceMutation.isPending ? <><Loader2 className="w-3 h-3 animate-spin mr-1" />Enrolling…</> : "Test Sequence Enrollment"}
        </Button>
      </div>

      <Separator className="my-4" />

      {/* 4B: Statement Analysis */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-2">
          <FileText className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm">4B — Statement AI Audit</span>
        </div>
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
            isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          data-testid="dropzone-statement"
        >
          <Upload className="w-6 h-6 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Drop a PDF statement here or click to browse</p>
          <p className="text-xs text-muted-foreground mt-1">PDF only — max 5MB</p>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) analyzeFile(f); }}
            data-testid="input-statement-file"
          />
        </div>
        {statementResult && (
          <div className="mt-3 border rounded-lg overflow-hidden" data-testid="table-statement-result">
            <table className="w-full text-sm">
              <tbody>
                {[
                  ["Processor", statementResult.processorDetected ?? "N/A"],
                  ["Effective Rate", statementResult.effectiveRate ?? "N/A"],
                  ["Monthly Volume", statementResult.monthlyVolume ?? "N/A"],
                  ["Estimated Savings", statementResult.estimatedSavings ?? "N/A"],
                  ["Analysis Time", statementResult.durationMs ? `${statementResult.durationMs}ms` : "N/A"],
                ].map(([label, value]) => (
                  <tr key={label} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium text-muted-foreground w-40">{label}</td>
                    <td className="px-3 py-2">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Separator className="my-4" />

      {/* 4C: Booking Links */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm">4C — Booking Links</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={loadBookingLinks}
          disabled={bookingLoading}
          data-testid="button-load-booking-links"
        >
          {bookingLoading ? <><Loader2 className="w-3 h-3 animate-spin mr-1" />Loading…</> : "Check Booking Links"}
        </Button>
        {bookingLinks && (
          <div className="mt-3 space-y-2" data-testid="list-booking-links">
            {bookingLinks.calendars?.map((cal: any) => (
              <div key={cal.key} className="flex items-center gap-2 text-sm border rounded-md p-2">
                <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                <span className="font-medium w-24 shrink-0">{cal.name}</span>
                <span className="text-muted-foreground text-xs flex-1 truncate">{cal.calendarId}</span>
                <a
                  href={cal.bookingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline flex items-center gap-1 shrink-0"
                  data-testid={`link-booking-${cal.key}`}
                >
                  <ExternalLink className="w-3 h-3" /> Open
                </a>
              </div>
            ))}
            {bookingLinks.unconfigured?.map((key: string) => (
              <div key={key} className="flex items-center gap-2 text-sm border rounded-md p-2 opacity-50">
                <XCircle className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">{key} — not configured</span>
              </div>
            ))}
            {!bookingLinks.configured && bookingLinks.unconfigured?.length > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                Set <code>GHL_CALENDAR_ID</code> and related env vars to enable booking links.
              </p>
            )}
          </div>
        )}
      </div>

      <Separator className="my-4" />

      {/* 4D: Application Test */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <ClipboardList className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm">4D — Merchant Application Test</span>
        </div>
        <div className="flex gap-2 mb-2">
          <Input
            type="email"
            placeholder="test+app@example.com"
            value={appEmail}
            onChange={(e) => setAppEmail(e.target.value)}
            className="flex-1"
            data-testid="input-app-email"
          />
          <Button
            size="sm"
            onClick={() => applicationMutation.mutate()}
            disabled={!appEmail || applicationMutation.isPending}
            data-testid="button-test-application"
          >
            {applicationMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Create Test Deal"}
          </Button>
        </div>
        {appResult?.ok && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-200" data-testid="result-application">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Deal #{appResult.dealId} created</span>
            <a
              href={appResult.dealUrl}
              className="ml-auto text-primary hover:underline flex items-center gap-1 shrink-0"
              data-testid="link-view-deal"
            >
              View deal <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>
    </PhaseCard>
  );
}

// ─── Phase 5 ──────────────────────────────────────────────────────────────────
function Phase5QueueHealth() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const check = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/wizard/queue-health", { credentials: "include" });
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      toast({ title: "Queue health check failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const status: StatusDot = !result
    ? "idle"
    : result.queues?.some((q: any) => q.isStale)
    ? "warn"
    : "ok";

  return (
    <PhaseCard
      phase={5}
      title="Queue & Cron Health"
      description="Verify BullMQ workers are running and processing jobs on schedule."
      status={status}
    >
      {result?.queueMode && result.queueMode !== "bullmq_redis" && (
        <div className="mb-3 p-3 rounded-md bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 text-sm text-yellow-800 dark:text-yellow-200">
          ⚠ BullMQ queue mode: {result.queueMode}. Queue diagnostics do not indicate durable processing.
        </div>
      )}
      {result?.queues && (
        <div className="overflow-x-auto mb-3">
          <table className="w-full text-sm" data-testid="table-queue-health">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left py-1 pr-3">Queue</th>
                <th className="text-left py-1 pr-3">Status</th>
                <th className="text-left py-1 pr-3">Waiting</th>
                <th className="text-left py-1 pr-3">Failed</th>
                <th className="text-left py-1">Last Run</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.queues.map((q: any) => (
                <tr key={q.name} data-testid={`row-queue-${q.name}`}>
                  <td className="py-2 pr-3 font-mono text-xs">{q.name}</td>
                  <td className="py-2 pr-3">
                    {q.isStale ? (
                      <Badge className="bg-red-100 text-red-800 border-red-300 text-xs">STALE</Badge>
                    ) : q.paused ? (
                      <Badge variant="outline" className="text-yellow-600 border-yellow-400 text-xs">PAUSED</Badge>
                    ) : (
                      <Badge className="bg-green-100 text-green-800 border-green-300 text-xs">OK</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs">{q.waiting}</td>
                  <td className="py-2 pr-3 text-xs">{q.failed > 0 ? <span className="text-red-600">{q.failed}</span> : q.failed}</td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {q.lastCompletedAt
                      ? new Date(q.lastCompletedAt).toLocaleString()
                      : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={check}
        disabled={loading}
        data-testid="button-check-queue-health"
      >
        {loading ? <><Loader2 className="w-3 h-3 animate-spin mr-1" />Checking…</> : <><Activity className="w-3 h-3 mr-1" />Check Queue Health</>}
      </Button>
    </PhaseCard>
  );
}

// ─── Phase 6 ──────────────────────────────────────────────────────────────────
const FLAG_METADATA: Record<string, { label: string; impact: string }> = {
  LEGACY_OUTREACH_ENABLED:    { label: "Legacy Outreach",   impact: "Enables automated cold email sends via sequence worker" },
  ORCHESTRATOR_ENABLED:       { label: "AI Orchestrator",   impact: "Starts AI SDR autonomous lead scoring + routing" },
  SMS_ENABLED:                { label: "SMS",               impact: "Enables SMS channel — requires TCPA PEWC consent" },
  VOICE_AI_ENABLED:           { label: "Voice AI",          impact: "Enables AI voice calls — requires TCPA consent" },
  RINGLESS_VM_ENABLED:        { label: "Ringless VM",       impact: "Enables ringless voicemail drops" },
  NIGHTLY_DISCOVERY_ENABLED:  { label: "Nightly Discovery", impact: "Enables nightly Sunbiz/Outscraper lead discovery" },
  SDR_ENABLED:                { label: "SDR",               impact: "Enables the AI SDR worker to process leads" },
  FREE_ENRICHMENT_ENABLED:    { label: "Free Enrichment",   impact: "Enables the no-cost JSON-LD/RDAP/contact-page enrichment pipeline required before any paid provider pilot" },
};

function FlagRow({
  flagKey,
  state,
  onToggle,
  isAdmin,
}: {
  flagKey: string;
  state: { enabled: boolean; source: string; envVarName: string };
  onToggle: (flag: string, enabled: boolean, reason: string) => void;
  isAdmin: boolean;
}) {
  const meta = FLAG_METADATA[flagKey] ?? { label: flagKey, impact: "Feature flag" };
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");

  const sourceLabel: Record<string, { text: string; variant: "outline" | "default" | "secondary" }> = {
    env:         { text: "ENV VAR", variant: "outline" },
    db_override: { text: "DB OVERRIDE", variant: "default" },
    default:     { text: "DEFAULT", variant: "secondary" },
  };
  const sl = sourceLabel[state.source] ?? { text: state.source, variant: "outline" };

  const handleConfirm = () => {
    if (reason.trim().length < 10) return;
    onToggle(flagKey, !state.enabled, reason.trim());
    setDialogOpen(false);
    setReason("");
  };

  return (
    <div className="flex items-start gap-3 py-3 border-b last:border-0" data-testid={`row-flag-${flagKey}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{meta.label}</span>
          <Badge variant={sl.variant} className="text-xs">{sl.text}</Badge>
          {state.source === "env" && (
            <span className="text-xs text-muted-foreground">{state.envVarName}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{meta.impact}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge
          className={state.enabled
            ? "bg-green-100 text-green-800 border-green-300"
            : "bg-muted text-muted-foreground"}
        >
          {state.enabled ? "ENABLED" : "DISABLED"}
        </Badge>
        {isAdmin && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDialogOpen(true)}
            disabled={state.source === "env"}
            title={state.source === "env" ? "Set via environment variable — DB override is secondary" : undefined}
            data-testid={`button-toggle-flag-${flagKey}`}
            className="h-7 px-2"
          >
            {state.enabled ? <ToggleRight className="w-4 h-4 text-green-600" /> : <ToggleLeft className="w-4 h-4 text-muted-foreground" />}
          </Button>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{state.enabled ? "Disable" : "Enable"} {meta.label}?</DialogTitle>
            <DialogDescription>
              {meta.impact}. This change is written to the database and takes effect immediately (30s cache).
              {state.source === "env" && " Note: an environment variable is also set and will take priority."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`reason-${flagKey}`} className="text-sm font-medium">
              Reason for this change <span className="text-muted-foreground">(required, min 10 chars)</span>
            </Label>
            <Textarea
              id={`reason-${flagKey}`}
              placeholder="e.g. Enabling SMS for go-live — PEWC consent verified in audit"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              data-testid="input-flag-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              variant={state.enabled ? "destructive" : "default"}
              onClick={handleConfirm}
              disabled={reason.trim().length < 10}
              data-testid="button-confirm-flag-toggle"
            >
              {state.enabled ? "Disable" : "Enable"} {meta.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Phase6GoLive({ flagStates, setFlagStates }: {
  flagStates: Record<string, { enabled: boolean; source: string; envVarName: string }>;
  setFlagStates: (s: Record<string, { enabled: boolean; source: string; envVarName: string }>) => void;
}) {
  const { user } = useAuth();
  const isAdmin = (user as any)?.role === "admin";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sequences, setSequences] = useState<any[]>([]);
  const sequenceIntents=useRetainedLocalIntent();
  const [seqLoading, setSeqLoading] = useState(false);

  const loadSequences = async () => {
    setSeqLoading(true);
    try {
      const res = await fetch("/api/sequences?limit=200", { credentials: "include" });
      if(!res.ok) throw new Error("Sequence list unavailable. Retry before taking action.");
      const data = await res.json();
      const all: any[] = Array.isArray(data) ? data : (data.sequences ?? data.data ?? []);
      setSequences(all.filter((s: any) => s.name?.startsWith("W6")));
    } catch (err: any) {
      toast({ title: "Failed to load sequences", description: err.message, variant: "destructive" });
    } finally {
      setSeqLoading(false);
    }
  };

  const toggleSequence = async (id: number, currentStatus: string) => {
    const csrfToken = getCsrfToken();
    try {
      const row=sequences.find(row=>row.id===id);
      if(!row?.version || row.retiredAt) throw new Error("Sequence unavailable or retired. Reload before changing its state.");
      const res = await fetch(`/api/sequences/${id}/toggle-status`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
        body:JSON.stringify(sequenceIntents.payload(`toggle:${id}`,{expectedVersion:row.version})),
      });
      if(!res.ok) {
        const error=await res.json();
        throw new Error(error.message || "Sequence change not applied");
      }
      const updated = await res.json();
      sequenceIntents.accepted(`toggle:${id}`);
      setSequences((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...updated } : s))
      );
      toast({ title: `Sequence ${updated.status === "active" ? "activated" : "paused"}` });
    } catch (err: any) {
      toast({ title: "Toggle failed", description: err.message, variant: "destructive" });
    }
  };

  const activateAll = async () => {
    const paused = sequences.filter((s) => s.status !== "active");
    for (const seq of paused) {
      await toggleSequence(seq.id, seq.status);
    }
    toast({ title: "All W6 sequences activated" });
  };

  const handleFlagToggle = async (flag: string, enabled: boolean, reason: string) => {
    const csrfRes = await fetch("/api/csrf-token", { credentials: "include" });
    const { token } = await csrfRes.json();

    const res = await fetch("/api/wizard/feature-flag", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ flag, enabled, confirmReason: reason }),
    });

    if (!res.ok) {
      const err = await res.json();
      toast({ title: "Flag change failed", description: err.error, variant: "destructive" });
      return;
    }

    const updated = await res.json();
    toast({ title: `${flag} ${updated.enabled ? "enabled" : "disabled"} (DB override)` });

    const refetch = await fetch("/api/wizard/feature-flags", { credentials: "include" });
    if (refetch.ok) setFlagStates(await refetch.json());
  };

  const status: StatusDot = Object.keys(flagStates).length > 0 ? "warn" : "idle";

  return (
    <PhaseCard
      phase={6}
      title="Go-Live Activation Summary"
      description="Activate W6 sequences and toggle feature flags with an audit trail."
      status={status}
    >
      {/* 6A: W6 Sequences */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <span className="font-semibold text-sm">6A — W6 Sequence Activator</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={loadSequences} disabled={seqLoading} data-testid="button-load-sequences">
              {seqLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Load"}
            </Button>
            {sequences.length > 0 && (
              <Button size="sm" onClick={activateAll} data-testid="button-activate-all-sequences">
                Activate All W6
              </Button>
            )}
          </div>
        </div>
        {sequences.length === 0 && !seqLoading && (
          <p className="text-xs text-muted-foreground">Click Load to fetch W6 sequences.</p>
        )}
        {sequences.map((seq) => (
          <div key={seq.id} className="flex items-center gap-2 py-2 border-b last:border-0" data-testid={`row-sequence-${seq.id}`}>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium truncate block">{seq.name}</span>
              <span className="text-xs text-muted-foreground">{seq.stepCount ?? 0} steps</span>
            </div>
            <Badge
              className={seq.status === "active"
                ? "bg-green-100 text-green-800 border-green-300 text-xs"
                : "bg-muted text-muted-foreground text-xs"}
            >
              {seq.status === "active" ? "Active" : "Paused"}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => toggleSequence(seq.id, seq.status)}
              data-testid={`button-toggle-sequence-${seq.id}`}
            >
              {seq.status === "active" ? "Pause" : "Activate"}
            </Button>
          </div>
        ))}
      </div>

      <Separator className="my-4" />

      {/* 6B: Feature Flags */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm">6B — Feature Flag Controls</span>
          {!isAdmin && (
            <span className="text-xs text-muted-foreground">(read-only for managers — admin required to toggle)</span>
          )}
        </div>
        {Object.entries(flagStates).map(([key, state]) => (
          <FlagRow
            key={key}
            flagKey={key}
            state={state}
            onToggle={handleFlagToggle}
            isAdmin={isAdmin}
          />
        ))}
        {Object.keys(flagStates).length === 0 && (
          <p className="text-xs text-muted-foreground">Loading feature flags…</p>
        )}
      </div>

      <Separator className="my-4" />

      {/* 6C: Field Sales Pilot */}
      <FieldSalesPilotPanel isAdmin={isAdmin} />
    </PhaseCard>
  );
}

// ─── Field Sales Pilot Panel ──────────────────────────────────────────────────
function FieldSalesPilotPanel({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{
    reps: { id: string; email: string | null; firstName: string | null; lastName: string | null; role: string | null; inPilot: boolean }[];
    pilotIds: string[];
  }>({
    queryKey: ["/api/admin/field-sales-pilot"],
    staleTime: 30_000,
  });

  const toggle = async (userId: string, currentlyIn: boolean) => {
    setTogglingId(userId);
    try {
      const csrfToken = getCsrfToken();
      const res = await fetch(`/api/admin/field-sales-pilot/${userId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
        body: JSON.stringify({ enabled: !currentlyIn }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Toggle failed");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/field-sales-pilot"] });
      toast({ title: `Rep ${currentlyIn ? "removed from" : "added to"} Field Sales pilot` });
    } catch (err: any) {
      toast({ title: "Toggle failed", description: err.message, variant: "destructive" });
    } finally {
      setTogglingId(null);
    }
  };

  const reps = data?.reps ?? [];
  const pilotCount = reps.filter((r) => r.inPilot).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm">6C — Field Sales Pilot Reps</span>
          {pilotCount > 0 && (
            <Badge className="bg-blue-100 text-blue-800 border-blue-300 text-xs">{pilotCount} in pilot</Badge>
          )}
        </div>
        {!isAdmin && (
          <span className="text-xs text-muted-foreground">admin required to toggle</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Toggle per-rep access to Field Day without a redeploy. Reps in the pilot list can use the
        Field Sales module when <code className="font-mono">FIELD_SALES_ENABLED</code> is on.
        Admins and managers always have access regardless of this list.
      </p>
      {isLoading && <p className="text-xs text-muted-foreground">Loading reps…</p>}
      {!isLoading && reps.length === 0 && (
        <p className="text-xs text-muted-foreground">No rep accounts found.</p>
      )}
      {reps.map((rep) => {
        const name = [rep.firstName, rep.lastName].filter(Boolean).join(" ") || rep.email || rep.id;
        const isBusy = togglingId === rep.id;
        return (
          <div key={rep.id} className="flex items-center gap-3 py-2 border-b last:border-0">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium truncate block">{name}</span>
              <span className="text-xs text-muted-foreground">{rep.email ?? rep.id} · {rep.role}</span>
            </div>
            {rep.inPilot && (
              <Badge className="bg-green-100 text-green-800 border-green-300 text-xs shrink-0">Pilot</Badge>
            )}
            <Switch
              checked={rep.inPilot}
              disabled={!isAdmin || isBusy}
              onCheckedChange={() => toggle(rep.id, rep.inPilot)}
              aria-label={`Toggle Field Sales pilot for ${name}`}
            />
            {isBusy && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function SetupWizard() {
  const [testContactId, setTestContactId] = useState<number | null>(null);
  const [flagStates, setFlagStates] = useState<Record<string, { enabled: boolean; source: string; envVarName: string }>>({});

  const flagQuery = useQuery<Record<string, { enabled: boolean; source: string; envVarName: string }>>({
    queryKey: ["/api/wizard/feature-flags"],
    staleTime: 30_000,
    retry: false,
  });

  const resolvedFlags = flagQuery.data ?? flagStates;

  const updateFlags = (s: Record<string, { enabled: boolean; source: string; envVarName: string }>) => {
    setFlagStates(s);
  };

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 space-y-2">
      <div className="flex items-center gap-3 mb-6">
        <FlaskConical className="w-6 h-6 text-primary" />
        <div>
          <PageTitle className="text-xl font-bold">Setup & Activation Wizard</PageTitle>
          <p className="text-sm text-muted-foreground">
            Step through each phase to verify your platform is ready for live operations.
          </p>
        </div>
      </div>

      <Phase1Connectivity />
      <Phase2TestContact testContactId={testContactId} setTestContactId={setTestContactId} />
      <Phase3LiveChannelTests testContactId={testContactId} flagStates={resolvedFlags} />
      <Phase4AutomationTests testContactId={testContactId} />
      <Phase5QueueHealth />
      <Phase6GoLive flagStates={flagQuery.data ?? flagStates} setFlagStates={updateFlags} />
    </div>
  );
}
