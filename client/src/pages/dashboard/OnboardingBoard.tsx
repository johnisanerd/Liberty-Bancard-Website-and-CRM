import { useMutation } from "@tanstack/react-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { CrmDataState } from "@/components/crm/CrmPresentation";
import { isPendingTask } from "@/lib/task-source";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle, Clock, AlertTriangle, FileText, Users, Activity, RefreshCw, ClipboardList, Upload } from "lucide-react";
import { useState, useRef } from "react";
import { getCsrfToken } from "@/lib/queryClient";
import type {
  OnboardingChecklistItem,
  OnboardingChecklistItemKey,
  OnboardingChecklistItemStatus,
  MerchantOnboardingStage,
} from "@shared/schema";
import {
  ONBOARDING_CHECKLIST_ITEM_KEYS,
  ONBOARDING_CHECKLIST_ITEM_LABELS,
  MERCHANT_ONBOARDING_STAGE_KEYS,
  MERCHANT_ONBOARDING_STAGE_LABELS,
} from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { getDealCardIdentity } from "@/lib/deal-identity";

const BOARDING_STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  not_submitted: { label: "Not Submitted", variant: "outline" },
  submitted: { label: "Submitted", variant: "default" },
  under_review: { label: "Under Review", variant: "secondary" },
  approved: { label: "Approved", variant: "default" },
  declined: { label: "Declined", variant: "destructive" },
  more_info_needed: { label: "Info Needed", variant: "outline" },
};

type BoardEntry = {
  deal: {
    id: number;
    name: string | null;
    stage: string | null;
    contactId: number | null;
    boardingStatus: string | null;
    mid: string | null;
    createdAt: string | null;
  };
  contact: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  checklistItems: OnboardingChecklistItem[];
  stats: {
    totalItems: number;
    approvedItems: number;
    pendingItems: number;
    overdueItems: number;
    progressPct: number;
  };
};

type KpiData = {
  totalActive: number;
  pendingDocs: number;
  overdueItems: number;
  completedThisMonth: number;
};

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ComponentType<{ className?: string }> }> = {
  not_requested: { label: "Not Requested", variant: "outline", icon: Clock },
  requested: { label: "Requested", variant: "default", icon: Clock },
  received: { label: "Received", variant: "secondary", icon: FileText },
  approved: { label: "Approved", variant: "default", icon: CheckCircle },
  rejected: { label: "Rejected", variant: "destructive", icon: AlertTriangle },
};

