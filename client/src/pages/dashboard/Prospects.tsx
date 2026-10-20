import { useState, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCrmQuery, useCrmActorIdentity } from "@/hooks/use-crm-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search, Sparkles, Loader2, UserPlus, Users, MoreVertical, RefreshCw, ChevronDown, PlayCircle, LayoutList } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import DashboardErrorState from "@/components/DashboardErrorState";
import type { Prospect, ProspectList } from "@shared/schema";

function getScoreBadgeClass(score: string | null | undefined) {
  switch (score) {
    case "hot":  return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800";
    case "warm": return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800";
    case "cold": return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800";
    default:     return "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/30 dark:text-gray-300 dark:border-gray-800";
  }
}

function getStatusBadgeClass(status: string | null | undefined) {
  switch (status) {
    case "enriched":    return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800";
    case "contacted":   return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800";
    case "qualified":   return "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800";
    case "do_not_contact": return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800";
    default:            return "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/30 dark:text-gray-300 dark:border-gray-800";
  }
}

function formatDate(date: string | Date | null | undefined) {
  if (!date) return "--";
  return new Date(date).toLocaleDateString();
}

const PAGE_SIZE = 50;

export default function Prospects() {
  const [searchInput, setSearchInput]     = useState("");
  const [searchTerm, setSearchTerm]       = useState("");
  const [selectedListId, setSelectedListId] = useState<string>("all");
  const [scoreSort, setScoreSort]         = useState<"none" | "asc" | "desc">("none");
  const [filterVertical, setFilterVertical] = useState<string>("all");
  const [filterScore, setFilterScore]     = useState<string>("all");
  const [page, setPage]                   = useState(0);

  // ── Bulk selection ─────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { toast } = useToast();
  const actorIdentity = useCrmActorIdentity();

  // Search is debounced and executed on the server across the whole table.
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // A filter, search, list or actor change resets the page and drops any
  // selection so a stale selection can never act on rows no longer in view.
  useEffect(() => {
    setPage(0);
    setSelectedIds(new Set());
  }, [searchTerm, selectedListId, filterVertical, filterScore, scoreSort, actorIdentity]);

  const prospectParams = new URLSearchParams();
  if (selectedListId !== "all") prospectParams.set("listId", selectedListId);
  if (searchTerm) prospectParams.set("search", searchTerm);
  if (filterVertical !== "all") prospectParams.set("vertical", filterVertical);
  if (filterScore !== "all") prospectParams.set("score", filterScore);
  if (scoreSort !== "none") prospectParams.set("scoreSort", scoreSort);
  prospectParams.set("limit", String(PAGE_SIZE));
  prospectParams.set("offset", String(page * PAGE_SIZE));

  const { data: prospectsResult, isLoading: prospectsLoading, isError: prospectsError, refetch: refetchProspects } =
    useCrmQuery<{ data: Prospect[]; total: number; limit: number; offset: number }>({
      queryKey: ["/api/prospects", prospectParams.toString()],
      queryFn: async ({ signal }) => {
        const res = await apiRequest("GET", `/api/prospects?${prospectParams.toString()}`, undefined, undefined, signal);
        return res.json();
      },
    });
  const prospects = prospectsResult?.data;
  const serverTotal = prospectsResult?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(serverTotal / PAGE_SIZE) - 1);
  useEffect(() => {
    // The filtered total can shrink between reads; never sit on an empty page past the end.
    if (prospectsResult && page > lastPage) setPage(lastPage);
  }, [prospectsResult, page, lastPage]);

  const { data: prospectLists } = useCrmQuery<ProspectList[]>({ queryKey: ["/api/prospect-lists"] });
  const { data: sequences = [] } = useCrmQuery<any[]>({ queryKey: ["/api/sequences"] });
  const { data: workflows = [] } = useCrmQuery<any[]>({ queryKey: ["/api/workflows"] });

  // Verticals come from the whole table, not only the loaded page.
  const { data: verticalsResult } = useCrmQuery<{ verticals: string[] }>({
    queryKey: ["/api/prospects/verticals", selectedListId],
    queryFn: async ({ signal }) => {
      const res = await apiRequest("GET", `/api/prospects/verticals${selectedListId !== "all" ? `?listId=${selectedListId}` : ""}`, undefined, undefined, signal);
      return res.json();
    },
  });
  const verticals = verticalsResult?.verticals ?? [];

  // ── Mutations ──────────────────────────────────────────────────────────────
  const enrichMutation = useMutation({
    mutationFn: async (prospectId: number) => {
      await apiRequest("POST", "/api/enrichment-jobs", { prospectId, idempotencyKey: crypto.randomUUID() });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: "Enrichment started", description: "The prospect is being enriched." });
    },
    onError: (error: Error) => {
      toast({ title: "Enrichment failed", description: error.message, variant: "destructive" });
    },
  });

  const bulkEnrichMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      // Enrich each selected prospect in sequence (uses existing endpoint)
      const results = await Promise.allSettled(
        ids.map(id => apiRequest("POST", "/api/enrichment-jobs", { prospectId: id, idempotencyKey: crypto.randomUUID() }))
      );
      const failed = results.filter(r => r.status === "rejected").length;
      return { queued: ids.length - failed, failed };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      setSelectedIds(new Set());
      toast({
        title: `${data.queued} prospects queued for enrichment`,
        description: data.failed > 0 ? `${data.failed} failed to queue.` : "Results will appear shortly.",
      });
    },
    onError: (err: Error) => toast({ title: "Bulk enrich failed", description: err.message, variant: "destructive" }),
  });

  const routeProspectsMutation = useMutation({
    mutationFn: async () => {
      const enrichedIds = prospects
        ?.filter(p => p.score && p.status !== "campaign_assigned" && p.status !== "converted" && p.status !== "do_not_contact")
        .map(p => p.id) || [];
      if (enrichedIds.length === 0) throw new Error("No eligible prospects to route");
      const res = await apiRequest("POST", "/api/ai/route-prospects-bulk", { prospectIds: enrichedIds });
      return res.json();
    },
    onSuccess: (data: { routed: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: `AI routed ${data.routed} prospects`, description: "Prospects matched to campaigns by vertical and score." });
    },
    onError: (err: Error) => {
      toast({ title: "AI routing failed", description: err.message, variant: "destructive" });
    },
  });

  const convertMutation = useMutation({
    mutationFn: async (prospectId: number) => {
      const res = await apiRequest("POST", `/api/prospects/${prospectId}/convert`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Prospect converted to contact", description: "Contact, deal, scoring, and routing all triggered." });
    },
    onError: (err: Error) => {
      toast({ title: "Conversion failed", description: err.message, variant: "destructive" });
    },
  });

  const batchConvertMutation = useMutation({
    mutationFn: async () => {
      const hotIds = prospects
        ?.filter(p => (p.score === "hot" || p.qualificationScore === "A") && p.status !== "converted" && !p.contactId)
        .map(p => p.id) || [];
      if (hotIds.length === 0) throw new Error("No hot/A-scored prospects to convert");
      const res = await apiRequest("POST", "/api/prospects/convert-batch", { prospectIds: hotIds });
      return res.json();
    },
    onSuccess: (data: { converted: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: `${data.converted} prospects converted`, description: "All converted to contacts with deals, scoring, and sequence enrollment." });
    },
    onError: (err: Error) => {
      toast({ title: "Batch conversion failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Page-loaded counts ─────────────────────────────────────────────────────
  // Search, filters and sort are applied by the server; these tallies describe
  // only the rows currently loaded on this page and are labeled as such.
  const filteredProspects = prospects;
  const totalCount   = serverTotal;
  const pageCount    = prospects?.length || 0;
  const enrichedCount = filteredProspects?.filter((p) => p.status === "enriched").length || 0;
  const hotCount     = filteredProspects?.filter((p) => p.score === "hot").length || 0;
  const warmCount    = filteredProspects?.filter((p) => p.score === "warm").length || 0;
  const coldCount    = filteredProspects?.filter((p) => p.score === "cold").length || 0;
  const pageStart    = serverTotal === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd      = page * PAGE_SIZE + pageCount;

  const selectedProspectsWithContact = (prospects || []).filter(p => selectedIds.has(p.id) && p.contactId);

  const enrollSequenceMutation = useMutation({
    mutationFn: async (sequenceId: number) => {
      const promises = selectedProspectsWithContact.map((p) =>
        apiRequest("POST", "/api/sequence-enrollments", { sequenceId, contactId: p.contactId, status: "active" })
      );
      return Promise.all(promises);
    },
    onSuccess: () => {
      toast({ title: "Enrolled", description: "Selected prospects enrolled in sequence." });
      setSelectedIds(new Set());
    },
    onError: (err: Error) => toast({ title: "Enrollment failed", description: err.message, variant: "destructive" }),
  });

  const addToWorkflowMutation = useMutation({
    mutationFn: async (workflowId: number) => {
      const selected = (prospects || []).filter(p => selectedIds.has(p.id));
      const promises = selected.map((p) =>
        apiRequest("POST", `/api/workflows/${workflowId}/run`, { entityType: "prospect", entityId: p.id })
      );
      return Promise.all(promises);
    },
    onSuccess: () => {
      toast({ title: "Workflow started", description: "Selected prospects added to workflow." });
      setSelectedIds(new Set());
    },
    onError: (err: Error) => toast({ title: "Workflow error", description: err.message, variant: "destructive" }),
  });

  // ── Bulk selection helpers ─────────────────────────────────────────────────
  const allPageSelected = (filteredProspects?.length || 0) > 0 && (filteredProspects || []).every(p => selectedIds.has(p.id));
  const someSelected    = selectedIds.size > 0;

  const toggleAll = useCallback(() => {
    if (allPageSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        (filteredProspects || []).forEach(p => next.delete(p.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        (filteredProspects || []).forEach(p => next.add(p.id));
        return next;
      });
    }
  }, [filteredProspects, allPageSelected]);

  const toggleOne = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  if (prospectsError) {
    return <DashboardErrorState title="Failed to load prospects" onRetry={() => refetchProspects()} />;
  }

  return (
    <div className="space-y-6">
      {/* ── Stats ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <Card><CardContent className="p-4">
          <div className="text-sm text-muted-foreground" data-testid="label-total-prospects">Total matching (all pages)</div>
          <div className="text-2xl font-bold" data-testid="count-total-prospects">{totalCount}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-sm text-muted-foreground" data-testid="label-enriched-count">Enriched (this page)</div>
          <div className="text-2xl font-bold" data-testid="count-enriched">{enrichedCount}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-sm text-muted-foreground" data-testid="label-hot-count">Hot (this page)</div>
          <div className="text-2xl font-bold text-red-600 dark:text-red-400" data-testid="count-hot">{hotCount}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-sm text-muted-foreground" data-testid="label-warm-count">Warm (this page)</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="count-warm">{warmCount}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-sm text-muted-foreground" data-testid="label-cold-count">Cold (this page)</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400" data-testid="count-cold">{coldCount}</div>
        </CardContent></Card>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="text-prospects-scope" role="note">
        Source Prospects (staging records from imports and discovery), read from the server with its filtered total.
        Totals count every matching row; Enriched/Hot/Warm/Cold count only the {pageCount} rows on this page.
      </p>

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3 flex-wrap items-end">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by company, email, or owner…"
            className="pl-9"
            value={searchInput}
            aria-label="Search source prospects"
            onChange={(e) => setSearchInput(e.target.value)}
            data-testid="input-search-prospects"
          />
        </div>

        <Select value={selectedListId} onValueChange={setSelectedListId}>
          <SelectTrigger className="w-full sm:w-56" data-testid="select-prospect-list">
            <SelectValue placeholder="All Lists" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" data-testid="select-item-all-lists">All Lists</SelectItem>
            {prospectLists?.map((list) => (
              <SelectItem key={list.id} value={String(list.id)} data-testid={`select-item-list-${list.id}`}>
                {list.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterVertical} onValueChange={setFilterVertical}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="All verticals" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All verticals</SelectItem>
            {verticals.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filterScore} onValueChange={setFilterScore}>
          <SelectTrigger className="w-full sm:w-36">
            <SelectValue placeholder="All scores" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scores</SelectItem>
            <SelectItem value="hot">Hot</SelectItem>
            <SelectItem value="warm">Warm</SelectItem>
            <SelectItem value="cold">Cold</SelectItem>
          </SelectContent>
        </Select>

        <Select value={scoreSort} onValueChange={(v) => setScoreSort(v as "none" | "asc" | "desc")} data-testid="select-score-sort">
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Sort by score" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Default order</SelectItem>
            <SelectItem value="desc">Score: High → Low</SelectItem>
            <SelectItem value="asc">Score: Low → High</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          data-testid="button-ai-route-prospects"
          className="gap-2 shrink-0"
          onClick={() => routeProspectsMutation.mutate()}
          disabled={routeProspectsMutation.isPending}
        >
          {routeProspectsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          AI Route (this page)
        </Button>

        <Button
          data-testid="button-batch-convert"
          className="gap-2 shrink-0"
          onClick={() => batchConvertMutation.mutate()}
          disabled={batchConvertMutation.isPending}
        >
          {batchConvertMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
          Convert Hot Leads (this page)
        </Button>
      </div>

      {/* ── Bulk action bar (shown when something is selected) ────────────── */}
      {someSelected && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
          <Checkbox
            checked={allPageSelected}
            onCheckedChange={toggleAll}
            className="shrink-0"
          />
          <span className="text-sm font-medium text-blue-800 dark:text-blue-300">
            {selectedIds.size} prospect{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <Button
            size="sm"
            variant="default"
            className="gap-1.5 h-8"
            onClick={() => bulkEnrichMutation.mutate([...selectedIds])}
            disabled={bulkEnrichMutation.isPending}
          >
            {bulkEnrichMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Enrich Selected ({selectedIds.size})
          </Button>
          {selectedProspectsWithContact.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5 h-8" disabled={enrollSequenceMutation.isPending} data-testid="button-enroll-sequence">
                  {enrollSequenceMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
                  Enroll in Sequence
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {sequences.length === 0 ? (
                  <DropdownMenuItem disabled>No sequences available</DropdownMenuItem>
                ) : (
                  sequences.map((seq: any) => (
                    <DropdownMenuItem key={seq.id} onClick={() => enrollSequenceMutation.mutate(seq.id)} data-testid={`menu-sequence-${seq.id}`}>
                      {seq.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5 h-8" disabled={addToWorkflowMutation.isPending} data-testid="button-add-workflow">
                {addToWorkflowMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LayoutList className="h-3.5 w-3.5" />}
                Add to Workflow
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {workflows.length === 0 ? (
                <DropdownMenuItem disabled>No workflows available</DropdownMenuItem>
              ) : (
                workflows.map((wf: any) => (
                  <DropdownMenuItem key={wf.id} onClick={() => addToWorkflowMutation.mutate(wf.id)} data-testid={`menu-workflow-${wf.id}`}>
                    {wf.name}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm" variant="ghost" className="h-8 text-muted-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                    data-testid="checkbox-select-all-prospects"
                  />
                </TableHead>
                <TableHead>Company Name</TableHead>
                <TableHead>Owner Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Contacted</TableHead>
                <TableHead className="text-right w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prospectsLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i} data-testid={`skeleton-row-${i}`}>
                    {Array.from({ length: 10 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filteredProspects?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center h-24 text-muted-foreground" data-testid="text-no-prospects">
                    No prospects found
                  </TableCell>
                </TableRow>
              ) : (
                filteredProspects?.map((prospect) => (
                  <TableRow
                    key={prospect.id}
                    data-testid={`row-prospect-${prospect.id}`}
                    className={selectedIds.has(prospect.id) ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(prospect.id)}
                        onCheckedChange={() => toggleOne(prospect.id)}
                        aria-label={`Select ${prospect.companyName}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium" data-testid={`text-company-${prospect.id}`}>
                      <div className="flex items-center gap-1.5">
                        {prospect.companyName || "--"}
                        {(prospect as any).linkedinEnrichedAt && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-blue-200 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300" data-testid={`badge-li-${prospect.id}`} title="LinkedIn enriched">Li</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell data-testid={`text-owner-${prospect.id}`}>
                      {[prospect.ownerFirstName, prospect.ownerLastName].filter(Boolean).join(" ") || <span className="text-muted-foreground text-xs">--</span>}
                    </TableCell>
                    <TableCell data-testid={`text-email-${prospect.id}`}>
                      {prospect.email
                        ? <a href={`mailto:${prospect.email}`} className="text-blue-600 hover:underline text-sm">{prospect.email}</a>
                        : <span className="text-muted-foreground text-xs">--</span>
                      }
                    </TableCell>
                    <TableCell data-testid={`text-phone-${prospect.id}`}>
                      {prospect.phone
                        ? <a href={`tel:${prospect.phone}`} className="text-blue-600 hover:underline text-sm">{prospect.phone}</a>
                        : <span className="text-muted-foreground text-xs">--</span>
                      }
                    </TableCell>
                    <TableCell data-testid={`text-vertical-${prospect.id}`}>
                      {prospect.vertical
                        ? <Badge variant="outline" className="text-[10px] px-1.5">{prospect.vertical}</Badge>
                        : <span className="text-muted-foreground text-xs">--</span>
                      }
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge
                          variant="outline"
                          className={`no-default-hover-elevate no-default-active-elevate ${getScoreBadgeClass(prospect.score)}`}
                          data-testid={`badge-score-${prospect.id}`}
                        >
                          {prospect.score || "unqualified"}
                        </Badge>
                        {(prospect.score === "hot" || prospect.score === "warm") &&
                          !prospect.phone &&
                          (!prospect.email || prospect.email.includes("placeholder.com")) && (
                          <Badge
                            variant="outline"
                            className="no-default-hover-elevate no-default-active-elevate text-amber-600 border-amber-400 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-700 text-[10px]"
                            data-testid={`badge-not-contactable-${prospect.id}`}
                          >
                            Not contactable yet
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`no-default-hover-elevate no-default-active-elevate ${getStatusBadgeClass(prospect.status)}`}
                        data-testid={`badge-status-${prospect.id}`}
                      >
                        {prospect.status || "raw"}
                      </Badge>
                    </TableCell>
                    <TableCell data-testid={`text-last-contacted-${prospect.id}`}>
                      {formatDate(prospect.lastContactedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost" size="icon"
                          onClick={() => enrichMutation.mutate(prospect.id)}
                          disabled={enrichMutation.isPending}
                          aria-label="Enrich prospect"
                          data-testid={`button-enrich-${prospect.id}`}
                          title="Re-enrich"
                        >
                          <Sparkles className="h-4 w-4" />
                        </Button>
                        {prospect.status !== "converted" && !prospect.contactId && (
                          <Button
                            variant="ghost" size="icon"
                            onClick={() => convertMutation.mutate(prospect.id)}
                            disabled={convertMutation.isPending}
                            aria-label="Convert to contact"
                            data-testid={`button-convert-${prospect.id}`}
                            title="Convert to contact"
                          >
                            <UserPlus className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Source prospect pages" data-testid="prospects-pagination">
        <span className="text-sm text-muted-foreground" data-testid="text-prospects-range">
          {serverTotal === 0 ? "No matching prospects" : `Showing ${pageStart}–${pageEnd} of ${serverTotal} matching`}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={page <= 0 || prospectsLoading} onClick={() => { setPage(page - 1); setSelectedIds(new Set()); }} data-testid="button-prospects-prev">Previous</Button>
          <span className="text-sm">Page {page + 1} of {lastPage + 1}</span>
          <Button variant="outline" disabled={page >= lastPage || prospectsLoading} onClick={() => { setPage(page + 1); setSelectedIds(new Set()); }} data-testid="button-prospects-next">Next</Button>
        </div>
      </nav>
    </div>
  );
}
