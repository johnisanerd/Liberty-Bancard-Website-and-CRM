import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  CheckCircle2, XCircle, AlertCircle, RefreshCw, ExternalLink,
  Mail, MessageSquare, Globe, Shield, Zap, Activity,
  Loader2, ChevronRight, Lock, Unlock, Key, Phone,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ZeroBounceUsage {
  usedToday: number;
}

interface OutboundSettings {
  outboundGlobalPaused: boolean;
  outboundGlobalPausedReason: string | null;
  outboundDailyEmailCap: number;
  coldEmailSendsToday: number;
  coldEmailRemainingToday: number;
  emailChannelPaused: boolean;
  smsChannelPaused: boolean;
  coldEmailChannelPaused: boolean;
}

interface GmailOAuthStatus {
  secretsPresent: boolean;
  encryptionAvailable: boolean;
  encryptionDetail: string;
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  aliases: string[];
  acceptedAliases: string[];
  scopes: string[];
}

interface GmailVerifyResult { success: boolean; email?: string; error?: string }
interface GmailAuthorizeResult { authUrl: string; redirectUri: string }

interface ColdEmailProbe {
  ok: boolean;
  method: string;
  apiReachable: boolean;
  requiredDomain: string;
  requiredSender: string;
  detectedDomain: string | null;
  detectedSender: string | null;
  domainVerified: boolean;
  senderVerified: boolean;
  attestation: { attestedBy: string; attestedAt: string; attestationNote: string } | null;
  probeTimestamp: string;
}

interface SmsProbe {
  ok: boolean;
  method: string;
  apiReachable: boolean;
  smsCapable: boolean;
  smsSendingNumber: string | null;
  a2pApprovalAttested: boolean;
  a2pAttestation: { attestedBy: string; attestedAt: string } | null;
  phoneNumbers: { number: string; capabilities: string[] }[];
  consentNote: string;
  numberAttestation: { attestedBy: string } | null;
}

// ── Status indicators ──────────────────────────────────────────────────────────

function StatusIcon({ ok, loading }: { ok: boolean | null; loading?: boolean }) {
  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (ok === null) return <AlertCircle className="h-4 w-4 text-yellow-500" />;
  return ok
    ? <CheckCircle2 className="h-4 w-4 text-green-500" />
    : <XCircle className="h-4 w-4 text-red-500" />;
}

function GateBadge({ ok, loading }: { ok: boolean | null; loading?: boolean }) {
  if (loading) return <Badge variant="outline" className="text-xs">Checking…</Badge>;
  if (ok === null) return <Badge variant="outline" className="text-xs text-yellow-600 border-yellow-300 bg-yellow-50">Warning</Badge>;
  return ok
    ? <Badge variant="outline" className="text-xs text-green-700 border-green-300 bg-green-50">Pass</Badge>
    : <Badge variant="outline" className="text-xs text-red-700 border-red-300 bg-red-50">Fail</Badge>;
}

function GateRow({ label, ok, loading, note }: { label: string; ok: boolean | null; loading?: boolean; note?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <div className="flex items-center gap-2">
        <StatusIcon ok={ok} loading={loading} />
        <span>{label}</span>
        {note && <span className="text-xs text-muted-foreground">— {note}</span>}
      </div>
      <GateBadge ok={ok} loading={loading} />
    </div>
  );
}

function ChannelToggle({
  label, description, checked, onChange, disabled,
}: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        {checked ? <Lock className="h-3 w-3 text-red-500" /> : <Unlock className="h-3 w-3 text-green-500" />}
        <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} data-testid={`toggle-${label.toLowerCase().replace(/\s+/g, "-")}`} />
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────────

