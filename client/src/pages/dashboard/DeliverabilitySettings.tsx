import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Flame, Shield, Gauge, AlertTriangle, CheckCircle2, Loader2,
  Mail, MessageSquare, Info, Lock, X, Plus, Activity,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface DeliverabilitySettings {
  warmupEnabled: boolean;
  warmupStartDate: string | null;
  bounceThresholdPct: number;
  complaintThresholdPct: number;
  unsubscribeThresholdPct: number;
  noProspectSendEmail: boolean;
  noProspectSendSms: boolean;
  testEmailAllowlist: string[];
}

// ── Warmup schedule ────────────────────────────────────────────────────────────

const WARMUP_SCHEDULE = [
  { window: "Day 1–6",  cap: 20,  label: "Initial warmup" },
  { window: "Day 7–13", cap: 50,  label: "Ramp-up" },
  { window: "Day 14–29",cap: 100, label: "Mid warmup" },
  { window: "Day 30+",  cap: 250, label: "Full warmup" },
];

function computeWarmupDay(startDate: string | null): number | null {
  if (!startDate) return null;
  return Math.max(1, Math.floor((Date.now() - new Date(startDate).getTime()) / 86400000) + 1);
}

function computeWarmupCap(day: number | null): number | null {
  if (day === null) return null;
  if (day >= 30) return 250;
  if (day >= 14) return 100;
  if (day >= 7) return 50;
  return 20;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2">
      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function SectionLabel({ icon: Icon, label, description }: { icon: React.ComponentType<{className?:string}>; label: string; description: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <div className="p-2 rounded-lg bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-sm font-semibold">{label}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DeliverabilitySettings() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<DeliverabilitySettings>({
    queryKey: ["/api/admin/deliverability-settings"],
    refetchInterval: 60_000,
  });

  // Local form state
  const [warmupEnabled, setWarmupEnabled] = useState(false);
  const [warmupStartDate, setWarmupStartDate] = useState("");
  const [bounceThreshold, setBounceThreshold] = useState("5");
  const [complaintThreshold, setComplaintThreshold] = useState("0.1");
  const [unsubThreshold, setUnsubThreshold] = useState("5");
  const [noProspectEmail, setNoProspectEmail] = useState(true);
  const [noProspectSms, setNoProspectSms] = useState(false);
  const [allowlistInput, setAllowlistInput] = useState("");
  const [allowlist, setAllowlist] = useState<string[]>([]);

  // Sync server state → local state once loaded
  useEffect(() => {
    if (!data) return;
    setWarmupEnabled(data.warmupEnabled);
    setWarmupStartDate(data.warmupStartDate ?? "");
    setBounceThreshold(String(data.bounceThresholdPct));
    setComplaintThreshold(String(data.complaintThresholdPct));
    setUnsubThreshold(String(data.unsubscribeThresholdPct));
    setNoProspectEmail(data.noProspectSendEmail);
    setNoProspectSms(data.noProspectSendSms);
    setAllowlist(data.testEmailAllowlist ?? []);
  }, [data]);

  const warmupDay = computeWarmupDay(warmupEnabled ? warmupStartDate || null : null);
  const warmupCap = computeWarmupCap(warmupDay);

  const saveMutation = useMutation({
    mutationFn: (payload: Partial<DeliverabilitySettings> & { testEmailAllowlist?: string[] }) =>
      apiRequest("PATCH", "/api/admin/deliverability-settings", payload),
    onSuccess: () => {
      toast({ title: "Deliverability settings saved" });
      qc.invalidateQueries({ queryKey: ["/api/admin/deliverability-settings"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/launch-readiness"] });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  function save() {
    saveMutation.mutate({
      warmupEnabled,
      warmupStartDate: warmupStartDate || null,
      bounceThresholdPct: parseFloat(bounceThreshold) || 5,
      complaintThresholdPct: parseFloat(complaintThreshold) || 0.1,
      unsubscribeThresholdPct: parseFloat(unsubThreshold) || 5,
      noProspectSendEmail: noProspectEmail,
      noProspectSendSms: noProspectSms,
      testEmailAllowlist: allowlist,
    });
  }

  function addAllowlistEmail() {
    const email = allowlistInput.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast({ title: "Invalid email", variant: "destructive" });
      return;
    }
    if (allowlist.includes(email)) return;
    setAllowlist([...allowlist, email]);
    setAllowlistInput("");
  }

  function removeAllowlistEmail(email: string) {
    setAllowlist(allowlist.filter((e) => e !== email));
  }

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading deliverability settings…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader
        title="Deliverability Settings"
        subtitle="Warmup ramp, per-channel caps, bounce/complaint auto-pause thresholds, and no-prospect-send test mode."
      />

      {/* ── 1. Warmup Mode ── */}
      <Card>
        <CardHeader>
          <SectionLabel
            icon={Flame}
            label="Warmup Mode"
            description="Enforces a per-sender daily cap ramp schedule. Cap cannot be manually raised while warmup is active."
          />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Warmup mode enabled</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Overrides daily cap with warmup schedule below</p>
            </div>
            <Switch
              checked={warmupEnabled}
              onCheckedChange={setWarmupEnabled}
              data-testid="toggle-warmup-enabled"
            />
          </div>

          {warmupEnabled && (
            <div className="space-y-3 pl-2 border-l-2 border-blue-200">
              <div className="space-y-1">
                <Label className="text-xs">Warmup start date</Label>
                <Input
                  type="date"
                  value={warmupStartDate}
                  onChange={(e) => setWarmupStartDate(e.target.value)}
                  className="max-w-xs"
                  data-testid="input-warmup-start-date"
                />
                {warmupDay != null && (
                  <p className="text-xs text-blue-600 font-medium">
                    Day {warmupDay} of warmup · current cap: {warmupCap}/day
                  </p>
                )}
              </div>

              <div>
                <p className="text-xs text-muted-foreground font-medium mb-2">Warmup schedule</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border rounded-lg overflow-hidden" data-testid="table-warmup-schedule">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="py-2 px-3 text-left font-semibold">Window</th>
                        <th className="py-2 px-3 text-left font-semibold">Send cap / day</th>
                        <th className="py-2 px-3 text-left font-semibold">Stage</th>
                        <th className="py-2 px-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {WARMUP_SCHEDULE.map((row) => {
                        const current = warmupCap === row.cap;
                        return (
                          <tr key={row.window} className={`border-b ${current ? "bg-blue-50" : ""}`}>
                            <td className="py-1.5 px-3">{row.window}</td>
                            <td className="py-1.5 px-3 font-semibold">{row.cap}</td>
                            <td className="py-1.5 px-3 text-muted-foreground">{row.label}</td>
                            <td className="py-1.5 px-3">
                              {current && <Badge className="text-xs bg-blue-100 text-blue-700">current</Badge>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {!warmupEnabled && (
            <InfoNote>
              When warmup is off, the configured daily cap in Outbound Settings applies. Enable warmup to enforce the ramp schedule above.
            </InfoNote>
          )}
        </CardContent>
      </Card>

      {/* ── 2. Bounce / Complaint / Unsubscribe Thresholds ── */}
      <Card>
        <CardHeader>
          <SectionLabel
            icon={AlertTriangle}
            label="Auto-Pause Thresholds"
            description="When bounce or complaint rates exceed these thresholds, the email channel is automatically paused and an admin alert is raised."
          />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Bounce threshold (%)</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={bounceThreshold}
                  onChange={(e) => setBounceThreshold(e.target.value)}
                  min={0.1} max={50} step={0.1}
                  className="max-w-[100px]"
                  data-testid="input-bounce-threshold"
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
              <p className="text-xs text-muted-foreground">Auto-pauses email channel</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Complaint threshold (%)</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={complaintThreshold}
                  onChange={(e) => setComplaintThreshold(e.target.value)}
                  min={0.01} max={10} step={0.01}
                  className="max-w-[100px]"
                  data-testid="input-complaint-threshold"
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
              <p className="text-xs text-muted-foreground">Auto-pauses email channel</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Unsubscribe alert threshold (%)</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={unsubThreshold}
                  onChange={(e) => setUnsubThreshold(e.target.value)}
                  min={0.1} max={50} step={0.1}
                  className="max-w-[100px]"
                  data-testid="input-unsub-threshold"
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
              <p className="text-xs text-muted-foreground">Alert only — does not auto-pause</p>
            </div>
          </div>

          <InfoNote>
            Thresholds are evaluated by the anomaly detection job every 30 minutes. Bounce and complaint breaches auto-pause the email channel and write a critical alert. Unsubscribe rate triggers a warning alert only. Re-enable the channel manually from the Outbound Readiness page once you've investigated.
          </InfoNote>
        </CardContent>
      </Card>

      {/* ── 3. No-Prospect-Send Test Mode ── */}
      <Card>
        <CardHeader>
          <SectionLabel
            icon={Shield}
            label="No-Prospect-Send Test Mode"
            description="Server-side guard that rejects any send where the recipient is not on the internal test allowlist. Enable during pre-launch testing to prevent accidental sends to real prospects."
          />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2">
              <div>
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> Email guard
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">Blocks all email sends to non-allowlisted addresses</p>
              </div>
              <div className="flex items-center gap-2">
                {noProspectEmail
                  ? <Badge className="text-xs bg-green-100 text-green-700"><CheckCircle2 className="h-3 w-3 mr-1" /> Active</Badge>
                  : <Badge variant="destructive" className="text-xs"><AlertTriangle className="h-3 w-3 mr-1" /> Off</Badge>}
                <Switch
                  checked={noProspectEmail}
                  onCheckedChange={setNoProspectEmail}
                  data-testid="toggle-no-prospect-email"
                />
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between py-2">
              <div>
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" /> SMS guard
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">Blocks all SMS sends to non-allowlisted numbers</p>
              </div>
              <div className="flex items-center gap-2">
                {noProspectSms
                  ? <Badge className="text-xs bg-green-100 text-green-700"><CheckCircle2 className="h-3 w-3 mr-1" /> Active</Badge>
                  : <Badge variant="secondary" className="text-xs">Off</Badge>}
                <Switch
                  checked={noProspectSms}
                  onCheckedChange={setNoProspectSms}
                  data-testid="toggle-no-prospect-sms"
                />
              </div>
            </div>
          </div>

          {/* Test email allowlist */}
          <div className="space-y-2 pt-2">
            <Label className="text-sm font-medium">Test email allowlist</Label>
            <p className="text-xs text-muted-foreground">
              Addresses in this list (plus all @libertybancard.com addresses) can always receive sends even when guards are active.
            </p>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="test@example.com"
                value={allowlistInput}
                onChange={(e) => setAllowlistInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addAllowlistEmail()}
                className="flex-1"
                data-testid="input-allowlist-email"
              />
              <Button variant="outline" size="sm" onClick={addAllowlistEmail} data-testid="btn-add-allowlist">
                <Plus className="h-3.5 w-3.5 mr-1" /> Add
              </Button>
            </div>
            {allowlist.length > 0 && (
              <div className="space-y-1 mt-2">
                {allowlist.map((email) => (
                  <div key={email} className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded text-sm">
                    <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="flex-1 font-mono text-xs">{email}</span>
                    <Button
                      variant="ghost" size="sm" className="h-5 w-5 p-0"
                      onClick={() => removeAllowlistEmail(email)}
                      data-testid={`btn-remove-allowlist-${email}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {allowlist.length === 0 && noProspectEmail && (
              <InfoNote>
                No addresses in allowlist. Only @libertybancard.com addresses can receive sends while email guard is active.
              </InfoNote>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── 4. Reply-rate monitoring note ── */}
      <Card>
        <CardHeader>
          <SectionLabel
            icon={Activity}
            label="Reply-Rate Monitoring"
            description="Reply rate is tracked per sequence and per batch. View anomalies in the Activation Panel → Anomaly Detection section."
          />
        </CardHeader>
        <CardContent>
          <InfoNote>
            Reply-rate drops of 30%+ below the 7-day average trigger a warning alert. Drops of 50%+ trigger a critical alert. Configure thresholds in the Activation Panel. No separate configuration is needed here — monitoring is always on.
          </InfoNote>
        </CardContent>
      </Card>

      {/* ── Save button ── */}
      <div className="flex justify-end gap-3 pb-4">
        <Button
          onClick={save}
          disabled={saveMutation.isPending}
          data-testid="btn-save-deliverability"
        >
          {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save Deliverability Settings
        </Button>
      </div>
    </div>
  );
}
