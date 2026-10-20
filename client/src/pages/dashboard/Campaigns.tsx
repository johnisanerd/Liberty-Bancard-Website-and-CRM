import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useMutation } from "@tanstack/react-query";
import { useCrmQuery } from "@/hooks/use-crm-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Send, Plus, Play, Pause, Trash2, Mail, Clock, Pencil, Eye, Users, List, BarChart2, AlertTriangle, X } from "lucide-react";
import DashboardErrorState from "@/components/DashboardErrorState";
import EmailPreviewModal, { EmailPreviewContent } from "@/components/EmailPreviewModal";
import ReadinessIntelligencePanel from "@/components/ReadinessIntelligencePanel";
import type { Campaign, CampaignStep, ProspectList } from "@shared/schema";
import { SFP_CONTACT_VERTICAL_IDS, CONTACT_VERTICAL_MAPPING_VERSION } from "@shared/contact-vertical-taxonomy";

// Current approved taxonomy from its existing owner (stable IDs). Legacy labels already saved on a
// campaign stay visible read-only and are never rewritten in bulk.
const CANONICAL_VERTICALS: readonly string[] = SFP_CONTACT_VERTICAL_IDS;

const campaignFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  targetListId: z.coerce.number().optional(),
  targetVerticals: z.array(z.string()).optional(),
  targetScores: z.array(z.string()).optional(),
  aiPersonalization: z.boolean().optional(),
  dailySendLimit: z.coerce.number().min(1).optional(),
  readinessThreshold: z.coerce.number().min(0).max(100).optional().nullable(),
});

type CampaignFormData = z.infer<typeof campaignFormSchema>;

const stepFormSchema = z.object({
  stepOrder: z.coerce.number().min(1, "Step order is required"),
  stepType: z.string().min(1, "Step type is required"),
  delayDays: z.coerce.number().min(0).optional(),
  subject: z.string().optional(),
  bodyTemplate: z.string().optional(),
  channel: z.string().optional(),
});

type StepFormData = z.infer<typeof stepFormSchema>;

function isMeaningfulBody(html: string): boolean {
  if (!html) return false;
  const normalised = html
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return false;
  const EMPTY_SHELLS = /^(\s*<p(\s[^>]*)?>(\s|<br\s*\/?>)*<\/p>\s*)*$/i;
  return !EMPTY_SHELLS.test(normalised);
}

function getStatusBadgeClass(status: string | null | undefined) {
  switch (status) {
    case "active":
      return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800";
    case "paused":
      return "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-800";
    case "completed":
      return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800";
    case "draft":
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/30 dark:text-gray-300 dark:border-gray-800";
  }
}

type AudiencePreviewResult = {
  eligibleCount: number;
  sampleContacts: Array<{ id: number; name: string; email: string; vertical: string | null }>;
  totalInVerticals: number;
  blockedCount: number;
  blockReasons: Record<string, unknown>;
  // Phase 2: 4-category breakdown
  excludedByReadiness?: number;
  readinessSubReasons?: { null_score: number; stale_score: number; below_threshold: number };
  blockedByContactability?: number;
  alreadyQueued?: number;
  queueable?: number;
  readinessThreshold?: number | null;
  readinessModelVersionUsed?: number;
};

type PreviewPollResponse = {
  status: "idle" | "running" | "done" | "error" | "interrupted";
  previewId?: number;
  result?: AudiencePreviewResult;
  error?: string;
};

