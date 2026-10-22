import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ReaderStatus } from "@/components/dashboard/ReaderStatus";
import { readerState } from "@/lib/reader-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  ExternalLink,
  Zap,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Globe,
  Mail,
  Share2,
  FileText,
  Calendar,
  Sparkles,
  ArrowRight,
  Copy,
  Settings,
} from "lucide-react";

interface BlazeSettings {
  enabled: boolean;
  webhookUrl: string;
  workspaceId?: string;
  zapierConnected: boolean;
  lastSyncAt: string | null;
  contentTypes: string[];
}

interface BlazeTestResult {
  status: "connected" | "not_configured" | "auth_failed" | "workspace_not_found" | "webhook_unreachable" | "request_failed" | "configured_unverified";
  success: boolean;
  message: string;
}

const BLAZE_STATUS_META: Record<
  string,
  { label: string; variant: "default" | "outline" | "destructive" | "secondary"; icon: typeof CheckCircle2 }
> = {
  connected: { label: "Connected", variant: "default", icon: CheckCircle2 },
  not_configured: { label: "Not Configured", variant: "outline", icon: XCircle },
  auth_failed: { label: "Authentication Failed", variant: "destructive", icon: XCircle },
  workspace_not_found: { label: "Workspace Not Found", variant: "destructive", icon: XCircle },
  webhook_unreachable: { label: "Webhook Unreachable", variant: "destructive", icon: XCircle },
  request_failed: { label: "Request Failed", variant: "destructive", icon: XCircle },
  configured_unverified: { label: "Configured (Unverified)", variant: "secondary", icon: AlertTriangle },
};

