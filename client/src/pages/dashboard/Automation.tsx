import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Zap, Package, Workflow, ChevronDown, ChevronRight, Mail, MessageSquare, Clock, ListChecks, Bell, FileText, Tag, Shield, ArrowRight, ExternalLink, Sparkles, Play, BarChart3, Route, Ticket, Brain, FileSearch, Activity, CheckCircle2, AlertCircle, Pause, RefreshCw, AlertTriangle, DollarSign, Power } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { WorkflowEmailStepEditor, type WorkflowEmailStepTarget } from "@/components/dashboard/WorkflowEmailStepEditor";
import type { CollateralPacket, Workflow as WorkflowType, MessageTemplate } from "@shared/schema";

interface AIAction {
  key: string;
  label: string;
  actionType: string;
  totalRuns: number;
  lastRun: string | null;
}

interface AiHealth {
  status: "healthy" | "credential_error" | "quota_exceeded" | "not_configured";
  configured: boolean;
  message: string | null;
}

interface KillSwitchState {
  paused: boolean;
  pausedReason: string | null;
  dailySpendCents: number;
  spendCapCents: number | null;
}

interface CommandCenterData {
  aiActions: AIAction[];
  workflowStats: { totalRuns: number; last24h: number };
  health?: AiHealth;
  killSwitch: KillSwitchState;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "Just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days !== 1 ? "s" : ""} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months !== 1 ? "s" : ""} ago`;
}

const AI_ACTION_ICONS: Record<string, typeof Sparkles> = {
  generate_tasks: ListChecks,
  auto_progress: BarChart3,
  route_prospects: Route,
  classify_tickets: Ticket,
  insights: Brain,
  statement_analysis: FileSearch,
};

const AI_ACTION_ENDPOINTS: Record<string, string | null> = {
  generate_tasks: "/api/ai/generate-tasks",
  auto_progress: "/api/ai/auto-progress-deals",
  route_prospects: "/api/ai/route-prospects-bulk",
  classify_tickets: null,
  insights: "/api/ai/insights",
  statement_analysis: null,
};

