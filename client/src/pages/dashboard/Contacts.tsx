import React, { useState, useMemo, useEffect,useRef } from "react";
import { useContacts, useContactsFacets, useCreateContact, useUpdateContact } from "@/hooks/use-contacts";
import { useConfirmationFailedBatch } from "@/hooks/use-confirmation-failed-batch";
import { useMutation } from "@tanstack/react-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Plus, MoreHorizontal, UserPlus, Mail, MessageSquare, Zap, AlertTriangle, Sparkles, Activity, ArrowRight, Clock, TrendingUp, Ticket, Download, CheckSquare, ExternalLink, Users, Merge, ChevronRight, Archive, RotateCcw, Star, UserCheck, Filter, Calendar, RefreshCw, BellOff, PhoneMissed, Trash2, ShieldAlert } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { exportToCSV } from "@/lib/export-csv";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { destinationUrl, peopleState } from "@/lib/crm-destination-state";
import { CrmPage, CrmPageHeader, CrmFilterPanel, CrmDataTable } from "@/components/crm/CrmPresentation";
import DashboardErrorState from "@/components/DashboardErrorState";
import { VERTICALS } from "@shared/schema";
import { resolveContactTargetVertical, SFP_CONTACT_VERTICAL_IDS } from "@shared/contact-vertical-taxonomy";

const formSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  email: z.string().email(),
  phone: z.string().min(1, "Required"),
  companyName: z.string().min(1, "Required"),
  vertical: z.string().optional(),
  monthlyVolume: z.string().optional(),
  notes: z.string().optional(), // #426
});

type FormData = z.infer<typeof formSchema>;

interface ActivityEvent {
  id: string;
  type: string;
  action: string;
  entityType: string;
  entityId: number;
  details: Record<string, string>;
  createdAt: string;
}

