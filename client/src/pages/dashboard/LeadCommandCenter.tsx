import { PageTitle } from "@/components/ui/page-header";
import { useState, useCallback, useMemo, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { DataState } from "@/components/ui/data-state";
import {
  Search, Upload, Sparkles, Loader2, ArrowRightLeft, UserPlus,
  Mail, Phone, Globe, CheckCircle2, Clock, XCircle, Brain,
  ChevronDown, ChevronRight, Zap, Users, PlayCircle, LayoutList, Target,
  TrendingUp, AlertCircle, MapPin, Building2, FileText, DollarSign,
  ChevronLeft, ChevronsLeft, ChevronsRight, Tag,
} from "lucide-react";
import type { SunbizEntity, Prospect } from "@shared/schema";
import type { OutreachStatus } from "@/types/outreach-status";
import { KpiBreakdownPopover, type KpiBreakdownPopoverProps } from "@/components/ui/kpi-breakdown-popover";
import { fmtN } from "@/lib/format";
import LeadIntelligence from "./LeadIntelligence";

type UnifiedRow = {
  id: string;
  source: "sunbiz" | "prospect";
  rawId: number;
  name: string;
  owner: string;
  email: string;
  phone: string;
  website: string;
  city: string;
  state: string;
  zip: string;
  address: string;
  vertical: string;
  score: string;
  enrichmentStatus: string;
  qualificationScore: string;
  estimatedResidual: string;
  contactId: number | null;
  prospectStatus: string;
  dba: string;
  filingNumber: string;
  entityType: string;
  aiSummary: string;
  tags: string[];
  ownerEmail: string;
  ownerPhone: string;
  notes: string;
  estimatedVolume: string;
  estimatedAvgTicket: string;
  enrichedAt: string;
};

function toUnifiedRows(entities: SunbizEntity[], prospects: Prospect[]): UnifiedRow[] {
  const eRows: UnifiedRow[] = entities.map((e) => ({
    id: `e-${e.id}`,
    source: "sunbiz" as const,
    rawId: e.id,
    name: e.entityName || "",
    owner: e.ownerName || "",
    email: e.email || e.ownerEmail || "",
    phone: e.phone || e.ownerPhone || "",
    website: e.website || "",
    city: e.principalCity || "",
    state: e.principalState || "",
    zip: e.principalZip || "",
    address: e.principalAddress || "",
    vertical: e.vertical || "",
    score: e.score || "raw",
    enrichmentStatus: e.enrichmentStatus || "pending",
    qualificationScore: "--",
    estimatedResidual: "--",
    contactId: null,
    prospectStatus: "",
    dba: e.dba || "",
    filingNumber: e.filingNumber || "",
    entityType: e.entityType || "",
    aiSummary: e.aiSummary || "",
    tags: e.tags || [],
    ownerEmail: e.ownerEmail || "",
    ownerPhone: e.ownerPhone || "",
    notes: e.notes || "",
    estimatedVolume: "",
    estimatedAvgTicket: "",
    enrichedAt: e.enrichedAt ? String(e.enrichedAt) : "",
  }));
  const pRows: UnifiedRow[] = prospects
    .filter((p) => p.status !== "converted")
    .map((p) => ({
      id: `p-${p.id}`,
      source: "prospect" as const,
      rawId: p.id,
      name: p.companyName || "",
      owner: [p.ownerFirstName, p.ownerLastName].filter(Boolean).join(" "),
      email: p.email || p.ownerEmail || "",
      phone: p.phone || p.ownerPhone || "",
      website: p.website || "",
      city: p.city || "",
      state: p.state || "",
      zip: p.zip || "",
      address: p.address || "",
      vertical: p.vertical || "",
      score: p.score || "cold",
      enrichmentStatus: p.status === "enriched" || p.status === "qualified" ? "enriched" : p.status === "enriching" ? "processing" : "pending",
      qualificationScore: p.qualificationScore || "--",
      estimatedResidual: p.estimatedResidual || "--",
      contactId: p.contactId ?? null,
      prospectStatus: p.status || "raw",
      dba: p.dba || "",
      filingNumber: "",
      entityType: "",
      aiSummary: p.aiSummary || "",
      tags: p.tags || [],
      ownerEmail: p.ownerEmail || "",
      ownerPhone: p.ownerPhone || "",
      notes: p.notes || "",
      estimatedVolume: p.estimatedVolume || "",
      estimatedAvgTicket: p.estimatedAvgTicket ? String(p.estimatedAvgTicket) : "",
      enrichedAt: p.enrichedAt ? String(p.enrichedAt) : "",
    }));
  return [...eRows, ...pRows];
}

function getScoreVariant(score: string) {
  switch (score) {
    case "hot": return "destructive" as const;
    case "warm": return "default" as const;
    case "cold": return "secondary" as const;
    default: return "outline" as const;
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case "enriched": return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case "processing": return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
    case "failed": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    default: return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function filterRows(rows: UnifiedRow[], search: string, scoreFilter: string, statusFilter: string, sourceFilter: string) {
  return rows.filter((r) => {
    if (search) {
      const t = search.toLowerCase();
      if (!r.name.toLowerCase().includes(t) && !r.owner.toLowerCase().includes(t) && !r.email.toLowerCase().includes(t) && !r.city.toLowerCase().includes(t) && !r.vertical.toLowerCase().includes(t) && !r.dba.toLowerCase().includes(t)) return false;
    }
    if (scoreFilter !== "all" && r.score !== scoreFilter) return false;
    if (statusFilter !== "all" && r.enrichmentStatus !== statusFilter) return false;
    if (sourceFilter === "quiz_lead") {
      if (!r.tags.some(t => t === "quiz_lead_linked" || t === "lead_free_analysis" || t === "src_quiz")) return false;
    } else if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
    return true;
  });
}

const PAGE_SIZE = 25;

function DetailRow({ row }: { row: UnifiedRow }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 text-sm" data-testid={`detail-${row.id}`}>
      <div className="space-y-3">
        <h4 className="font-semibold flex items-center gap-1.5">
          <Building2 className="h-4 w-4" /> Company Details
        </h4>
        <div className="space-y-1.5 text-muted-foreground">
          <div className="flex items-start gap-2">
            <span className="font-medium text-foreground min-w-[80px]">Name:</span>
            <span>{row.name || "--"}</span>
          </div>
          {row.dba && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">DBA:</span>
              <span>{row.dba}</span>
            </div>
          )}
          {row.filingNumber && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Filing #:</span>
              <span>{row.filingNumber}</span>
            </div>
          )}
          {row.entityType && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Type:</span>
              <span>{row.entityType}</span>
            </div>
          )}
          {row.vertical && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Industry:</span>
              <Badge variant="outline" className="text-xs">{row.vertical}</Badge>
            </div>
          )}
          {row.website && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Website:</span>
              <a href={row.website.startsWith("http") ? row.website : `https://${row.website}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 underline truncate max-w-[200px]">{row.website}</a>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="font-semibold flex items-center gap-1.5">
          <Users className="h-4 w-4" /> Contact & Location
        </h4>
        <div className="space-y-1.5 text-muted-foreground">
          {row.owner && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Owner:</span>
              <span>{row.owner}</span>
            </div>
          )}
          {row.email && (
            <div className="flex items-start gap-2">
              <Mail className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="break-all">{row.email}</span>
            </div>
          )}
          {row.ownerEmail && row.ownerEmail !== row.email && (
            <div className="flex items-start gap-2">
              <Mail className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="break-all">{row.ownerEmail} (owner)</span>
            </div>
          )}
          {row.phone && (
            <div className="flex items-start gap-2">
              <Phone className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{row.phone}</span>
            </div>
          )}
          {row.ownerPhone && row.ownerPhone !== row.phone && (
            <div className="flex items-start gap-2">
              <Phone className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{row.ownerPhone} (owner)</span>
            </div>
          )}
          {(row.address || row.city) && (
            <div className="flex items-start gap-2">
              <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{[row.address, row.city, row.state, row.zip].filter(Boolean).join(", ")}</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="font-semibold flex items-center gap-1.5">
          <Brain className="h-4 w-4" /> Intelligence & Scoring
        </h4>
        <div className="space-y-1.5 text-muted-foreground">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground min-w-[80px]">Score:</span>
            <Badge variant={getScoreVariant(row.score)}>{row.score}</Badge>
            {row.qualificationScore !== "--" && (
              <Badge variant="outline">Grade {row.qualificationScore}</Badge>
            )}
          </div>
          {row.estimatedVolume && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Volume:</span>
              <span>{row.estimatedVolume}</span>
            </div>
          )}
          {row.estimatedResidual !== "--" && (
            <div className="flex items-start gap-2">
              <DollarSign className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>Est. Residual: {row.estimatedResidual}</span>
            </div>
          )}
          {row.estimatedAvgTicket && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Avg Ticket:</span>
              <span>${row.estimatedAvgTicket}</span>
            </div>
          )}
          {row.enrichedAt && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-foreground min-w-[80px]">Enriched:</span>
              <span>{new Date(row.enrichedAt).toLocaleDateString()}</span>
            </div>
          )}
          {(row.tags?.length ?? 0) > 0 && (
            <div className="flex items-start gap-2 flex-wrap">
              <Tag className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {row.tags.map((t, i) => (
                <Badge key={i} variant="outline" className="text-xs">{t}</Badge>
              ))}
            </div>
          )}
        </div>
        {row.aiSummary && (
          <div className="mt-2">
            <h4 className="font-semibold flex items-center gap-1.5 mb-1">
              <FileText className="h-4 w-4" /> AI Summary
            </h4>
            <p className="text-xs leading-relaxed bg-muted/50 rounded-md p-2">{row.aiSummary}</p>
          </div>
        )}
        {row.notes && !row.aiSummary && (
          <div className="mt-2">
            <h4 className="font-semibold flex items-center gap-1.5 mb-1">
              <FileText className="h-4 w-4" /> Notes
            </h4>
            <p className="text-xs leading-relaxed bg-muted/50 rounded-md p-2">{row.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LeadCommandCenter() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [filterScore, setFilterScore] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterSource, setFilterSource] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState("queue");
  const [currentPage, setCurrentPage] = useState(1);
  const [pipelinePage, setPipelinePage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Server-side pagination for sunbiz entities (2M+ records — must paginate server-side)
  const ENTITY_PAGE_SIZE = 100;
  const [entityPage, setEntityPage] = useState(1);

  const {
    data: entitiesPage,
    isLoading: entitiesLoading,
    isError: entitiesError,
    error: entitiesErrorObj,
    refetch: refetchEntities,
  } = useQuery<{ data: SunbizEntity[]; total: number; limit: number; offset: number }>({
    queryKey: ["/api/sunbiz/entities", entityPage],
    queryFn: async () => {
      const offset = (entityPage - 1) * ENTITY_PAGE_SIZE;
      const res = await fetch(`/api/sunbiz/entities?limit=${ENTITY_PAGE_SIZE}&offset=${offset}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });
  const { data: stats } = useQuery<{ total: number; enriched: number; pending: number; withEmail: number; withPhone: number; withWebsite: number; withContactInfo: number }>({ queryKey: ["/api/sunbiz/stats"] });
  const {
    data: prospectsRaw,
    isLoading: prospectsLoading,
    isError: prospectsError,
    error: prospectsErrorObj,
    refetch: refetchProspects,
  } = useQuery<Prospect[]>({ queryKey: ["/api/prospects"] });
  const { data: sequencesRaw = [] } = useQuery<any[]>({ queryKey: ["/api/sequences"] });
  const { data: workflowsRaw = [] } = useQuery<any[]>({ queryKey: ["/api/workflows"] });
  const { data: outreachStatus, isLoading: outreachStatusLoading } = useQuery<OutreachStatus>({ queryKey: ["/api/outreach/status"], staleTime: 60_000 });

  const entities = entitiesPage?.data ?? [];
  const entityTotal = entitiesPage?.total ?? 0;
  const entityTotalPages = Math.max(1, Math.ceil(entityTotal / ENTITY_PAGE_SIZE));
  const prospects = Array.isArray(prospectsRaw) ? prospectsRaw : [];
  const sequences = Array.isArray(sequencesRaw) ? sequencesRaw : [];
  const workflows = Array.isArray(workflowsRaw) ? workflowsRaw : [];

  const isLoading = entitiesLoading || prospectsLoading;
  const isError = entitiesError || prospectsError;
  const combinedError = entitiesErrorObj || prospectsErrorObj;
  const refetchAll = () => {
    refetchEntities();
    refetchProspects();
  };

  const allRows = useMemo(() => toUnifiedRows(entities, prospects), [entities, prospects]);
  const filteredQueue = useMemo(() => filterRows(allRows, searchTerm, filterScore, filterStatus, filterSource), [allRows, searchTerm, filterScore, filterStatus, filterSource]);

  const totalPages = Math.max(1, Math.ceil(filteredQueue.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedQueue = useMemo(() => filteredQueue.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filteredQueue, safePage]);

  const qualifiedRows = useMemo(() => {
    return allRows.filter((r) => {
      if (r.source !== "prospect") return false;
      const isHotWarm = r.score === "hot" || r.score === "warm";
      const isGoodGrade = r.qualificationScore === "A" || r.qualificationScore === "B";
      const isQualifiedStatus = r.prospectStatus === "qualified" || r.prospectStatus === "enriched";
      return (isHotWarm && isGoodGrade) || (isQualifiedStatus && isGoodGrade);
    });
  }, [allRows]);

  const pipelineTotalPages = Math.max(1, Math.ceil(qualifiedRows.length / PAGE_SIZE));
  const safePipelinePage = Math.min(pipelinePage, pipelineTotalPages);
  const paginatedPipeline = useMemo(() => qualifiedRows.slice((safePipelinePage - 1) * PAGE_SIZE, safePipelinePage * PAGE_SIZE), [qualifiedRows, safePipelinePage]);

  const kpis = useMemo(() => {
    const totalLeads = (outreachStatus?.entities?.total || 0) + (outreachStatus?.prospects?.total || 0) + (outreachStatus?.contacts?.total || 0);
    const pendingEnrichment = stats?.pending || 0;
    const enriched = (stats?.enriched || 0) + prospects.filter((p) => p.status === "enriched" || p.status === "qualified").length;
    const hotLeads = (outreachStatus?.entities?.hot || 0) + (outreachStatus?.prospects?.hot || 0) + (outreachStatus?.contacts?.hot || 0);
    const warmLeads = (outreachStatus?.entities?.warm || 0) + (outreachStatus?.prospects?.warm || 0) + (outreachStatus?.contacts?.warm || 0);
    const converted = outreachStatus?.prospects?.converted ?? prospects.filter((p) => p.status === "converted").length;
    const crmWithContactInfo = outreachStatus?.contacts?.withContactInfo ?? 0;
    return { totalLeads, pendingEnrichment, enriched, hotLeads, warmLeads, converted, crmWithContactInfo };
  }, [stats, prospects, outreachStatus]);

  const selectedEntities = useMemo(() => Array.from(selectedIds).filter((id) => id.startsWith("e-")).map((id) => parseInt(id.slice(2))), [selectedIds]);
  const selectedProspects = useMemo(() => Array.from(selectedIds).filter((id) => id.startsWith("p-")).map((id) => parseInt(id.slice(2))), [selectedIds]);
  const selectedProspectsWithContact = useMemo(() => {
    return allRows.filter((r) => selectedIds.has(r.id) && r.source === "prospect" && r.contactId).map((r) => ({ prospectId: r.rawId, contactId: r.contactId! }));
  }, [selectedIds, allRows]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/entities", entityPage] });
    queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
  };

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch("/api/sunbiz/upload", { method: "POST", body: formData, headers, credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => { toast({ title: "Upload Complete", description: `Imported ${data.imported} entities.` }); invalidateAll(); },
    onError: (err: any) => { toast({ title: "Upload Failed", description: err.message, variant: "destructive" }); },
  });

  const corevtUploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch("/api/sunbiz/upload-corevt", { method: "POST", body: formData, headers, credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => { toast({ title: "Import Complete", description: `Imported ${data.imported} entities from state filing data.` }); invalidateAll(); },
    onError: (err: any) => { toast({ title: "Import Failed", description: err.message, variant: "destructive" }); },
  });

  const convertToProspectsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sunbiz/convert-batch", { entityIds: selectedEntities });
      return res.json();
    },
    onSuccess: (data) => { toast({ title: "Converted", description: `${data.converted} entities pushed to prospects.` }); invalidateAll(); setSelectedIds(new Set()); },
    onError: (err: any) => { toast({ title: "Error", description: err.message, variant: "destructive" }); },
  });

  const convertToContactsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/prospects/convert-batch", { prospectIds: selectedProspects });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Converted", description: `${data.converted} prospects converted to contacts.` });
      invalidateAll();
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      setSelectedIds(new Set());
    },
    onError: (err: any) => { toast({ title: "Error", description: err.message, variant: "destructive" }); },
  });

  const aiRouteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await apiRequest("POST", "/api/ai/route-prospects-bulk", { prospectIds: ids });
      return res.json();
    },
    onSuccess: (data) => { toast({ title: "AI Routing Complete", description: `Routed ${data.routed} prospects to campaigns.` }); invalidateAll(); setSelectedIds(new Set()); },
    onError: (err: any) => { toast({ title: "Routing Error", description: err.message, variant: "destructive" }); },
  });

  // Direct sequence-enrollment and arbitrary workflow-run loops were retired
  // for this legacy fallback page (#1963) — this component only renders for
  // non-admin/manager roles via LegacyLeadCommandCenterRedirect in App.tsx.
  // Use the governed bulk-enrollment flow on Lead Ops / Sequences instead.

  const handleFileUpload = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const formData = new FormData();
    formData.append("file", file);
    const isZip = file.name.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
    if (isZip || file.name.toLowerCase().includes("corevt")) {
      formData.append("listName", `Corevt Import ${new Date().toLocaleDateString()}`);
      formData.append("maxRecords", "10000");
      formData.append("onlyWithAddress", "true");
      corevtUploadMutation.mutate(formData);
    } else {
      formData.append("listName", `Sunbiz Import ${new Date().toLocaleDateString()}`);
      uploadMutation.mutate(formData);
    }
  }, [uploadMutation, corevtUploadMutation]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileUpload(e.dataTransfer.files);
  }, [handleFileUpload]);

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = (rows: UnifiedRow[]) => {
    const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
    if (allSelected) {
      const next = new Set(selectedIds);
      rows.forEach((r) => next.delete(r.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      rows.forEach((r) => next.add(r.id));
      setSelectedIds(next);
    }
  };

  const toggleExpanded = (id: string) => {
    const next = new Set(expandedRows);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedRows(next);
  };

  const renderPagination = (page: number, total: number, setPage: (p: number) => void, rowCount: number) => {
    if (total <= 1 && rowCount <= PAGE_SIZE) return null;
    return (
      <div className="flex items-center justify-between gap-4 px-4 py-3 border-t" data-testid="pagination-controls">
        <span className="text-sm text-muted-foreground">
          Showing {Math.min((page - 1) * PAGE_SIZE + 1, rowCount)}-{Math.min(page * PAGE_SIZE, rowCount)} of {rowCount}
        </span>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="First page" onClick={() => setPage(1)} disabled={page <= 1} data-testid="button-page-first">
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Previous page" onClick={() => setPage(page - 1)} disabled={page <= 1} data-testid="button-page-prev">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm px-2 min-w-[80px] text-center">
            Page {page} of {total}
          </span>
          <Button size="icon" variant="ghost" aria-label="Next page" onClick={() => setPage(page + 1)} disabled={page >= total} data-testid="button-page-next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Last page" onClick={() => setPage(total)} disabled={page >= total} data-testid="button-page-last">
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  };

  const renderTable = (rows: UnifiedRow[], showSelectAll: boolean, page: number, totalPg: number, setPage: (p: number) => void, totalRowCount: number) => {
    return (
      <>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead className="w-10">
                  {showSelectAll && (
                    <Checkbox
                      checked={rows.length > 0 && rows.every((r) => selectedIds.has(r.id))}
                      onCheckedChange={() => toggleSelectAll(rows)}
                      data-testid="checkbox-select-all"
                    />
                  )}
                </TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Est. Residual</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-muted-foreground" data-testid="text-no-results">
                    No leads found matching your criteria
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => toggleExpanded(row.id)}
                      data-testid={`row-lead-${row.id}`}
                    >
                      <TableCell className="w-8 px-2">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          aria-label="Expand row"
                          onClick={(e) => { e.stopPropagation(); toggleExpanded(row.id); }}
                          data-testid={`button-expand-${row.id}`}
                        >
                          {expandedRows.has(row.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </Button>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(row.id)}
                          onCheckedChange={() => toggleSelect(row.id)}
                          data-testid={`checkbox-${row.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.source === "sunbiz" ? "outline" : "secondary"} data-testid={`badge-source-${row.id}`}>
                          {row.source === "sunbiz" ? "Sunbiz" : "Prospect"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-medium text-sm max-w-[220px] truncate" title={row.name}>
                            {row.name || "--"}
                          </div>
                          {(row.email || row.phone) && (
                            <div className="flex items-center gap-2 mt-0.5">
                              {row.email && (
                                <span className="text-xs text-muted-foreground flex items-center gap-0.5 max-w-[160px] truncate">
                                  <Mail className="h-3 w-3 shrink-0" />{row.email}
                                </span>
                              )}
                              {row.phone && (
                                <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                                  <Phone className="h-3 w-3 shrink-0" />{row.phone}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm max-w-[140px] truncate">{row.owner || "--"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{row.city}{row.state ? `, ${row.state}` : ""}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getScoreVariant(row.score)} data-testid={`badge-score-${row.id}`}>
                          {row.score}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {getStatusIcon(row.enrichmentStatus)}
                          <span className="text-xs capitalize">{row.enrichmentStatus}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium">{row.qualificationScore}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{row.estimatedResidual}</span>
                      </TableCell>
                    </TableRow>
                    {expandedRows.has(row.id) && (
                      <TableRow>
                        <TableCell colSpan={10} className="p-0 bg-muted/30">
                          <DetailRow row={row} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {renderPagination(page, totalPg, setPage, totalRowCount)}
      </>
    );
  };

  const renderMassActions = () => {
    if (selectedIds.size === 0) return null;
    return (
      <div className="sticky top-0 z-50 flex flex-wrap items-center gap-2 p-3 border rounded-md bg-background shadow-sm" data-testid="mass-action-bar">
        <span className="text-sm font-medium mr-2">{selectedIds.size} selected</span>
        {/* Bulk enrichment always throws (CRO-03 provider transport disabled);
            disabled here instead of left clickable-but-broken (matches Lead Ops). */}
        <Button
          size="sm"
          variant="outline"
          disabled
          title="Bulk enrichment is retired — CRO-03 provider transport is disabled."
          data-testid="button-enrich-selected"
        >
          <Sparkles className="h-4 w-4 mr-1.5" />
          Enrich Selected (retired)
        </Button>
        {selectedEntities.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => convertToProspectsMutation.mutate()}
            disabled={convertToProspectsMutation.isPending}
            data-testid="button-convert-to-prospects"
          >
            {convertToProspectsMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ArrowRightLeft className="h-4 w-4 mr-1.5" />}
            Convert to Prospects
          </Button>
        )}
        {selectedProspects.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => convertToContactsMutation.mutate()}
            disabled={convertToContactsMutation.isPending}
            data-testid="button-convert-to-contacts"
          >
            {convertToContactsMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1.5" />}
            Convert to Contacts
          </Button>
        )}
        {selectedProspects.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => aiRouteMutation.mutate(selectedProspects)}
            disabled={aiRouteMutation.isPending}
            data-testid="button-ai-route"
          >
            {aiRouteMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Zap className="h-4 w-4 mr-1.5" />}
            AI Route to Campaigns
          </Button>
        )}
        {selectedProspectsWithContact.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled
                title="Direct sequence enrollment is retired on this legacy page — use the governed bulk-enrollment flow on Lead Ops or Sequences."
                data-testid="button-enroll-sequence"
              >
                <PlayCircle className="h-4 w-4 mr-1.5" />
                Enroll in Sequence (retired)
                <ChevronDown className="h-3.5 w-3.5 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {sequences.length === 0 ? (
                <DropdownMenuItem disabled>No sequences available</DropdownMenuItem>
              ) : (
                sequences.map((seq: any) => (
                  <DropdownMenuItem key={seq.id} disabled data-testid={`menu-sequence-${seq.id}`}>
                    {seq.name}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              disabled
              title="Arbitrary workflow execution is retired on this legacy page — workflows now run only from their own triggers."
              data-testid="button-add-workflow"
            >
              <LayoutList className="h-4 w-4 mr-1.5" />
              Add to Workflow (retired)
              <ChevronDown className="h-3.5 w-3.5 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {workflows.length === 0 ? (
              <DropdownMenuItem disabled>No workflows available</DropdownMenuItem>
            ) : (
              workflows.map((wf: any) => (
                <DropdownMenuItem key={wf.id} disabled data-testid={`menu-workflow-${wf.id}`}>
                  {wf.name}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const uploading = uploadMutation.isPending || corevtUploadMutation.isPending;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <PageTitle className="text-2xl font-bold" data-testid="text-page-title">Lead Command Center</PageTitle>
        <p className="text-sm text-muted-foreground">Unified view of all leads, enrichment, and conversion pipeline</p>
      </div>

      {(() => {
        const enrichedProspectCount = prospects.filter((p) => p.status === "enriched" || p.status === "qualified").length;
        const kpiCards: Array<{
          config: KpiBreakdownPopoverProps;
          testId: string;
          colorClass?: string;
        }> = [
          {
            testId: "text-kpi-total",
            config: {
              label: "Total lead records",
              total: kpis.totalLeads,
              rows: [
                { label: "Sunbiz entities", value: outreachStatus?.entities?.total || 0 },
                { label: "Prospects", value: outreachStatus?.prospects?.total || 0 },
                { label: "CRM contacts", value: outreachStatus?.contacts?.total || 0 },
              ],
              overlapWarning: "Combined record count; sources may overlap.",
              loading: outreachStatusLoading,
              triggerTestId: "trigger-total-lead-breakdown",
            },
          },
          {
            testId: "text-kpi-pending",
            colorClass: "text-amber-600 dark:text-amber-400",
            config: {
              label: "Pending Enrichment",
              total: kpis.pendingEnrichment,
              rows: [
                { label: "Sunbiz entities", value: stats?.pending || 0 },
              ],
              explanation: "Sunbiz entities queued and awaiting enrichment.",
              loading: stats === undefined,
              triggerTestId: "trigger-pending-breakdown",
            },
          },
          {
            testId: "text-kpi-enriched",
            colorClass: "text-green-600 dark:text-green-400",
            config: {
              label: "Enrichment Attempted",
              total: kpis.enriched,
              rows: [
                { label: "Sunbiz entities enriched", value: stats?.enriched || 0 },
                { label: "Loaded prospects enriched/qualified", value: enrichedProspectCount },
              ],
              explanation: "Prospect count reflects records currently loaded in this view.",
              overlapWarning: "Entities promoted to prospects may appear in both buckets.",
              loading: stats === undefined || prospectsLoading,
              triggerTestId: "trigger-enriched-breakdown",
            },
          },
          {
            testId: "text-kpi-contactable",
            colorClass: "text-teal-600 dark:text-teal-400",
            config: {
              label: "CRM records with contact info",
              total: kpis.crmWithContactInfo,
              rows: [
                { label: "CRM contacts with info", value: outreachStatus?.contacts?.withContactInfo ?? 0 },
              ],
              explanation: "Counts active, non-DNC CRM records with a nonblank email or phone. This is not a canonical outreach-eligibility check.",
              loading: outreachStatusLoading,
              triggerTestId: "trigger-contactable-breakdown",
            },
          },
          {
            testId: "text-kpi-hot",
            colorClass: "text-red-600 dark:text-red-400",
            config: {
              label: "Hot Leads",
              total: kpis.hotLeads,
              rows: [
                { label: "Sunbiz entities", value: outreachStatus?.entities?.hot || 0 },
                { label: "Prospects", value: outreachStatus?.prospects?.hot || 0 },
                { label: "CRM contacts", value: outreachStatus?.contacts?.hot || 0 },
              ],
              explanation: "Score tier: hot (≥70) across all pipeline stages.",
              overlapWarning: "A record promoted across stages may appear in more than one bucket.",
              loading: outreachStatusLoading,
              triggerTestId: "trigger-hot-breakdown",
            },
          },
          {
            testId: "text-kpi-warm",
            colorClass: "text-orange-600 dark:text-orange-400",
            config: {
              label: "Warm Leads",
              total: kpis.warmLeads,
              rows: [
                { label: "Sunbiz entities", value: outreachStatus?.entities?.warm || 0 },
                { label: "Prospects", value: outreachStatus?.prospects?.warm || 0 },
                { label: "CRM contacts", value: outreachStatus?.contacts?.warm || 0 },
              ],
              explanation: "Score tier: warm (45–69) across all pipeline stages.",
              overlapWarning: "A record promoted across stages may appear in more than one bucket.",
              loading: outreachStatusLoading,
              triggerTestId: "trigger-warm-breakdown",
            },
          },
          {
            testId: "text-kpi-converted",
            colorClass: "text-blue-600 dark:text-blue-400",
            config: {
              label: "Converted",
              total: kpis.converted,
              rows: [
                { label: "Prospects converted", value: kpis.converted },
              ],
              explanation: "Prospects converted to CRM contacts. Uses server total when available; falls back to loaded-row count.",
              loading: outreachStatusLoading && prospectsLoading,
              triggerTestId: "trigger-converted-breakdown",
            },
          },
        ];

        return (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            {kpiCards.map(({ config, testId, colorClass }) => (
              <Card key={testId} className="hover-elevate">
                <CardContent className="p-3 text-center">
                  <div className={`text-2xl font-bold${colorClass ? ` ${colorClass}` : ""}`} data-testid={testId}>
                    {fmtN(config.total)}
                  </div>
                  <KpiBreakdownPopover {...config} />
                </CardContent>
              </Card>
            ))}
          </div>
        );
      })()}

      <div
        className={`flex items-center gap-3 p-3 border-2 border-dashed rounded-md transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        data-testid="upload-zone"
      >
        {uploading ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm font-medium">Processing file...</span>
          </div>
        ) : (
          <>
            <Upload className="h-5 w-5 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground">Drag & drop CSV or corevt.zip files here, or</span>
            <label htmlFor="lcc-file-upload" className="ml-auto">
              <Button variant="outline" size="sm" asChild>
                <span data-testid="button-upload-file">
                  <Upload className="h-4 w-4 mr-1.5" />
                  Select File
                </span>
              </Button>
              <input id="lcc-file-upload" type="file" accept=".csv,.zip,.txt" className="hidden" onChange={(e) => handleFileUpload(e.target.files)} />
            </label>
          </>
        )}
      </div>

      <div className="text-xs text-muted-foreground flex items-center gap-1.5 px-1">
        <Sparkles className="h-3.5 w-3.5" />
        <span>Automated enrichment is currently retired — CRO-03 provider transport is disabled. Use CRO-03 staging review for enrichment instead.</span>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); setExpandedRows(new Set()); }} className="space-y-3">
        <TabsList data-testid="tabs-list">
          <TabsTrigger value="queue" data-testid="tab-queue">
            <Target className="h-4 w-4 mr-1.5" />
            Enrichment Queue
            <Badge variant="secondary" className="ml-1.5 text-xs">{filteredQueue.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="pipeline" data-testid="tab-pipeline">
            <TrendingUp className="h-4 w-4 mr-1.5" />
            Qualified Pipeline
            <Badge variant="secondary" className="ml-1.5 text-xs">{qualifiedRows.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="intelligence" data-testid="tab-intelligence">
            <Brain className="h-4 w-4 mr-1.5" />
            Lead Intelligence
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search leads..."
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                className="pl-9"
                data-testid="input-search"
              />
            </div>
            <Select value={filterScore} onValueChange={(v) => { setFilterScore(v); setCurrentPage(1); }}>
              <SelectTrigger className="w-[130px]" data-testid="select-filter-score">
                <SelectValue placeholder="Score" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Scores</SelectItem>
                <SelectItem value="hot">Hot</SelectItem>
                <SelectItem value="warm">Warm</SelectItem>
                <SelectItem value="cold">Cold</SelectItem>
                <SelectItem value="raw">Raw</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setCurrentPage(1); }}>
              <SelectTrigger className="w-[140px]" data-testid="select-filter-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="enriched">Enriched</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterSource} onValueChange={(v) => { setFilterSource(v); setCurrentPage(1); }}>
              <SelectTrigger className="w-[130px]" data-testid="select-filter-source">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                <SelectItem value="sunbiz">Sunbiz</SelectItem>
                <SelectItem value="prospect">Prospect</SelectItem>
                <SelectItem value="quiz_lead">Quiz Lead</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {renderMassActions()}

          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : isError ? (
            <Card>
              <CardContent className="p-0">
                <DataState
                  query={{ isLoading: false, isError: true, error: combinedError, refetch: refetchAll }}
                  errorTitle="Failed to load leads"
                  testId="lead-queue"
                >
                  <></>
                </DataState>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                {renderTable(paginatedQueue, true, safePage, totalPages, setCurrentPage, filteredQueue.length)}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="pipeline" className="space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-lg font-semibold" data-testid="text-pipeline-title">Qualified Pipeline</h3>
              <p className="text-sm text-muted-foreground">{qualifiedRows.length} conversion-ready leads (hot/warm + A/B grade)</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const hotIds = qualifiedRows.filter((r) => r.score === "hot").map((r) => r.rawId);
                  if (hotIds.length > 0) convertToContactsMutation.mutate();
                }}
                disabled={convertToContactsMutation.isPending || qualifiedRows.filter(r => r.score === "hot").length === 0}
                data-testid="button-convert-all-hot"
              >
                <Zap className="h-4 w-4 mr-1.5" /> Convert All Hot
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => aiRouteMutation.mutate(qualifiedRows.map((r) => r.rawId))}
                disabled={aiRouteMutation.isPending || qualifiedRows.length === 0}
                data-testid="button-route-pipeline"
              >
                <Target className="h-4 w-4 mr-1.5" /> AI Route Pipeline
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              {renderTable(paginatedPipeline, false, safePipelinePage, pipelineTotalPages, setPipelinePage, qualifiedRows.length)}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="intelligence" className="space-y-3">
          <LeadIntelligence />
        </TabsContent>
      </Tabs>
    </div>
  );
}