function CampaignDetail({ campaign }: { campaign: Campaign }) {
  const { toast } = useToast();
  const [showStepForm, setShowStepForm] = useState(false);
  const [editingStep, setEditingStep] = useState<CampaignStep | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBodyTemplate, setEditBodyTemplate] = useState("");
  const [editDelayDays, setEditDelayDays] = useState(0);
  const [editBodyTab, setEditBodyTab] = useState<"write" | "preview">("write");
  const [previewStep, setPreviewStep] = useState<CampaignStep | null>(null);
  const [showQueueConfirm, setShowQueueConfirm] = useState(false);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [approveConfirmText, setApproveConfirmText] = useState("");
  const REQUIRED_APPROVE_CONFIRM = "APPROVE CAMPAIGN LAUNCH";

  useEffect(() => {
    if (!editingStep) return;
    setEditBodyTab(isMeaningfulBody(editingStep.bodyTemplate ?? "") ? "preview" : "write");
  }, [editingStep?.id]);

  const { data: steps, isLoading: stepsLoading } = useCrmQuery<CampaignStep[]>({
    queryKey: ["/api/campaigns", campaign.id, "steps"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/campaigns/${campaign.id}/steps`, { credentials: "include", signal });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  const { data: approvalStatus } = useCrmQuery<{ approved: boolean; contentRevision: number; approvedRevision: number | null }>({
    queryKey: ["/api/campaigns", campaign.id, "approval"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/campaigns/${campaign.id}/approval`, { credentials: "include", signal });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: campaign.status === "draft" || campaign.status === "paused",
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaign.id}/approve`, { confirm: approveConfirmText });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "approval"] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setShowApproveDialog(false);
      setApproveConfirmText("");
      toast({ title: "Campaign approved for launch" });
    },
    onError: (err: Error) => {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    },
  });

  const stepForm = useForm<StepFormData>({
    resolver: zodResolver(stepFormSchema),
    defaultValues: {
      stepOrder: (steps?.length || 0) + 1,
      stepType: "initial_outreach",
      delayDays: 0,
      subject: "",
      bodyTemplate: "",
      channel: "email",
    },
  });

  const addStepMutation = useMutation({
    mutationFn: async (data: StepFormData) => {
      await apiRequest("POST", `/api/campaigns/${campaign.id}/steps`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "steps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "approval"] });
      toast({ title: "Step added", description: "Campaign step has been created." });
      setShowStepForm(false);
      stepForm.reset({ stepOrder: (steps?.length || 0) + 2, stepType: "initial_outreach", delayDays: 0, subject: "", bodyTemplate: "", channel: "email" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add step", description: err.message, variant: "destructive" });
    },
  });

  const deleteStepMutation = useMutation({
    mutationFn: async (stepId: number) => {
      await apiRequest("DELETE", `/api/campaign-steps/${stepId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "steps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "approval"] });
      toast({ title: "Step deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete step", description: err.message, variant: "destructive" });
    },
  });

  const updateStepMutation = useMutation({
    mutationFn: async ({ stepId, subject, bodyTemplate, delayDays }: { stepId: number; subject: string; bodyTemplate: string; delayDays: number }) => {
      await apiRequest("PUT", `/api/campaign-steps/${stepId}`, { subject, bodyTemplate, delayDays });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "steps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "approval"] });
      toast({ title: "Step updated", description: "Campaign step has been saved." });
      setEditingStep(null);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update step", description: err.message, variant: "destructive" });
    },
  });

  const isCrmMode = !campaign.targetListId && (campaign.targetVerticals?.length ?? 0) > 0;

  // Async audience preview — POST to start, GET to poll.
  // Polling runs every 2s while status === "running"; stops when done or error.
  const { data: previewPoll } = useCrmQuery<PreviewPollResponse>({
    queryKey: ["/api/campaigns", campaign.id, "audience-preview"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/campaigns/${campaign.id}/audience-preview`, { credentials: "include", signal });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: isCrmMode,
    refetchInterval: (query) => {
      const status = (query.state.data as PreviewPollResponse | undefined)?.status;
      return status === "running" ? 2000 : false;
    },
    staleTime: Infinity,
  });

  const startPreviewMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaign.id}/audience-preview`);
      return res.json() as Promise<PreviewPollResponse>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns", campaign.id, "audience-preview"] });
    },
    onError: (err: Error) => {
      toast({ title: "Preview failed to start", description: err.message, variant: "destructive" });
    },
  });

  // Convenience aliases for readability in JSX below.
  const previewStatus = previewPoll?.status ?? "idle";
  const audiencePreview = previewStatus === "done" ? previewPoll?.result : undefined;
  const previewRunning = previewStatus === "running" || startPreviewMutation.isPending;

  // previewId is captured when startPreviewMutation succeeds or when the polling
  // query returns a completed preview. It is required by the queue endpoint.
  const latestPreviewId = previewPoll?.previewId;

  const queueMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (isCrmMode && latestPreviewId) body.previewId = latestPreviewId;
      const res = await apiRequest("POST", `/api/campaigns/${campaign.id}/queue`, body);
      return res.json() as Promise<{ queued: number; mode: string }>;
    },
    onSuccess: (data: { queued: number; mode: string; previewEligibleCount?: number; countDifference?: number } | void) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      const d = data as any;
      const queued = d?.queued ?? 0;
      const mode = d?.mode === "contacts" ? " from CRM contacts" : "";
      const diff = d?.countDifference;
      const diffNote = diff !== undefined && diff !== 0
        ? ` (preview showed ${d.previewEligibleCount} eligible — ${Math.abs(diff)} ${diff < 0 ? "fewer" : "more"} than preview due to live contactability check)`
        : "";
      toast({ title: "Messages queued", description: `${queued} messages queued${mode}.${diffNote}` });
    },
    onError: (err: Error) => {
      toast({ title: "Queue failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/campaigns/${campaign.id}/toggle-status`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      toast({ title: "Campaign updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4 pt-4 border-t">
      {isCrmMode && (
        <div className="rounded-md border bg-blue-50/50 dark:bg-blue-950/20 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-blue-700 dark:text-blue-300">CRM Contact Mode</p>
              <p className="text-xs text-muted-foreground">
                Targeting: {campaign.targetVerticals?.join(", ") || "All verticals"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => startPreviewMutation.mutate()}
              disabled={previewRunning}
              data-testid={`button-audience-preview-${campaign.id}`}
            >
              <Eye className="w-3 h-3 mr-1" />
              {previewRunning ? "Computing…" : previewStatus === "done" ? "Re-run Preview" : "Preview Audience"}
            </Button>
          </div>
          {previewRunning && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="alert-preview-running">
              <Skeleton className="h-3 w-3 rounded-full" />
              <span>Computing exact eligible count across all contacts in vertical(s)… this may take a moment.</span>
            </div>
          )}
          {previewStatus === "error" && (
            <p className="text-xs text-destructive" data-testid="text-preview-error">
              Preview failed: {previewPoll?.error ?? "unknown error"}. Please try again.
            </p>
          )}
          {audiencePreview && (
            <div className="space-y-3">
              {/* Summary row */}
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-green-700 dark:text-green-400" data-testid="text-eligible-count">
                  {audiencePreview.eligibleCount.toLocaleString()} eligible
                </span>
                <span className="text-muted-foreground">
                  of {audiencePreview.totalInVerticals.toLocaleString()} in vertical{(campaign.targetVerticals?.length ?? 0) !== 1 ? "s" : ""}
                </span>
                {audiencePreview.blockedCount > 0 && (
                  <span className="text-orange-600 dark:text-orange-400 text-xs">
                    {audiencePreview.blockedCount} blocked
                  </span>
                )}
              </div>

              {/* Phase 2: 4-category breakdown */}
              {(audiencePreview.excludedByReadiness !== undefined || audiencePreview.blockedByContactability !== undefined) && (
                <div className="rounded border bg-background/60 divide-y text-xs" data-testid="panel-readiness-breakdown">
                  {/* 1. Excluded by readiness */}
                  {(audiencePreview.excludedByReadiness ?? 0) > 0 && (
                    <div className="p-2 space-y-1">
                      <div className="flex justify-between font-medium text-red-700 dark:text-red-400">
                        <span>Excluded by readiness</span>
                        <span data-testid="text-excluded-by-readiness">{audiencePreview.excludedByReadiness}</span>
                      </div>
                      {audiencePreview.readinessSubReasons && (
                        <div className="pl-3 space-y-0.5 text-muted-foreground">
                          {audiencePreview.readinessSubReasons.null_score > 0 && (
                            <div className="flex justify-between">
                              <span>No score yet</span>
                              <span>{audiencePreview.readinessSubReasons.null_score}</span>
                            </div>
                          )}
                          {audiencePreview.readinessSubReasons.stale_score > 0 && (
                            <div className="flex justify-between">
                              <span>Stale / outdated score</span>
                              <span>{audiencePreview.readinessSubReasons.stale_score}</span>
                            </div>
                          )}
                          {audiencePreview.readinessSubReasons.below_threshold > 0 && (
                            <div className="flex justify-between">
                              <span>Below threshold ({audiencePreview.readinessThreshold ?? 0})</span>
                              <span>{audiencePreview.readinessSubReasons.below_threshold}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {/* 2. Blocked by contactability */}
                  {(audiencePreview.blockedByContactability ?? 0) > 0 && (
                    <div className="p-2 flex justify-between font-medium text-orange-700 dark:text-orange-400">
                      <span>Blocked by contactability</span>
                      <span data-testid="text-blocked-by-contactability">{audiencePreview.blockedByContactability}</span>
                    </div>
                  )}
                  {/* 3. Already queued */}
                  {(audiencePreview.alreadyQueued ?? 0) > 0 && (
                    <div className="p-2 flex justify-between text-muted-foreground">
                      <span>Already in queue</span>
                      <span data-testid="text-already-queued">{audiencePreview.alreadyQueued}</span>
                    </div>
                  )}
                  {/* 4. Queueable */}
                  <div className="p-2 flex justify-between font-semibold text-green-700 dark:text-green-400">
                    <span>Queueable (ready to send)</span>
                    <span data-testid="text-queueable">{audiencePreview.queueable ?? audiencePreview.eligibleCount}</span>
                  </div>
                  {audiencePreview.readinessModelVersionUsed !== undefined && (
                    <div className="p-2 flex justify-between text-muted-foreground text-[10px]">
                      <span>Readiness model v{audiencePreview.readinessModelVersionUsed}</span>
                      {audiencePreview.readinessThreshold != null && (
                        <span>Threshold: {audiencePreview.readinessThreshold}</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Sample contacts */}
              {audiencePreview.sampleContacts.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">Sample contacts:</p>
                  {audiencePreview.sampleContacts.map((c) => (
                    <div key={c.id} className="flex items-center justify-between text-xs gap-2 p-1 rounded bg-background/80">
                      <span className="font-medium truncate">{c.name}</span>
                      <span className="text-muted-foreground truncate">{c.vertical ?? "—"}</span>
                      <span className="text-muted-foreground shrink-0 text-[10px]">{c.email}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(campaign.status === "draft" || campaign.status === "paused") && isAdmin && !approvalStatus?.approved && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowApproveDialog(true)}
            data-testid={`button-approve-launch-${campaign.id}`}
          >
            Approve for Launch
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => toggleStatusMutation.mutate()}
          disabled={
            toggleStatusMutation.isPending ||
            (campaign.status !== "active" && campaign.status !== "paused" && campaign.status !== "draft") ||
            ((campaign.status === "draft" || campaign.status === "paused") && !approvalStatus?.approved)
          }
          title={
            campaign.status === "active" ? "Pause this campaign" :
            (campaign.status === "draft" || campaign.status === "paused") && !approvalStatus?.approved ? "An admin must approve this campaign for launch before it can be activated" :
            "Activate this campaign"
          }
          data-testid={`button-toggle-status-${campaign.id}`}
        >
          {campaign.status === "active" ? (
            <><Pause className="w-4 h-4 mr-1" /> Pause</>
          ) : (
            <><Play className="w-4 h-4 mr-1" /> Activate</>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (isCrmMode) {
              setShowQueueConfirm(true);
            } else {
              queueMutation.mutate();
            }
          }}
          disabled={queueMutation.isPending || (isCrmMode && previewStatus !== "done")}
          title={
            isCrmMode && previewStatus === "idle" ? "Run Preview Audience first to confirm exact eligible count" :
            isCrmMode && previewStatus === "running" ? "Preview is computing — please wait" :
            isCrmMode && previewStatus === "error" ? "Preview failed — please re-run before queuing" :
            undefined
          }
          data-testid={`button-queue-messages-${campaign.id}`}
        >
          <Send className="w-4 h-4 mr-1" />
          {queueMutation.isPending ? "Queuing..." : isCrmMode && audiencePreview ? `Queue ${audiencePreview.eligibleCount.toLocaleString()} Contacts` : "Queue Messages"}
        </Button>
        {isCrmMode && previewStatus === "idle" && (
          <p className="text-xs text-muted-foreground self-center" data-testid="text-preview-required-hint">
            Preview audience first to enable queueing
          </p>
        )}
        {isCrmMode && previewRunning && (
          <p className="text-xs text-muted-foreground self-center" data-testid="text-preview-computing-hint">
            Preview computing…
          </p>
        )}
      </div>

      <AlertDialog open={showQueueConfirm} onOpenChange={setShowQueueConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Queue Campaign Messages</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will queue email messages for CRM contacts in{" "}
                  <strong>{campaign.targetVerticals?.join(", ") || "all verticals"}</strong>.
                </p>
                {audiencePreview ? (
                  <div className="rounded-md border bg-muted/40 p-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span>Eligible contacts</span>
                      <span className="font-medium">{audiencePreview.eligibleCount.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Total in verticals</span>
                      <span>{audiencePreview.totalInVerticals.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Configured daily limit (not sender capacity)</span>
                      <span>{campaign.dailySendLimit ?? 200}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Run "Preview Audience" first to see eligible contact counts before queuing.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Every contact is checked through the contactability gate before a message row is created.
                  Blocked contacts are skipped and audit-logged.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-queue-cancel-${campaign.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => queueMutation.mutate()}
              disabled={previewStatus !== "done" || !audiencePreview || audiencePreview.eligibleCount === 0}
              data-testid={`button-queue-confirm-${campaign.id}`}
            >
              {previewStatus !== "done" || !audiencePreview
                ? "Preview Required"
                : audiencePreview.eligibleCount > 0
                  ? `Queue ${audiencePreview.eligibleCount.toLocaleString()} Messages`
                  : "No Eligible Contacts"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showApproveDialog} onOpenChange={(open) => { setShowApproveDialog(open); if (!open) setApproveConfirmText(""); }}>
        <DialogContent data-testid={`dialog-approve-launch-${campaign.id}`}>
          <DialogHeader>
            <DialogTitle>Approve "{campaign.name}" for Launch</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This records an admin launch approval scoped to the campaign's current content. Any further
              edit to the campaign or its steps invalidates this approval and requires re-approval.
            </p>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Type <strong>{REQUIRED_APPROVE_CONFIRM}</strong> to confirm
              </label>
              <Input
                value={approveConfirmText}
                onChange={(e) => setApproveConfirmText(e.target.value)}
                placeholder={REQUIRED_APPROVE_CONFIRM}
                data-testid={`input-approve-confirm-${campaign.id}`}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowApproveDialog(false)} data-testid={`button-approve-cancel-${campaign.id}`}>
                Cancel
              </Button>
              <Button
                onClick={() => approveMutation.mutate()}
                disabled={approveConfirmText !== REQUIRED_APPROVE_CONFIRM || approveMutation.isPending}
                data-testid={`button-approve-confirm-${campaign.id}`}
              >
                {approveMutation.isPending ? "Approving…" : "Approve for Launch"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h4 className="font-medium text-sm">Steps</h4>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowStepForm(!showStepForm)}
            data-testid={`button-add-step-${campaign.id}`}
          >
            <Plus className="w-4 h-4 mr-1" /> Add Step
          </Button>
        </div>

        {stepsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : steps && steps.length > 0 ? (
          <div className="space-y-2">
            {steps.map((step) => (
              <div key={step.id}>
              <div
                className="flex flex-wrap items-center gap-3 p-3 rounded-md border bg-muted/30"
                data-testid={`step-item-${step.id}`}
              >
                <Badge variant="outline" className="no-default-hover-elevate no-default-active-elevate">
                  #{step.stepOrder}
                </Badge>
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Mail className="w-3 h-3" />
                  <span>{step.channel || "email"}</span>
                </div>
                <span className="text-sm font-medium">{step.stepType?.replace(/_/g, " ")}</span>
                {step.delayDays ? (
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>{step.delayDays}d delay</span>
                  </div>
                ) : null}
                {step.subject ? (
                  <span className="text-sm text-muted-foreground truncate max-w-[200px]">{step.subject}</span>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Preview step"
                    onClick={() => setPreviewStep(step)}
                    data-testid={`button-preview-step-${step.id}`}
                  >
                    <Eye className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit step"
                    onClick={() => {
                      if (editingStep?.id === step.id) {
                        setEditingStep(null);
                      } else {
                        setEditingStep(step);
                        setEditSubject(step.subject ?? "");
                        setEditBodyTemplate(step.bodyTemplate ?? "");
                        setEditDelayDays(step.delayDays ?? 0);
                      }
                    }}
                    data-testid={`button-edit-step-${step.id}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete step"
                    onClick={() => deleteStepMutation.mutate(step.id)}
                    disabled={deleteStepMutation.isPending}
                    data-testid={`button-delete-step-${step.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              {editingStep?.id === step.id && (
                <div className="mt-2 p-3 rounded-md border bg-background space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor={`edit-subject-${step.id}`}>
                      Subject
                    </label>
                    <Input
                      id={`edit-subject-${step.id}`}
                      value={editSubject}
                      onChange={(e) => setEditSubject(e.target.value)}
                      data-testid={`input-edit-subject-${step.id}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Body Template
                      </label>
                      <div className="flex rounded border overflow-hidden text-xs">
                        <button
                          type="button"
                          onClick={() => setEditBodyTab("write")}
                          className={`px-3 py-1 ${editBodyTab === "write" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                          data-testid={`button-body-tab-write-${step.id}`}
                        >
                          Write
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditBodyTab("preview")}
                          className={`px-3 py-1 ${editBodyTab === "preview" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                          data-testid={`button-body-tab-preview-${step.id}`}
                        >
                          Preview
                        </button>
                      </div>
                    </div>
                    {editBodyTab === "write" ? (
                      <Textarea
                        id={`edit-body-${step.id}`}
                        value={editBodyTemplate}
                        onChange={(e) => setEditBodyTemplate(e.target.value)}
                        rows={5}
                        data-testid={`textarea-edit-body-${step.id}`}
                      />
                    ) : (
                      <div className="rounded border bg-background p-2 min-h-[120px]" data-testid={`preview-body-content-${step.id}`}>
                        <EmailPreviewContent
                          subject={editSubject}
                          body={editBodyTemplate}
                          showComplianceNotice={false}
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor={`edit-delay-${step.id}`}>
                      Delay (days)
                    </label>
                    <Input
                      id={`edit-delay-${step.id}`}
                      type="number"
                      min={0}
                      value={editDelayDays}
                      onChange={(e) => setEditDelayDays(Number(e.target.value))}
                      data-testid={`input-edit-delay-${step.id}`}
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingStep(null)}
                      data-testid={`button-cancel-edit-step-${step.id}`}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={updateStepMutation.isPending}
                      onClick={() => updateStepMutation.mutate({ stepId: step.id, subject: editSubject, bodyTemplate: editBodyTemplate, delayDays: editDelayDays })}
                      data-testid={`button-save-edit-step-${step.id}`}
                    >
                      {updateStepMutation.isPending ? "Saving..." : "Save"}
                    </Button>
                  </div>
                </div>
              )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid={`text-no-steps-${campaign.id}`}>
            No steps configured yet.
          </p>
        )}

        {showStepForm && (
          <Card className="mt-3">
            <CardContent className="p-4">
              <Form {...stepForm}>
                <form onSubmit={stepForm.handleSubmit((d) => addStepMutation.mutate(d))} className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <FormField
                      control={stepForm.control}
                      name="stepOrder"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Step Order</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              {...field}
                              onChange={(e) => field.onChange(Number(e.target.value))}
                              data-testid={`input-step-order-${campaign.id}`}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={stepForm.control}
                      name="stepType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Step Type</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid={`select-step-type-${campaign.id}`}>
                                <SelectValue placeholder="Select type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="initial_outreach">Initial Outreach</SelectItem>
                              <SelectItem value="follow_up">Follow Up</SelectItem>
                              <SelectItem value="break_up">Break Up</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={stepForm.control}
                      name="delayDays"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Delay (days)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              {...field}
                              onChange={(e) => field.onChange(Number(e.target.value))}
                              data-testid={`input-delay-days-${campaign.id}`}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <FormField
                    control={stepForm.control}
                    name="subject"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Subject</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid={`input-step-subject-${campaign.id}`} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={stepForm.control}
                    name="bodyTemplate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Body Template</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            rows={4}
                            data-testid={`textarea-step-body-${campaign.id}`}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={stepForm.control}
                    name="channel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Channel</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value || "email"}>
                          <FormControl>
                            <SelectTrigger data-testid={`select-step-channel-${campaign.id}`}>
                              <SelectValue placeholder="Select channel" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="email">Email</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowStepForm(false)} data-testid={`button-cancel-step-${campaign.id}`}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" disabled={addStepMutation.isPending} data-testid={`button-save-step-${campaign.id}`}>
                      {addStepMutation.isPending ? "Saving..." : "Save Step"}
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}
      </div>

      <EmailPreviewModal
        open={!!previewStep}
        onOpenChange={(o) => { if (!o) setPreviewStep(null); }}
        subject={previewStep?.subject ?? ""}
        body={previewStep?.bodyTemplate ?? ""}
      />
    </div>
  );
}

type StuckSendingMessage = {
  id: number;
  campaignId: number | null;
  toEmail: string | null;
  toPhone: string | null;
  subject: string | null;
  status: string | null;
  sendingAt: string | null;
  error: string | null;
};

type StuckSendingResponse = {
  count: number;
  messages: StuckSendingMessage[];
};

function StuckSendingBanner({ onDismiss }: { onDismiss: () => void }) {
  const [showDetail, setShowDetail] = useState(false);
  const { data } = useCrmQuery<StuckSendingResponse>({
    queryKey: ["/api/outbound-messages/stuck-sending"],
    refetchInterval: 30_000,
  });

  const count = data?.count ?? 0;
  if (count === 0) return null;

  return (
    <>
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-4 py-2.5"
        data-testid="banner-stuck-sending"
        role="alert"
      >
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
            {count} message{count !== 1 ? "s" : ""} stuck in&nbsp;
            <span className="font-bold">sending</span> for &gt;60&nbsp;s
          </span>
          <span className="text-xs text-amber-600 dark:text-amber-400 hidden sm:inline">
            — may indicate a worker crash before the 5-min cleanup fires
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="text-xs font-medium text-amber-700 dark:text-amber-300 underline underline-offset-2 hover:no-underline"
            onClick={() => setShowDetail(true)}
            data-testid="button-view-stuck-sending"
          >
            View
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-200"
            data-testid="button-dismiss-stuck-banner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Messages stuck in sending ({count})
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            These rows have been in <code className="text-xs bg-muted px-1 rounded">sending</code> status for more than 60 seconds.
            They will be marked <code className="text-xs bg-muted px-1 rounded">failed</code> automatically when the 5-minute cleanup runs.
            Investigate worker health if this count is large or growing.
          </p>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs" data-testid="table-stuck-sending">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">ID</th>
                  <th className="px-3 py-2 text-left font-medium">Campaign</th>
                  <th className="px-3 py-2 text-left font-medium">To</th>
                  <th className="px-3 py-2 text-left font-medium">Subject</th>
                  <th className="px-3 py-2 text-left font-medium">Sending At</th>
                  <th className="px-3 py-2 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {data?.messages.map((msg) => {
                  const sendingAgo = msg.sendingAt
                    ? Math.round((Date.now() - new Date(msg.sendingAt).getTime()) / 1000)
                    : null;
                  return (
                    <tr key={msg.id} className="border-b last:border-b-0 hover:bg-muted/30" data-testid={`row-stuck-${msg.id}`}>
                      <td className="px-3 py-2 font-mono">{msg.id}</td>
                      <td className="px-3 py-2">{msg.campaignId ?? "—"}</td>
                      <td className="px-3 py-2 truncate max-w-[140px]">{msg.toEmail ?? msg.toPhone ?? "—"}</td>
                      <td className="px-3 py-2 truncate max-w-[160px]">{msg.subject ?? "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-amber-700 dark:text-amber-400">
                        {sendingAgo != null ? `${sendingAgo}s ago` : "—"}
                      </td>
                      <td className="px-3 py-2 truncate max-w-[140px] text-destructive">{msg.error ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Campaigns() {
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [audienceSource, setAudienceSource] = useState<"prospect" | "crm">("prospect");
  const [stuckBannerDismissed, setStuckBannerDismissed] = useState(false);

  const { data: campaigns, isLoading, isError, refetch } = useCrmQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
  });

  const { data: prospectLists } = useCrmQuery<ProspectList[]>({
    queryKey: ["/api/prospect-lists"],
  });

  const form = useForm<CampaignFormData>({
    resolver: zodResolver(campaignFormSchema),
    defaultValues: {
      name: "",
      description: "",
      targetVerticals: [],
      targetScores: [],
      aiPersonalization: true,
      dailySendLimit: 200,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: CampaignFormData) => {
      await apiRequest("POST", "/api/campaigns", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      toast({ title: "Campaign created", description: "Your new campaign has been created." });
      setIsCreateOpen(false);
      form.reset({ name: "", description: "", targetVerticals: [], targetScores: [], aiPersonalization: true, dailySendLimit: 200 });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create campaign", description: err.message, variant: "destructive" });
    },
  });

  const listMap = new Map<number, ProspectList>();
  prospectLists?.forEach((l) => listMap.set(l.id, l));

  return (
    <div className="space-y-6">
      {!stuckBannerDismissed && (
        <StuckSendingBanner onDismiss={() => setStuckBannerDismissed(true)} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-campaigns-title">Campaigns</h2>
          <p className="text-sm text-muted-foreground">Manage outbound email campaigns for lead generation</p>
        </div>

        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2" data-testid="button-create-campaign">
              <Plus className="w-4 h-4" /> Create Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Campaign</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((d) => createMutation.mutate(d))} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Campaign Name</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Q1 Restaurant Outreach" data-testid="input-campaign-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea {...field} rows={2} placeholder="Campaign description..." data-testid="input-campaign-description" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* Audience Source toggle */}
                <FormItem>
                  <FormLabel>Audience Source</FormLabel>
                  <div className="flex gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={audienceSource === "prospect" ? "default" : "outline"}
                      className="gap-1.5"
                      onClick={() => {
                        setAudienceSource("prospect");
                        form.setValue("targetVerticals", []);
                      }}
                      data-testid="button-source-prospect"
                    >
                      <List className="w-3.5 h-3.5" /> Prospect List
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={audienceSource === "crm" ? "default" : "outline"}
                      className="gap-1.5"
                      onClick={() => {
                        setAudienceSource("crm");
                        form.setValue("targetListId", undefined);
                      }}
                      data-testid="button-source-crm"
                    >
                      <Users className="w-3.5 h-3.5" /> CRM Contacts by Vertical
                    </Button>
                  </div>
                </FormItem>

                {audienceSource === "prospect" && (
                  <FormField
                    control={form.control}
                    name="targetListId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Target List</FormLabel>
                        <Select
                          onValueChange={(val) => field.onChange(val ? Number(val) : undefined)}
                          value={field.value ? String(field.value) : ""}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-target-list">
                              <SelectValue placeholder="Select a prospect list" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {prospectLists?.map((list) => (
                              <SelectItem key={list.id} value={String(list.id)} data-testid={`select-item-list-${list.id}`}>
                                {list.name} ({list.totalRecords} records)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {audienceSource === "crm" && (
                  <FormField
                    control={form.control}
                    name="targetVerticals"
                    render={() => (
                      <FormItem>
                        <FormLabel>Target Verticals</FormLabel>
                        <p className="text-xs text-muted-foreground">
                          Select industries from the current taxonomy ({CONTACT_VERTICAL_MAPPING_VERSION}). Choosing a vertical sets a draft audience only; it does not change eligibility, enroll anyone or send.
                        </p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {CANONICAL_VERTICALS.map((v) => (
                            <FormField
                              key={v}
                              control={form.control}
                              name="targetVerticals"
                              render={({ field }) => (
                                <FormItem className="flex items-center gap-1.5">
                                  <FormControl>
                                    <Checkbox
                                      checked={field.value?.includes(v)}
                                      onCheckedChange={(checked) => {
                                        const current = field.value || [];
                                        field.onChange(checked ? [...current, v] : current.filter((x) => x !== v));
                                      }}
                                      data-testid={`checkbox-vertical-${v.toLowerCase().replace(/\s+/g, "-")}`}
                                    />
                                  </FormControl>
                                  <FormLabel className="font-normal text-sm cursor-pointer">{v}</FormLabel>
                                </FormItem>
                              )}
                            />
                          ))}
                        </div>
                        {(form.watch("targetVerticals") ?? []).filter((v) => !CANONICAL_VERTICALS.includes(v)).length > 0 && (
                          <p className="text-xs text-muted-foreground pt-1" data-testid="legacy-vertical-labels">
                            Legacy labels kept as saved (read-only): {(form.watch("targetVerticals") ?? []).filter((v) => !CANONICAL_VERTICALS.includes(v)).join(", ")}
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <FormField
                  control={form.control}
                  name="targetScores"
                  render={() => (
                    <FormItem>
                      <FormLabel>Target Scores</FormLabel>
                      <div className="flex flex-wrap gap-4">
                        {["hot", "warm", "cold"].map((score) => (
                          <FormField
                            key={score}
                            control={form.control}
                            name="targetScores"
                            render={({ field }) => (
                              <FormItem className="flex items-center gap-2">
                                <FormControl>
                                  <Checkbox
                                    checked={field.value?.includes(score)}
                                    onCheckedChange={(checked) => {
                                      const current = field.value || [];
                                      if (checked) {
                                        field.onChange([...current, score]);
                                      } else {
                                        field.onChange(current.filter((v) => v !== score));
                                      }
                                    }}
                                    data-testid={`checkbox-score-${score}`}
                                  />
                                </FormControl>
                                <FormLabel className="font-normal capitalize cursor-pointer">{score}</FormLabel>
                              </FormItem>
                            )}
                          />
                        ))}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="aiPersonalization"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-2">
                      <FormLabel>AI Personalization</FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="switch-ai-personalization"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="dailySendLimit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Configured daily send limit</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        This is a ceiling for this campaign only. Effective sender capacity and the outbound pause are separate and are applied at send time; saving a campaign never enrolls or sends.
                      </p>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) => field.onChange(Number(e.target.value))}
                          data-testid="input-daily-send-limit"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {audienceSource === "crm" && (
                  <FormField
                    control={form.control}
                    name="readinessThreshold"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Min. Readiness Score (0–100)</FormLabel>
                        <p className="text-xs text-muted-foreground">
                          Only contacts scoring at or above this threshold will be queued. Leave blank for no minimum.
                          A score of 0 disables the filter; 60+ recommended for best deliverability.
                        </p>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="e.g. 60"
                            {...field}
                            value={field.value ?? ""}
                            onChange={(e) => field.onChange(e.target.value === "" ? null : Number(e.target.value))}
                            data-testid="input-readiness-threshold"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <div className="flex justify-end pt-2">
                  <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-campaign">
                    {createMutation.isPending ? "Creating..." : "Create Campaign"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="campaigns" data-testid="tabs-campaigns-page">
        <TabsList className="mb-4">
          <TabsTrigger value="campaigns" className="gap-1.5" data-testid="tab-campaigns">
            <Mail className="w-3.5 h-3.5" /> Campaigns
          </TabsTrigger>
          <TabsTrigger value="readiness" className="gap-1.5" data-testid="tab-readiness">
            <BarChart2 className="w-3.5 h-3.5" /> Readiness Intelligence
          </TabsTrigger>
        </TabsList>

        <TabsContent value="readiness">
          <ReadinessIntelligencePanel />
        </TabsContent>

        <TabsContent value="campaigns">
      {isError ? (
        <DashboardErrorState title="Failed to load campaigns" onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-16" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-4 w-full" />
                <div className="grid grid-cols-2 gap-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : campaigns && campaigns.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {campaigns.map((campaign) => {
            const targetList = campaign.targetListId ? listMap.get(campaign.targetListId) : null;
            const isExpanded = expandedId === campaign.id;

            return (
              <Card key={campaign.id} data-testid={`card-campaign-${campaign.id}`}>
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
                  <div className="space-y-1 min-w-0">
                    <CardTitle className="text-base truncate" data-testid={`text-campaign-name-${campaign.id}`}>
                      {campaign.name}
                    </CardTitle>
                    {campaign.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2" data-testid={`text-campaign-desc-${campaign.id}`}>
                        {campaign.description}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                    {campaign.name.startsWith("SDR-") && (
                      <Badge
                        variant="secondary"
                        className="no-default-hover-elevate no-default-active-elevate"
                        data-testid={`badge-template-${campaign.id}`}
                      >
                        Template
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={`no-default-hover-elevate no-default-active-elevate ${getStatusBadgeClass(campaign.status)}`}
                      data-testid={`badge-campaign-status-${campaign.id}`}
                    >
                      {campaign.status || "draft"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {targetList && (
                    <div className="text-sm text-muted-foreground" data-testid={`text-target-list-${campaign.id}`}>
                      Target: {targetList.name} ({targetList.totalRecords} records)
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-1">
                    {campaign.aiPersonalization && (
                      <Badge variant="outline" className="no-default-hover-elevate no-default-active-elevate text-xs">
                        AI Personalization
                      </Badge>
                    )}
                    {campaign.totalSteps && (
                      <Badge variant="outline" className="no-default-hover-elevate no-default-active-elevate text-xs">
                        {campaign.totalSteps} Steps
                      </Badge>
                    )}
                    {campaign.targetVerticals && campaign.targetVerticals.length > 0 && !campaign.targetListId && (
                      <Badge
                        variant="outline"
                        className="no-default-hover-elevate no-default-active-elevate text-xs bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
                        data-testid={`badge-crm-mode-${campaign.id}`}
                      >
                        CRM · {campaign.targetVerticals.length} {campaign.targetVerticals.length === 1 ? "Vertical" : "Verticals"}
                      </Badge>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 rounded-md bg-muted/50">
                      <div className="text-xs text-muted-foreground">Sent</div>
                      <div className="text-lg font-semibold" data-testid={`text-total-sent-${campaign.id}`}>
                        {campaign.totalSent || 0}
                      </div>
                    </div>
                    <div className="p-2 rounded-md bg-muted/50">
                      <div className="text-xs text-muted-foreground">Opened</div>
                      <div className="text-lg font-semibold" data-testid={`text-total-opened-${campaign.id}`}>
                        {campaign.totalOpened || 0}
                      </div>
                    </div>
                    <div className="p-2 rounded-md bg-muted/50">
                      <div className="text-xs text-muted-foreground">Replied</div>
                      <div className="text-lg font-semibold" data-testid={`text-total-replied-${campaign.id}`}>
                        {campaign.totalReplied || 0}
                      </div>
                    </div>
                    <div className="p-2 rounded-md bg-muted/50">
                      <div className="text-xs text-muted-foreground">Bounced</div>
                      <div className="text-lg font-semibold" data-testid={`text-total-bounced-${campaign.id}`}>
                        {campaign.totalBounced || 0}
                      </div>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setExpandedId(isExpanded ? null : campaign.id)}
                    data-testid={`button-expand-campaign-${campaign.id}`}
                  >
                    {isExpanded ? "Collapse" : "Manage Steps"}
                  </Button>

                  {isExpanded && <CampaignDetail campaign={campaign} />}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="p-8 text-center">
            <Mail className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground" data-testid="text-no-campaigns">
              No campaigns yet. Create your first campaign to start outbound outreach.
            </p>
          </CardContent>
        </Card>
      )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
