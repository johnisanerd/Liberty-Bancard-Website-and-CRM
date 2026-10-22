import { PageTitle } from "@/components/ui/page-header";
import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getCsrfToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  Upload,
  Sparkles,
  Loader2,
  Download,
  ArrowRightLeft,
  Globe,
  Mail,
  Phone,
  Building2,
  User,
  FileText,
  CheckCircle2,
  Clock,
  XCircle,
  Filter,
  RefreshCw,
  Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { SunbizEntity } from "@shared/schema";

function getScoreVariant(score: string | null | undefined) {
  switch (score) {
    case "hot": return "destructive";
    case "warm": return "default";
    case "cold": return "secondary";
    default: return "outline";
  }
}

function getStatusIcon(status: string | null | undefined) {
  switch (status) {
    case "enriched": return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case "processing": return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
    case "failed": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    default: return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

export default function LeadGenCleaner() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [filterScore, setFilterScore] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [detailEntity, setDetailEntity] = useState<SunbizEntity | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const { data: entitiesResult, isLoading } = useQuery<{ data: SunbizEntity[]; total: number }>({
    queryKey: ["/api/sunbiz/entities"],
    queryFn: async () => {
      const res = await fetch("/api/sunbiz/entities?limit=500", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch entities");
      return res.json();
    },
  });
  const entities = entitiesResult?.data ?? [];

  const { data: stats } = useQuery<{
    total: number;
    enriched: number;
    pending: number;
    withEmail: number;
    withPhone: number;
    withWebsite: number;
  }>({
    queryKey: ["/api/sunbiz/stats"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const response = await fetch("/api/sunbiz/upload", { method: "POST", body: formData, headers, credentials: "include" });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Upload Complete", description: `Imported ${data.imported} entities from Sunbiz file.` });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/entities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/stats"] });
    },
    onError: (err: any) => {
      toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
    },
  });

  const enrichMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/sunbiz/entities/${id}/enrich`, { idempotencyKey: crypto.randomUUID() });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/entities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/stats"] });
    },
  });

  const enrichBatchMutation = useMutation({
    mutationFn: async (entityIds: number[]) => {
      const res = await apiRequest("POST", "/api/sunbiz/enrich-batch", { entityIds, idempotencyKey: crypto.randomUUID() });
      return res.json();
    },
    onSuccess: (data) => {
      const s = data?.summary;
      const description = s
        ? `${s.success} succeeded, ${s.partial_success} partial, ${s.skipped} skipped, ${s.failed} failed (of ${s.total}).`
        : `Enriched ${data.processed ?? 0} entities.`;
      toast({ title: "Batch Enrichment", description });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/entities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/stats"] });
    },
    onError: (err: any) => {
      toast({ title: "Enrichment Error", description: err.message, variant: "destructive" });
    },
  });

  const convertMutation = useMutation({
    mutationFn: async (entityIds: number[]) => {
      const res = await apiRequest("POST", "/api/sunbiz/convert-batch", { entityIds });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Converted to Prospects", description: `${data.converted} entities pushed to prospect pipeline.` });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/entities"] });
      setSelectedIds(new Set());
    },
    onError: (err: any) => {
      toast({ title: "Conversion Error", description: err.message, variant: "destructive" });
    },
  });

  const corevtUploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const response = await fetch("/api/sunbiz/upload-corevt", { method: "POST", body: formData, headers, credentials: "include" });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Corevt Import Complete", description: `Imported ${data.imported} entities from Florida state filing data.` });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/entities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sunbiz/stats"] });
    },
    onError: (err: any) => {
      toast({ title: "Import Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileUpload = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const formData = new FormData();
    formData.append("file", file);

    const isZip = file.name.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
    const isCorevt = file.name.toLowerCase().includes("corevt");

    if (isZip || isCorevt) {
      formData.append("listName", `Sunbiz Corevt Import ${new Date().toLocaleDateString()}`);
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

  const toggleSelect = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(e => e.id)));
    }
  };

  const filtered = entities.filter(e => {
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      if (
        !(e.entityName || "").toLowerCase().includes(term) &&
        !(e.ownerName || "").toLowerCase().includes(term) &&
        !(e.email || "").toLowerCase().includes(term) &&
        !(e.principalCity || "").toLowerCase().includes(term) &&
        !(e.filingNumber || "").toLowerCase().includes(term)
      ) return false;
    }
    if (filterScore !== "all" && e.score !== filterScore) return false;
    if (filterStatus !== "all" && e.enrichmentStatus !== filterStatus) return false;
    return true;
  });

  const enrichedSelected = Array.from(selectedIds).filter(id => {
    const e = entities.find(ent => ent.id === id);
    return e && e.enrichmentStatus === "enriched";
  });

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <PageTitle className="text-2xl font-bold" data-testid="text-page-title">Lead Gen Cleaner</PageTitle>
          <p className="text-sm text-muted-foreground">Upload Sunbiz files, enrich with contact data, push to sequences</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => enrichBatchMutation.mutate(entities.filter((entity) => entity.enrichmentStatus !== "enriched").slice(0, 25).map((entity) => entity.id))}
            disabled={enrichBatchMutation.isPending || !stats?.pending}
            data-testid="button-enrich-all"
          >
            {enrichBatchMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
            Enrich All ({stats?.pending || 0})
          </Button>
          <Button
            variant="outline"
            disabled={enrichedSelected.length === 0 || convertMutation.isPending}
            onClick={() => convertMutation.mutate(enrichedSelected)}
            data-testid="button-convert-selected"
          >
            {convertMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArrowRightLeft className="h-4 w-4 mr-2" />}
            Push to Prospects ({enrichedSelected.length})
          </Button>
          <a href="/api/sunbiz/export?enrichedOnly=true" target="_blank" rel="noopener noreferrer">
            <Button variant="outline" data-testid="button-export-csv">
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold" data-testid="text-stat-total">{stats?.total || 0}</div>
            <div className="text-xs text-muted-foreground">Total Entities</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-green-600" data-testid="text-stat-enriched">{stats?.enriched || 0}</div>
            <div className="text-xs text-muted-foreground">Enriched</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-amber-600" data-testid="text-stat-pending">{stats?.pending || 0}</div>
            <div className="text-xs text-muted-foreground">Pending</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-blue-600" data-testid="text-stat-email">{stats?.withEmail || 0}</div>
            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><Mail className="h-3 w-3" /> Emails</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-purple-600" data-testid="text-stat-phone">{stats?.withPhone || 0}</div>
            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><Phone className="h-3 w-3" /> Phones</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-teal-600" data-testid="text-stat-website">{stats?.withWebsite || 0}</div>
            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><Globe className="h-3 w-3" /> Websites</div>
          </CardContent>
        </Card>
      </div>

      <Card
        className={`border-2 border-dashed transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <CardContent className="p-6 text-center">
          {(uploadMutation.isPending || corevtUploadMutation.isPending) ? (
            <div className="space-y-2">
              <Loader2 className="h-8 w-8 mx-auto animate-spin text-primary" />
              <p className="text-sm font-medium">
                {corevtUploadMutation.isPending
                  ? "Processing state filing data... This may take a moment for large files."
                  : "Uploading CSV file..."}
              </p>
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-1">
                Drag & drop files here, or click to browse
              </p>
              <p className="text-xs text-muted-foreground mb-3">
                Supports CSV files and Florida Sunbiz corevt.zip state filing data
              </p>
              <label htmlFor="file-upload">
                <Button variant="outline" asChild>
                  <span data-testid="button-upload-file">
                    <Upload className="h-4 w-4 mr-2" />
                    Select File
                  </span>
                </Button>
              </label>
              <input
                id="file-upload"
                type="file"
                accept=".csv,.txt,.tsv,.zip"
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files)}
                data-testid="input-file-upload"
              />
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search entities, owners, emails, cities..."
            className="pl-9"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            data-testid="input-search"
          />
        </div>
        <Select value={filterScore} onValueChange={setFilterScore}>
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
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[140px]" data-testid="select-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="enriched">Enriched</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <Badge variant="outline" className="text-xs">
          {filtered.length} results
        </Badge>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === filtered.length && filtered.length > 0}
                      onChange={toggleSelectAll}
                      data-testid="checkbox-select-all"
                    />
                  </TableHead>
                  <TableHead>Entity Name</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      {entities.length === 0 ? "Upload Sunbiz CSV files to get started" : "No matching entities found"}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.slice(0, 200).map((entity) => (
                    <TableRow key={entity.id} data-testid={`row-entity-${entity.id}`}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(entity.id)}
                          onChange={() => toggleSelect(entity.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-sm max-w-[200px] truncate" title={entity.entityName}>
                          {entity.entityName}
                        </div>
                        {entity.dba && (
                          <div className="text-xs text-muted-foreground">DBA: {entity.dba}</div>
                        )}
                        {entity.filingNumber && (
                          <div className="text-xs text-muted-foreground">#{entity.filingNumber}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{entity.ownerName || "--"}</div>
                        {entity.ownerEmail && (
                          <div className="text-xs text-blue-600 truncate max-w-[150px]">{entity.ownerEmail}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          {entity.email && (
                            <div className="flex items-center gap-1 text-xs">
                              <Mail className="h-3 w-3 text-muted-foreground" />
                              <span className="truncate max-w-[130px]">{entity.email}</span>
                            </div>
                          )}
                          {entity.phone && (
                            <div className="flex items-center gap-1 text-xs">
                              <Phone className="h-3 w-3 text-muted-foreground" />
                              {entity.phone}
                            </div>
                          )}
                          {entity.website && (
                            <div className="flex items-center gap-1 text-xs">
                              <Globe className="h-3 w-3 text-muted-foreground" />
                              <span className="truncate max-w-[130px]">{entity.website}</span>
                            </div>
                          )}
                          {!entity.email && !entity.phone && !entity.website && (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{entity.principalCity || "--"}{entity.principalState ? `, ${entity.principalState}` : ""}</div>
                        {entity.vertical && (
                          <Badge variant="outline" className="text-xs mt-0.5">{entity.vertical}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getScoreVariant(entity.score)} data-testid={`badge-score-${entity.id}`}>
                          {entity.score || "raw"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {getStatusIcon(entity.enrichmentStatus)}
                          <span className="text-xs capitalize">{entity.enrichmentStatus || "pending"}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="View details"
                            onClick={() => setDetailEntity(entity)}
                            data-testid={`button-view-${entity.id}`}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {entity.enrichmentStatus !== "enriched" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Enrich entity"
                              onClick={() => enrichMutation.mutate(entity.id)}
                              disabled={enrichMutation.isPending}
                              data-testid={`button-enrich-${entity.id}`}
                            >
                              {enrichMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {filtered.length > 200 && (
            <div className="p-3 text-center text-xs text-muted-foreground border-t">
              Showing 200 of {filtered.length} entities. Use filters to narrow results.
            </div>
          )}
        </Card>
      )}

      <Dialog open={!!detailEntity} onOpenChange={() => setDetailEntity(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              {detailEntity?.entityName}
            </DialogTitle>
          </DialogHeader>
          {detailEntity && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Filing #:</span>
                  <span className="ml-2 font-medium">{detailEntity.filingNumber || "--"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Type:</span>
                  <span className="ml-2">{detailEntity.entityType || "--"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>
                  <span className="ml-2">{detailEntity.entityStatus || "--"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Filed:</span>
                  <span className="ml-2">{detailEntity.filingDate || "--"}</span>
                </div>
              </div>

              {detailEntity.principalAddress && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Principal Address</h4>
                  <p className="text-sm text-muted-foreground">
                    {detailEntity.principalAddress}
                    {detailEntity.principalCity && `, ${detailEntity.principalCity}`}
                    {detailEntity.principalState && ` ${detailEntity.principalState}`}
                    {detailEntity.principalZip && ` ${detailEntity.principalZip}`}
                  </p>
                </div>
              )}

              {detailEntity.registeredAgentName && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Registered Agent</h4>
                  <p className="text-sm text-muted-foreground">{detailEntity.registeredAgentName}</p>
                  {detailEntity.registeredAgentAddress && (
                    <p className="text-xs text-muted-foreground">{detailEntity.registeredAgentAddress}</p>
                  )}
                </div>
              )}

              {(() => {
                const officerList = Array.isArray(detailEntity.officers)
                  ? (detailEntity.officers as Array<{title: string; name: string; address: string}>)
                  : [];
                if (officerList.length === 0) return null;
                return (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Officers / Directors</h4>
                    <div className="space-y-1">
                      {officerList.map((officer, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          <User className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" />
                          <div>
                            <span className="font-medium">{officer.name}</span>
                            <span className="text-muted-foreground ml-1">({officer.title})</span>
                            {officer.address && <div className="text-xs text-muted-foreground">{officer.address}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="border-t pt-3">
                <h4 className="text-sm font-medium mb-2">Enriched Contact Info</h4>
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Owner:</span>
                    <span>{detailEntity.ownerName || "--"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Email:</span>
                    <span className="text-blue-600">{detailEntity.email || detailEntity.ownerEmail || "--"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Phone:</span>
                    <span>{detailEntity.phone || detailEntity.ownerPhone || "--"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Website:</span>
                    <span className="text-blue-600">{detailEntity.website || "--"}</span>
                  </div>
                </div>
              </div>

              {detailEntity.aiSummary && (
                <div className="border-t pt-3">
                  <h4 className="text-sm font-medium mb-1">AI Analysis</h4>
                  <p className="text-sm text-muted-foreground">{detailEntity.aiSummary}</p>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                {detailEntity.enrichmentStatus !== "enriched" && (
                  <Button
                    size="sm"
                    onClick={() => {
                      enrichMutation.mutate(detailEntity.id);
                      setDetailEntity(null);
                    }}
                    disabled={enrichMutation.isPending}
                    data-testid="button-detail-enrich"
                  >
                    <Sparkles className="h-4 w-4 mr-1" />
                    Enrich
                  </Button>
                )}
                {detailEntity.enrichmentStatus === "enriched" && !detailEntity.prospectId && (
                  <Button
                    size="sm"
                    onClick={() => {
                      convertMutation.mutate([detailEntity.id]);
                      setDetailEntity(null);
                    }}
                    disabled={convertMutation.isPending}
                    data-testid="button-detail-convert"
                  >
                    <ArrowRightLeft className="h-4 w-4 mr-1" />
                    Push to Prospects
                  </Button>
                )}
                {detailEntity.prospectId && (
                  <Badge variant="outline">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Prospect #{detailEntity.prospectId}
                  </Badge>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