export default function OutboundReadiness() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Queries ─────────────────────────────────────────────────────────────────
  const { data: settings, isLoading: settingsLoading } = useQuery<OutboundSettings>({
    queryKey: ["/api/system/outbound-settings"],
    refetchInterval: 30_000,
  });
  const { data: gmail, isLoading: gmailLoading, refetch: refetchGmail } = useQuery<GmailOAuthStatus>({
    queryKey: ["/api/admin/gmail-oauth/status"],
    refetchInterval: 60_000,
  });
  const { data: coldProbe, isLoading: coldProbeLoading, refetch: refetchColdProbe } = useQuery<ColdEmailProbe>({
    queryKey: ["/api/admin/ghl-probes/cold-email"],
    refetchInterval: 120_000,
    retry: 1,
  });
  const { data: smsProbe, isLoading: smsProbeLoading, refetch: refetchSmsProbe } = useQuery<SmsProbe>({
    queryKey: ["/api/admin/ghl-probes/sms"],
    refetchInterval: 120_000,
    retry: 1,
  });
  const { data: zbUsage, isLoading: zbUsageLoading } = useQuery<ZeroBounceUsage>({
    queryKey: ["/api/admin/settings/zerobounce-usage"],
    refetchInterval: 60_000,
  });

  // ── Mutations ────────────────────────────────────────────────────────────────
  const channelMutation = useMutation({
    mutationFn: (patch: Partial<OutboundSettings>) => apiRequest("PATCH", "/api/system/outbound-settings", patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/system/outbound-settings"] }),
    onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });
  const revokeMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/admin/gmail-oauth/revoke"),
    onSuccess: () => { toast({ title: "Gmail access revoked" }); qc.invalidateQueries({ queryKey: ["/api/admin/gmail-oauth/status"] }); },
    onError: (err: any) => toast({ title: "Revoke failed", description: err.message, variant: "destructive" }),
  });

  // ── Gmail verify ─────────────────────────────────────────────────────────────
  const [gmailVerifyResult, setGmailVerifyResult] = useState<GmailVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  async function verifyGmail() {
    setVerifying(true); setGmailVerifyResult(null);
    try {
      const res = await apiRequest("POST", "/api/admin/gmail-oauth/verify");
      setGmailVerifyResult(await res.json());
    } catch (err: any) { setGmailVerifyResult({ success: false, error: err.message }); }
    finally { setVerifying(false); }
  }

  // ── Gmail OAuth flow ──────────────────────────────────────────────────────────
  const [authorizing, setAuthorizing] = useState(false);
  async function startGmailOAuth() {
    setAuthorizing(true);
    try {
      const res = await apiRequest("GET", "/api/admin/gmail-oauth/authorize");
      const data: GmailAuthorizeResult = await res.json();
      if (data.authUrl) {
        window.open(data.authUrl, "_blank", "width=600,height=700");
        toast({ title: "OAuth window opened", description: "Complete sign-in in the new window. Refresh status when done." });
      } else {
        toast({ title: "OAuth error", description: (data as any).message, variant: "destructive" });
      }
    } catch (err: any) { toast({ title: "OAuth error", description: err.message, variant: "destructive" }); }
    finally { setAuthorizing(false); }
  }

  // ── A2P attestation ───────────────────────────────────────────────────────────
  const [attesting, setAttesting] = useState<string | null>(null);
  async function recordAttestation(gateKey: string, note: string, expiresAt?: string) {
    setAttesting(gateKey);
    try {
      const res = await apiRequest("POST", "/api/admin/ghl-probes/attest", { gateKey, attestationNote: note, expiresAt });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Attestation recorded", description: `Gate: ${gateKey}` });
        refetchColdProbe(); refetchSmsProbe();
      } else {
        toast({ title: "Attestation failed", description: data.message, variant: "destructive" });
      }
    } catch (err: any) { toast({ title: "Attestation error", description: err.message, variant: "destructive" }); }
    finally { setAttesting(null); }
  }

  // ── Handle OAuth callback query params ────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectedEmail = params.get("gmail_connected");
    const gmailError     = params.get("gmail_error");
    if (connectedEmail) {
      toast({ title: "Gmail connected!", description: `Connected as ${decodeURIComponent(connectedEmail)}` });
      refetchGmail();
      window.history.replaceState({}, "", window.location.pathname);
    } else if (gmailError) {
      toast({ title: "Gmail OAuth failed", description: decodeURIComponent(gmailError), variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const isChanging  = channelMutation.isPending;
  const globalPaused = settings?.outboundGlobalPaused ?? true;

  // ── Gate summary values (all pulled from live API data, not front-end guesses) ─
  const encryptionOk  = gmail?.encryptionAvailable ?? null;
  const gmailOk       = gmail?.connected ?? null;
  const coldEmailOk   = coldProbe?.ok ?? null;
  const smsOk         = smsProbe?.ok ?? null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <PageHeader
        title="Outbound Launch Readiness"
        subtitle="All channels paused until every required gate passes. Configure Gmail OAuth, verify GHL channels, run attestations, and monitor send health."
      />

      {/* ── Global status banner ── */}
      <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${globalPaused ? "bg-yellow-50 border-yellow-300 text-yellow-800" : "bg-red-50 border-red-300 text-red-800"}`}>
        <Shield className="h-5 w-5 shrink-0" />
        <div className="flex-1">
          <p className="font-semibold text-sm">
            {globalPaused ? "Outbound is GLOBALLY PAUSED — no sequences will fire" : "⚠ Outbound is LIVE — all active enrollments will fire"}
          </p>
          {settings?.outboundGlobalPausedReason && (
            <p className="text-xs mt-0.5">{settings.outboundGlobalPausedReason}</p>
          )}
        </div>
        <Button
          size="sm"
          variant={globalPaused ? "default" : "destructive"}
          disabled={isChanging || settingsLoading}
          data-testid="btn-toggle-global-pause"
          onClick={() => channelMutation.mutate({ outboundGlobalPaused: !globalPaused })}
        >
          {isChanging ? <Loader2 className="h-3 w-3 animate-spin" /> : globalPaused ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
          {globalPaused ? "Resume Outbound" : "Pause All Outbound"}
        </Button>
      </div>

      {/* ── Launch Gate Checklist ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4" /> Launch Gate Checklist</CardTitle>
          <CardDescription>
            All required gates must pass before enabling outbound. Run{" "}
            <code className="text-xs font-mono bg-muted px-1 rounded">npx tsx scripts/test-outbound-readiness.ts</code> for the full server-side check.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <GateRow label="Global pause ON (safe start)" ok={globalPaused} />
          <GateRow label="Credential encryption key set" ok={encryptionOk} loading={gmailLoading}
            note={gmail?.encryptionDetail ?? "CREDENTIAL_ENCRYPTION_KEY"} />
          <GateRow label="Gmail OAuth connected" ok={gmailOk} loading={gmailLoading}
            note={gmail?.email ?? (gmail?.secretsPresent ? "OAuth not completed" : "Secrets not set")} />
          <GateRow label="Cold email domain + sender verified" ok={coldEmailOk} loading={coldProbeLoading}
            note={coldProbe ? `${coldProbe.detectedDomain ?? "(via attestation)"} — ${coldProbe.method}` : undefined} />
          <GateRow label="SMS number + A2P 10DLC attested" ok={smsOk} loading={smsProbeLoading}
            note={smsProbe ? (smsProbe.smsSendingNumber ?? (smsProbe.numberAttestation ? "via attestation" : "not verified")) : undefined} />
          <GateRow label="GHL webhook signing configured" ok={null} note="GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY (Ed25519, current) or GHL_WEBHOOK_SECRET (HMAC-SHA256, legacy fallback)" />
          <GateRow label="Compliance mailing address" ok={null} note="compliance_mailing_address system setting" />
          <GateRow label="Unsubscribe token secret" ok={null} note="UNSUBSCRIBE_TOKEN_SECRET env var" />
          <GateRow label="Daily email cap configured" ok={(settings?.outboundDailyEmailCap ?? 0) > 0}
            note={`${settings?.outboundDailyEmailCap ?? "?"}/day`} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── Per-channel pause controls ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Activity className="h-4 w-4" /> Per-Channel Controls</CardTitle>
            <CardDescription>Pause individual channels independently of the global switch.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {settingsLoading ? (
              <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : (
              <>
                <ChannelToggle label="All Email" description="Block every email send (cold + department + Gmail) — defaults paused until explicitly released"
                  checked={settings?.emailChannelPaused ?? true}
                  onChange={(v) => channelMutation.mutate({ emailChannelPaused: v })} disabled={isChanging} />
                <Separator />
                <ChannelToggle label="Cold Email Only" description="Block cold outreach (GHL / SMTP from Scott@mail.libertybancard.com) — defaults paused"
                  checked={settings?.coldEmailChannelPaused ?? true}
                  onChange={(v) => channelMutation.mutate({ coldEmailChannelPaused: v })} disabled={isChanging} />
                <Separator />
                <ChannelToggle label="SMS" description="Block all GHL SMS sends from sequence steps — defaults paused until explicitly released"
                  checked={settings?.smsChannelPaused ?? true}
                  onChange={(v) => channelMutation.mutate({ smsChannelPaused: v })} disabled={isChanging} />
                <Separator />
                <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Cold email today</span>
                  <span className="font-mono font-medium">{settings?.coldEmailSendsToday ?? 0} / {settings?.outboundDailyEmailCap ?? "?"} cap</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Gmail OAuth ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Mail className="h-4 w-4" /> Gmail OAuth — Department Email</CardTitle>
            <CardDescription>
              Required for non-cold sequences (onboarding@, accounts@, security@, etc.).
              <strong className="text-red-600"> If Gmail is unavailable, non-cold sequences are BLOCKED — not rerouted to GHL.</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {gmailLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground flex items-center gap-1"><Key className="h-3 w-3" /> Encryption key (CREDENTIAL_ENCRYPTION_KEY)</span>
                    <GateBadge ok={gmail?.encryptionAvailable ?? false} />
                  </div>
                  {gmail?.encryptionDetail && (
                    <p className="text-xs text-muted-foreground pl-4">{gmail.encryptionDetail}</p>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">OAuth secrets (CLIENT_ID + SECRET)</span>
                    <GateBadge ok={gmail?.secretsPresent ?? false} />
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">OAuth token stored (encrypted at rest)</span>
                    <GateBadge ok={gmail?.connected ?? false} />
                  </div>
                  {gmail?.email && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Connected account</span>
                      <span className="font-mono text-xs">{gmail.email}</span>
                    </div>
                  )}
                  {gmail?.acceptedAliases && gmail.acceptedAliases.length > 0 && (
                    <div className="flex items-start justify-between text-sm gap-2">
                      <span className="text-muted-foreground shrink-0">Accepted Send-As aliases</span>
                      <span className="text-xs text-right">{gmail.acceptedAliases.join(", ")}</span>
                    </div>
                  )}
                  {gmail?.connectedAt && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Connected at</span>
                      <span className="text-xs">{new Date(gmail.connectedAt).toLocaleString()}</span>
                    </div>
                  )}
                </div>

                {!gmail?.encryptionAvailable && (
                  <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-800 space-y-1">
                    <p className="font-medium">Encryption key required</p>
                    <p>Generate: <code className="bg-white px-1 rounded">openssl rand -hex 32</code></p>
                    <p>Add as <code className="bg-white px-1 rounded">CREDENTIAL_ENCRYPTION_KEY</code> in Replit Secrets, then restart the workflow.</p>
                  </div>
                )}

                {gmail?.encryptionAvailable && !gmail?.secretsPresent && (
                  <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground space-y-1">
                    <p className="font-medium">Setup required:</p>
                    <p>1. Create OAuth 2.0 credentials in Google Cloud Console</p>
                    <p>2. Add <code className="bg-background px-1 rounded">GOOGLE_CLIENT_ID</code> and <code className="bg-background px-1 rounded">GOOGLE_CLIENT_SECRET</code> to Replit Secrets</p>
                    <p>3. Restart the workflow, then click Connect Gmail</p>
                  </div>
                )}

                {gmailVerifyResult && (
                  <div className={`rounded-md px-3 py-2 text-xs ${gmailVerifyResult.success ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}>
                    {gmailVerifyResult.success ? `✓ Live — ${gmailVerifyResult.email}` : `✗ ${gmailVerifyResult.error}`}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {gmail?.encryptionAvailable && gmail?.secretsPresent && !gmail?.connected && (
                    <Button size="sm" onClick={startGmailOAuth} disabled={authorizing} data-testid="btn-connect-gmail">
                      {authorizing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ExternalLink className="h-3 w-3 mr-1" />}
                      Connect Gmail
                    </Button>
                  )}
                  {gmail?.connected && (
                    <>
                      <Button size="sm" variant="outline" onClick={verifyGmail} disabled={verifying} data-testid="btn-verify-gmail">
                        {verifying ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
                        Verify Connection
                      </Button>
                      <Button size="sm" variant="ghost" onClick={startGmailOAuth} disabled={authorizing} data-testid="btn-reconnect-gmail">
                        <RefreshCw className="h-3 w-3 mr-1" /> Reconnect
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700"
                        onClick={() => { if (confirm("Revoke Gmail access?")) revokeMutation.mutate(); }}
                        disabled={revokeMutation.isPending} data-testid="btn-revoke-gmail">
                        {revokeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Revoke"}
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => refetchGmail()} data-testid="btn-refresh-gmail-status">
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── GHL Cold Email Probe ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-blue-600" /> GHL Cold Email Channel
              <Badge variant="outline" className="text-xs ml-auto">
                {coldProbeLoading ? "Probing…" : coldProbe?.method ?? "not probed"}
              </Badge>
            </CardTitle>
            <CardDescription>
              Live probe of GHL email settings for the cold-outreach domain and sender address.
              If the API cannot confirm, record an admin attestation after verifying manually in GHL Settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {coldProbeLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Probing GHL…</div>
            ) : coldProbe ? (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">GHL API reachable</span>
                    <GateBadge ok={coldProbe.apiReachable} />
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Sending domain ({coldProbe.requiredDomain})</span>
                    <GateBadge ok={coldProbe.domainVerified} />
                  </div>
                  {coldProbe.detectedDomain && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground pl-4">Detected domain</span>
                      <code className="text-xs font-mono">{coldProbe.detectedDomain}</code>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Sending address ({coldProbe.requiredSender})</span>
                    <GateBadge ok={coldProbe.senderVerified} />
                  </div>
                  {coldProbe.attestation && (
                    <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
                      ✓ Attested by {coldProbe.attestation.attestedBy} on{" "}
                      {new Date(coldProbe.attestation.attestedAt).toLocaleDateString()}
                      {coldProbe.attestation.attestationNote && ` — "${coldProbe.attestation.attestationNote}"`}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Last probed: {new Date(coldProbe.probeTimestamp).toLocaleTimeString()}
                  </p>
                </div>
                {!coldProbe.ok && (
                  <Button size="sm" variant="outline" className="w-full" disabled={attesting === "cold_email_verified"}
                    onClick={() => recordAttestation(
                      "cold_email_verified",
                      `Domain ${coldProbe.requiredDomain} and sender ${coldProbe.requiredSender} manually verified in GHL Settings → Email`
                    )}
                    data-testid="btn-attest-cold-email">
                    {attesting === "cold_email_verified" ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    Record Admin Attestation (I verified in GHL Settings)
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => refetchColdProbe()} data-testid="btn-refresh-cold-probe">
                  <RefreshCw className="h-3 w-3 mr-1" /> Re-probe
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Probe not available</p>
            )}
          </CardContent>
        </Card>

        {/* ── GHL SMS / A2P Probe ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Phone className="h-4 w-4 text-green-600" /> GHL SMS & A2P 10DLC
              <Badge variant="outline" className="text-xs ml-auto">
                {smsProbeLoading ? "Probing…" : smsProbe?.method ?? "not probed"}
              </Badge>
            </CardTitle>
            <CardDescription>
              Live probe of GHL phone numbers. A2P 10DLC approval status cannot be read via API —
              admin must attest after confirming campaign approval in GHL Settings → Phone Numbers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {smsProbeLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Probing GHL…</div>
            ) : smsProbe ? (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">GHL API reachable</span>
                    <GateBadge ok={smsProbe.apiReachable} />
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">SMS-capable number</span>
                    <GateBadge ok={smsProbe.smsCapable || !!smsProbe.numberAttestation} />
                  </div>
                  {smsProbe.smsSendingNumber && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground pl-4">Sending number</span>
                      <code className="text-xs font-mono">{smsProbe.smsSendingNumber}</code>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">A2P 10DLC campaign approved</span>
                    <GateBadge ok={smsProbe.a2pApprovalAttested} />
                  </div>
                  {smsProbe.a2pAttestation && (
                    <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
                      ✓ A2P attested by {smsProbe.a2pAttestation.attestedBy} on{" "}
                      {new Date(smsProbe.a2pAttestation.attestedAt).toLocaleDateString()}
                    </div>
                  )}
                  {!smsProbe.a2pApprovalAttested && (
                    <div className="rounded-md bg-yellow-50 border border-yellow-200 px-3 py-2 text-xs text-yellow-800">
                      A2P approval cannot be read via GHL API. After confirming approval in GHL Settings → Phone Numbers → 10DLC Brands & Campaigns, click the button below.
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{smsProbe.consentNote}</p>
                </div>
                {!smsProbe.a2pApprovalAttested && (
                  <Button size="sm" variant="outline" className="w-full" disabled={attesting === "a2p_campaign_approved"}
                    onClick={() => recordAttestation(
                      "a2p_campaign_approved",
                      "A2P 10DLC campaign approval manually verified in GHL Settings → Phone Numbers → Campaigns"
                    )}
                    data-testid="btn-attest-a2p">
                    {attesting === "a2p_campaign_approved" ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    I verified A2P 10DLC approval in GHL
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => refetchSmsProbe()} data-testid="btn-refresh-sms-probe">
                  <RefreshCw className="h-3 w-3 mr-1" /> Re-probe
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Probe not available</p>
            )}
          </CardContent>
        </Card>

        {/* ── ZeroBounce Usage ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-violet-600" /> ZeroBounce Usage
            </CardTitle>
            <CardDescription>Daily email validation usage reported by the application.</CardDescription>
          </CardHeader>
          <CardContent>
            {zbUsageLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : zbUsage ? (
              (
                <div className="space-y-3">
                  <div className="rounded-md border px-4 py-3">
                    <span className="text-2xl font-bold font-mono">{zbUsage.usedToday.toLocaleString()}</span>
                    <p className="text-xs text-muted-foreground mt-1">validation attempts today (UTC)</p>
                  </div>
                  <p className="text-xs text-muted-foreground">Reported usage only; no application-local daily ceiling is applied.</p>
                </div>
              )
            ) : (
              <p className="text-sm text-muted-foreground">Usage data unavailable.</p>
            )}
          </CardContent>
        </Card>

        {/* ── Send Architecture Reference ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4" /> Send Architecture</CardTitle>
            <CardDescription>Channel selection rules for each sequence type.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-2 font-medium"><MessageSquare className="h-3.5 w-3.5 text-blue-600" /> Cold Email</div>
                <p className="text-xs text-muted-foreground">From: Scott@mail.libertybancard.com</p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="h-3 w-3" /><span>GHL Conversations API (primary)</span></div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="h-3 w-3" /><span>SMTP fallback if configured (adds List-Unsubscribe header)</span></div>
              </div>
              <div className="rounded-md border border-red-100 bg-red-50/30 p-3 space-y-1">
                <div className="flex items-center gap-2 font-medium"><Mail className="h-3.5 w-3.5 text-purple-600" /> Department / Transactional Email</div>
                <p className="text-xs text-muted-foreground">From: accounts@, onboarding@, security@, etc.</p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="h-3 w-3" /><span>Gmail OAuth only (required)</span></div>
                <div className="flex items-center gap-1 text-xs font-medium text-red-700"><XCircle className="h-3 w-3" /><span>NOT rerouted to GHL if Gmail unavailable — send is BLOCKED</span></div>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-2 font-medium"><MessageSquare className="h-3.5 w-3.5 text-green-600" /> SMS</div>
                <p className="text-xs text-muted-foreground">Via GHL Conversations API</p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="h-3 w-3" /><span>Requires GHL token + SMS-capable number + A2P approval</span></div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Idempotency & Webhook Security ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4" /> Idempotency & Webhook Security</CardTitle>
            <CardDescription>Send dedup, webhook verification, and replay protection.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Idempotency key format</p>
                  <code className="text-xs font-mono text-purple-700 bg-purple-50 px-2 py-1 rounded">seq-{"{enrollId}"}-s{"{stepOrder}"}</code>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Webhook signing</p>
                  <code className="text-xs font-mono text-blue-700 bg-blue-50 px-2 py-1 rounded">Ed25519 (primary) / HMAC-SHA256 (legacy)</code>
                </div>
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p className="flex items-start gap-1"><CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 shrink-0" /> Step already sent → skip re-send, advance enrollment</p>
                <p className="flex items-start gap-1"><CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 shrink-0" /> GHL retries same payload → 200 immediately (dedup by SHA-256 hash)</p>
                <p className="flex items-start gap-1"><CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 shrink-0" /> Webhook verified before dedup: Ed25519 public-key (current) or HMAC-SHA256 (legacy fallback)</p>
                <p className="flex items-start gap-1"><CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 shrink-0" /> Replay protection: events &gt; 5 min old rejected (dateAdded / x-ghl-timestamp)</p>
                <p className="flex items-start gap-1"><CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 shrink-0" /> Set <code className="font-mono">GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY</code> (Ed25519 PEM from GHL Marketplace portal) for current standard</p>
              </div>
              <Separator />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium mb-1">Required DB tables</p>
                <p><code className="font-mono">outbound_send_log</code> — migration 0076</p>
                <p><code className="font-mono">webhook_event_log</code> — migration 0076</p>
                <p><code className="font-mono">outbound_admin_attestations</code> — migration 0077</p>
              </div>
            </div>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