export default function BlazeIntegration() {
  const { toast } = useToast();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [testResult, setTestResult] = useState<BlazeTestResult | null>(null);

  const settingsQuery = useQuery<BlazeSettings>({
    queryKey: ["/api/integrations/blaze"],
  });
  const settings = settingsQuery.data;
  const settingsState = readerState(settingsQuery);

  const saveMutation = useMutation({
    mutationFn: async (data: { webhookUrl: string; workspaceId: string }) => {
      const res = await apiRequest("POST", "/api/integrations/blaze", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/blaze"] });
      toast({ title: "Settings Saved", description: "Blaze.ai integration settings updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/blaze/test");
      return (await res.json()) as BlazeTestResult;
    },
    onSuccess: (data) => {
      setTestResult(data);
      const meta = BLAZE_STATUS_META[data.status];
      toast({
        title: meta?.label || (data.success ? "Connection OK" : "Test Failed"),
        description: data.message,
        variant: data.success ? "default" : data.status === "configured_unverified" ? "default" : "destructive",
      });
    },
    onError: (err: Error) => {
      setTestResult(null);
      toast({ title: "Test Failed", description: err.message, variant: "destructive" });
    },
  });

  const inboundWebhookUrl = `${window.location.origin}/api/webhooks/blaze`;

  const contentCapabilities = [
    { icon: Mail, label: "Email Campaigns", description: "AI-generated drip sequences and newsletters for merchant outreach" },
    { icon: Share2, label: "Social Media", description: "Auto-publish to LinkedIn, Facebook, Instagram with brand consistency" },
    { icon: FileText, label: "Blog Content", description: "SEO-optimized articles about payment processing, compliance, industry trends" },
    { icon: Calendar, label: "Content Calendar", description: "Automated scheduling aligned with campaign cadences" },
    { icon: Globe, label: "Landing Pages", description: "AI-generated landing page copy for vertical-specific campaigns" },
    { icon: Sparkles, label: "Autopilot Mode", description: "Fully autonomous marketing strategy execution based on your website" },
  ];

  const zapierSteps = [
    "Go to zapier.com and search for 'Blaze' in the app directory",
    "Create a new Zap with Blaze.ai as the trigger app",
    "Select trigger event (e.g., 'Content Published', 'Campaign Completed')",
    "Connect your Blaze.ai account when prompted",
    "Add Liberty Bancard webhook as the action (URL below)",
    "Map the content fields to the webhook payload",
    "Test and turn on your Zap",
  ];

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto" data-testid="page-blaze-integration">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <PageTitle className="text-2xl font-bold" data-testid="text-blaze-title">
            Blaze.ai Marketing Integration
          </PageTitle>
          <Badge variant={settingsState !== "unavailable" && settings?.enabled ? "default" : "outline"} className="gap-1" data-testid="badge-blaze-status">
            {settingsState === "loading" ? (
              <><Loader2 className="w-3 h-3 animate-spin" /> Checking…</>
            ) : settingsState === "unavailable" ? (
              <><AlertTriangle className="w-3 h-3" /> Status unavailable</>
            ) : settings?.enabled ? (
              <><CheckCircle2 className="w-3 h-3" /> {settingsState === "stale" ? "Connected (last known)" : "Connected"}</>
            ) : (
              <><XCircle className="w-3 h-3" /> Not Connected</>
            )}
          </Badge>
        </div>
        <p className="text-muted-foreground">
          Connect Blaze.ai to automate content marketing across email, social media, blogs, and more. Blaze generates AI-powered marketing content aligned with your campaigns.
        </p>
      </div>

      {(settingsState === "unavailable" || settingsState === "stale") && (
        <ReaderStatus state={settingsState} subject="Blaze settings" onRetry={() => void settingsQuery.refetch()} />
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card data-testid="card-blaze-settings">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="w-4 h-4" />
              Connection Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Blaze.ai Workspace ID (optional)</Label>
              <Input
                placeholder="Your Blaze workspace ID"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                data-testid="input-blaze-workspace"
              />
              <p className="text-xs text-muted-foreground">Find this in your Blaze.ai account settings</p>
            </div>

            <div className="space-y-2">
              <Label>Blaze.ai Outgoing Webhook URL (optional)</Label>
              <Input
                placeholder="https://hooks.blaze.ai/your-webhook"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                data-testid="input-blaze-webhook"
              />
              <p className="text-xs text-muted-foreground">If Blaze supports webhooks for your plan, paste the URL here</p>
            </div>

            <div className="space-y-2">
              <Label>Your Inbound Webhook URL</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={inboundWebhookUrl}
                  className="font-mono text-xs"
                  aria-label="Blaze inbound webhook URL" data-testid="input-inbound-webhook"
                />
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Copy webhook URL"
                  onClick={() => {
                    navigator.clipboard.writeText(inboundWebhookUrl);
                    toast({ title: "Copied", description: "Webhook URL copied to clipboard" });
                  }}
                  data-testid="button-copy-webhook"
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Use this URL in Blaze.ai or Zapier to send content events to Liberty Bancard</p>
            </div>

            <div className="flex gap-2">
              <Button
                className="gap-2"
                onClick={() => saveMutation.mutate({ webhookUrl, workspaceId })}
                disabled={saveMutation.isPending}
                data-testid="button-save-blaze"
              >
                {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Save Settings
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
                data-testid="button-test-blaze"
              >
                {testMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Test Connection
              </Button>
            </div>

            {testResult && (() => {
              const meta = BLAZE_STATUS_META[testResult.status];
              const Icon = meta?.icon || AlertTriangle;
              return (
                <div
                  className="flex items-start gap-2 p-3 rounded-md border bg-muted/30"
                  data-testid="result-blaze-test"
                >
                  <Icon className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <Badge variant={meta?.variant || "outline"} data-testid="badge-blaze-test-status">
                      {meta?.label || testResult.status}
                    </Badge>
                    <p className="text-xs text-muted-foreground" data-testid="text-blaze-test-message">
                      {testResult.message}
                    </p>
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>

        <Card data-testid="card-zapier-setup">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4" />
              Zapier Integration (Recommended)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The most reliable way to connect Blaze.ai is through Zapier. This lets you automate content flows between Blaze and Liberty Bancard.
            </p>
            <ol className="space-y-2">
              {zapierSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium mt-0.5">
                    {i + 1}
                  </span>
                  <span className="text-muted-foreground">{step}</span>
                </li>
              ))}
            </ol>
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => window.open("https://zapier.com/apps/blaze/integrations", "_blank")}
                data-testid="button-open-zapier"
              >
                <ExternalLink className="w-4 h-4" />
                Open Zapier
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => window.open("https://www.blaze.ai", "_blank")}
                data-testid="button-open-blaze"
              >
                <ExternalLink className="w-4 h-4" />
                Open Blaze.ai
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-content-capabilities">
        <CardHeader>
          <CardTitle className="text-base">What Blaze.ai Can Automate</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {contentCapabilities.map((cap) => {
              const Icon = cap.icon;
              return (
                <div
                  key={cap.label}
                  className="p-4 rounded-md border space-y-2"
                  data-testid={`capability-${cap.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-primary" />
                    <span className="font-medium text-sm">{cap.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{cap.description}</p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-use-cases">
        <CardHeader>
          <CardTitle className="text-base">Recommended Automations for Liberty Bancard</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            {
              title: "New Lead Nurture Content",
              description: "When a new lead enters the pipeline, Blaze auto-generates a personalized email drip sequence based on their industry vertical",
            },
            {
              title: "Statement Upload Follow-Up",
              description: "After a merchant uploads their statement, Blaze creates a follow-up email with educational content about their specific fee issues",
            },
            {
              title: "Weekly Social Content",
              description: "Blaze generates weekly LinkedIn and Facebook posts about payment processing tips, compliance updates, and success stories",
            },
            {
              title: "Vertical-Specific Campaigns",
              description: "Auto-generate marketing content tailored to Medical/Dental, Restaurant, Automotive, and other verticals",
            },
            {
              title: "Monthly Newsletter",
              description: "Blaze compiles industry news, rate updates, and company announcements into a professional newsletter",
            },
          ].map((useCase, i) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-md border">
              <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-medium">{useCase.title}</div>
                <p className="text-xs text-muted-foreground">{useCase.description}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
