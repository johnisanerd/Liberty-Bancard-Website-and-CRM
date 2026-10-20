import { useState,useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import {useCrmQuery as useQuery,useCrmActorIdentity} from "@/hooks/use-crm-query";
import {useLocation,useSearch} from "wouter";
import {c4WorkspaceSelection,reviewQueueViews,reviewQueueUrl} from "@/lib/crm-destination-state";
import {CrmDataState} from "@/components/crm/CrmPresentation";
import {DeadLetterHistory} from "@/components/crm/DeadLetterHistory";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {Sheet,SheetContent,SheetTitle,SheetDescription} from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  ClipboardList,
  CheckCircle2,
  Clock,
  ChevronRight,
  FileQuestion,
  BarChart2,
  CheckCheck,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ReviewQueueItem } from "@shared/schema";

interface ChecklistItem {
  key: string;
  label: string;
}

interface ReviewQueueMeta {
  contactName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  businessName?: string;
  source?: string;
  industry?: string;
  vertical?: string;
  monthlyVolume?: string;
  currentProcessor?: string;
  painPoints?: string | string[];
  recommendedProgram?: string;
  estimatedSavings?: string | number;
  utmSource?: string;
  utmCampaign?: string;
  subject?: string;
  category?: string;
  priority?: string;
  description?: string;
  offerPath?: string;
  goal?: string;
  promoCode?: string;
  contactId?: number;
  dealId?: number;
  ghlContactId?: string;
}

interface GhlWorkflow {
  id: string;
  name: string;
  isSet: boolean;
}

type StatusTab = "pending" | "approved" | "all";

function typeBadge(sourceType: string) {
  if (sourceType === "rfi") {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 text-xs" data-testid="badge-type-rfi">
        <FileQuestion className="w-3 h-3 mr-1" />
        RFI
      </Badge>
    );
  }
  return (
    <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 text-xs" data-testid="badge-type-quiz">
      <BarChart2 className="w-3 h-3 mr-1" />
      Quiz
    </Badge>
  );
}

function statusBadge(status: string) {
  if (status === "approved") {
    return (
      <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-xs">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Approved
      </Badge>
    );
  }
  return (
    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 text-xs">
      <Clock className="w-3 h-3 mr-1" />
      Pending
    </Badge>
  );
}

function getMetadata(item: ReviewQueueItem): ReviewQueueMeta {
  if (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) return {};
  return item.metadata as ReviewQueueMeta;
}

function getChecklistState(item: ReviewQueueItem): Record<string, boolean> {
  if (!item.checklistState || typeof item.checklistState !== "object" || Array.isArray(item.checklistState)) return {};
  return item.checklistState as Record<string, boolean>;
}

function getContactName(meta: ReviewQueueMeta): string {
  if (meta.contactName) return meta.contactName;
  const first = meta.firstName ?? "";
  const last = meta.lastName ?? "";
  return `${first} ${last}`.trim() || "—";
}

function getCheckedCount(state: Record<string, boolean>, checklist: ChecklistItem[]): number {
  return checklist.filter((ci) => state[ci.key] === true).length;
}

// Keys already surfaced by the "known fields" section above, or that are
// purely internal bookkeeping and shouldn't be shown as a raw label/value row.
const META_CONSUMED_KEYS = new Set([
  "contactName", "firstName", "lastName", "email", "phone",
  "companyName", "businessName", "source", "industry", "vertical",
  "monthlyVolume", "currentProcessor", "painPoints", "recommendedProgram",
  "estimatedSavings", "utmSource", "utmCampaign", "subject", "category",
  "priority", "description", "offerPath", "goal", "promoCode",
]);

// Fields that must never be rendered even in the "remaining metadata" fallback
// section: secrets/credentials, raw auth material, and internal IDs that are
// either shown elsewhere (item.sourceId) or are not meaningful to a reviewer.
const META_SENSITIVE_KEY_PATTERN = /token|password|secret|apikey|api_key|auth|cookie|session|privatekey|private_key|ssn|ein|ssn_|account_?number|routing_?number|card_?number|cvv|signature|hash|credential/i;
const META_HIDDEN_KEYS = new Set([
  "contactId", "dealId", "ticketId", "sourceId", "id", "userId",
  "entityId", "entityType", "ghlContactId", "ghlWorkflowId", "ghlTaskId",
  "ip", "ipAddress", "userAgent",
]);

function humanizeMetaKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

const META_MAX_FLATTEN_DEPTH = 3;

function formatMetaScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const str = String(value).trim();
  return str && str !== "—" ? str : null;
}

// Recursively flattens metadata values into human-readable "Parent > Child"
// label/value pairs instead of ever rendering raw JSON. Sensitive keys are
// redacted at every nesting level, not just the top level, so a non-sensitive
// parent key (e.g. "details") cannot smuggle a nested "token" or "authHeader"
// field into the UI.
function flattenMetaValue(
  label: string,
  value: unknown,
  depth: number,
  out: Array<[string, string]>,
): void {
  if (value === null || value === undefined) return;
  if (depth > META_MAX_FLATTEN_DEPTH) return;

  if (Array.isArray(value)) {
    const scalars = value
      .filter((v) => v === null || v === undefined || typeof v !== "object")
      .map((v) => formatMetaScalar(v))
      .filter((v): v is string => !!v);
    if (scalars.length === value.length && scalars.length > 0) {
      out.push([label, scalars.join(", ")]);
      return;
    }
    value.forEach((item, idx) => {
      flattenMetaValue(`${label} #${idx + 1}`, item, depth + 1, out);
    });
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (META_SENSITIVE_KEY_PATTERN.test(key) || META_HIDDEN_KEYS.has(key)) continue;
      flattenMetaValue(`${label} \u2013 ${humanizeMetaKey(key)}`, nested, depth + 1, out);
    }
    return;
  }

  const scalar = formatMetaScalar(value);
  if (scalar) out.push([label, scalar]);
}

function formatMetaValue(key: string, value: unknown): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  flattenMetaValue(humanizeMetaKey(key), value, 0, rows);
  return rows;
}