function KpiCard({ label, value, sub, icon: Icon, color }: { label: string; value: number | string; sub?: string; icon: React.ComponentType<{ className?: string }>; color: string }) {
  return (
    <Card data-testid={`kpi-card-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`} data-testid={`kpi-value-${label.toLowerCase().replace(/\s/g, "-")}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`p-2 rounded-lg ${color === "text-blue-600 dark:text-blue-400" ? "bg-blue-100 dark:bg-blue-900/40" : color === "text-amber-600 dark:text-amber-400" ? "bg-amber-100 dark:bg-amber-900/40" : color === "text-red-600 dark:text-red-400" ? "bg-red-100 dark:bg-red-900/40" : "bg-emerald-100 dark:bg-emerald-900/40"}`}>
            <Icon className={`w-5 h-5 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ChecklistRow({
  dealId,
  itemKey,
  item,
  canApprove,
}: {
  dealId: number;
  itemKey: OnboardingChecklistItemKey;
  item: OnboardingChecklistItem | undefined;
  canApprove: boolean;
}) {
  const { toast } = useToast();
  const label = ONBOARDING_CHECKLIST_ITEM_LABELS[itemKey];
  const currentStatus = (item?.status || "not_requested") as OnboardingChecklistItemStatus;
  const config = STATUS_CONFIG[currentStatus] ?? STATUS_CONFIG.not_requested;
  const StatusIcon = config.icon;

  const mutation = useMutation({
    mutationFn: async (newStatus: string) => {
      const res = await apiRequest("PATCH", `/api/deals/${dealId}/onboarding-checklist/${itemKey}`, { status: newStatus });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding-board"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Failed to update status", variant: "destructive" });
    },
  });

  const availableStatuses = ["not_requested", "requested", "received", ...(canApprove ? ["approved", "rejected"] : [])];

  return (
    <div className="flex items-center justify-between gap-2 py-1.5" data-testid={`checklist-row-${dealId}-${itemKey}`}>
      <div className="flex items-center gap-2 min-w-0">
        <StatusIcon className={`w-4 h-4 shrink-0 ${currentStatus === "approved" ? "text-emerald-600 dark:text-emerald-400" : currentStatus === "rejected" ? "text-red-500" : currentStatus === "received" ? "text-blue-500" : "text-muted-foreground"}`} />
        <span className="text-xs truncate">{label}</span>
      </div>
      <Select
        value={currentStatus}
        onValueChange={(val) => mutation.mutate(val)}
        disabled={mutation.isPending}
      >
        <SelectTrigger className="h-7 w-[130px] text-xs shrink-0" data-testid={`select-status-${dealId}-${itemKey}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {availableStatuses.map((s) => (
            <SelectItem key={s} value={s} className="text-xs">
              {STATUS_CONFIG[s]?.label ?? s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function WorkflowStageProgress({ dealId }: { dealId: number }) {
  const { data: stages = [], isError, isLoading, refetch } = useQuery<MerchantOnboardingStage[]>({
    queryKey: [`/api/deals/${dealId}/onboarding-stages`],
    queryFn: async ({signal}) => {
      const res = await fetch(`/api/deals/${dealId}/onboarding-stages`, { credentials: "include",signal });
      if (!res.ok) throw new Error("Workflow stages unavailable");
      const rows=await res.json();
      if (!Array.isArray(rows)) throw new Error("Invalid workflow stages");
      return rows;
    },
  });

  if (isError) return <CrmDataState state="unavailable" message="Workflow stages unavailable" onRetry={()=>void refetch()}/>;
  if (isLoading) return <CrmDataState state="loading" message="Reading workflow stages…"/>;
  if (stages.length === 0) return <CrmDataState state="empty" message="No workflow stages recorded."/>;

  const complete = stages.filter(s => s.status === "complete").length;
  const total = MERCHANT_ONBOARDING_STAGE_KEYS.length;
  const pct = Math.round((complete / total) * 100);
  const inProgress = stages.find(s => s.status === "in_progress");
  const blocked = stages.filter(s => s.status === "blocked").length;

  return (
    <div className="space-y-1.5" data-testid={`workflow-stages-${dealId}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted-foreground font-medium">
          <ClipboardList className="w-3 h-3" />
          Onboarding Workflow
        </span>
        <span className="text-muted-foreground">{complete}/{total} stages</span>
      </div>
      <Progress value={pct} className="h-1" data-testid={`workflow-progress-${dealId}`} />
      <div className="flex flex-wrap gap-1.5">
        {inProgress && (
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            ▶ {MERCHANT_ONBOARDING_STAGE_LABELS[inProgress.stageKey as keyof typeof MERCHANT_ONBOARDING_STAGE_LABELS] || inProgress.stageKey}
          </Badge>
        )}
        {blocked > 0 && (
          <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
            {blocked} blocked
          </Badge>
        )}
      </div>
    </div>
  );
}

function DealChecklistCard({ entry, canApprove }: { entry: BoardEntry; canApprove: boolean }) {
  const { deal, contact, checklistItems, stats, documentsCount } = entry as any;
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: dealTasks, isLoading:tasksLoading, isError: tasksError, refetch: retryTasks } = useQuery<{ id: number; title: string; status: string | null; dueDate: string | null; effectiveState?: string; authorityState?: string }[]>({
    queryKey: ["/api/tasks", { dealId: deal.id }],
    queryFn: async ({signal}) => {
      const res = await fetch(`/api/tasks?dealId=${deal.id}`, { credentials: "include",signal });
      if (!res.ok) throw new Error("Deal tasks unavailable");
      const rows=await res.json();
      if (!Array.isArray(rows)) throw new Error("Invalid deal tasks");
      rows.forEach(isPendingTask);
      return rows;
    },
  });

  const nearestSlaDue = (() => {
    if (!dealTasks || dealTasks.length === 0) return null;
    const now = Date.now();
    const upcoming = dealTasks
      .filter(t => t.dueDate && isPendingTask(t) && new Date(t.dueDate).getTime() >= now)
      .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());
    if (upcoming.length === 0) return null;
    return new Date(upcoming[0].dueDate!);
  })();

  const initMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/deals/${deal.id}/onboarding-checklist/init`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding-board"] });
      toast({ title: "Checklist initialized", description: "Document checklist created for this deal." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const { primary: cardPrimary, secondary: cardSecondary } = getDealCardIdentity(deal, contact || undefined);

  const overdueFlag = stats.overdueItems > 0;

  return (
    <Card className={`${overdueFlag ? "border-amber-400 dark:border-amber-600" : ""}`} data-testid={`deal-card-${deal.id}`}>
      {tasksError && <CrmDataState state="unavailable" message="SLA task facts unavailable; no no-assignment conclusion." onRetry={()=>void retryTasks()}/>}
      {tasksLoading && <CrmDataState state="loading" message="Reading independent SLA task facts; task absence is not established."/>}
      <CardHeader className="pb-2 px-4 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold truncate" data-testid={`text-merchant-name-${deal.id}`}>
              {cardPrimary}
            </CardTitle>
            {cardSecondary && (
              <p className="text-xs text-muted-foreground truncate mt-0.5" data-testid={`text-merchant-secondary-${deal.id}`}>
                {cardSecondary}
              </p>
            )}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {deal.stage && (
                <Badge variant="secondary" className="text-xs" data-testid={`badge-stage-${deal.id}`}>
                  {deal.stage}
                </Badge>
              )}
              {deal.boardingStatus && (() => {
                const cfg = BOARDING_STATUS_CONFIG[deal.boardingStatus] ?? { label: deal.boardingStatus, variant: "outline" as const };
                const variant = deal.boardingStatus === "not_submitted" ? "secondary" : cfg.variant;
                return (
                  <Badge variant={variant} className="text-xs" data-testid={`badge-boarding-${deal.id}`}>
                    {cfg.label}
                  </Badge>
                );
              })()}
              {deal.mid && (() => {
                const isAdminOnly = user?.role === "admin";
                const midDisplay = isAdminOnly ? deal.mid : `****${deal.mid.slice(-4)}`;
                return (
                  <Badge variant="outline" className="text-xs font-mono text-green-700 dark:text-green-400 border-green-300" data-testid={`badge-mid-${deal.id}`}>
                    MID: {midDisplay}
                  </Badge>
                );
              })()}
              {typeof documentsCount === "number" && documentsCount > 0 && (
                <Badge variant="outline" className="text-xs text-indigo-600 border-indigo-300" data-testid={`badge-docs-count-${deal.id}`}>
                  {documentsCount} doc{documentsCount !== 1 ? "s" : ""}
                </Badge>
              )}
              {overdueFlag && (
                <Badge variant="outline" className="text-xs text-amber-600 border-amber-400" data-testid={`badge-overdue-${deal.id}`}>
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  {stats.overdueItems} overdue
                </Badge>
              )}
              {!tasksLoading && !tasksError && nearestSlaDue && (
                <Badge variant="outline" className="text-xs text-blue-600 border-blue-300" data-testid={`badge-next-sla-${deal.id}`}>
                  <Clock className="w-3 h-3 mr-1" />
                  Next SLA: {nearestSlaDue.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </Badge>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-bold text-primary" data-testid={`text-progress-pct-${deal.id}`}>{stats.progressPct}%</p>
            <p className="text-xs text-muted-foreground">{stats.approvedItems}/{stats.totalItems}</p>
          </div>
        </div>
        <Progress value={stats.progressPct} className="h-1.5 mt-2" data-testid={`progress-bar-${deal.id}`} />
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        {/* Workflow Stage Progress */}
        <WorkflowStageProgress dealId={deal.id} />

        {checklistItems.length === 0 ? (
          <div className="text-center py-2">
            <p className="text-xs text-muted-foreground mb-2">No checklist initialized</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => initMutation.mutate()}
              disabled={initMutation.isPending}
              className="text-xs h-7"
              data-testid={`button-init-checklist-${deal.id}`}
            >
              {initMutation.isPending ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <FileText className="w-3 h-3 mr-1" />}
              Initialize Checklist
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {ONBOARDING_CHECKLIST_ITEM_KEYS.map((key) => {
              const item = (checklistItems as any[]).find((i: any) => i.itemKey === key);
              return (
                <ChecklistRow
                  key={key}
                  dealId={deal.id}
                  itemKey={key}
                  item={item}
                  canApprove={canApprove}
                />
              );
            })}
          </div>
        )}

        {/* Inline document upload — attaches file to this deal/contact (#441) */}
        <InlineDocUpload dealId={deal.id} contactId={deal.contactId} />
      </CardContent>
    </Card>
  );
}

/** Compact document upload widget embedded in each onboarding deal card. */
function InlineDocUpload({ dealId, contactId }: { dealId: number; contactId: number | null }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleFile = async (file: File) => {
    if (!contactId) {
      toast({ title: "Cannot upload", description: "No contact linked to this deal.", variant: "destructive" });
      return;
    }
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("contactId", String(contactId));
      formData.append("dealId", String(dealId));
      formData.append("category", "Onboarding Document");

      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;

      const res = await fetch("/api/merchant-documents/upload", {
        method: "POST",
        headers,
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message || "Upload failed");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding-board"] });
      toast({ title: "Document uploaded", description: file.name });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="pt-1">
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
        className="hidden"
        data-testid={`input-inline-upload-${dealId}`}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      <Button
        size="sm"
        variant="ghost"
        className="w-full h-7 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => fileRef.current?.click()}
        disabled={isUploading || !contactId}
        data-testid={`button-inline-upload-${dealId}`}
      >
        {isUploading
          ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
          : <Upload className="w-3 h-3 mr-1" />}
        {isUploading ? "Uploading…" : "Upload Document"}
      </Button>
    </div>
  );
}

export default function OnboardingBoard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [stageFilter, setStageFilter] = useState<string>("all");
  const canApprove = user?.role === "admin" || user?.role === "manager";

  const { data: boardData, isLoading: boardLoading, isError: boardError, refetch } = useQuery<BoardEntry[]>({
    queryKey: ["/api/onboarding-board"],
    queryFn: async () => {
      const res = await fetch("/api/onboarding-board", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load board");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const { data: kpis, isLoading: kpiLoading, isError: kpiError, refetch: retryKpis } = useQuery<KpiData>({
    queryKey: ["/api/operator/onboarding-kpis"],
    queryFn: async () => {
      const res = await fetch("/api/operator/onboarding-kpis", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load KPIs");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const stages = ["all", ...Array.from(new Set((boardData || []).map((e) => e.deal.stage || "Unknown")))];

  const filtered = (boardData || []).filter(
    (e) => stageFilter === "all" || (e.deal.stage || "Unknown") === stageFilter
  );

  const sortedEntries = [...filtered].sort((a, b) => {
    if (b.stats.overdueItems !== a.stats.overdueItems) return b.stats.overdueItems - a.stats.overdueItems;
    return a.stats.progressPct - b.stats.progressPct;
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold" data-testid="text-board-title">Onboarding Operations Board</h2>
          <p className="text-sm text-muted-foreground mt-1">Track document collection and checklist progress per merchant deal</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const [board,kpi]=await Promise.all([refetch(),retryKpis()]);
            toast({title:board.isError || kpi.isError ? "Refresh incomplete" : "Refreshed",
              description:board.isError || kpi.isError ? "One or more sources could not be read. No clear-board or zero-KPI conclusion is available." : "Board and KPI readback completed.",
              variant:board.isError || kpi.isError ? "destructive" : "default"});
          }}
          data-testid="button-refresh-board"
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {kpiError && <CrmDataState state="unavailable" message="Onboarding KPIs unavailable; board remains independent." onRetry={()=>void retryKpis()}/>}
      {kpiLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : kpis ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="kpi-grid">
          <KpiCard label="Active Onboarding" value={kpis.totalActive} sub="deals in pipeline" icon={Users} color="text-blue-600 dark:text-blue-400" />
          <KpiCard label="Pending Documents" value={kpis.pendingDocs} sub="not_requested + requested" icon={FileText} color="text-amber-600 dark:text-amber-400" />
          <KpiCard label="Overdue Items" value={kpis.overdueItems} sub=">2 days without update" icon={AlertTriangle} color="text-red-600 dark:text-red-400" />
          <KpiCard label="Approved This Month" value={kpis.completedThisMonth} sub="documents approved" icon={CheckCircle} color="text-emerald-600 dark:text-emerald-400" />
        </div>
      ) : null}

      <div className="flex items-center gap-3 flex-wrap">
        <Select value={stageFilter} onValueChange={setStageFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-stage-filter">
            <Activity className="w-4 h-4 mr-2" />
            <SelectValue placeholder="Filter by stage" />
          </SelectTrigger>
          <SelectContent>
            {stages.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "all" ? "All Stages" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground" data-testid="text-deal-count">
          {sortedEntries.length} {sortedEntries.length === 1 ? "deal" : "deals"}
        </p>
      </div>

      {boardError ? <CrmDataState state="unavailable" message="Onboarding board unavailable; no empty-board conclusion is established." onRetry={()=>void refetch()}/> : boardLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-56" />)}
        </div>
      ) : sortedEntries.length === 0 ? (
        <Card data-testid="card-empty-board">
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <CheckCircle className="w-12 h-12 text-muted-foreground" />
            <div className="text-center space-y-1">
              <h3 className="text-lg font-semibold">No Active Onboarding Deals</h3>
              <p className="text-sm text-muted-foreground">
                {stageFilter !== "all" ? "No deals match the selected stage filter." : "Deals moved to the onboarding pipeline will appear here."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" data-testid="board-grid">
          {sortedEntries.map((entry) => (
            <DealChecklistCard key={entry.deal.id} entry={entry} canApprove={canApprove} />
          ))}
        </div>
      )}
    </div>
  );
}