interface BulkMessageResult {
  sent: number;
  skipped: number;
  errors: number;
  total: number;
  results: { contactId: number; status: string; error?: string }[];
}

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr).getTime();
  if (isNaN(date)) return "Unknown date";
  const now = Date.now();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? "s" : ""} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? "s" : ""} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay !== 1 ? "s" : ""} ago`;
  if (diffWeek < 5) return `${diffWeek} week${diffWeek !== 1 ? "s" : ""} ago`;
  return `${diffMonth} month${diffMonth !== 1 ? "s" : ""} ago`;
}

function getActionMeta(event: ActivityEvent): { icon: typeof Activity; label: string } {
  if (event.type === "ghl") {
    if (event.action === "email") {
      const dir = event.details?.direction === "inbound" ? "Received" : "Sent";
      return { icon: Mail, label: `Email ${dir}` };
    }
    if (event.action === "sms") {
      const dir = event.details?.direction === "inbound" ? "Received" : "Sent";
      return { icon: MessageSquare, label: `SMS ${dir}` };
    }
  }

  switch (event.action) {
    case "contact_created": return { icon: UserPlus, label: "Contact Created" };
    case "deal_created": return { icon: TrendingUp, label: "Deal Created" };
    case "deal_updated":
    case "deal_auto_progressed": return { icon: ArrowRight, label: "Deal Updated" };
    case "ticket_created": return { icon: Ticket, label: "Ticket Created" };
    case "ticket_ai_classified": return { icon: Sparkles, label: "AI Classified" };
    case "sla_breach": return { icon: AlertTriangle, label: "SLA Breach" };
    case "workflow_triggered": return { icon: Zap, label: "Workflow Triggered" };
    default: return { icon: Activity, label: event.action };
  }
}

function getDetailText(event: ActivityEvent): string | null {
  if (!event.details) return null;
  if (event.details.subject) return event.details.subject;
  if (event.details.name) return event.details.name;
  if (event.details.stageName) return `Stage: ${event.details.stageName}`;
  if (event.details.category) return event.details.category;
  return null;
}

function ActivityTimeline({ entityType, entityId }: { entityType: string; entityId: number }) {
  const { data: events, isLoading } = useQuery<ActivityEvent[]>({
    queryKey: ["/api/activity", entityType, entityId],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/activity?entityType=${entityType}&entityId=${entityId}`, { credentials: "include", signal });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!entityId,
  });

  const displayEvents = events?.slice(0, 20) ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4 pt-4" data-testid="activity-timeline-loading">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 items-start">
            <Skeleton className="h-8 w-8 rounded-full shrink-0" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (displayEvents.length === 0) {
    return (
      <div className="pt-4 text-center text-sm text-muted-foreground" data-testid="activity-timeline-empty">
        No activity yet
      </div>
    );
  }

  return (
    <div className="pt-4 space-y-0" data-testid="activity-timeline">
      <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Clock className="h-4 w-4" /> Activity Timeline
      </h4>
      <div className="relative">
        {displayEvents.map((event, index) => {
          const { icon: Icon, label } = getActionMeta(event);
          const detail = getDetailText(event);
          const isLast = index === displayEvents.length - 1;

          return (
            <div
              key={event.id}
              className="relative flex gap-3 pb-4"
              data-testid={`activity-item-${event.id}`}
            >
              <div className="flex flex-col items-center">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </div>
                {!isLast && (
                  <div className="w-px flex-1 bg-border mt-1" />
                )}
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-sm font-medium" data-testid={`activity-label-${event.id}`}>
                  {label}
                </p>
                {detail && (
                  <p className="text-xs text-muted-foreground truncate" data-testid={`activity-detail-${event.id}`}>
                    {detail}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5" data-testid={`activity-time-${event.id}`}>
                  {formatRelativeTime(event.createdAt)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DuplicateGroup {
  email: string;
  phone: string;
  contacts: any[];
}

function DuplicateFinderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [selectedGroup, setSelectedGroup] = useState<DuplicateGroup | null>(null);
  const [primaryId, setPrimaryId] = useState<string>("");
  const [sourceContactId, setSourceContactId] = useState<string>("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [operationStatus, setOperationStatus] = useState<string | null>(null);
  const [previewEvidence, setPreviewEvidence] = useState<any | null>(null);
  const [isMerging, setIsMerging] = useState(false);

  const handleMerge = async () => {
    if (!sourceContactId || !primaryId) return;
    setIsMerging(true);
    try {
      const response = await apiRequest("POST", "/api/contacts/merge-operations/preview", {
        survivorContactId: Number(primaryId),
        deprecatedContactId: Number(sourceContactId),
        idempotencyKey: crypto.randomUUID(),
        fieldDecisions: { email: "survivor", phone: "survivor" },
      });
      const preview = await response.json();
      setOperationId(preview.operationId ?? null);
      setOperationStatus(preview.conflicts?.length ? "blocked" : "previewed");
      setPreviewEvidence(preview);
      toast({
        title: preview.conflicts?.length ? "Reviewed preview blocked" : "Reviewed preview created",
        description: preview.conflicts?.length
          ? preview.conflicts.join(", ")
          : `Operation ${preview.operationId} is ready for admin approval and execution.`,
      });
    } catch (error: any) {
      toast({ title: "Reviewed merge unavailable", description: error.message, variant: "destructive" });
    } finally {
      setIsMerging(false);
    }
  };
  const advanceOperation = async (action: "approve" | "execute" | "undo") => {
    if (!operationId) return;
    setIsMerging(true);
    try {
      const operationEndpoints = {
        approve: "/api/contact-merge-operations/:operationId/approve",
        execute: "/api/contact-merge-operations/:operationId/execute",
        undo: "/api/contact-merge-operations/:operationId/undo",
      } as const;
      const response = await apiRequest("POST", operationEndpoints[action].replace(":operationId", operationId));
      const operation = await response.json();
      setOperationStatus(operation.status);
      toast({ title: `Merge ${action}d`, description: `Operation status: ${operation.status}` });
    } catch (error: any) {
      toast({ title: `Unable to ${action} merge`, description: error.message, variant: "destructive" });
    } finally {
      setIsMerging(false);
    }
  };
  const loadCandidates = async () => {
    if (!/^\d+$/.test(sourceContactId)) return;
    setIsMerging(true);
    try {
      const response = await fetch(`/api/contacts/${sourceContactId}/merge-candidates`, { credentials: "include" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to load reviewed candidates");
      const candidates = result.candidates ?? [];
      setSelectedGroup({ email: "", phone: "", contacts: candidates });
      setPrimaryId(String(candidates[0]?.id ?? ""));
      if (!candidates.length) toast({ title: "No eligible reviewed candidates", description: "Shared, weak, invalid, or insufficient identity evidence is excluded." });
    } catch (error: any) {
      toast({ title: "Reviewed merge unavailable", description: error.message, variant: "destructive" });
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setSelectedGroup(null); setPrimaryId(""); setPreviewEvidence(null); } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle data-testid="text-duplicates-title">
            {selectedGroup ? "Merge Duplicate Contacts" : "Potential Duplicate Contacts"}
          </DialogTitle>
        </DialogHeader>

        {!selectedGroup ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Enter a contact ID to load token-based reviewed merge evidence. No merge is performed here.</p>
            <div className="flex gap-2">
              <Input value={sourceContactId} onChange={(event) => setSourceContactId(event.target.value)} placeholder="Contact ID" inputMode="numeric" />
              <Button onClick={loadCandidates} disabled={!sourceContactId || isMerging}>Load candidates</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Button variant="ghost" size="sm" onClick={() => { setSelectedGroup(null); setPrimaryId(""); }} data-testid="button-back-to-list">
              Back to list
            </Button>

            <div>
              <p className="text-sm font-medium mb-2">Select the primary record to keep:</p>
              <div className="space-y-2" data-testid="radio-primary-select">
                {selectedGroup.contacts.map((c: any) => (
                  <Card
                    key={c.id}
                    className={`cursor-pointer ${primaryId === String(c.id) ? "border-primary" : ""}`}
                    onClick={() => setPrimaryId(String(c.id))}
                    data-testid={`merge-candidate-${c.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <input
                          type="radio"
                          name="primary-contact"
                          value={String(c.id)}
                          checked={primaryId === String(c.id)}
                          onChange={() => setPrimaryId(String(c.id))}
                          className="mt-1"
                          data-testid={`radio-contact-${c.id}`}
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{c.firstName} {c.lastName}</span>
                            {primaryId === String(c.id) && (
                              <Badge variant="default" data-testid={`badge-primary-${c.id}`}>Primary</Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
                            <span data-testid={`merge-email-${c.id}`}>Email: {c.email || "N/A"}</span>
                            <span data-testid={`merge-phone-${c.id}`}>Phone: {c.phone || "N/A"}</span>
                            <span data-testid={`merge-company-${c.id}`}>Company: {c.companyName || "N/A"}</span>
                            <span data-testid={`merge-status-${c.id}`}>Status: {c.status || "N/A"}</span>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            <div className="rounded-md border p-3 bg-muted/50" data-testid="merge-preview">
              <p className="text-sm font-medium mb-1">Merge Preview</p>
              <p className="text-xs text-muted-foreground">A preview is read-only. No provider call, send, consent rewrite, or classification change occurs. Active enrollment, class, GHL, identity, and uniqueness conflicts block approval.</p>
              {previewEvidence && (
                <div className="mt-3 space-y-2 text-xs">
                  <p><strong>Evidence:</strong> {previewEvidence.evidence?.length ?? 0} eligible tokenized observation(s); shared and weak phones are excluded.</p>
                  <p><strong>Relationships:</strong> {Object.entries(previewEvidence.relationshipCounts ?? {}).map(([name, count]) => `${name}: ${count}`).join(", ") || "none"}</p>
                  <p><strong>Safety result:</strong> {previewEvidence.conflicts?.length ? previewEvidence.conflicts.join(", ") : "No preflight conflicts. Execution remains subject to stale and overlap checks."}</p>
                  <p><strong>Irreversible effects:</strong> pending outbound work is terminalized and makes undo fail closed; historic consent, GHL, classification, and send evidence are retained.</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setSelectedGroup(null); setPrimaryId(""); }} data-testid="button-merge-cancel">
                Cancel
              </Button>
              <Button
                onClick={handleMerge}
                disabled={!primaryId || isMerging}
                data-testid="button-confirm-merge"
              >
                <Merge className="h-4 w-4 mr-2" />
                {isMerging ? "Creating..." : "Create reviewed preview"}
              </Button>
            </div>
            {operationId && (
              <div className="rounded-md border p-3 space-y-2" data-testid="reviewed-merge-lifecycle">
                <p className="text-sm">Reviewed operation: <span className="font-mono">{operationId}</span> ({operationStatus})</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={isMerging || operationStatus !== "previewed"} onClick={() => advanceOperation("approve")}>Admin approve</Button>
                  <Button size="sm" disabled={isMerging || operationStatus !== "approved"} onClick={() => advanceOperation("execute")}>Admin execute</Button>
                  <Button size="sm" variant="outline" disabled={isMerging || !["completed", "reconciliation_pending"].includes(operationStatus ?? "")} onClick={() => advanceOperation("undo")}>Admin undo</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Contacts() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { user } = useAuth();
  const isManagerOrAdmin = user?.role === "admin" || user?.role === "manager";
  // The registered reader resolves assignedToMe only through agentOwnershipEmail.
  // Other roles silently receive an unfiltered result; never label that "mine".
  const assignmentFilterSupported = user?.role === "agent";
  const parsedPeople = peopleState(search,isManagerOrAdmin,assignmentFilterSupported);
  const peopleParams = parsedPeople.params;
  useEffect(()=>{
    if(!parsedPeople.issues.length && peopleParams.toString()!==new URLSearchParams(search).toString())
      setLocation(destinationUrl(location,peopleParams,window.location.hash),{replace:true});
  },[search,location,setLocation]);
  const requestedSize = Number(peopleParams.get("limit") ?? 50);
  const pageSize = [25, 50, 100].includes(requestedSize) ? requestedSize : 50;
  const peoplePath = location === "/dashboard/contacts-leads" ? "/dashboard/contacts-leads" : "/dashboard/contacts";
  const offsetParam = Number(peopleParams.get("offset") ?? "0");
  const offset = Number.isSafeInteger(offsetParam) && offsetParam >= 0
    ? Math.floor(offsetParam / pageSize) * pageSize : 0;
  const page = Math.floor(offset / pageSize);
  const pendingParams = useRef<{ source: string; params: URLSearchParams; scheduled: boolean; replace: boolean }>();
  const setPage = (nextPage: number | ((current: number) => number)) => {
    const resolvedPage = typeof nextPage === "function" ? nextPage(page) : nextPage;
    const next = new URLSearchParams(search);
    if (resolvedPage > 0) next.set("offset", String(resolvedPage * pageSize));
    else next.delete("offset");
    setLocation(destinationUrl(peoplePath, next, window.location.hash));
  };
  const updatePeopleParam = (key: string, value: string, replace = false) => {
    // Existing "clear filters" actions change several fields synchronously.
    // Merge those changes before one navigation rather than losing all but
    // the final setter against a captured URL.
    if (!pendingParams.current || pendingParams.current.source !== search)
      pendingParams.current = { source: search, params: new URLSearchParams(search), scheduled: false, replace };
    const pending = pendingParams.current;
    const next = pending.params;
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("offset");
    pending.replace = pending.replace && replace;
    if (!pending.scheduled) {
      pending.scheduled = true;
      queueMicrotask(() => {
        setLocation(destinationUrl(peoplePath, next, window.location.hash), { replace: pending.replace });
        if (pendingParams.current === pending) pendingParams.current = undefined;
      });
    }
  };
  // These list controls are URL state, so a shared link/back navigation always
  // describes the same People view and every change returns to the first page.
  const searchTerm = peopleParams.get("search") ?? "";
  const activitySort = peopleParams.get("sort") ?? "";
  const showArchived = peopleParams.get("archived") === "true";
  const statusFilter = peopleParams.get("status") ?? "";
  // Default to "production" so the list shows only real contacts unless the admin
  // explicitly selects another class. "all" is a virtual value that removes the filter.
  const recordClassFilter = peopleParams.get("recordClass") ?? "production";
  const [searchDraft, setSearchTerm] = useState(searchTerm);
  const latestSearch = useRef(search);
  latestSearch.current = search;
  useEffect(() => { setSearchTerm(searchTerm); }, [searchTerm]);
  useEffect(() => {
    if (searchDraft === searchTerm) return;
    const timeout = setTimeout(() => {
      const next = new URLSearchParams(latestSearch.current);
      if (searchDraft) next.set("search", searchDraft); else next.delete("search");
      next.delete("offset");
      setLocation(destinationUrl(peoplePath, next, window.location.hash), { replace: true });
    }, 250);
    return () => clearTimeout(timeout);
  }, [searchDraft, searchTerm, peoplePath, setLocation]);
  const setActivitySort = (value: string) => updatePeopleParam("sort", value);
  const setShowArchived = (value: boolean) => updatePeopleParam("archived", value ? "true" : "");
  const setStatusFilter = (value: string) => updatePeopleParam("status", value);
  // #1443 — Declare server-filter states BEFORE useContacts so they can be passed as
  // reactive query params. Initialized synchronously from URL search params so the very
  // first fetch already carries the filter (no double-fetch / empty-flash from useEffect).
  const churnRiskOnly = peopleParams.get("churnRisk") === "high";
  const setChurnRiskOnly = (v: boolean) => updatePeopleParam("churnRisk", v ? "high" : "");
  const noOutreach24hOnly = peopleParams.get("noOutreach") === "24h";
  const setNoOutreach24hOnly = (v: boolean) => updatePeopleParam("noOutreach", v ? "24h" : "");
  const blockedOnly = peopleParams.get("blocked") === "true";
  const setBlockedOnly = (v: boolean) => updatePeopleParam("blocked", v ? "true" : "");
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const emailHealthFilter = peopleParams.get("emailHealth") ?? "";
  const setEmailHealthFilter = (v: string) => updatePeopleParam("emailHealth", v);
  const assignedToMe = peopleParams.get("assignedToMe") === "true";
  const setAssignedToMe = (v: boolean) => updatePeopleParam("assignedToMe", v ? "true" : "");
  const verticalFilter = peopleParams.get("vertical") ?? "";
  const setVerticalFilter = (v: string) => updatePeopleParam("vertical", v);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false); // #236
  const tagFilter = peopleParams.get("tag") ?? "";
  const setTagFilter = (v: string) => updatePeopleParam("tag", v);
  const neverContactedOnly = peopleParams.get("neverContacted") === "true";
  const setNeverContactedOnly = (v: boolean) => updatePeopleParam("neverContacted", v ? "true" : "");
  const createdThisWeekOnly = peopleParams.get("createdThisWeek") === "true";
  const setCreatedThisWeekOnly = (v: boolean) => updatePeopleParam("createdThisWeek", v ? "true" : "");
  const leadSourceFilter = peopleParams.get("leadSource") ?? "";
  const setLeadSourceFilter = (v: string) => updatePeopleParam("leadSource", v);
  const hasAssigneeOnly = peopleParams.get("hasAssignee") === "true";
  const setHasAssigneeOnly = (v: boolean) => updatePeopleParam("hasAssignee", v ? "true" : "");
  const contactedTodayOnly = peopleParams.get("contactedToday") === "true";
  const setContactedTodayOnly = (v: boolean) => updatePeopleParam("contactedToday", v ? "true" : "");
  const lifecycleFilter = peopleParams.get("lifecycle") ?? "";
  const setLifecycleFilter = (v: string) => updatePeopleParam("lifecycle", v);
  const staleContactsOnly = peopleParams.get("stale") === "true";
  const setStaleContactsOnly = (v: boolean) => updatePeopleParam("stale", v ? "true" : "");
  const recentlyUpdated = peopleParams.get("recentlyUpdated") === "true";
  const setRecentlyUpdated = (v: boolean) => updatePeopleParam("recentlyUpdated", v ? "true" : "");
  const noDealOnly = peopleParams.get("noDeal") === "true";
  const setNoDealOnly = (v: boolean) => updatePeopleParam("noDeal", v ? "true" : "");
  const notContactedIn30Only = peopleParams.get("notContactedIn30") === "true";
  const setNotContactedIn30Only = (v: boolean) => updatePeopleParam("notContactedIn30", v ? "true" : "");

  const { data: contactsResult, isLoading, isError, refetch } = useContacts({
    limit: pageSize,
    offset,
    churnRisk: churnRiskOnly ? "high" : undefined,
    noOutreach: noOutreach24hOnly ? "24h" : undefined,
    blocked: blockedOnly ? "true" : undefined,
    search: searchTerm || undefined,
    sort: activitySort || undefined,
    archived: showArchived ? "true" : undefined,
    recordClass: recordClassFilter === "all" ? undefined : (recordClassFilter || undefined),
    status: statusFilter || undefined,
    emailHealth: emailHealthFilter || undefined,
    assignedToMe,
    vertical: verticalFilter || undefined,
    tag: tagFilter || undefined,
    contactedToday: contactedTodayOnly,
    hasAssignee: hasAssigneeOnly,
    leadSource: leadSourceFilter || undefined,
    lifecycle: lifecycleFilter || undefined,
    stale: staleContactsOnly,
    recentlyUpdated,
    neverContacted: neverContactedOnly,
    notContactedIn30: notContactedIn30Only,
    noDeal: noDealOnly,
    createdThisWeek: createdThisWeekOnly,
  });
  const contacts = contactsResult?.data;

  // Facets load separately — a slow/failing facet query never blocks contact rows.
  const facetsParams = {
    churnRisk: churnRiskOnly ? "high" : undefined,
    noOutreach: noOutreach24hOnly ? "24h" : undefined,
    blocked: blockedOnly ? "true" : undefined,
    search: searchTerm || undefined,
    sort: activitySort || undefined,
    archived: showArchived ? "true" : undefined,
    recordClass: recordClassFilter === "all" ? undefined : (recordClassFilter || undefined),
    status: statusFilter || undefined,
    emailHealth: emailHealthFilter || undefined,
    assignedToMe,
    vertical: verticalFilter || undefined,
    tag: tagFilter || undefined,
    contactedToday: contactedTodayOnly,
    hasAssignee: hasAssigneeOnly,
    leadSource: leadSourceFilter || undefined,
    lifecycle: lifecycleFilter || undefined,
    stale: staleContactsOnly,
    recentlyUpdated,
    neverContacted: neverContactedOnly,
    notContactedIn30: notContactedIn30Only,
    noDeal: noDealOnly,
    createdThisWeek: createdThisWeekOnly,
  };
  const { data: facetsResult, isLoading: facetsLoading, isError: facetsError } = useContactsFacets(facetsParams);

  const totalContacts = facetsResult?.total;   // undefined while loading
  const totalPages = totalContacts != null ? Math.ceil(totalContacts / pageSize) : undefined;
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<any>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectedContact(null);
    setIsDialogOpen(false);
    setDuplicatesOpen(false);
  }, [search]);
  const createContact = useCreateContact();
  const updateContact = useUpdateContact();

  // Batch confirmation-failed check — one request for the whole page (≤100 IDs)
  const pageContactIds = useMemo(
    () => (contacts ?? []).map((c: any) => c.id as number),
    [contacts],
  );
  const { failedMap: confirmationFailedMap } = useConfirmationFailedBatch(pageContactIds);
  const { toast } = useToast();
  const lifecycleIntents=useRef<Record<string,{key:string;payload:any}>>({});
  const lifecyclePayload=(operation:string,ids:number[])=>{
    const items=ids.map(id=>{
      const row=contacts?.find((contact:any)=>contact.id===id);
      if(!row || !Number.isSafeInteger(row.lifecycleVersion) || !row.recordClass) {
        throw new Error("Selected contact snapshot unavailable. Reload before archiving or restoring.");
      }
      return {id,expectedVersion:row.lifecycleVersion,expectedOwner:row.assignedTo ?? null,expectedRecordClass:row.recordClass};
    }).sort((a,b)=>a.id-b.id);
    if(!user?.id) throw new Error("Current account unavailable");
    const key=JSON.stringify([items,user.id,user.accountVersion]);
    const slot=`${operation}:${ids.slice().sort((a,b)=>a-b).join(",")}`;
    if(lifecycleIntents.current[slot]?.key!==key) lifecycleIntents.current[slot]={key,payload:{
      commandId:crypto.randomUUID(),expectedActorId:user.id,expectedAccountVersion:user.accountVersion,items}};
    return lifecycleIntents.current[slot].payload;
  };
  const refreshContactWork=()=>{
    for(const key of ["/api/contacts","/api/tasks","/api/analytics","/api/daily-briefing","/api/notifications"]) {
      void queryClient.invalidateQueries({queryKey:[key]});
    }
  };
  const bulkArchive=async(ids:number[])=>{
    const response=await apiRequest("POST","/api/contacts/bulk-archive",lifecyclePayload("bulk-archive",ids));
    const result=await response.json();refreshContactWork();return result;
  };

  const archiveContactMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/contacts/${id}/archive`,lifecyclePayload("archive",[id]));
      return res.json();
    },
    onSuccess: () => {
      refreshContactWork();
      toast({ title: "Contact archived" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to archive contact", description: err.message, variant: "destructive" });
    },
  });

  const restoreContactMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/contacts/${id}/restore`,lifecyclePayload("restore",[id]));
      return res.json();
    },
    onSuccess: () => {
      refreshContactWork();
      toast({ title: "Contact restored" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to restore contact", description: err.message, variant: "destructive" });
    },
  });

  // #422 — Agents query for quick-assign
  const { data: agentsList } = useQuery<{ id: number; email: string; firstName?: string | null; lastName?: string | null }[]>({
    queryKey: ["/api/agents"],
  });

  const assignContactMutation = useMutation({
    mutationFn: async ({ id, assignedTo }: { id: number; assignedTo: string | null }) => {
      const res = await apiRequest("PATCH", `/api/contacts/${id}/assign`, { assignedTo });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/contacts"] }),
    onError: (err: any) => toast({ title: "Assign failed", description: err.message, variant: "destructive" }),
  });

  // #1784 — Hard-delete workflow state
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [snapshotTotal, setSnapshotTotal] = useState<number>(0);
  const [deletePreviewData, setDeletePreviewData] = useState<any | null>(null);
  const [hardDeleteDialogOpen, setHardDeleteDialogOpen] = useState(false);
  const [hardDeleteConfirmPhrase, setHardDeleteConfirmPhrase] = useState("");
  const [isHardDeleting, setIsHardDeleting] = useState(false);
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false);

  const { data: classCounts } = useQuery<Record<string, number>>({
    queryKey: ["/api/contacts/class-counts"],
    enabled: user?.role === "admin",
    refetchInterval: 120_000,
  });

  const handleSelectAllMatching = async () => {
    const cls = recordClassFilter;
    if (!["test", "demo", "synthetic"].includes(cls)) return;
    setIsLoadingSnapshot(true);
    try {
      const res = await apiRequest("POST", "/api/admin/contacts/bulk-delete-snapshot", {
        selectAllFilter: { recordClass: cls },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Snapshot failed");
      setSnapshotId(data.snapshotId);
      setSnapshotTotal(data.total);
      // Replace selectedIds with a sentinel to indicate frozen snapshot
      setSelectedIds(new Set([-1])); // placeholder; actual IDs are server-side
      toast({
        title: "All matching contacts selected",
        description: `${data.total} ${cls} contacts frozen into a selection snapshot.`,
      });
    } catch (err: any) {
      toast({ title: "Failed to select all", description: err.message, variant: "destructive" });
    } finally {
      setIsLoadingSnapshot(false);
    }
  };

  const handleHardDeletePreview = async () => {
    let sid = snapshotId;
    // If no frozen snapshot, create one from selectedIds
    if (!sid || selectedIds.size !== 1 || !selectedIds.has(-1)) {
      const ids = Array.from(selectedIds).filter((id) => id > 0);
      if (ids.length === 0) return;
      setIsLoadingSnapshot(true);
      try {
        const res = await apiRequest("POST", "/api/admin/contacts/bulk-delete-snapshot", {
          contactIds: ids,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Snapshot failed");
        sid = data.snapshotId;
        setSnapshotId(data.snapshotId);
        setSnapshotTotal(data.total);
      } catch (err: any) {
        toast({ title: "Failed to create snapshot", description: err.message, variant: "destructive" });
        setIsLoadingSnapshot(false);
        return;
      } finally {
        setIsLoadingSnapshot(false);
      }
    }
    // Run preview
    setIsLoadingSnapshot(true);
    try {
      const res = await apiRequest("POST", "/api/admin/contacts/bulk-hard-delete/preview", {
        snapshotId: sid,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Preview failed");
      setDeletePreviewData(data);
      setHardDeleteConfirmPhrase("");
      setHardDeleteDialogOpen(true);
    } catch (err: any) {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    } finally {
      setIsLoadingSnapshot(false);
    }
  };

  const handleHardDeleteExecute = async () => {
    if (!deletePreviewData) return;
    const expectedPhrase = deletePreviewData.confirmationPhrase;
    if (hardDeleteConfirmPhrase.trim() !== expectedPhrase) {
      toast({ title: "Phrase mismatch", description: `Type exactly: ${expectedPhrase}`, variant: "destructive" });
      return;
    }
    setIsHardDeleting(true);
    try {
      const res = await apiRequest("POST", "/api/admin/contacts/bulk-hard-delete", {
        previewId: deletePreviewData.previewId,
        idempotencyKey: crypto.randomUUID(),
        confirmationPhrase: hardDeleteConfirmPhrase.trim(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Deletion failed");
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/class-counts"] });
      setHardDeleteDialogOpen(false);
      setSnapshotId(null);
      setDeletePreviewData(null);
      setSelectedIds(new Set());
      toast({
        title: "Contacts permanently deleted",
        description: `Deleted: ${data.deleted} | Blocked: ${data.blocked} | Failed: ${data.failed}`,
      });
    } catch (err: any) {
      toast({ title: "Deletion failed", description: err.message, variant: "destructive" });
    } finally {
      setIsHardDeleting(false);
    }
  };

  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkChannel, setBulkChannel] = useState<"email" | "sms">("email");
  const [bulkSubject, setBulkSubject] = useState("");
  const [bulkMessage, setBulkMessage] = useState("");
  const [bulkResults, setBulkResults] = useState<BulkMessageResult | null>(null);

  const bulkSendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bulk-message", {
        contactIds: Array.from(selectedIds),
        channel: bulkChannel,
        subject: bulkChannel === "email" ? bulkSubject : undefined,
        message: bulkMessage,
      });
      return res.json() as Promise<BulkMessageResult>;
    },
    onSuccess: (data) => {
      setBulkResults(data);
      toast({
        title: "Bulk message complete",
        description: `Sent: ${data.sent}, Skipped: ${data.skipped}, Errors: ${data.errors}`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      companyName: "",
      notes: "",
    }
  });

  const onSubmit = async (data: FormData) => {
    try {
      await createContact.mutateAsync({ ...data, status: "New" });
      setIsDialogOpen(false);
      form.reset();
    } catch {
      // onError handler in useCreateContact shows toast
    }
  };

  const EMAIL_HEALTH_OPTIONS = [
    { value: "", label: "All" },
    { value: "active", label: "Active (status only, not validated)" },
    { value: "bounced", label: "Bounced" },
    { value: "invalid", label: "Invalid" },
    { value: "opted_out", label: "Opted Out" },
  ];

  // Rows, totals and ordering come from the same canonical server predicate.
  const filteredContacts = contacts;
  const sortedContacts = contacts;

  const summaryLoading = facetsLoading;
  const emailHealthSummary = facetsError || !facetsResult ? undefined : {
    total:facetsResult.total,
    active:facetsResult.byEmailHealth.active ?? 0,
    bounced:facetsResult.byEmailHealth.bounced ?? 0,
    invalid:facetsResult.byEmailHealth.invalid ?? 0,
    opted_out:facetsResult.byEmailHealth.opted_out ?? 0,
  };

  const contactsFilterState = { searchTerm, statusFilter, emailHealthFilter, showArchived: String(showArchived), assignedToMe: String(assignedToMe) };

  const handleApplySavedFilter = (filters: Record<string, unknown>) => {
    setSearchTerm(String(filters.searchTerm || ""));
    setStatusFilter(String(filters.statusFilter || ""));
    setEmailHealthFilter(String(filters.emailHealthFilter || ""));
    if (filters.showArchived === "true") setShowArchived(true);
    else setShowArchived(false);
    if (filters.assignedToMe === "true") setAssignedToMe(true);
    else setAssignedToMe(false);
  };

  // #318 — Shift+click range selection
  const lastSelectedIdRef = React.useRef<number | null>(null);

  const toggleSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey && lastSelectedIdRef.current != null && filteredContacts) {
      const ids = filteredContacts.map((c: any) => c.id as number);
      const lastIdx = ids.indexOf(lastSelectedIdRef.current);
      const curIdx = ids.indexOf(id);
      if (lastIdx !== -1 && curIdx !== -1) {
        const [lo, hi] = [Math.min(lastIdx, curIdx), Math.max(lastIdx, curIdx)];
        setSelectedIds(prev => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
          return next;
        });
        return;
      }
    }
    lastSelectedIdRef.current = id;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === (filteredContacts?.length || 0)) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredContacts?.map((c: any) => c.id) || []));
    }
  };

  const bulkUpdateStatus = async (status: string) => {
    if (bulkUpdating) return;
    setBulkUpdating(true);
    try {
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        await updateContact.mutateAsync({ id, status });
      }
      setSelectedIds(new Set());
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      toast({ title: "Bulk update failed", description: message, variant: "destructive" });
    } finally {
      setBulkUpdating(false);
    }
  };

  const openBulkDialog = (channel: "email" | "sms") => {
    setBulkChannel(channel);
    setBulkSubject("");
    setBulkMessage("");
    setBulkResults(null);
    setBulkDialogOpen(true);
  };

  const handleBulkLinkedInEnrich = async () => {
    if (bulkUpdating) return;
    setBulkUpdating(true);
    try {
      throw new Error("Bulk LinkedIn enrichment is retired; CRO-03 provider transport is disabled.");
    } catch (err: any) {
      toast({ title: "LinkedIn enrichment failed", description: err.message, variant: "destructive" });
    } finally {
      setBulkUpdating(false);
    }
  };

  const selectedContacts = Array.from(selectedIds);

  if (isError) {
    return <DashboardErrorState title="Failed to load contacts" onRetry={() => refetch()} />;
  }

  const summaryTotal = emailHealthSummary?.total ?? 0;
  const healthStats = [
    {
      key: "active",
      label: "Active status",
      hint: "Raw status 'active': legacy, not a validated address",
      value: emailHealthSummary?.active ?? 0,
      idleColor: "text-emerald-600 dark:text-emerald-400",
      selectedBg: "bg-emerald-100 dark:bg-emerald-900/40 border-emerald-400 dark:border-emerald-600",
      selectedText: "text-emerald-700 dark:text-emerald-300",
    },
    {
      key: "bounced",
      label: "Bounced",
      value: emailHealthSummary?.bounced ?? 0,
      idleColor: "text-red-600 dark:text-red-400",
      selectedBg: "bg-red-100 dark:bg-red-900/40 border-red-400 dark:border-red-600",
      selectedText: "text-red-700 dark:text-red-300",
    },
    {
      key: "invalid",
      label: "Invalid",
      value: emailHealthSummary?.invalid ?? 0,
      idleColor: "text-orange-600 dark:text-orange-400",
      selectedBg: "bg-orange-100 dark:bg-orange-900/40 border-orange-400 dark:border-orange-600",
      selectedText: "text-orange-700 dark:text-orange-300",
    },
    {
      key: "opted_out",
      label: "Opted Out",
      value: emailHealthSummary?.opted_out ?? 0,
      idleColor: "text-slate-500 dark:text-slate-400",
      selectedBg: "bg-slate-200 dark:bg-slate-700 border-slate-400 dark:border-slate-500",
      selectedText: "text-slate-700 dark:text-slate-200",
    },
  ] as const;

  return (
    <CrmPage className="space-y-6">
      <CrmPageHeader title="People" description="Contacts in your authorized scope. Filters and paging are shareable in the URL."
        primaryAction={<Button onClick={()=>setIsDialogOpen(true)} data-testid="button-add-contact"><Plus className="mr-2 h-4 w-4" /> Add Contact</Button>} />
      {!!parsedPeople.issues.length && <div role="alert" className="rounded-md border p-3 text-sm">
        {parsedPeople.issues.map(issue=><p key={issue.key}>{issue.reason}</p>)}
      </div>}
      {/* Email Health Stats Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" data-testid="email-health-stats-bar">
        {/* Total */}
        <button
          onClick={() => setEmailHealthFilter("")}
          data-testid="stat-email-health-all"
          className={`flex flex-col items-center justify-center px-3 py-2.5 rounded-lg border transition-all cursor-pointer ${
            emailHealthFilter === ""
              ? "bg-primary/10 border-primary/50 text-primary shadow-sm"
              : "bg-muted/50 border-border hover:bg-muted text-foreground"
          }`}
        >
          {summaryLoading ? (
            <Skeleton className="h-6 w-10 mb-1" />
          ) : (
            <span className="text-xl font-bold leading-tight" data-testid="stat-count-all">{emailHealthSummary ? summaryTotal.toLocaleString() : "Unknown"}</span>
          )}
          <span className="text-[11px] font-medium text-muted-foreground mt-0.5">Total Contacts</span>
        </button>

        {/* Per-status stats */}
        {healthStats.map((stat) => {
          const pct = summaryTotal > 0 ? Math.round((stat.value / summaryTotal) * 100) : 0;
          const isActive = emailHealthFilter === stat.key;
          return (
            <button
              key={stat.key}
              onClick={() => setEmailHealthFilter(isActive ? "" : stat.key)}
              data-testid={`stat-email-health-${stat.key}`}
              title={"hint" in stat ? (stat as { hint?: string }).hint : undefined}
              className={`flex flex-col items-center justify-center px-3 py-2.5 rounded-lg border transition-all cursor-pointer ${
                isActive
                  ? `${stat.selectedBg} shadow-sm`
                  : "bg-muted/50 border-border hover:bg-muted"
              }`}
            >
              {summaryLoading ? (
                <Skeleton className="h-6 w-10 mb-1" />
              ) : (
                <span
                  className={`text-xl font-bold leading-tight ${isActive ? stat.selectedText : stat.idleColor}`}
                  data-testid={`stat-count-${stat.key}`}
                >
                  {emailHealthSummary ? stat.value.toLocaleString() : "Unknown"}
                </span>
              )}
              <span className={`text-[11px] font-medium mt-0.5 ${isActive ? stat.selectedText : stat.idleColor}`}>
                {stat.label}
              </span>
              {!summaryLoading && summaryTotal > 0 && (
                <span className="text-[10px] text-muted-foreground" data-testid={`stat-pct-${stat.key}`}>{pct}%</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search contacts..." 
              className="pl-9"
              value={searchDraft}
              onChange={(e) => setSearchTerm(e.target.value)}
              data-testid="input-search-contacts"
            />
          </div>
          {/* #592 — Filtered count: shows "—" while loading, "Unavailable" on error, never a stale 0 */}
          {sortedContacts && (
            <span className="text-sm text-muted-foreground whitespace-nowrap" data-testid="text-filtered-count">
              {facetsLoading
                ? "— contacts"
                : facetsError
                ? "Count unavailable"
                : totalContacts != null
                ? `${totalContacts.toLocaleString()} ${totalContacts === 1 ? "contact" : "contacts"} matching the current filters${facetsResult?.asOf ? ` · as of ${new Date(facetsResult.asOf).toLocaleTimeString()}` : ""}`
                : "— contacts"}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-2 flex-wrap">
          {/* #566 — Sort select */}
          <Select value={activitySort || "__default__"} onValueChange={v => setActivitySort(v === "__default__" ? "" : v)}>
            <SelectTrigger aria-label="Sort contacts" className="h-8 w-[160px] text-xs" data-testid="select-contact-sort">
              <SelectValue placeholder="Sort by…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Default order</SelectItem>
              <SelectItem value="activity_desc">Last active (newest)</SelectItem>
              <SelectItem value="activity_asc">Last active (oldest)</SelectItem>
              <SelectItem value="score_desc">Lead score (high→low)</SelectItem>
              <SelectItem value="alpha">A → Z (name)</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1 flex-wrap" data-testid="email-health-filter">
            {EMAIL_HEALTH_OPTIONS.map((opt) => {
              const isActive = emailHealthFilter === opt.value;
              const count = opt.value
                ? emailHealthSummary?.[opt.value as "active" | "bounced" | "invalid" | "opted_out"] ?? 0
                : summaryTotal;
              return (
                <button
                  key={opt.value || "all"}
                  onClick={() => setEmailHealthFilter(opt.value)}
                  data-testid={`chip-email-health-${opt.value || "all"}`}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    isActive
                      ? opt.value === "bounced" || opt.value === "invalid"
                        ? "bg-red-100 border-red-300 text-red-700 dark:bg-red-900/40 dark:border-red-700 dark:text-red-300"
                        : opt.value === "opted_out"
                        ? "bg-slate-200 border-slate-400 text-slate-700 dark:bg-slate-700 dark:border-slate-500 dark:text-slate-200"
                        : "bg-primary/10 border-primary/30 text-primary"
                      : "bg-background border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {opt.label}
                  {count !== undefined && count > 0 && (
                    <span className={`px-1 py-0.5 rounded text-[10px] font-semibold ${
                      isActive ? "bg-white/30 dark:bg-black/20" : "bg-muted-foreground/10"
                    }`} data-testid={`count-email-health-${opt.value || "all"}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setAssignedToMe(!assignedToMe)}
            data-testid="chip-assigned-to-me"
            disabled={!assignmentFilterSupported}
            title={!assignmentFilterSupported ? "Assigned-to-me filtering is unavailable for this role" : undefined}
            aria-describedby={!assignmentFilterSupported ? "people-assignment-filter-support" : undefined}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              assignedToMe
                ? "bg-primary/10 border-primary/30 text-primary"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <UserCheck className="h-3 w-3" />
            Assigned to me
          </button>
          {/* #462 — Never contacted filter chip */}
          <button
            onClick={() => setNeverContactedOnly(!neverContactedOnly)}
            data-testid="chip-never-contacted"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              neverContactedOnly
                ? "bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <Clock className="h-3 w-3" />
            Never contacted
          </button>
          {/* #383 — Contacted today chip */}
          <button
            onClick={() => setContactedTodayOnly(!contactedTodayOnly)}
            data-testid="chip-contacted-today"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              contactedTodayOnly
                ? "bg-teal-50 border-teal-300 text-teal-700 dark:bg-teal-900/30 dark:border-teal-700 dark:text-teal-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <UserCheck className="h-3 w-3" />
            Contacted today
          </button>
          {/* #482 — Created this week filter chip */}
          <button
            onClick={() => setCreatedThisWeekOnly(!createdThisWeekOnly)}
            data-testid="chip-created-this-week"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              createdThisWeekOnly
                ? "bg-green-50 border-green-300 text-green-700 dark:bg-green-900/30 dark:border-green-700 dark:text-green-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <Calendar className="h-3 w-3" />
            This week
          </button>
          {/* #398 — Stale contacts chip (no activity in 30+ days) */}
          <button
            onClick={() => setStaleContactsOnly(!staleContactsOnly)}
            data-testid="chip-stale-contacts"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              staleContactsOnly
                ? "bg-orange-50 border-orange-300 text-orange-700 dark:bg-orange-900/30 dark:border-orange-700 dark:text-orange-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <Clock className="h-3 w-3" />
            Stale (30d)
          </button>
          {/* #543 — Recently updated chip (last 7 days) */}
          <button
            onClick={() => setRecentlyUpdated(!recentlyUpdated)}
            data-testid="chip-recently-updated"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              recentlyUpdated
                ? "bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <RefreshCw className="h-3 w-3" />
            Updated this week
          </button>
          {/* #1245 — Not contacted in 30 days chip */}
          <button
            onClick={() => setNotContactedIn30Only(!notContactedIn30Only)}
            data-testid="chip-not-contacted-30d"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              notContactedIn30Only
                ? "bg-red-50 border-red-300 text-red-700 dark:bg-red-900/30 dark:border-red-700 dark:text-red-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <PhoneMissed className="h-3 w-3" />
            No call (30d)
          </button>
          {/* #1443 — Blocked contacts chip */}
          <button
            onClick={() => setBlockedOnly(!blockedOnly)}
            data-testid="chip-blocked-contacts"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              blockedOnly
                ? "bg-red-50 border-red-300 text-red-700 dark:bg-red-900/30 dark:border-red-700 dark:text-red-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <BellOff className="h-3 w-3" />
            Blocked
          </button>
          {/* #1443 — Churn risk chip */}
          <button
            onClick={() => setChurnRiskOnly(!churnRiskOnly)}
            data-testid="chip-churn-risk"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              churnRiskOnly
                ? "bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <TrendingUp className="h-3 w-3" />
            Churn Risk
          </button>
          {/* #1443 — No-outreach 24h chip */}
          <button
            onClick={() => setNoOutreach24hOnly(!noOutreach24hOnly)}
            data-testid="chip-no-outreach-24h"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              noOutreach24hOnly
                ? "bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <Clock className="h-3 w-3" />
            No outreach (24h)
          </button>
          {/* #1784 — Record class filter chips (admin only) */}
          {user?.role === "admin" && (
            <div className="flex items-center gap-1 flex-wrap" data-testid="record-class-filter">
              {(["production", "test", "demo", "synthetic", "unknown", "all"] as const).map((cls) => {
                const isActive = recordClassFilter === cls || (cls === "production" && recordClassFilter === "production");
                const label = cls === "all" ? "All classes" : cls.charAt(0).toUpperCase() + cls.slice(1);
                const count = cls !== "all" ? (classCounts?.[cls] ?? 0) : undefined;
                const isDangerous = cls === "test" || cls === "demo" || cls === "synthetic";
                return (
                  <button
                    key={cls}
                    onClick={() => {
                      // Clear frozen snapshot when filter changes
                      if (snapshotId) { setSnapshotId(null); setSelectedIds(new Set()); }
                      updatePeopleParam("recordClass", cls === "production" ? "" : cls);
                    }}
                    data-testid={`chip-record-class-${cls}`}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      isActive
                        ? isDangerous
                          ? "bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300"
                          : cls === "unknown"
                          ? "bg-slate-100 border-slate-400 text-slate-700 dark:bg-slate-800 dark:border-slate-500 dark:text-slate-200"
                          : "bg-primary/10 border-primary/30 text-primary"
                        : "bg-background border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {isDangerous && <ShieldAlert className="h-2.5 w-2.5" />}
                    {label}
                    {count !== undefined && count > 0 && (
                      <span className="px-1 py-0.5 rounded text-[10px] font-semibold bg-muted-foreground/10">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {/* #835 — No-deal contacts chip */}
          <button
            onClick={() => setNoDealOnly(!noDealOnly)}
            data-testid="chip-no-deal"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              noDealOnly
                ? "bg-slate-100 border-slate-400 text-slate-700 dark:bg-slate-800 dark:border-slate-500 dark:text-slate-200"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            No deal
          </button>
          {/* #619 — Has assignee chip */}
          <button
            onClick={() => setHasAssigneeOnly(!hasAssigneeOnly)}
            data-testid="chip-has-assignee"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              hasAssigneeOnly
                ? "bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-700 dark:text-indigo-300"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <UserCheck className="h-3 w-3" />
            Assigned
          </button>
          <div className="flex items-center gap-2" data-testid="toggle-show-archived-contacts">
            <Switch
              checked={showArchived}
              onCheckedChange={setShowArchived}
              data-testid="switch-show-archived-contacts"
            />
            <Label className="text-sm cursor-pointer" onClick={() => setShowArchived(!showArchived)}>
              Show Archived
            </Label>
          </div>
          {/* #236 — Advanced filter toggle */}
          <Button
            variant={showAdvancedFilters ? "secondary" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => setShowAdvancedFilters(v => !v)}
            data-testid="button-advanced-filters"
          >
            <Activity className="w-3.5 h-3.5" />
            Filters {(verticalFilter || tagFilter || leadSourceFilter || hasAssigneeOnly) ? "•" : ""}
          </Button>
          {/* #1784 — Select-all-matching button for eligible classes */}
          {user?.role === "admin" && ["test", "demo", "synthetic"].includes(recordClassFilter) && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/20"
              disabled={isLoadingSnapshot}
              onClick={handleSelectAllMatching}
              data-testid="button-select-all-matching"
            >
              <CheckSquare className="w-3.5 h-3.5" />
              {isLoadingSnapshot ? "Freezing…" : `Select all ${recordClassFilter}`}
              {classCounts?.[recordClassFilter] !== undefined && (
                <span className="ml-1 opacity-70">({classCounts[recordClassFilter]})</span>
              )}
            </Button>
          )}
          {selectedIds.size > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2" data-testid="button-bulk-actions">
                  <CheckSquare className="w-4 h-4" />
                  {selectedIds.size} selected
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => bulkUpdateStatus("New")} disabled={bulkUpdating} data-testid="bulk-mark-lead">Mark as Lead</DropdownMenuItem>
                <DropdownMenuItem onClick={() => bulkUpdateStatus("Contacted")} disabled={bulkUpdating} data-testid="bulk-mark-contacted">Mark Contacted</DropdownMenuItem>
                <DropdownMenuItem onClick={() => bulkUpdateStatus("Won")} disabled={bulkUpdating} data-testid="bulk-mark-won">Mark Won</DropdownMenuItem>
                <DropdownMenuItem onClick={() => bulkUpdateStatus("Lost")} disabled={bulkUpdating} data-testid="bulk-mark-lost">Mark Lost</DropdownMenuItem>
                <DropdownMenuItem disabled data-testid="bulk-linkedin-enrich">
                  Enrich from LinkedIn (retired — CRO-03 provider transport disabled)
                </DropdownMenuItem>
                {/* #1784 — Permanent hard delete (admin only, test/demo/synthetic) */}
                {user?.role === "admin" && (
                  <DropdownMenuItem
                    disabled={bulkUpdating || isLoadingSnapshot}
                    data-testid="bulk-hard-delete"
                    className="text-red-600 dark:text-red-400 focus:text-red-700 focus:bg-red-50 dark:focus:bg-red-900/30"
                    onClick={handleHardDeletePreview}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    {isLoadingSnapshot ? "Loading preview…" : "Permanently delete…"}
                  </DropdownMenuItem>
                )}
                {/* #507 — Bulk archive selected contacts */}
                {isManagerOrAdmin && (
                  <DropdownMenuItem
                    disabled={bulkUpdating}
                    data-testid="bulk-archive"
                    onClick={async () => {
                      if (!confirm(`Archive ${selectedIds.size} contact(s)?`)) return;
                      setBulkUpdating(true);
                      try {
                        await bulkArchive(Array.from(selectedIds));
                        queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
                        toast({ title: "Contacts archived", description: `${selectedIds.size} contacts archived` });
                        setSelectedIds(new Set());
                      } catch (err: any) {
                        toast({ title: "Archive failed", description: err.message, variant: "destructive" });
                      } finally {
                        setBulkUpdating(false);
                      }
                    }}
                  >
                    Archive selected
                  </DropdownMenuItem>
                )}
                {/* #516 — Bulk re-score (admin/manager only) */}
                {isManagerOrAdmin && (
                  <DropdownMenuItem
                    disabled={bulkUpdating}
                    data-testid="bulk-rescore"
                    onClick={async () => {
                      setBulkUpdating(true);
                      try {
                        const res = await apiRequest("POST", "/api/contacts/mass-score", {
                          contactIds: Array.from(selectedIds),
                        });
                        const d = await res.json();
                        toast({ title: "Re-score started", description: d.message ?? `Scoring ${selectedIds.size} contacts…` });
                        setSelectedIds(new Set());
                      } catch (err: any) {
                        toast({ title: "Re-score failed", description: err.message, variant: "destructive" });
                      } finally {
                        setBulkUpdating(false);
                      }
                    }}
                  >
                    Re-score contacts
                  </DropdownMenuItem>
                )}
                {/* #803 — Bulk reassign to rep (admin/manager only) */}
                {isManagerOrAdmin && agentsList && agentsList.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={bulkUpdating} data-testid="bulk-reassign-rep">
                      Reassign to rep
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem
                        onClick={async () => {
                          setBulkUpdating(true);
                          try {
                            await Promise.all(Array.from(selectedIds).map(id =>
                              apiRequest("PATCH", `/api/contacts/${id}/assign`, { assignedTo: null }).then(r => r.json())
                            ));
                            queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
                            toast({ title: "Unassigned", description: `${selectedIds.size} contacts unassigned` });
                            setSelectedIds(new Set());
                          } catch (err: any) {
                            toast({ title: "Failed", description: err.message, variant: "destructive" });
                          } finally { setBulkUpdating(false); }
                        }}
                        data-testid="bulk-reassign-unassign"
                      >
                        — Unassign
                      </DropdownMenuItem>
                      {agentsList.filter((a: any) => a.status === "active").map((agent: any) => (
                        <DropdownMenuItem
                          key={agent.id}
                          data-testid={`bulk-reassign-${agent.id}`}
                          onClick={async () => {
                            setBulkUpdating(true);
                            try {
                              await Promise.all(Array.from(selectedIds).map(id =>
                                apiRequest("PATCH", `/api/contacts/${id}/assign`, { assignedTo: agent.email }).then(r => r.json())
                              ));
                              queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
                              toast({ title: "Reassigned", description: `${selectedIds.size} contacts assigned to ${agent.firstName} ${agent.lastName}` });
                              setSelectedIds(new Set());
                            } catch (err: any) {
                              toast({ title: "Failed", description: err.message, variant: "destructive" });
                            } finally { setBulkUpdating(false); }
                          }}
                        >
                          {agent.firstName} {agent.lastName}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {/* #927 — Bulk lifecycle state update (admin/manager only) */}
                {isManagerOrAdmin && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={bulkUpdating} data-testid="bulk-lifecycle-trigger">
                      Set lifecycle state…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {["PROSPECT","ENGAGED","QUALIFIED","PROPOSAL_SENT","NEGOTIATION","CLOSED_WON","CLOSED_LOST","DISQUALIFIED","NURTURE"].map((state) => (
                        <DropdownMenuItem key={state} onClick={async () => {
                          setBulkUpdating(true);
                          try {
                            await Promise.all(Array.from(selectedIds).map(id =>
                              apiRequest("PUT", `/api/contacts/${id}`, { lifecycleState: state }).then(r => r.json())
                            ));
                            queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
                            toast({ title: "Lifecycle updated", description: `Set ${selectedIds.size} contacts to ${state}` });
                            setSelectedIds(new Set());
                          } catch (err: any) {
                            toast({ title: "Update failed", description: err.message, variant: "destructive" });
                          } finally {
                            setBulkUpdating(false);
                          }
                        }} data-testid={`bulk-lifecycle-${state}`}>
                          {state.replace(/_/g, " ")}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {/* #391 — Bulk tag by vertical (admin/manager only) */}
                {isManagerOrAdmin && (
                  <DropdownMenuItem
                    disabled={bulkUpdating}
                    data-testid="bulk-tag-vertical"
                    onClick={async () => {
                      const v = window.prompt("Enter vertical to tag selected contacts with (e.g. restaurant, retail, automotive):");
                      if (!v?.trim()) return;
                      setBulkUpdating(true);
                      try {
                        await Promise.all(Array.from(selectedIds).map(id =>
                          apiRequest("PUT", `/api/contacts/${id}`, { vertical: v.trim() }).then(r => r.json())
                        ));
                        queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
                        toast({ title: "Vertical applied", description: `Tagged ${selectedIds.size} contacts as "${v.trim()}"` });
                        setSelectedIds(new Set());
                      } catch (err: any) {
                        toast({ title: "Tag failed", description: err.message, variant: "destructive" });
                      } finally {
                        setBulkUpdating(false);
                      }
                    }}
                  >
                    Tag vertical…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="outline" size="sm" className="gap-2" onClick={() => setDuplicatesOpen(true)} data-testid="button-find-duplicates">
            <Users className="w-4 h-4" /> Find Duplicates
          </Button>
          {/* #1443 — Export blocked contacts CSV (server-side, no row cap) */}
          {blockedOnly && isManagerOrAdmin && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20"
              data-testid="button-export-blocked-contacts"
              onClick={() => {
                const a = document.createElement("a");
                a.href = `/api/contacts/blocked/export-csv`;
                a.download = `blocked-contacts-${new Date().toISOString().split("T")[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }}
            >
              <Download className="w-4 h-4" /> Export Blocked CSV
            </Button>
          )}
          {(emailHealthFilter === "bounced" || emailHealthFilter === "invalid" || emailHealthFilter === "opted_out") && (
            <Button variant="outline" size="sm" className="gap-2 border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20" onClick={() => exportToCSV(filteredContacts || [], `contacts_${emailHealthFilter}`, [
              { key: "firstName", label: "First Name" },
              { key: "lastName", label: "Last Name" },
              { key: "email", label: "Email" },
              { key: "phone", label: "Phone" },
              { key: "companyName", label: "Company" },
              { key: "status", label: "Status" },
              { key: "emailStatus", label: "Email Status" },
              { key: "bouncedAt", label: "Bounced At" },
              { key: "leadScore", label: "Lead Score" },
              { key: "createdAt", label: "Created At" },
            ])} data-testid="button-export-bounced-contacts">
              <Download className="w-4 h-4" /> Export {emailHealthFilter === "opted_out" ? "Opted-Out" : emailHealthFilter === "invalid" ? "Invalid" : "Bounced"}
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-2" onClick={() => {
            const role = user?.role;
            if (role === "admin" || role === "manager") {
              // Server-side export — no row cap, respects active filters
              const params = new URLSearchParams();
              for (const [key, value] of Object.entries(facetsParams)) {
                if (value !== undefined && value !== false && value !== "") params.set(key, String(value));
              }
              const url = `/api/contacts/export-csv${params.toString() ? `?${params}` : ""}`;
              const a = document.createElement("a");
              a.href = url;
              a.download = `contacts-${new Date().toISOString().split("T")[0]}.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            } else {
              // Agent: client-side export of visible page only
              exportToCSV(sortedContacts || [], "contacts", [
                { key: "firstName", label: "First Name" },
                { key: "lastName", label: "Last Name" },
                { key: "email", label: "Email" },
                { key: "phone", label: "Phone" },
                { key: "companyName", label: "Company" },
                { key: "status", label: "Status" },
                { key: "emailStatus", label: "Email Status" },
                { key: "leadScore", label: "Lead Score" },
                { key: "createdAt", label: "Created At" },
              ]);
            }
          }} data-testid="button-export-contacts">
            <Download className="w-4 h-4" /> Export CSV
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Contact</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>First Name</FormLabel>
                        <FormControl><Input {...field} data-testid="input-create-contact-first-name" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last Name</FormLabel>
                        <FormControl><Input {...field} data-testid="input-create-contact-last-name" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl><Input {...field} type="email" data-testid="input-create-contact-email" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl><Input {...field} data-testid="input-create-contact-phone" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="companyName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company</FormLabel>
                      <FormControl><Input {...field} data-testid="input-create-contact-company" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="vertical"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Vertical</FormLabel>
                      <Select value={field.value || ""} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger data-testid="select-contact-vertical">
                            <SelectValue placeholder="Select vertical (optional)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {VERTICALS.map((v) => (
                            <SelectItem key={v} value={v}>{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* #426 — Notes field in add-contact dialog */}
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="Any notes about this contact..."
                          rows={2}
                          data-testid="input-contact-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end pt-4">
                  <Button type="submit" disabled={createContact.isPending}>
                    {createContact.isPending ? "Creating..." : "Create Contact"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {selectedContacts.length > 0 && (
        <div className="flex items-center gap-3 p-3 bg-primary/5 rounded-md flex-wrap" data-testid="bulk-actions-toolbar">
          <span className="text-sm font-medium" data-testid="text-selected-count">
            {selectedContacts.length} selected
          </span>
          <Button size="sm" onClick={() => openBulkDialog("email")} data-testid="button-bulk-email">
            <Mail className="w-4 h-4 mr-1" /> Bulk Email
          </Button>
          <Button size="sm" onClick={() => openBulkDialog("sms")} data-testid="button-bulk-sms">
            <MessageSquare className="w-4 h-4 mr-1" /> Bulk SMS
          </Button>
          {isManagerOrAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="border-orange-300 text-orange-700 hover:bg-orange-50 dark:border-orange-700 dark:text-orange-300 dark:hover:bg-orange-900/20"
              disabled={bulkUpdating}
              onClick={async () => {
                if (!confirm(`Archive ${selectedContacts.length} contact(s)? They will be hidden but recoverable.`)) return;
                setBulkUpdating(true);
                try {
                  await bulkArchive(Array.from(selectedIds));
                  queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
                  toast({ title: "Contacts archived", description: `${selectedContacts.length} contacts archived` });
                  setSelectedIds(new Set());
                } catch (err: any) {
                  toast({ title: "Archive failed", description: err.message, variant: "destructive" });
                } finally {
                  setBulkUpdating(false);
                }
              }}
              data-testid="button-bulk-archive"
            >
              <Archive className="w-4 h-4 mr-1" /> Archive
            </Button>
          )}
          {user?.role === "admin" && (
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
              disabled={isLoadingSnapshot || isHardDeleting}
              onClick={handleHardDeletePreview}
              data-testid="button-bulk-delete"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {isLoadingSnapshot ? "Loading…" : "Delete"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setSelectedIds(new Set())} data-testid="button-clear-selection">
            Clear
          </Button>
        </div>
      )}

      {/* #236 — Advanced filter drawer with #238 vertical filter */}
      <CrmFilterPanel open={showAdvancedFilters} onOpenChange={setShowAdvancedFilters}>
        <div className="p-3 border rounded-lg bg-muted/30 space-y-3 animate-in fade-in-0 slide-in-from-top-2 duration-150" data-testid="advanced-filters-panel">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Advanced Filters</span>
            {(verticalFilter || statusFilter || tagFilter || leadSourceFilter || hasAssigneeOnly) && (
              <Button variant="ghost" size="sm" className="text-xs h-6 px-2" onClick={() => { setVerticalFilter(""); setStatusFilter(""); setTagFilter(""); setLeadSourceFilter(""); setHasAssigneeOnly(false); setLifecycleFilter(""); setContactedTodayOnly(false); }} data-testid="button-clear-vertical">
                Clear all
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Industry / Vertical</Label>
              <Select value={verticalFilter || "__all__"} onValueChange={v => setVerticalFilter(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-vertical-filter">
                  <SelectValue placeholder="All verticals" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All verticals</SelectItem>
                  {[...SFP_CONTACT_VERTICAL_IDS, ...VERTICALS.filter((v) => !resolveContactTargetVertical(v))].map(v => (
                    <SelectItem key={v} value={v}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Status</Label>
              <Select value={statusFilter || "__all__"} onValueChange={v => setStatusFilter(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-status-filter-advanced">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All statuses</SelectItem>
                  {["New", "Contacted", "Qualified", "Won", "Lost"].map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* #520 — Lifecycle state filter */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Lifecycle State</Label>
              <Select value={lifecycleFilter || "__all__"} onValueChange={v => setLifecycleFilter(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-lifecycle-filter">
                  <SelectValue placeholder="All lifecycle states" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All lifecycle states</SelectItem>
                  {["PROSPECT","QUALIFIED_LEAD","PROPOSAL_SENT","NEGOTIATION","CLOSED_WON","CLOSED_LOST","CHURNED","WINBACK"].map(s => (
                    <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* #514 — Lead source filter */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Lead Source</Label>
              <Select value={leadSourceFilter || "__all__"} onValueChange={v => setLeadSourceFilter(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-lead-source-filter">
                  <SelectValue placeholder="All sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All sources</SelectItem>
                  {["google_ads", "sunbiz", "imported_list", "referral", "outbound", "inbound", "partner"].map(s => (
                    <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* #263 — Tag filter */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Tag</Label>
              <div className="relative">
                <Input
                  className="h-8 text-xs pr-6"
                  placeholder="Filter by tag…"
                  value={tagFilter}
                  onChange={e => setTagFilter(e.target.value)}
                  data-testid="input-tag-filter"
                />
                {tagFilter && (
                  <button
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setTagFilter("")}
                    data-testid="button-clear-tag-filter"
                    type="button"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </CrmFilterPanel>

      <div className="flex flex-wrap gap-2" aria-label="People URL presets">
        <Button variant="outline" onClick={() => {
          const next = new URLSearchParams();
          if (peoplePath === "/dashboard/contacts-leads") next.set("tab", "people");
          setLocation(destinationUrl(peoplePath, next, window.location.hash));
        }} data-testid="preset-people-all">Production people</Button>
        <Button variant="outline" disabled={!assignmentFilterSupported}
          aria-describedby={!assignmentFilterSupported ? "people-assignment-filter-support" : undefined}
          onClick={() => updatePeopleParam("assignedToMe", "true")}
          data-testid="preset-people-mine">Assigned to me</Button>
        <Button variant="outline" onClick={() => updatePeopleParam("blocked", "true")}
          data-testid="preset-people-blocked">Outreach blocked</Button>
        {!assignmentFilterSupported && <span id="people-assignment-filter-support"
          className="text-sm text-muted-foreground self-center">Assigned-to-me filtering is unavailable for this role.</span>}
        <span className="text-sm text-muted-foreground self-center">URL presets only — no saved-filter writes.</span>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="overflow-x-auto">
              <Table className="min-w-[700px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Name</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-4 w-4 rounded" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-36" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : filteredContacts?.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center gap-3" data-testid="empty-contacts">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <Users className="w-6 h-6 text-muted-foreground" />
              </div>
              {searchTerm || activitySort || showArchived || statusFilter || recordClassFilter !== "production" || verticalFilter || tagFilter || leadSourceFilter || hasAssigneeOnly || churnRiskOnly || noOutreach24hOnly || blockedOnly || emailHealthFilter || assignedToMe || contactedTodayOnly || lifecycleFilter || staleContactsOnly || recentlyUpdated || neverContactedOnly || notContactedIn30Only || noDealOnly || createdThisWeekOnly ? (
                <>
                  <p className="text-sm font-medium text-foreground" data-testid="text-empty-contacts">No matching contacts</p>
                  <p className="text-xs text-muted-foreground max-w-xs">Adjust or clear the active filters to broaden this list.</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground" data-testid="text-empty-contacts">No contacts yet</p>
                  <p className="text-xs text-muted-foreground max-w-xs">Add your first contact to start tracking leads and customers.</p>
                  <Button size="sm" className="gap-1 mt-1" onClick={() => setIsDialogOpen(true)} data-testid="button-empty-add-contact">
                    <Plus className="w-3.5 h-3.5" /> Add Contact
                  </Button>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Page-only selection stays owned by this authorized directory. */}
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 text-sm text-muted-foreground" data-testid="contacts-select-all-bar">
                <Checkbox
                  checked={
                    (filteredContacts?.length ?? 0) > 0 &&
                    selectedIds.size === (filteredContacts?.length ?? 0)
                  }
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all contacts on this page"
                  data-testid="checkbox-select-all"
                />
                <span
                  className="cursor-pointer select-none"
                  onClick={toggleSelectAll}
                  data-testid="label-select-all"
                >
                  {selectedIds.size > 0 && selectedIds.size === (filteredContacts?.length ?? 0)
                    ? `All ${selectedIds.size} on this page selected`
                    : selectedIds.size > 0
                    ? `${selectedIds.size} selected`
                    : "Select all"}
                </span>
              </div>
              <CrmDataTable
                containerResponsive
               rows={sortedContacts ?? []}
              columns={[
                {
                  header: "",
                  className: "w-10 pr-0",
                  cell: (contact: any) => (
                    <Checkbox
                      checked={selectedIds.has(contact.id)}
                      onCheckedChange={() => {
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          if (next.has(contact.id)) next.delete(contact.id); else next.add(contact.id);
                          return next;
                        });
                      }}
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      data-testid={`checkbox-contact-${contact.id}`}
                      aria-label={`Select contact #${contact.id}`}
                    />
                  ),
                },
                {
                  header: "Name",
                  cell: (contact: any) => {
                    const isArchived = !!contact.archivedAt;
                    return (
                      <div className="flex items-center gap-2 flex-wrap font-medium">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                          {contact.firstName?.[0] ?? '?'}{contact.lastName?.[0] ?? ''}
                        </div>
                        <a href={`/dashboard/contacts/${contact.id}`} onClick={e=>e.stopPropagation()}
                          className={`inline-flex min-h-11 items-center text-foreground hover:underline ${isArchived ? "line-through" : ""}`}
                          data-testid={`link-contact-${contact.id}`}>{contact.firstName} {contact.lastName}</a>
                        {confirmationFailedMap.has(contact.id) && (
                          <Badge variant="destructive" className="text-xs gap-1 cursor-pointer no-default-hover-elevate no-default-active-elevate"
                            data-testid={`badge-confirmation-failed-${contact.id}`}
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); setLocation(`/dashboard/contacts/${contact.id}#confirmation-status`); }}
                            title="Confirmation failed — click to view details"
                          >
                            <AlertTriangle className="h-3 w-3" />Confirm Failed
                          </Badge>
                        )}
                        {(contact as any).isDecisionMaker && (
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400 shrink-0" aria-label="Decision Maker" data-testid={`badge-dm-star-${contact.id}`} />
                        )}
                        {/* #284 — Hot Lead badge for contacts with high score (#395 adds breakdown tooltip) */}
                        {(contact as any).leadScore >= 80 && (() => {
                          const sb = (contact as any).scoreBreakdown;
                          const tip = sb ? `Score: ${(contact as any).leadScore}\nRevenue: ${sb.revPotential?.score ?? "—"}/${sb.revPotential?.max ?? 30}\nSwitchability: ${sb.switchability?.score ?? "—"}/${sb.switchability?.max ?? 25}\nUW Confidence: ${sb.uwConfidence?.score ?? "—"}/${sb.uwConfidence?.max ?? 25}\nEngagement: ${sb.engagement?.score ?? "—"}/${sb.engagement?.max ?? 20}` : `Lead score: ${(contact as any).leadScore}`;
                          return (
                            <Badge className="text-[10px] px-1 py-0 h-4 bg-red-100 text-red-700 border-red-200 no-default-hover-elevate no-default-active-elevate" variant="outline" data-testid={`badge-hot-lead-${contact.id}`} title={tip}>
                              🔥 Hot
                            </Badge>
                          );
                        })()}
                        {/* #556 — Warm lead badge (score 50-79) */}
                        {(contact as any).leadScore >= 50 && (contact as any).leadScore < 80 && (() => {
                          const sb = (contact as any).scoreBreakdown;
                          const tip = sb ? `Score: ${(contact as any).leadScore}\nRevenue: ${sb.revPotential?.score ?? "—"}/${sb.revPotential?.max ?? 30}\nSwitchability: ${sb.switchability?.score ?? "—"}/${sb.switchability?.max ?? 25}\nUW Confidence: ${sb.uwConfidence?.score ?? "—"}/${sb.uwConfidence?.max ?? 25}\nEngagement: ${sb.engagement?.score ?? "—"}/${sb.engagement?.max ?? 20}` : `Lead score: ${(contact as any).leadScore}`;
                          return (
                            <Badge className="text-[10px] px-1 py-0 h-4 bg-amber-50 text-amber-700 border-amber-200 no-default-hover-elevate no-default-active-elevate" variant="outline" data-testid={`badge-warm-lead-${contact.id}`} title={tip}>
                              🌟 Warm
                            </Badge>
                          );
                        })()}
                        {/* #564 / #395 — Lead score for cool contacts (score 1-49) with breakdown tooltip */}
                        {(contact as any).leadScore != null && (contact as any).leadScore < 50 && (contact as any).leadScore > 0 && (() => {
                          const sb = (contact as any).scoreBreakdown;
                          const tip = sb ? `Score: ${(contact as any).leadScore}\nRevenue: ${sb.revPotential?.score ?? "—"}/${sb.revPotential?.max ?? 30}\nSwitchability: ${sb.switchability?.score ?? "—"}/${sb.switchability?.max ?? 25}\nUW Confidence: ${sb.uwConfidence?.score ?? "—"}/${sb.uwConfidence?.max ?? 25}\nEngagement: ${sb.engagement?.score ?? "—"}/${sb.engagement?.max ?? 20}` : `Lead score: ${(contact as any).leadScore}`;
                          return (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-slate-200 bg-slate-50 text-slate-600 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-lead-score-${contact.id}`} title={tip}>
                              {(contact as any).leadScore}
                            </Badge>
                          );
                        })()}
                        {contact.emailStatus && contact.emailStatus !== "active" && (
                          <span className={`text-xs px-1 py-0.5 rounded ${contact.emailStatus === "bounced" || contact.emailStatus === "invalid" ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" : "bg-slate-100 text-slate-600"}`} data-testid={`badge-email-status-${contact.id}`}>
                            {contact.emailStatus}
                          </span>
                        )}
                        {/* #430 — Lead source badge */}
                        {(contact as any).leadSource && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 py-0 h-4 border-slate-200 bg-slate-50 text-slate-600 no-default-hover-elevate no-default-active-elevate max-w-[60px] truncate"
                            data-testid={`badge-lead-source-${contact.id}`}
                            title={`Source: ${(contact as any).leadSource}`}
                          >
                            {((contact as any).leadSource as string).replace(/_/g, " ")}
                          </Badge>
                        )}
                        {/* #457 — LinkedIn enrichment badge */}
                        {(contact as any).linkedinEnrichedAt && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-blue-200 bg-blue-50 text-blue-700 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-enriched-${contact.id}`} title={`LinkedIn enriched ${new Date((contact as any).linkedinEnrichedAt).toLocaleDateString()}`}>
                            Li
                          </Badge>
                        )}
                        {isArchived && isManagerOrAdmin && (
                          <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-archived-contact-${contact.id}`}>
                            <Archive className="w-3 h-3 mr-1" /> Archived
                          </Badge>
                        )}
                      </div>
                    );
                  },
                },
                { header: "Company", accessorKey: "companyName" as const, hideOnMobile: true },
                { header: "Email", accessorKey: "email" as const, className: "text-muted-foreground text-sm", hideOnMobile: true },
                /* #448 — Phone column */
                { header: "Phone", accessorKey: "phone" as const, className: "text-muted-foreground text-sm", hideOnMobile: true },
                {
                  header: "Vertical",
                  hideOnMobile: true,
                  cell: (contact: any) => contact.vertical ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary" data-testid={`badge-vertical-${contact.id}`}>
                      {contact.vertical}
                    </span>
                  ) : <span className="text-muted-foreground/40 text-xs">—</span>,
                },
                {
                  header: "Tags",
                  hideOnMobile: true,
                  cell: (contact: any) => (
                    <div className="flex gap-1 flex-wrap">
                      {(contact.tags || []).slice(0, 2).map((tag: string) => (
                        <span key={tag} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-muted text-muted-foreground">{tag}</span>
                      ))}
                      {(contact.tags || []).length > 2 && <span className="text-xs text-muted-foreground">+{contact.tags.length - 2}</span>}
                    </div>
                  ),
                },
                {
                  header: "Status",
                  cell: (contact: any) => (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                      ${contact.status === 'New' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                        contact.status === 'Won' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                        contact.status === 'Contacted' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' :
                        'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'}`}>
                      {contact.status}
                    </span>
                  ),
                },
                {
                  header: "Last Activity",
                  hideOnMobile: true,
                  cell: (contact: any) => {
                    const d = (contact as any).lastActivityAt;
                    if (!d) return <span className="text-muted-foreground/40 text-xs" data-testid={`text-last-activity-${contact.id}`}>—</span>;
                    const diff = Date.now() - new Date(d).getTime();
                    const days = Math.floor(diff / 86400000);
                    const label = days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`;
                    return (
                      <span className={`text-xs ${days > 14 ? "text-muted-foreground" : ""}`} data-testid={`text-last-activity-${contact.id}`} title={new Date(d).toLocaleDateString()}>
                        {label}
                      </span>
                    );
                  },
                },
                {
                  // #503 — Last contacted date (separate from last activity)
                  header: "Last Contacted",
                  hideOnMobile: true,
                  cell: (contact: any) => {
                    const d = (contact as any).lastContactedAt;
                    if (!d) return <span className="text-muted-foreground/40 text-xs" data-testid={`text-last-contacted-${contact.id}`}>—</span>;
                    const diff = Date.now() - new Date(d).getTime();
                    const days = Math.floor(diff / 86400000);
                    const label = days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`;
                    return (
                      <span className={`text-xs ${days > 30 ? "text-destructive/70" : days > 14 ? "text-muted-foreground" : ""}`}
                        data-testid={`text-last-contacted-${contact.id}`} title={new Date(d).toLocaleDateString()}>
                        {label}
                      </span>
                    );
                  },
                },
                {
                  header: "Assigned Rep",
                  hideOnMobile: true,
                  cell: (contact: any) => isManagerOrAdmin && agentsList ? (
                    // #422 — Quick-assign Select for manager/admin
                    <select
                      value={contact.assignedTo || ""}
                      onChange={e => {
                        e.stopPropagation();
                        assignContactMutation.mutate({ id: contact.id, assignedTo: e.target.value || null });
                      }}
                      onClick={e => e.stopPropagation()}
                      data-testid={`select-assigned-rep-${contact.id}`}
                      aria-label={`Assigned representative for contact #${contact.id}`}
                      className="text-xs border border-border rounded px-1.5 py-0.5 bg-background text-foreground max-w-[120px]"
                    >
                      <option value="">Unassigned</option>
                      {agentsList.map(a => (
                        <option key={a.id} value={a.email}>
                          {a.firstName && a.lastName ? `${a.firstName} ${a.lastName}` : a.email.split("@")[0]}
                        </option>
                      ))}
                    </select>
                  ) : contact.assignedTo ? (
                    <span
                      className={`inline-flex items-center gap-1 text-xs ${contact.assignedTo === user?.email ? "text-primary font-medium" : "text-muted-foreground"}`}
                      data-testid={`text-assigned-rep-${contact.id}`}
                    >
                      <UserCheck className="h-3 w-3 shrink-0" />
                      {contact.assignedTo === user?.email ? "Me" : contact.assignedTo.split("@")[0]}
                    </span>
                  ) : <span className="text-muted-foreground/40 text-xs">—</span>,
                },
                {
                  header: "",
                  className: "text-right",
                  hideOnMobile: true,
                  cell: (contact: any) => {
                    const isArchived = !!contact.archivedAt;
                    return (
                      <div className="flex items-center justify-end gap-1" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                        {isArchived && (
                          <Button variant="ghost" size="icon" aria-label="Restore contact"
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); restoreContactMutation.mutate(contact.id); }}
                            data-testid={`button-restore-contact-${contact.id}`}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" aria-label="View contact"
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); setLocation(`/dashboard/contacts/${contact.id}`); }}
                          data-testid={`button-view-${contact.id}`}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="More actions"
                              onClick={(e: React.MouseEvent) => e.stopPropagation()} data-testid={`button-actions-${contact.id}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={(e: React.MouseEvent) => { e.stopPropagation(); updateContact.mutate({ id: contact.id, status: "Contacted" }); }}>
                              Mark Contacted
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e: React.MouseEvent) => { e.stopPropagation(); updateContact.mutate({ id: contact.id, status: "Won" }); }}>
                              Mark Won
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e: React.MouseEvent) => { e.stopPropagation(); updateContact.mutate({ id: contact.id, status: "Lost" }); }}>
                              Mark Lost
                            </DropdownMenuItem>
                            {/* #523 — Snooze contact (sets nextAllowedContactDate) */}
                            <DropdownMenuItem onClick={async (e: React.MouseEvent) => {
                              e.stopPropagation();
                              const daysStr = window.prompt("Snooze for how many days? (1–365)", "7");
                              const days = parseInt(daysStr || "", 10);
                              if (!days || days < 1 || days > 365) return;
                              try {
                                await apiRequest("PATCH", `/api/contacts/${contact.id}/snooze`, { days });
                                queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
                                toast({ title: `Contact snoozed for ${days} day${days === 1 ? "" : "s"}` });
                              } catch {
                                toast({ title: "Snooze failed", variant: "destructive" });
                              }
                            }} data-testid={`menu-snooze-contact-${contact.id}`}>
                              <BellOff className="w-4 h-4 mr-2" /> Snooze {(contact as any).nextAllowedContactDate ? "(active)" : ""}
                            </DropdownMenuItem>
                            {isManagerOrAdmin && (isArchived ? (
                              <DropdownMenuItem onClick={(e: React.MouseEvent) => { e.stopPropagation(); restoreContactMutation.mutate(contact.id); }} data-testid={`menu-restore-contact-${contact.id}`}>
                                <RotateCcw className="w-4 h-4 mr-2" /> Restore
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={(e: React.MouseEvent) => { e.stopPropagation();
                                if(window.confirm("Archive this contact? Existing history will be retained. You can restore it from the archived list.")) archiveContactMutation.mutate(contact.id);
                              }} data-testid={`menu-archive-contact-${contact.id}`}>
                                <Archive className="w-4 h-4 mr-2" /> Archive
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  },
                },
               ].map((column,index)=>({id:String(index),label:column.header,
                 render:(row:any)=>column.cell ? column.cell(row) : String(row[column.accessorKey!] ?? "—"),
                 headerClassName:column.className,cellClassName:column.className}))}
              onRowClick={(c: any) => setLocation(`/dashboard/contacts/${c.id}`)}
              mobileCard={(contact: any) => {
                const isArchived = !!contact.archivedAt;
                return (
                  <div className={`flex items-start gap-3 p-3 ${isArchived ? "opacity-50" : ""}`} data-testid={`contact-row-${contact.id}`}>
                    <Checkbox
                      checked={selectedIds.has(contact.id)}
                      onCheckedChange={() => {
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          if (next.has(contact.id)) next.delete(contact.id); else next.add(contact.id);
                          return next;
                        });
                      }}
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      className="mt-1 shrink-0"
                      data-testid={`checkbox-contact-mobile-${contact.id}`}
                      aria-label={`Select contact #${contact.id}`}
                    />
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                      {contact.firstName?.[0] ?? '?'}{contact.lastName?.[0] ?? ''}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <a href={`/dashboard/contacts/${contact.id}`} onClick={e=>e.stopPropagation()}
                          className={`inline-flex min-h-11 items-center font-medium text-sm text-foreground hover:underline ${isArchived ? "line-through" : ""}`}
                          data-testid={`link-contact-card-${contact.id}`}>{contact.firstName} {contact.lastName}</a>
                        {(contact as any).isDecisionMaker && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
                        {/* #542 — DNC flag */}
                        {(contact as any).doNotContact && (
                          <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-400" data-testid={`badge-dnc-${contact.id}`} title="Do Not Contact">⛔ DNC</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{contact.companyName}</div>
                      <div className="text-xs text-muted-foreground truncate">{contact.email}</div>
                    </div>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0
                      ${contact.status === 'New' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                        contact.status === 'Won' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                        contact.status === 'Contacted' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' :
                        'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'}`}>
                      {contact.status}
                    </span>
                  </div>
                );
              }}
               testId="contacts-table"
            />
            </>
          )}
        </CardContent>
        {
          <div className="flex items-center justify-between px-6 py-4 border-t" data-testid="contacts-pagination">
            <span className="text-sm text-muted-foreground" data-testid="text-contacts-total">
              {totalContacts != null
                ? `Showing ${contacts?.length ? page * pageSize + 1 : 0}–${Math.min(page * pageSize + (contacts?.length ?? 0), totalContacts)} of ${totalContacts.toLocaleString()}`
                : facetsError ? "Total unavailable" : "Loading total…"}
              {facetsResult?.asOf && <span className="block text-xs">As of {new Date(facetsResult.asOf).toLocaleTimeString()}</span>}
            </span>
            <div className="flex gap-2">
              <label className="flex items-center gap-2 text-sm">
                Per page
                <select value={pageSize} onChange={e => updatePeopleParam("limit", e.target.value)}
                  data-testid="select-people-page-size" aria-label="People per page" className="min-h-11 rounded-md border bg-background px-2">
                  {[25,50,100].map(size => <option value={size} key={size}>{size}</option>)}
                </select>
              </label>
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} data-testid="button-contacts-prev">
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={isLoading || (totalPages != null ? page >= totalPages - 1 : (contacts?.length ?? 0) < pageSize)} onClick={() => setPage(p => p + 1)} data-testid="button-contacts-next">
                Next
              </Button>
            </div>
          </div>
        }
      </Card>

      <DuplicateFinderDialog open={duplicatesOpen} onOpenChange={setDuplicatesOpen} />

      {/* #1784 — Hard-delete confirmation dialog */}
      <Dialog open={hardDeleteDialogOpen} onOpenChange={(v) => { if (!v) { setHardDeleteDialogOpen(false); setHardDeleteConfirmPhrase(""); } }}>
        <DialogContent data-testid="hard-delete-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <ShieldAlert className="h-5 w-5" />
              Permanently Delete Contacts
            </DialogTitle>
          </DialogHeader>
          {deletePreviewData && (
            <div className="space-y-4">
              <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 p-3 space-y-1">
                <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                  This action is permanent and cannot be undone.
                </p>
                <p className="text-xs text-red-600 dark:text-red-400">
                  All disposable FK data will be permanently removed. Protected contacts will be skipped.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center" data-testid="hard-delete-preview-counts">
                <div className="rounded-md border p-2">
                  <div className="text-lg font-bold text-foreground" data-testid="preview-count-selected">
                    {deletePreviewData.selected}
                  </div>
                  <div className="text-xs text-muted-foreground">Selected</div>
                </div>
                <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 p-2">
                  <div className="text-lg font-bold text-green-700 dark:text-green-400" data-testid="preview-count-eligible">
                    {deletePreviewData.eligibleCount}
                  </div>
                  <div className="text-xs text-green-600 dark:text-green-400">Will delete</div>
                </div>
                <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-2">
                  <div className="text-lg font-bold text-amber-700 dark:text-amber-400" data-testid="preview-count-blocked">
                    {deletePreviewData.blockedCount}
                  </div>
                  <div className="text-xs text-amber-600 dark:text-amber-400">Blocked</div>
                </div>
              </div>

              {deletePreviewData.blockedCount > 0 && (
                <div className="text-xs text-muted-foreground rounded-md border p-2 max-h-32 overflow-y-auto">
                  <p className="font-medium mb-1">Blocked contacts (skipped, not deleted):</p>
                  {deletePreviewData.blocked.slice(0, 10).map((b: any) => (
                    <div key={b.contactId} data-testid={`blocked-contact-${b.contactId}`}>
                      ID {b.contactId}: {b.reason}
                    </div>
                  ))}
                  {deletePreviewData.blocked.length > 10 && (
                    <div>…and {deletePreviewData.blocked.length - 10} more</div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Type <span className="font-mono text-red-600 dark:text-red-400" data-testid="text-confirm-phrase">
                    {deletePreviewData.confirmationPhrase}
                  </span> to confirm:
                </p>
                <Input
                  value={hardDeleteConfirmPhrase}
                  onChange={(e) => setHardDeleteConfirmPhrase(e.target.value)}
                  placeholder={deletePreviewData.confirmationPhrase}
                  className="font-mono border-red-300 focus-visible:ring-red-400"
                  data-testid="input-confirm-phrase"
                  disabled={isHardDeleting}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => { setHardDeleteDialogOpen(false); setHardDeleteConfirmPhrase(""); }}
                  disabled={isHardDeleting}
                  data-testid="button-hard-delete-cancel"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleHardDeleteExecute}
                  disabled={
                    isHardDeleting ||
                    hardDeleteConfirmPhrase.trim() !== deletePreviewData.confirmationPhrase ||
                    deletePreviewData.eligibleCount === 0
                  }
                  data-testid="button-hard-delete-confirm"
                >
                  {isHardDeleting ? (
                    "Deleting…"
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete {deletePreviewData.eligibleCount} contacts
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDialogOpen} onOpenChange={(open) => { setBulkDialogOpen(open); if (!open) setBulkResults(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle data-testid="text-bulk-dialog-title">
              {bulkChannel === "email" ? "Send Bulk Email" : "Send Bulk SMS"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground" data-testid="text-bulk-recipient-count">
              Sending to {selectedContacts.length} contact{selectedContacts.length !== 1 ? "s" : ""} via {bulkChannel}
            </p>

            {bulkChannel === "email" && (
              <div>
                <label className="text-sm font-medium">Subject</label>
                <Input
                  value={bulkSubject}
                  onChange={(e) => setBulkSubject(e.target.value)}
                  placeholder="Email subject line"
                  data-testid="input-bulk-subject"
                />
              </div>
            )}

            <div>
              <label className="text-sm font-medium">Message</label>
              <Textarea
                value={bulkMessage}
                onChange={(e) => setBulkMessage(e.target.value)}
                placeholder="Type your message here..."
                rows={5}
                data-testid="input-bulk-message"
              />
              <p className="text-xs text-muted-foreground mt-1" data-testid="text-template-hints">
                {"Available variables: {{firstName}}, {{lastName}}, {{companyName}}, {{email}}"}
              </p>
            </div>

            <p className="text-xs text-muted-foreground border-t pt-3" data-testid="text-compliance-disclaimer">
              By sending this message you confirm all recipients have opted in to receive communications. Contacts flagged as Do Not Contact or without SMS consent will be automatically skipped.
            </p>

            {bulkResults && (
              <div className="rounded-md border p-3 space-y-1" data-testid="bulk-results-summary">
                <p className="text-sm font-medium">Results</p>
                <div className="flex gap-4 text-sm">
                  <span className="text-green-600 dark:text-green-400" data-testid="text-bulk-sent">Sent: {bulkResults.sent}</span>
                  <span className="text-yellow-600 dark:text-yellow-400" data-testid="text-bulk-skipped">Skipped: {bulkResults.skipped}</span>
                  <span className="text-red-600 dark:text-red-400" data-testid="text-bulk-errors">Errors: {bulkResults.errors}</span>
                </div>
              </div>
            )}

      {/* #241 — Sticky mobile "Add Contact" FAB */}
      <div className="fixed bottom-6 right-6 z-40 sm:hidden" data-testid="fab-add-contact">
        <Button
          size="icon"
          className="h-14 w-14 rounded-full shadow-lg"
          onClick={() => setIsDialogOpen(true)}
          aria-label="Add Contact"
          data-testid="button-fab-add-contact"
        >
          <Plus className="h-6 w-6" />
        </Button>
      </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setBulkDialogOpen(false)} data-testid="button-bulk-cancel">
                {bulkResults ? "Close" : "Cancel"}
              </Button>
              {!bulkResults && (
                <Button
                  onClick={() => bulkSendMutation.mutate()}
                  disabled={!bulkMessage || bulkSendMutation.isPending}
                  data-testid="button-bulk-send"
                >
                  {bulkSendMutation.isPending ? "Sending..." : `Send ${bulkChannel === "email" ? "Email" : "SMS"}`}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </CrmPage>
  );
}