function AICommandCenter() {
  const { toast } = useToast();
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [capInput, setCapInput] = useState<string>("");
  const [editingCap, setEditingCap] = useState(false);

  const { data: commandCenter, isLoading: commandCenterLoading } = useQuery<CommandCenterData>({
    queryKey: ["/api/ai/command-center"],
  });

  const pauseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai/kill-switch/pause");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/command-center"] });
      toast({ title: "AI Paused", description: "All AI operations have been halted immediately." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to pause AI", description: err.message, variant: "destructive" });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai/kill-switch/resume");
      if (res.status === 409) {
        const body = await res.json();
        throw new Error(body.message ?? "Cannot resume while spend cap is still exceeded.");
      }
      return res.json();
    },
    onSuccess: () => {
      setShowResumeDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/ai/command-center"] });
      toast({ title: "AI Resumed", description: "AI operations are now active again." });
    },
    onError: (err: Error) => {
      setShowResumeDialog(false);
      toast({ title: "Cannot Resume AI", description: err.message, variant: "destructive" });
    },
  });

  const spendCapMutation = useMutation({
    mutationFn: async (capDollars: number | null) => {
      const res = await apiRequest("POST", "/api/ai/kill-switch/spend-cap", { capDollars });
      return res.json();
    },
    onSuccess: () => {
      setEditingCap(false);
      queryClient.invalidateQueries({ queryKey: ["/api/ai/command-center"] });
      toast({ title: "Spend cap saved", description: "Daily AI spend cap updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save cap", description: err.message, variant: "destructive" });
    },
  });

  const runActionMutation = useMutation({
    mutationFn: async (actionKey: string) => {
      const endpoint = AI_ACTION_ENDPOINTS[actionKey];
      if (!endpoint) return null;
      const res = await apiRequest("POST", endpoint, actionKey === "route_prospects" ? {} : undefined);
      return res.json();
    },
    onSuccess: (data, actionKey) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/command-center"] });
      const label = commandCenter?.aiActions.find(a => a.key === actionKey)?.label || actionKey;

      // Credential / quota error returned as structured 200 (not a thrown HTTP error)
      if (data?.error && data?.message) {
        toast({
          title: data.errorType === "credential" ? "AI Credentials Issue" : data.errorType === "quota" ? "AI Quota Exceeded" : "AI Unavailable",
          description: data.message,
          variant: "destructive",
        });
        return;
      }

      if (data?.reason) {
        toast({
          title: "No Action Taken",
          description: `${label}: ${data.reason}`,
        });
        return;
      }

      const countLabel = data?.generated !== undefined
        ? `${data.generated} task${data.generated === 1 ? "" : "s"} generated`
        : data?.routed !== undefined
        ? `${data.routed} prospect${data.routed === 1 ? "" : "s"} routed`
        : data?.progressed !== undefined
        ? `${data.progressed} deal${data.progressed === 1 ? "" : "s"} progressed`
        : undefined;

      toast({
        title: "AI Action Complete",
        description: countLabel ? `${label}: ${countLabel}` : `Successfully ran ${label}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Action Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleRunAction = async (actionKey: string) => {
    setRunningAction(actionKey);
    try {
      await runActionMutation.mutateAsync(actionKey);
    } finally {
      setRunningAction(null);
    }
  };

  const handleRunAll = async () => {
    setRunningAll(true);
    try {
      const [tasksRes, progressRes] = await Promise.all([
        apiRequest("POST", "/api/ai/generate-tasks"),
        apiRequest("POST", "/api/ai/auto-progress-deals"),
      ]);
      const [tasksData, progressData] = await Promise.all([tasksRes.json(), progressRes.json()]);

      queryClient.invalidateQueries({ queryKey: ["/api/ai/command-center"] });

      // Surface any structured credential/quota errors returned as 200
      const aiError = (tasksData?.error && tasksData) || (progressData?.error && progressData);
      if (aiError) {
        toast({
          title: aiError.errorType === "credential" ? "AI Credentials Issue" : aiError.errorType === "quota" ? "AI Quota Exceeded" : "AI Unavailable",
          description: aiError.message || "One or more AI operations could not complete.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "All AI Operations Complete",
        description: "Successfully ran task generation and deal auto-progression.",
      });
    } catch (error: any) {
      toast({
        title: "Run All Failed",
        description: error.message || "An error occurred",
        variant: "destructive",
      });
    } finally {
      setRunningAll(false);
    }
  };

  if (commandCenterLoading) {
    return (
      <Card data-testid="card-ai-command-center">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            AI Command Center
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const aiActions = commandCenter?.aiActions || [];
  const workflowStats = commandCenter?.workflowStats || { totalRuns: 0, last24h: 0 };
  const health = commandCenter?.health;
  const isUnhealthy = health && health.status !== "healthy";
  const killSwitch = commandCenter?.killSwitch;
  const isPaused = killSwitch?.paused ?? false;
  const dailySpendDollars = ((killSwitch?.dailySpendCents ?? 0) / 100).toFixed(2);
  const spendCapDollars = killSwitch?.spendCapCents != null ? (killSwitch.spendCapCents / 100).toFixed(2) : null;
  const pauseReasonLabel =
    killSwitch?.pausedReason === "daily_spend_cap"
      ? "Auto-paused: daily spend cap reached"
      : "Manually paused by admin";

  return (
    <>
    {/* Resume confirmation dialog */}
    <Dialog open={showResumeDialog} onOpenChange={setShowResumeDialog}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resume AI Operations?</DialogTitle>
          <DialogDescription>
            This will re-enable all AI calls — proposals, advisor, executive snapshots, and scheduled AI ops.
            Only resume if you are confident the issue that caused the pause has been resolved.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowResumeDialog(false)}>Cancel</Button>
          <Button
            onClick={() => resumeMutation.mutate()}
            disabled={resumeMutation.isPending}
            data-testid="button-confirm-resume-ai"
          >
            {resumeMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            Yes, Resume AI
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Card data-testid="card-ai-command-center">
      {isPaused && (
        <div className="flex items-center gap-3 px-6 py-3 bg-destructive/10 border-b border-destructive/20 rounded-t-lg" data-testid="banner-ai-paused">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-destructive">AI Operations Paused — </span>
            <span className="text-sm text-destructive/80">{pauseReasonLabel}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10 shrink-0"
            onClick={() => setShowResumeDialog(true)}
            disabled={resumeMutation.isPending}
            data-testid="button-resume-ai-banner"
          >
            <Power className="w-3 h-3 mr-1" />
            Resume AI
          </Button>
        </div>
      )}
      <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            AI Command Center
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Run or pause AI-driven actions (task generation, deal auto-progress, prospect routing) and control the daily AI spend cap.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-workflow-stats">
            <Badge variant="secondary">{workflowStats.totalRuns} total runs</Badge>
            <Badge variant="outline">{workflowStats.last24h} last 24h</Badge>
          </div>
          {!isPaused && (
            <Button
              onClick={handleRunAll}
              disabled={runningAll}
              data-testid="button-run-all-ai"
            >
              {runningAll ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Run All AI Operations
            </Button>
          )}
          {isPaused ? (
            <Button
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => setShowResumeDialog(true)}
              disabled={resumeMutation.isPending}
              data-testid="button-resume-ai"
            >
              <Power className="w-4 h-4 mr-2" />
              Resume AI
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={() => pauseMutation.mutate()}
              disabled={pauseMutation.isPending}
              data-testid="button-pause-ai"
            >
              {pauseMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Pause className="w-4 h-4 mr-2" />
              )}
              Pause All AI
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Kill switch spend cap row */}
        <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/50 border flex-wrap" data-testid="kill-switch-spend-panel">
          <DollarSign className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="flex items-center gap-2 text-sm flex-1 flex-wrap">
            <span className="text-muted-foreground">Today's AI spend:</span>
            <span className="font-semibold" data-testid="text-daily-spend">${dailySpendDollars}</span>
            <span className="text-muted-foreground mx-2">·</span>
            <span className="text-muted-foreground">Daily cap:</span>
            {editingCap ? (
              <form
                className="flex items-center gap-2"
                onSubmit={e => {
                  e.preventDefault();
                  const val = parseFloat(capInput);
                  spendCapMutation.mutate(isNaN(val) ? null : val);
                }}
              >
                <Input
                  autoFocus
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 5.00"
                  className="w-28 h-7 text-sm"
                  value={capInput}
                  onChange={e => setCapInput(e.target.value)}
                  data-testid="input-spend-cap"
                />
                <Button type="submit" size="sm" className="h-7" disabled={spendCapMutation.isPending}>
                  {spendCapMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setEditingCap(false)}>
                  Cancel
                </Button>
                {spendCapDollars && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-destructive"
                    onClick={() => spendCapMutation.mutate(null)}
                    disabled={spendCapMutation.isPending}
                  >
                    Remove cap
                  </Button>
                )}
              </form>
            ) : (
              <>
                <span className="font-semibold" data-testid="text-spend-cap">
                  {spendCapDollars ? `$${spendCapDollars}` : "None"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setCapInput(spendCapDollars ?? "");
                    setEditingCap(true);
                  }}
                  data-testid="button-edit-spend-cap"
                >
                  Edit
                </Button>
              </>
            )}
          </div>
        </div>
        {isUnhealthy && health?.message && (
          <div
            className="flex items-start gap-3 rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/40 px-4 py-3 text-sm text-yellow-800 dark:text-yellow-300"
            data-testid="ai-health-banner"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold mr-1">
                {health.status === "not_configured" && "AI Not Configured —"}
                {health.status === "credential_error" && "AI Credentials Invalid —"}
                {health.status === "quota_exceeded" && "AI Quota Exceeded —"}
              </span>
              {health.message}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="ai-actions-grid">
          {aiActions.map((action) => {
            const Icon = AI_ACTION_ICONS[action.key] || Sparkles;
            const endpoint = AI_ACTION_ENDPOINTS[action.key];
            const isRunning = runningAction === action.key;
            const noEndpoint = endpoint === null;

            return (
              <Card key={action.key} className="overflow-visible" data-testid={`card-ai-action-${action.key}`}>
                <div className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <Icon className="w-4 h-4 text-primary" />
                      </div>
                      <span className="text-sm font-medium truncate">{action.label}</span>
                    </div>
                    {noEndpoint ? (
                      <Badge variant="outline" className="shrink-0" data-testid={`badge-auto-${action.key}`}>
                        {action.key === "classify_tickets" ? "Auto" : "On Upload"}
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRunAction(action.key)}
                        disabled={isRunning || runningAll}
                        data-testid={`button-run-${action.key}`}
                      >
                        {isRunning ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          "Run Now"
                        )}
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span data-testid={`text-runs-${action.key}`}>{action.totalRuns} runs</span>
                    <span data-testid={`text-last-run-${action.key}`}>{formatRelativeTime(action.lastRun)}</span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </CardContent>
    </Card>
    </>
  );
}

const ACTION_LABELS: Record<string, { label: string; icon: typeof Mail }> = {
  send_ghl_email: { label: "Send Email", icon: Mail },
  send_ghl_sms: { label: "Send SMS", icon: MessageSquare },
  send_packet: { label: "Send Packet", icon: Package },
  create_task: { label: "Create Task", icon: ListChecks },
  send_notification: { label: "Internal Notification", icon: Bell },
  update_deal: { label: "Update Deal", icon: FileText },
  update_contact_tags: { label: "Update Tags", icon: Tag },
  generate_proposal: { label: "Generate Proposal", icon: FileText },
  request_review: { label: "Request Review", icon: Shield },
  create_audit_log: { label: "Audit Log", icon: Shield },
  wait: { label: "Wait / Delay", icon: Clock },
};

function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

function ActionDetail({ action, index, onEditEmail }: { action: any; index: number; onEditEmail?: () => void }) {
  const config = ACTION_LABELS[action.type] || { label: action.type, icon: ArrowRight };
  const Icon = config.icon;

  return (
    <div className="flex gap-3 py-3" data-testid={`action-detail-${index}`}>
      <div className="flex flex-col items-center shrink-0">
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{config.label}</span>
          <Badge variant="outline" className="text-xs">{`Step ${index + 1}`}</Badge>
        </div>

        {action.type === "wait" && (
          <p className="text-sm text-muted-foreground mt-1">
            Wait {formatHours(action.hours)} before next step
          </p>
        )}

        {action.type === "send_ghl_email" && (
          <div className="mt-2 space-y-1">
            {action.subject && (
              <p className="text-sm"><span className="text-muted-foreground">Subject:</span> {action.subject}</p>
            )}
            <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3 mt-1 whitespace-pre-wrap" data-testid={`action-email-body-${index}`}>
              {stripHtml(action.body || "")}
            </div>
            {onEditEmail && !action.templateId && (
              <Button variant="outline" size="sm" className="mt-2" onClick={onEditEmail} data-testid={`button-edit-email-wording-${index}`}>
                Edit wording
              </Button>
            )}
            {action.templateId && (
              <p className="text-xs text-muted-foreground mt-1">Sends a stored template. Edit its wording from the message templates.</p>
            )}
          </div>
        )}

        {action.type === "send_ghl_sms" && (
          <div className="mt-2">
            <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3 whitespace-pre-wrap" data-testid={`action-sms-body-${index}`}>
              {action.body || ""}
            </div>
          </div>
        )}

        {action.type === "create_task" && (
          <div className="mt-1 space-y-1">
            <p className="text-sm">{action.title}</p>
            <div className="flex items-center gap-2 flex-wrap">
              {action.dueHours != null && <Badge variant="secondary" className="text-xs">Due: {formatHours(action.dueHours)}</Badge>}
              {action.priority && <Badge variant="secondary" className="text-xs">Priority: {action.priority}</Badge>}
              {action.assignedTo && <Badge variant="secondary" className="text-xs">Assigned: {action.assignedTo}</Badge>}
            </div>
          </div>
        )}

        {action.type === "send_notification" && (
          <div className="mt-1 space-y-1">
            <p className="text-sm">{action.title}</p>
            <p className="text-sm text-muted-foreground">{action.message}</p>
            {action.channel && <Badge variant="secondary" className="text-xs">Channel: {action.channel}</Badge>}
          </div>
        )}

        {action.type === "update_deal" && (
          <div className="mt-1 space-y-1">
            {action.stage && <p className="text-sm"><span className="text-muted-foreground">Move to stage:</span> {action.stage}</p>}
            {action.notes && <p className="text-sm text-muted-foreground">{action.notes}</p>}
          </div>
        )}

        {action.type === "update_contact_tags" && (
          <div className="mt-1 flex items-center gap-1 flex-wrap">
            {action.addTags?.map((tag: string) => (
              <Badge key={tag} variant="secondary" className="text-xs">+{tag}</Badge>
            ))}
            {action.removeTags?.map((tag: string) => (
              <Badge key={tag} variant="destructive" className="text-xs">-{tag}</Badge>
            ))}
          </div>
        )}

        {action.type === "request_review" && (
          <p className="text-sm text-muted-foreground mt-1">Request a Google review from the merchant</p>
        )}

        {action.type === "create_audit_log" && (
          <p className="text-sm text-muted-foreground mt-1">Log: {action.logAction}</p>
        )}

        {action.type === "send_packet" && (
          <p className="text-sm text-muted-foreground mt-1">Auto-select and send matching collateral packet based on deal offer path/vertical</p>
        )}

        {action.type === "generate_proposal" && (
          <p className="text-sm text-muted-foreground mt-1">Generate a statement analysis proposal for the merchant</p>
        )}
      </div>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowType }) {
  const [expanded, setExpanded] = useState(false);
  const [emailTarget, setEmailTarget] = useState<WorkflowEmailStepTarget | null>(null);
  const actions = Array.isArray(workflow.actions) ? workflow.actions : [];
  const actionTypeCounts: Record<string, number> = {};
  actions.forEach((a: any) => {
    const label = ACTION_LABELS[a.type]?.label || a.type;
    actionTypeCounts[label] = (actionTypeCounts[label] || 0) + 1;
  });

  const triggerLabels: Record<string, string> = {
    contact_created: "When a new contact is created",
    deal_stage_changed: "When a deal changes stage",
    ticket_created: "When a ticket is created",
    form_submitted: "When a form is submitted",
    deal_sla_breach: "When a deal SLA is breached",
    ticket_sla_breach: "When a ticket SLA is breached",
    go_live_milestone: "When a merchant goes live",
  };

  const triggerDetail = triggerLabels[workflow.triggerType] || workflow.triggerType;
  const triggerConfig = workflow.triggerConfig as Record<string, any> | null;

  return (
    <Card className="overflow-visible" data-testid={`card-workflow-${workflow.id}`}>
      <div
        className="flex items-center justify-between gap-3 p-4 cursor-pointer hover-elevate rounded-md"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-expand-workflow-${workflow.id}`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Workflow className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{workflow.name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{triggerDetail}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary" className="text-xs">{actions.length} step{actions.length !== 1 ? "s" : ""}</Badge>
          <Badge variant={workflow.enabled ? "default" : "secondary"} className="text-xs">
            {workflow.enabled ? "Active" : "Disabled"}
          </Badge>
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <CardContent className="pt-0 border-t">
          <div className="pt-4">
            <div className="mb-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Trigger</p>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs">{workflow.triggerType}</Badge>
                {triggerConfig?.toStage && <Badge variant="secondary" className="text-xs">To: {triggerConfig.toStage}</Badge>}
                {triggerConfig?.formType && <Badge variant="secondary" className="text-xs">Form: {triggerConfig.formType}</Badge>}
                {triggerConfig?.stage && <Badge variant="secondary" className="text-xs">Stage: {triggerConfig.stage}</Badge>}
                {triggerConfig?.maxMinutes && <Badge variant="secondary" className="text-xs">SLA: {formatHours(triggerConfig.maxMinutes / 60)}</Badge>}
              </div>
            </div>

            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Action Sequence</p>
            <div className="flex flex-wrap gap-1 mb-4">
              {Object.entries(actionTypeCounts).map(([label, count]) => (
                <Badge key={label} variant="secondary" className="text-xs">{label}{count > 1 ? ` x${count}` : ""}</Badge>
              ))}
            </div>

            <div className="pl-1">
              {actions.map((action: any, i: number) => (
                <ActionDetail key={i} action={action} index={i}
                  onEditEmail={workflow.retiredAt ? undefined : () => setEmailTarget({
                    workflowId: workflow.id, workflowName: workflow.name, workflowVersion: workflow.version,
                    workflowEnabled: workflow.enabled, stepIndex: i, subject: action.subject ?? null, body: action.body ?? "",
                  })} />
              ))}
            </div>
            <WorkflowEmailStepEditor target={emailTarget} onClose={() => setEmailTarget(null)} />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function PacketCard({ packet }: { packet: CollateralPacket }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="overflow-visible" data-testid={`card-packet-${packet.id}`}>
      <div
        className="flex items-center justify-between gap-3 p-4 cursor-pointer hover-elevate rounded-md"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-expand-packet-${packet.id}`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Package className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{packet.name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {packet.offerPath ? `Offer: ${packet.offerPath}` : packet.vertical ? `Vertical: ${packet.vertical}` : "General"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={packet.isActive ? "default" : "secondary"} className="text-xs">
            {packet.isActive ? "Active" : "Inactive"}
          </Badge>
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <CardContent className="pt-0 border-t">
          <div className="pt-4 space-y-3">
            {packet.description && (
              <p className="text-sm text-muted-foreground">{packet.description}</p>
            )}

            {packet.offerPath && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Offer Path</p>
                <Badge variant="outline" className="text-xs">{packet.offerPath}</Badge>
              </div>
            )}

            {packet.vertical && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Vertical</p>
                <Badge variant="outline" className="text-xs">{packet.vertical}</Badge>
              </div>
            )}

            {packet.tags && packet.tags.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Tags</p>
                <div className="flex flex-wrap gap-1">
                  {packet.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              </div>
            )}

            {packet.pages && packet.pages.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Included Pages</p>
                <div className="space-y-1">
                  {packet.pages.map((page) => (
                    <Link key={page} href={page} data-testid={`link-packet-page-${page}`}>
                      <div className="flex items-center gap-2 text-sm text-primary hover-elevate rounded-md p-2 cursor-pointer">
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        <span>{page.split("/").pop()?.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function TemplateCard({ template }: { template: MessageTemplate }) {
  const [expanded, setExpanded] = useState(false);
  const isEmail = template.channel === "email";

  return (
    <Card className="overflow-visible" data-testid={`card-template-${template.id}`}>
      <div
        className="flex items-center justify-between gap-3 p-4 cursor-pointer hover-elevate rounded-md"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-expand-template-${template.id}`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {isEmail ? <Mail className="w-4 h-4 text-muted-foreground shrink-0" /> : <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />}
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{template.name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{template.category} / {template.channel}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className="text-xs">{template.channel}</Badge>
          <Badge variant={template.isActive ? "default" : "secondary"} className="text-xs">
            {template.isActive ? "Active" : "Inactive"}
          </Badge>
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <CardContent className="pt-0 border-t">
          <div className="pt-4 space-y-3">
            {template.subject && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Subject Line</p>
                <p className="text-sm">{template.subject}</p>
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Message Body</p>
              <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3 whitespace-pre-wrap" data-testid={`template-body-${template.id}`}>
                {isEmail ? stripHtml(template.body) : template.body}
              </div>
            </div>

            {template.mergeFields && template.mergeFields.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Merge Fields</p>
                <div className="flex flex-wrap gap-1">
                  {template.mergeFields.map((field) => (
                    <Badge key={field} variant="secondary" className="text-xs">{`{{${field}}}`}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

interface WorkflowRun {
  id: number;
  workflowId: number;
  entityType?: string | null;
  entityId?: number | null;
  status: string;
  currentStep?: number | null;
  log: any;
  completedAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
}

function RecentWorkflowRuns() {
  const [showAll, setShowAll] = useState(false);

  const { data: runs, isLoading } = useQuery<WorkflowRun[]>({
    queryKey: ["/api/workflow-runs"],
    refetchInterval: 15000,
  });

  const { data: workflows } = useQuery<WorkflowType[]>({
    queryKey: ["/api/workflows"],
  });

  const workflowMap = new Map<number, string>();
  workflows?.forEach(w => workflowMap.set(w.id, w.name));

  if (isLoading) {
    return (
      <Card data-testid="card-recent-runs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Recent Workflow Runs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-24">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const sortedRuns = [...(runs || [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const displayRuns = showAll ? sortedRuns : sortedRuns.slice(0, 10);

  const statusCounts = {
    completed: sortedRuns.filter(r => r.status === "completed").length,
    running: sortedRuns.filter(r => r.status === "running").length,
    waiting: sortedRuns.filter(r => r.status === "waiting").length,
    failed: sortedRuns.filter(r => r.status === "failed").length,
  };

  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case "completed": return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "running": return <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />;
      case "waiting": return <Pause className="w-4 h-4 text-yellow-500" />;
      case "failed": return <AlertCircle className="w-4 h-4 text-red-500" />;
      default: return <Activity className="w-4 h-4 text-muted-foreground" />;
    }
  };

  return (
    <Card data-testid="card-recent-runs">
      <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Run History
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Execution log for the workflows below — every trigger, step, and outcome.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {statusCounts.completed > 0 && <Badge variant="secondary" data-testid="badge-runs-completed">{statusCounts.completed} completed</Badge>}
          {statusCounts.running > 0 && <Badge variant="default" data-testid="badge-runs-running">{statusCounts.running} running</Badge>}
          {statusCounts.waiting > 0 && <Badge variant="outline" data-testid="badge-runs-waiting">{statusCounts.waiting} waiting</Badge>}
          {statusCounts.failed > 0 && <Badge variant="destructive" data-testid="badge-runs-failed">{statusCounts.failed} failed</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        {displayRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-no-runs">No workflow runs recorded yet. Runs appear here when workflows are triggered.</p>
        ) : (
          <div className="space-y-2">
            {displayRuns.map(run => {
              const logEntries = Array.isArray(run.log) ? run.log : [];
              const actionsSummary = logEntries.filter((l: any) => l.action && l.action !== "started").map((l: any) => l.action).slice(0, 3);
              const stepsCompleted = logEntries.filter((l: any) => l.status === "completed").length;
              const stepsFailed = logEntries.filter((l: any) => l.status === "failed").length;

              return (
                <div key={run.id} className="flex items-center gap-3 p-3 rounded-md border" data-testid={`run-item-${run.id}`}>
                  <StatusIcon status={run.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{workflowMap.get(run.workflowId!) || `Workflow #${run.workflowId}`}</span>
                      <Badge variant={run.status === "completed" ? "secondary" : run.status === "failed" ? "destructive" : "outline"} className="text-xs">
                        {run.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
                      <span>{formatRelativeTime(run.createdAt)}</span>
                      {stepsCompleted > 0 && <span>{stepsCompleted} step{stepsCompleted !== 1 ? "s" : ""} done</span>}
                      {stepsFailed > 0 && <span className="text-red-500">{stepsFailed} failed</span>}
                      {run.entityType && <Badge variant="outline" className="text-xs">{run.entityType} #{run.entityId}</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap shrink-0">
                    {actionsSummary.map((action: string, i: number) => {
                      const config = ACTION_LABELS[action];
                      return config ? (
                        <Badge key={i} variant="secondary" className="text-xs">{config.label}</Badge>
                      ) : null;
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {sortedRuns.length > 10 && (
          <div className="mt-3 flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)} data-testid="button-toggle-all-runs">
              {showAll ? "Show Less" : `Show All (${sortedRuns.length})`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProposalSettings() {
  const { toast } = useToast();
  const { data: autoSendSetting, isLoading } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/settings/proposal-auto-send"],
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/settings/proposal-auto-send", { enabled });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/proposal-auto-send"] });
      toast({
        title: data.enabled ? "Auto-Send Enabled" : "Auto-Send Disabled",
        description: data.enabled
          ? "Proposals will be automatically emailed to merchants after generation."
          : "Proposals will be held for rep review before sending.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    },
  });

  const isEnabled = autoSendSetting?.enabled === true;

  return (
    <Card data-testid="card-proposal-settings">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileSearch className="w-4 h-4" />
          Proposal Settings
        </CardTitle>
        <p className="text-sm text-muted-foreground mt-1">Controls whether statement-analysis proposals email themselves to the merchant automatically, or wait for rep review.</p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground mb-1">
              Auto-Send Proposals
            </p>
            <p className="text-xs text-muted-foreground">
              {isEnabled
                ? "Proposals are automatically generated and emailed to merchants when a statement is uploaded."
                : "Proposals are generated but held for rep review before sending to the merchant."}
            </p>
          </div>
          <Button
            variant={isEnabled ? "default" : "outline"}
            size="sm"
            className="gap-2 shrink-0"
            onClick={() => toggleMutation.mutate(!isEnabled)}
            disabled={isLoading || toggleMutation.isPending}
            data-testid="button-toggle-auto-send"
          >
            {toggleMutation.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : isEnabled ? (
              <CheckCircle2 className="w-3 h-3" />
            ) : (
              <Pause className="w-3 h-3" />
            )}
            {isEnabled ? "Auto-Send ON" : "Hold for Review"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Automation() {
  const { data: packets, isLoading: packetsLoading } = useQuery<CollateralPacket[]>({
    queryKey: ["/api/collateral-packets"],
  });

  const { data: workflows, isLoading: workflowsLoading } = useQuery<WorkflowType[]>({
    queryKey: ["/api/workflows"],
  });

  const { data: templates, isLoading: templatesLoading } = useQuery<MessageTemplate[]>({
    queryKey: ["/api/message-templates"],
  });

  const isLoading = packetsLoading || workflowsLoading || templatesLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="automation-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="automation-page">
      <div>
        <div className="flex items-center gap-3">
          <Zap className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-semibold" data-testid="text-automation-title">Automation</h2>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          AI actions, workflow execution history, workflow definitions, message templates, proposal settings, and sales collateral — each section below is independently owned and scoped.
        </p>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <DollarSign className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Proposal Settings</h3>
        </div>
        <ProposalSettings />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">AI Command Center</h3>
        </div>
        <AICommandCenter />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Run History</h3>
        </div>
        <RecentWorkflowRuns />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-4">
          <Workflow className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Workflow Definitions ({workflows?.length || 0})</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Automated sequences that run when triggers fire. Click any workflow to see every step and the exact messages sent to merchants.</p>
        <div className="space-y-3" data-testid="workflow-list">
          {workflows && workflows.length > 0 ? (
            workflows.map((w) => <WorkflowCard key={w.id} workflow={w} />)
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-workflows-empty">No workflows configured</p>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Message Templates ({templates?.length || 0})</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Note: these are the pre-written email and SMS bodies workflows and manual sends pull from — not a workflow or campaign themselves. Click to preview the full message.</p>
        <div className="space-y-3" data-testid="template-list">
          {templates && templates.length > 0 ? (
            templates.map((t) => <TemplateCard key={t.id} template={t} />)
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-templates-empty">No message templates configured</p>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-4">
          <Package className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Sales Collateral ({packets?.length || 0})</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Sales enablement packets auto-matched and sent to merchants based on their offer path or industry vertical. Click to see what each packet contains.</p>
        <div className="space-y-3" data-testid="packet-list">
          {packets && packets.length > 0 ? (
            packets.map((p) => <PacketCard key={p.id} packet={p} />)
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-packets-empty">No collateral packets configured</p>
          )}
        </div>
      </div>
    </div>
  );
}