function MetaDisplay({ meta }: { meta: ReviewQueueMeta }) {
  const knownRows: Array<[string, string]> = (
    [
      ["Contact Name", getContactName(meta)],
      ["Email", meta.email],
      ["Phone", meta.phone],
      ["Company", meta.companyName ?? meta.businessName],
      ["Source", meta.source],
      ["Industry / Vertical", meta.industry ?? meta.vertical],
      ["Monthly Volume", meta.monthlyVolume],
      ["Current Processor", meta.currentProcessor],
      ["Pain Points", Array.isArray(meta.painPoints) ? meta.painPoints.join(", ") : meta.painPoints],
      ["Recommended Program", meta.recommendedProgram],
      ["Est. Annual Savings", meta.estimatedSavings != null ? `$${Number(meta.estimatedSavings).toLocaleString()}` : undefined],
      ["UTM Source", meta.utmSource],
      ["UTM Campaign", meta.utmCampaign],
      ["RFI Subject", meta.subject],
      ["RFI Category", meta.category],
      ["RFI Priority", meta.priority],
      ["RFI Description", meta.description],
      ["Goal / Offer Path", meta.offerPath ?? meta.goal],
      ["Promo Code", meta.promoCode],
    ] as Array<[string, string | undefined]>
  ).filter((row): row is [string, string] => !!row[1] && row[1] !== "—");

  // Second level: any remaining metadata keys not already shown above, so new
  // or unexpected fields from any current source still render instead of
  // silently disappearing behind a fixed whitelist.
  const extraRows: Array<[string, string]> = Object.entries(meta as Record<string, unknown>)
    .filter(([key]) => !META_CONSUMED_KEYS.has(key) && !META_HIDDEN_KEYS.has(key) && !META_SENSITIVE_KEY_PATTERN.test(key))
    .flatMap(([key, value]) => formatMetaValue(key, value));

  const rows = [...knownRows, ...extraRows];

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No details available.</p>;
  }

  return (
    <dl className="grid grid-cols-1 gap-y-2 text-sm">
      {rows.map(([label, value], idx) => (
        <div key={`${label}-${idx}`} className="flex gap-2">
          <dt className="w-40 shrink-0 font-medium text-muted-foreground">{label}</dt>
          <dd className="flex-1 text-foreground break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function ReviewQueue() {
  const { toast } = useToast();
  const viewState=c4WorkspaceSelection(useSearch(),"reviewView",reviewQueueViews,"pending");
  const activeTab=viewState.value;
  const [,navigate]=useLocation();
  const setActiveTab=(value:StatusTab)=>navigate(reviewQueueUrl(window.location.search,window.location.hash,value));
  const [selectedItem, setSelectedItem] = useState<ReviewQueueItem | null>(null);
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [selectedGhlWorkflow, setSelectedGhlWorkflow] = useState<string>("_none");
  const actorIdentity=useCrmActorIdentity();
  useEffect(()=>{setSelectedItem(null);setApproveDialogOpen(false);setSelectedGhlWorkflow("_none");},[actorIdentity]);

  const { data: checklistItems = [], isLoading: checklistLoading,isError:checklistError,refetch:retryChecklist } = useQuery<ChecklistItem[]>({
    queryKey: ["/api/review-queue/checklist-items"],
    queryFn:async({signal})=>{
      const response=await fetch("/api/review-queue/checklist-items",{credentials:"include",signal});
      if(!response.ok)throw new Error("Review checklist unavailable");
      const rows=await response.json();
      if(!Array.isArray(rows)||rows.some(row=>typeof row?.key!=="string"||typeof row?.label!=="string"))
        throw new Error("Review checklist shape unavailable");
      return rows;
    },
    staleTime: Infinity,
  });

  const { data: aggregates,isLoading:aggregatesLoading,isError:aggregatesError,refetch:retryAggregates } = useQuery<{ count: number; pending: number; approved: number; total: number; deadLetter?: { pending: number } }>({
    queryKey: ["/api/review-queue/pending-count"],
    queryFn:async({signal})=>{
      const response=await fetch("/api/review-queue/pending-count",{credentials:"include",signal});
      if(!response.ok)throw new Error("Review aggregate unavailable");
      const read=await response.json();
      if(![read?.pending,read?.approved,read?.total].every(n=>Number.isInteger(n)&&n>=0))
        throw new Error("Review aggregate shape unavailable");
      return read;
    },
    refetchInterval: 60000,
  });

  const { data: items = [], isLoading,isError:itemsError,error:itemsReadError,refetch:retryItems } = useQuery<ReviewQueueItem[]>({
    queryKey: ["/api/review-queue", activeTab],
    enabled:!viewState.issues.length,
    queryFn: async ({signal}) => {
      const url = activeTab === "all" ? "/api/review-queue" : `/api/review-queue?status=${activeTab}`;
      const res = await fetch(url, { credentials: "include",signal });
      if (!res.ok) throw new Error(`${res.status}: Review records read failed`);
      const rows=await res.json();
      if(!Array.isArray(rows)||rows.some(r=>!Number.isInteger(r?.id)))throw new Error("Review collection unavailable");
      return rows;
    },
  });

  const { data: ghlWorkflows = [],isLoading:workflowsLoading,isError:workflowsError,refetch:retryWorkflows } = useQuery<GhlWorkflow[]>({
    queryKey: ["/api/integrations/ghl-workflow-registry"],
    queryFn: async ({signal}) => {
      const res = await fetch("/api/integrations/ghl-workflow-registry", { credentials: "include",signal });
      if (!res.ok) throw new Error("Workflow registry unavailable");
      const rows=await res.json();
      if(!Array.isArray(rows))throw new Error("Workflow registry shape unavailable");
      return rows;
    },
  });

  const { data: selectedItemFresh,isLoading:itemLoading,isFetching:itemFetching,isError:itemError,error:itemReadError,refetch:retryItem } = useQuery<ReviewQueueItem>({
    queryKey: ["/api/review-queue", selectedItem?.id],
    queryFn: async ({signal}) => {
      const res = await fetch(`/api/review-queue/${selectedItem!.id}`, { credentials: "include",signal });
      if (!res.ok) throw new Error(`${res.status}: Selected review read failed`);
      const item=await res.json();
      if(item?.id!==selectedItem!.id)throw new Error("Selected review identity unavailable");
      return item;
    },
    enabled: !!selectedItem,
    staleTime:0,
    refetchOnMount:"always",
    refetchInterval: false,
  });

  // A row snapshot never regains edit authority after a failed/changed-actor read.
  const displayItem = itemLoading||itemFetching||itemError ? undefined : selectedItemFresh;
  const checklistAvailable=!checklistLoading&&!checklistError;
  const canEditCurrent=!!displayItem&&checklistAvailable&&!viewState.issues.length;
  const aggregatesAvailable=!aggregatesLoading&&!aggregatesError&&!!aggregates&&
    [aggregates.pending,aggregates.approved,aggregates.total].every(value=>Number.isInteger(value)&&value>=0);
  const checklistState = displayItem ? getChecklistState(displayItem) : {};
  const totalCount = checklistItems.length;
  const checkedCount = getCheckedCount(checklistState, checklistItems);
  const allChecked = totalCount > 0 && checkedCount === totalCount;

  const checklistMutation = useMutation({
    mutationFn: async ({ id, state }: { id: number; state: Record<string, boolean> }) => {
      if(!canEditCurrent||displayItem?.id!==id)throw new Error("Current review/checklist read required");
      const res = await apiRequest("PATCH", `/api/review-queue/${id}/checklist`, { checklistState: state });
      return res.json() as Promise<ReviewQueueItem>;
    },
    onSuccess: (data) => {
      setSelectedItem(data);
      queryClient.invalidateQueries({ queryKey: ["/api/review-queue", selectedItem?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/review-queue", activeTab] });
      queryClient.invalidateQueries({ queryKey: ["/api/review-queue/pending-count"] });
    },
    onError: () => toast({ title: "Failed to save checklist", variant: "destructive" }),
  });

  const approveMutation = useMutation({
    mutationFn: async ({ id, ghlWorkflowId }: { id: number; ghlWorkflowId?: string }) => {
      if(!canEditCurrent||displayItem?.id!==id)throw new Error("Current review/checklist read required");
      const res = await apiRequest("POST", `/api/review-queue/${id}/approve`, {
        ghlWorkflowId: ghlWorkflowId || undefined,
      });
      return res.json() as Promise<ReviewQueueItem>;
    },
    onSuccess: () => {
      toast({ title: "Item approved successfully" });
      setApproveDialogOpen(false);
      setSelectedItem(null);
      queryClient.invalidateQueries({ queryKey: ["/api/review-queue", activeTab] });
      queryClient.invalidateQueries({ queryKey: ["/api/review-queue/pending-count"] });
    },
    onError: (err: Error) => toast({ title: err?.message || "Approval failed", variant: "destructive" }),
  });

  function handleChecklistToggle(key: string, checked: boolean) {
    if (!displayItem||!canEditCurrent||checklistMutation.isPending||approveMutation.isPending) return;
    const newState = { ...checklistState, [key]: checked };
    checklistMutation.mutate({ id: displayItem.id, state: newState });
  }

  function handleApprove() {
    if (!displayItem||!canEditCurrent||!allChecked||checklistMutation.isPending||approveMutation.isPending) return;
    approveMutation.mutate({
      id: displayItem.id,
      ghlWorkflowId: selectedGhlWorkflow !== "_none" ? selectedGhlWorkflow : undefined,
    });
  }

  function openReview(item:ReviewQueueItem,trigger:HTMLElement|null){
    // C1's shared modal records this connected caller for focus return.
    trigger?.focus();
    setSelectedGhlWorkflow("_none");
    setSelectedItem(item);
  }
  const displayLoading = isLoading;

  return (
    <div className="space-y-6" data-testid="page-review-queue">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold" data-testid="text-review-queue-title">Review Queue</h2>
          <p className="text-sm text-muted-foreground">Review RFI and quiz submissions before approval</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <div className="text-2xl font-bold" data-testid="text-pending-count">
                {!aggregatesAvailable ? (aggregatesLoading?"Loading":"Unavailable") : aggregates!.pending}
              </div>
              <div className="text-xs text-muted-foreground">Pending (all time)</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-green-100 dark:bg-green-900/50 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <div className="text-2xl font-bold" data-testid="text-approved-count">
                {!aggregatesAvailable ? (aggregatesLoading?"Loading":"Unavailable") : aggregates!.approved}
              </div>
              <div className="text-xs text-muted-foreground">Approved (all time)</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
              <ClipboardList className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-2xl font-bold" data-testid="text-total-count">
                {!aggregatesAvailable ? (aggregatesLoading?"Loading":"Unavailable") : aggregates!.total}
              </div>
              <div className="text-xs text-muted-foreground">Total (all time)</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Counts: independent recorded Review Queue aggregate, all time. Records: selected status reader.
        Source readers do not supply a shared snapshot clock, timezone or class-completeness receipt.
      </p>
      {aggregatesError&&<CrmDataState state="unavailable" message="Review aggregate unavailable; successful record/checklist reads are independent." onRetry={()=>void retryAggregates()}/>}
      {checklistError&&<CrmDataState state="unavailable" message="Review checklist definition unavailable; record rows remain readable, but completion and editing are unavailable." onRetry={()=>void retryChecklist()}/>}
      <div className="flex items-center gap-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as StatusTab)}>
          <TabsList data-testid="tabs-status-filter">
            <TabsTrigger value="pending" data-testid="tab-pending">Pending</TabsTrigger>
            <TabsTrigger value="approved" data-testid="tab-approved">Approved</TabsTrigger>
            <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {viewState.issues.length ? <CrmDataState state="unavailable" message="Invalid/conflicting Review Queue view. Select Pending, Approved or All; no default collection was requested."/>
      : itemsError ? <CrmDataState state={/^403:/.test(itemsReadError?.message||"")?"denied":"unavailable"} message="Review records unavailable; this is not an empty or caught-up queue." onRetry={()=>void retryItems()}/>
      : displayLoading ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Loading...</CardContent></Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <CheckCheck className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="font-semibold mb-2">No Items</h3>
            <p className="text-sm text-muted-foreground">
              {activeTab === "pending"
                 ? "No pending items returned by this status reader; aggregate and checklist availability are independent."
                : activeTab === "approved"
                ? "No approved items yet."
                : "No items in the queue yet. RFI and quiz submissions will appear here."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <ScrollArea className="max-h-[600px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-8"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const meta = getMetadata(item);
                  const state = getChecklistState(item);
                  const checked = getCheckedCount(state, checklistItems);
                  return (
                    <TableRow
                      key={item.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={event=>openReview(item,event.currentTarget.querySelector("button"))}
                      data-testid={`row-queue-item-${item.id}`}
                    >
                      <TableCell>{typeBadge(item.sourceType)}</TableCell>
                      <TableCell className="font-medium" data-testid={`text-contact-name-${item.id}`}>
                        {getContactName(meta)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{meta.email ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground capitalize">{meta.source ?? item.sourceType}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 min-w-[80px]">
                          {checklistAvailable&&<Progress value={totalCount > 0 ? (checked / totalCount) * 100 : 0} className="h-1.5 w-16" />}
                          <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid={`text-progress-${item.id}`}>
                            {checklistAvailable?`${checked}/${totalCount}`:"Unavailable"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{statusBadge(item.status)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" className="h-11 w-11 p-0" aria-label={`Open review for ${getContactName(meta)}`}
                          aria-haspopup="dialog" data-testid={`button-open-review-${item.id}`}
                          onClick={event=>{event.stopPropagation();openReview(item,event.currentTarget);}}>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>
      )}

      {aggregatesAvailable && (aggregates!.deadLetter?.pending ?? 0) > 0 && <DeadLetterHistory counts={aggregates!.deadLetter} />}

      {selectedItem && (
        <Sheet open onOpenChange={open=>{if(!open){setSelectedItem(null);setApproveDialogOpen(false);}}}>
          <SheetContent className="flex flex-col p-0" data-testid="sheet-review-record">
            <div className="flex items-center justify-between gap-3 pl-6 pr-16 py-4 border-b">
              <div className="flex items-center gap-2">
                {displayItem&&typeBadge(displayItem.sourceType)}
                <SheetTitle className="font-semibold text-base" data-testid="text-panel-title">
                  {!displayItem?"Review item":displayItem.sourceType === "rfi"
                    ? (getMetadata(displayItem).subject ?? "RFI Review")
                    : `Quiz Lead — ${getContactName(getMetadata(displayItem))}`}
                </SheetTitle>
              </div>
            </div>
            <SheetDescription className="sr-only">Current authorized review record. Closing this view does not save or approve.</SheetDescription>
            {!displayItem&&<div className="p-6 space-y-4">
              <CrmDataState state={itemError?(/^403:/.test(itemReadError?.message||"")?"denied":"unavailable"):"loading"} message="Selected review item has no current authorized read; no snapshot grants editing." onRetry={itemError?()=>void retryItem():undefined}/>
              <Button variant="outline" onClick={()=>{setSelectedItem(null);setApproveDialogOpen(false);}} data-testid="button-cancel-review-read">Cancel selection</Button>
            </div>}

            {displayItem&&<>
            <ScrollArea className="flex-1">
              <div className="px-6 py-4 space-y-6">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold">Submission Details</h4>
                    {statusBadge(displayItem.status)}
                  </div>
                  <MetaDisplay meta={getMetadata(displayItem)} />
                </div>

                <Separator />

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold">Review Checklist</h4>
                    <span className="text-xs text-muted-foreground" data-testid="text-checklist-progress">
                      {checkedCount}/{totalCount} completed
                    </span>
                  </div>
                  <Progress
                    value={totalCount > 0 ? (checkedCount / totalCount) * 100 : 0}
                    className="h-2 mb-4"
                    data-testid="progress-checklist"
                  />
                  <div className="space-y-3">
                    {checklistItems.map((ci) => {
                      const isChecked = checklistState[ci.key] === true;
                      const isApproved = displayItem.status === "approved";
                      return (
                        <div key={ci.key} className="flex items-center gap-3">
                          <Checkbox
                            id={`check-${ci.key}`}
                            checked={isChecked}
                            disabled={isApproved || !canEditCurrent || checklistMutation.isPending||approveMutation.isPending}
                            onCheckedChange={(val) => handleChecklistToggle(ci.key, val === true)}
                            data-testid={`checkbox-${ci.key}`}
                          />
                          <Label
                            htmlFor={`check-${ci.key}`}
                            className={`text-sm cursor-pointer ${isChecked ? "line-through text-muted-foreground" : ""}`}
                          >
                            {ci.label}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {displayItem.status === "approved" && (
                  <div className="rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 p-3 text-sm text-green-800 dark:text-green-200 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>
                      Approved{displayItem.approvedAt ? ` on ${new Date(displayItem.approvedAt).toLocaleDateString()}` : ""}
                       {displayItem.ghlWorkflowId ? " — workflow recorded; execution unverified" : ""}
                    </span>
                  </div>
                )}
              </div>
            </ScrollArea>

            {displayItem.status !== "approved" && (
              <div className="px-6 py-4 border-t">
                <Button
                  className="w-full"
                   disabled={!canEditCurrent||!allChecked || approveMutation.isPending||checklistMutation.isPending}
                  onClick={() => setApproveDialogOpen(true)}
                  data-testid="button-approve"
                >
                  {!allChecked
                    ? `Complete checklist (${checkedCount}/${totalCount}) to approve`
                    : "Approve Item"}
                </Button>
              </div>
            )}
            </>}
          </SheetContent>
        </Sheet>
      )}

      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Approval</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              All checklist items are complete. Optionally trigger a GHL workflow before approving.
            </p>
            <div className="space-y-2">
              <Label>GHL Workflow (optional)</Label>
               {workflowsError&&<CrmDataState state="unavailable" message="Optional workflow registry unavailable; this is not a no-workflows result." onRetry={()=>void retryWorkflows()}/>}
               <Select value={selectedGhlWorkflow} onValueChange={setSelectedGhlWorkflow} disabled={workflowsLoading||workflowsError}>
                <SelectTrigger data-testid="select-ghl-workflow">
                  <SelectValue placeholder="Skip — no workflow" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Skip — no workflow</SelectItem>
                  {ghlWorkflows.filter((w) => w.isSet).map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
               {!workflowsLoading&&!workflowsError&&ghlWorkflows.filter((w) => w.isSet).length === 0 && (
                <p className="text-xs text-muted-foreground">No GHL workflows configured. Configure them in GHL Workflow IDs.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveDialogOpen(false)} data-testid="button-cancel-approve">
              Cancel
            </Button>
            <Button
              onClick={handleApprove}
               disabled={!canEditCurrent||!allChecked||approveMutation.isPending||checklistMutation.isPending||
                 (selectedGhlWorkflow!=="_none"&&(workflowsLoading||workflowsError))}
              data-testid="button-confirm-approve"
            >
              {approveMutation.isPending ? "Approving..." : "Confirm Approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
