import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { CrmPageHeader } from "@/components/crm/CrmPresentation";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  Monitor, TrendingUp, AlertTriangle, CheckCircle2, Clock, DollarSign,
  RefreshCw, Download, Settings, Plus, Pencil, Trash2, Loader2,
  ShieldCheck, ShieldAlert, ShieldX, MoreHorizontal,
} from "lucide-react";
import { exportToCSV } from "@/lib/export-csv";
import type { EquipmentModel } from "@shared/schema";

interface ReportRow {
  dealId: number;
  merchantName: string;
  terminalModel: string | null;
  terminalCost: number | null;
  monthlyVolume: number | null;
  monthlyGP: number | null;
  paybackMonths: number | null;
  tier: "green" | "yellow" | "red" | "unknown";
  paybackStatus: "on_track" | "paid_off" | "at_risk" | "unknown";
  stage: string;
  terminalApprovalStatus: string;
  closedAt: string | null;
}

interface ReportSummary {
  totalRecommendations: number;
  totalDeployedTerminals: null;
  totalCost: null;
  forecastCost: number | null;
  thisMonthCount: number;
  thisMonthCost: number | null;
  atRiskCount: number;
  paidOffCount: null;
  greenCount: number;
  yellowCount: number;
  redCount: number;
}

interface RoiReport {
  meta: { total: number; page: number; pageSize: number };
  rows: ReportRow[];
  summary: ReportSummary;
  config: { greenThresholdMonths: number; yellowThresholdMonths: number };
  generatedAt: string;
}

const tierLabel: Record<string, string> = {
  green: "On Track",
  yellow: "Caution",
  red: "At Risk",
  unknown: "N/A",
};

const tierBadge = (tier: string) => {
  if (tier === "green") return <Badge className="bg-green-100 text-green-700 border-green-200 no-default-hover-elevate no-default-active-elevate">{tierLabel[tier]}</Badge>;
  if (tier === "yellow") return <Badge className="bg-amber-100 text-amber-700 border-amber-200 no-default-hover-elevate no-default-active-elevate">{tierLabel[tier]}</Badge>;
  if (tier === "red") return <Badge className="bg-red-100 text-red-700 border-red-200 no-default-hover-elevate no-default-active-elevate">{tierLabel[tier]}</Badge>;
  return <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate">N/A</Badge>;
};

const approvalBadge = (status: string) => {
  if (status === "approved") return <span className="inline-flex items-center gap-1 text-xs text-green-700"><ShieldCheck className="w-3.5 h-3.5" /> Approved</span>;
  if (status === "pending_approval") return <span className="inline-flex items-center gap-1 text-xs text-amber-700"><ShieldAlert className="w-3.5 h-3.5" /> Pending</span>;
  if (status === "rejected") return <span className="inline-flex items-center gap-1 text-xs text-red-700"><ShieldX className="w-3.5 h-3.5" /> Rejected</span>;
  return <span className="text-xs text-muted-foreground">—</span>;
};

export default function TerminalROI() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isManagerOrAdmin = user?.role === "admin" || user?.role === "manager";

  const [configOpen, setConfigOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [editModel, setEditModel] = useState<EquipmentModel | null>(null);
  const [newModelForm, setNewModelForm] = useState({ name: "", category: "Terminal", description: "", msrp: "", libertyCost: "", isActive: true });
  const [greenThreshold, setGreenThreshold] = useState("");
  const [yellowThreshold, setYellowThreshold] = useState("");
  const [filterTier, setFilterTier] = useState<string>("all");
  const [reportPage, setReportPage] = useState(0);

  const { data: report, isLoading, refetch, isFetching } = useQuery<RoiReport>({
    queryKey: ["/api/admin/terminal-roi-report", reportPage],
    queryFn: async () => {
      const response = await fetch(`/api/admin/terminal-roi-report?page=${reportPage}`, { credentials: "include" });
      if (!response.ok) throw new Error("Terminal recommendation report unavailable");
      return response.json();
    },
    enabled: isManagerOrAdmin,
  });

  const { data: config, refetch: refetchConfig } = useQuery<{ greenThresholdMonths: number; yellowThresholdMonths: number }>({
    queryKey: ["/api/admin/terminal-economics-config"],
    enabled: isManagerOrAdmin,
    onSuccess: (d: { greenThresholdMonths: number; yellowThresholdMonths: number }) => {
      setGreenThreshold(String(d.greenThresholdMonths));
      setYellowThreshold(String(d.yellowThresholdMonths));
    },
  } as any);

  const { data: models, refetch: refetchModels } = useQuery<EquipmentModel[]>({
    queryKey: ["/api/equipment-models"],
  });

  const saveConfigMutation = useMutation({
    mutationFn: (data: { greenThresholdMonths: number; yellowThresholdMonths: number }) =>
      apiRequest("POST", "/api/admin/terminal-economics-config", data),
    onSuccess: () => {
      toast({ title: "Thresholds saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/terminal-economics-config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/terminal-roi-report"] });
      setConfigOpen(false);
    },
    onError: (e: any) => toast({ title: e.message || "Failed to save", variant: "destructive" }),
  });

  const createModelMutation = useMutation({
    mutationFn: (data: typeof newModelForm) =>
      apiRequest("POST", "/api/equipment-models", {
        name: data.name,
        category: data.category,
        description: data.description || null,
        msrp: Number(data.msrp),
        libertyCost: Number(data.libertyCost),
        isActive: data.isActive,
      }),
    onSuccess: () => {
      toast({ title: "Model created" });
      queryClient.invalidateQueries({ queryKey: ["/api/equipment-models"] });
      setNewModelForm({ name: "", category: "Terminal", description: "", msrp: "", libertyCost: "", isActive: true });
    },
    onError: (e: any) => toast({ title: e.message || "Failed to create", variant: "destructive" }),
  });

  const updateModelMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<EquipmentModel> & { id: number }) =>
      apiRequest("PUT", `/api/equipment-models/${id}`, data),
    onSuccess: () => {
      toast({ title: "Model updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/equipment-models"] });
      setEditModel(null);
    },
    onError: (e: any) => toast({ title: e.message || "Failed to update", variant: "destructive" }),
  });

  const deleteModelMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/equipment-models/${id}`),
    onSuccess: () => {
      toast({ title: "Model removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/equipment-models"] });
    },
    onError: (e: any) => toast({ title: e.message || "Failed to delete", variant: "destructive" }),
  });

  const rows = report?.rows ?? [];
  const filteredRows = filterTier === "all" ? rows : rows.filter((r) => r.tier === filterTier);
  const summary = report?.summary;

  const handleExport = () => {
    exportToCSV(
      rows.map((r) => ({
        dealId: r.dealId,
        merchant: r.merchantName,
        model: r.terminalModel,
        cost: r.terminalCost?.toFixed(2) ?? "Unavailable",
        monthlyGP: r.monthlyGP?.toFixed(2) ?? "Unavailable",
        paybackMonths: r.paybackMonths ?? "N/A",
        tier: r.tier,
        status: r.paybackStatus,
        stage: r.stage,
        approval: r.terminalApprovalStatus,
      })),
      "terminal-roi-report",
      [
        { key: "dealId", label: "Deal ID" },
        { key: "merchant", label: "Merchant" },
        { key: "model", label: "Terminal Model" },
        { key: "cost", label: "Terminal Cost ($)" },
        { key: "monthlyGP", label: "Monthly GP ($)" },
        { key: "paybackMonths", label: "Payback (months)" },
        { key: "tier", label: "Tier" },
        { key: "status", label: "Status" },
        { key: "stage", label: "Stage" },
        { key: "approval", label: "Approval Status" },
      ]
    );
  };

  if (!isManagerOrAdmin) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <p>Access restricted to managers and administrators.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="terminal-roi-page">
      <CrmPageHeader
        headingLevel={2}
        title="Terminal Recommendation Forecasts"
        description="Model-based forecasts; verified deployment and actual cash recovery are unavailable."
        primaryAction={
          <Button onClick={handleExport} className="gap-2" data-testid="button-export-report">
            <Download className="w-4 h-4" /> Export CSV
          </Button>
        }
        secondaryActions={
          <>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching} className="gap-2" data-testid="button-refresh-report">
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="More terminal report actions" className="gap-2" data-testid="button-terminal-report-more">
                  <MoreHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline">More</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setModelsOpen(true)} data-testid="button-manage-models">
                  <Monitor className="mr-2 h-4 w-4" /> Equipment Catalog
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setConfigOpen(true); refetchConfig(); }} data-testid="button-configure-thresholds">
                  <Settings className="mr-2 h-4 w-4" /> Thresholds
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      ) : summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card data-testid="stat-total-terminals">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1.5">
                <Monitor className="w-4 h-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Recommendations</span>
              </div>
              <div className="text-2xl font-bold">{summary.totalRecommendations}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{summary.forecastCost === null ? "Forecast cost unavailable" : `$${summary.forecastCost.toLocaleString(undefined, { maximumFractionDigits: 0 })} modelled cost (not invested cash)`}</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-this-month">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1.5">
                <TrendingUp className="w-4 h-4" />
                <span className="text-xs font-medium uppercase tracking-wide">This Month</span>
              </div>
              <div className="text-2xl font-bold">{summary.thisMonthCount}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{summary.thisMonthCost === null ? "Forecast cost unavailable" : `$${summary.thisMonthCost.toLocaleString(undefined, { maximumFractionDigits: 0 })} forecast cost`} · close-date cohort, not deployment</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-paid-off">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <span className="text-xs font-medium uppercase tracking-wide">Paid Off</span>
              </div>
              <div className="text-xl font-bold text-green-600">Unavailable</div>
              <div className="text-xs text-muted-foreground mt-0.5">{summary.greenCount} green / {summary.yellowCount} yellow</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-at-risk">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1.5">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <span className="text-xs font-medium uppercase tracking-wide">Forecast threshold</span>
              </div>
              <div className="text-2xl font-bold text-red-600">{summary.atRiskCount}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{summary.redCount} exceed {report?.config?.yellowThresholdMonths}mo threshold</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card data-testid="card-roi-table">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">Deal Breakdown</CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Filter:</span>
              {["all", "green", "yellow", "red"].map((t) => (
                <button
                  key={t}
                  onClick={() => setFilterTier(t)}
                  className={`min-h-11 min-w-11 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    filterTier === t
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                  data-testid={`filter-tier-${t}`}
                >
                  {t === "all" ? "All" : tierLabel[t]}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm" data-testid="text-no-terminal-data">
              <Monitor className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No deals with terminal recommendations found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground">Merchant</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground">Terminal</th>
                    <th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground">Cost</th>
                    <th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground">Monthly GP</th>
                    <th className="text-center py-3 px-4 text-xs font-medium text-muted-foreground">Payback</th>
                    <th className="text-center py-3 px-4 text-xs font-medium text-muted-foreground">Tier</th>
                    <th className="text-center py-3 px-4 text-xs font-medium text-muted-foreground">Approval</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground">Stage</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.dealId} className="border-b last:border-0 hover:bg-muted/30 transition-colors" data-testid={`row-terminal-${row.dealId}`}>
                      <td className="py-3 px-4 font-medium">{row.merchantName}</td>
                      <td className="py-3 px-4 text-muted-foreground">{row.terminalModel || "—"}</td>
                      <td className="py-3 px-4 text-right font-mono">{row.terminalCost === null ? "Unavailable" : `$${row.terminalCost.toFixed(0)}`}</td>
                      <td className="py-3 px-4 text-right font-mono">{row.monthlyGP !== null && row.monthlyGP > 0 ? `$${row.monthlyGP.toFixed(0)}` : "Unavailable"}</td>
                      <td className="py-3 px-4 text-center">
                        {row.paybackMonths != null ? (
                          <span className="inline-flex items-center gap-1 text-xs">
                            <Clock className="w-3.5 h-3.5 opacity-60" />
                            {row.paybackMonths} mo
                          </span>
                        ) : "—"}
                      </td>
                      <td className="py-3 px-4 text-center">{tierBadge(row.tier)}</td>
                      <td className="py-3 px-4 text-center">{approvalBadge(row.terminalApprovalStatus)}</td>
                      <td className="py-3 px-4 text-xs text-muted-foreground">{row.stage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {report && (
        <p className="text-xs text-muted-foreground text-right" data-testid="text-report-generated-at">
          <span>Production recommendations · forecasts only; verified deployment and actual cash recovery unavailable. Details and exports cover page {reportPage + 1} only; tier filter applies to this page.</span>
          <Button variant="outline" disabled={reportPage === 0 || isFetching} onClick={() => setReportPage(page => page - 1)}>Previous</Button>
          <Button variant="outline" disabled={(reportPage + 1) * report.meta.pageSize >= report.meta.total || isFetching} onClick={() => setReportPage(page => page + 1)}>Next</Button>
          Report generated: {new Date(report.generatedAt).toLocaleString()}
          {report.config && (
            <> · Thresholds: ≤{report.config.greenThresholdMonths}mo = green, ≤{report.config.yellowThresholdMonths}mo = yellow</>
          )}
        </p>
      )}

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent data-testid="dialog-threshold-config">
          <DialogHeader>
            <DialogTitle>Payback Threshold Configuration</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Define how many months until a terminal is considered at-risk. Green = low concern, Yellow = caution, Red = requires manager approval.
            </p>
            <div className="space-y-2">
              <Label>Green Threshold (months)</Label>
              <Input
                type="number"
                min={1}
                value={greenThreshold}
                onChange={(e) => setGreenThreshold(e.target.value)}
                placeholder="e.g. 6"
                data-testid="input-green-threshold"
              />
              <p className="text-xs text-muted-foreground">Deals with payback ≤ this many months are flagged green.</p>
            </div>
            <div className="space-y-2">
              <Label>Yellow Threshold (months)</Label>
              <Input
                type="number"
                min={1}
                value={yellowThreshold}
                onChange={(e) => setYellowThreshold(e.target.value)}
                placeholder="e.g. 12"
                data-testid="input-yellow-threshold"
              />
              <p className="text-xs text-muted-foreground">Deals between green and yellow thresholds. Red = beyond yellow threshold.</p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setConfigOpen(false)}>Cancel</Button>
              <Button
                disabled={saveConfigMutation.isPending}
                onClick={() => {
                  const g = parseInt(greenThreshold);
                  const y = parseInt(yellowThreshold);
                  if (!g || !y || g <= 0 || y <= g) {
                    toast({ title: "Yellow threshold must be greater than green threshold", variant: "destructive" });
                    return;
                  }
                  saveConfigMutation.mutate({ greenThresholdMonths: g, yellowThresholdMonths: y });
                }}
                data-testid="button-save-thresholds"
              >
                {saveConfigMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                Save Thresholds
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={modelsOpen} onOpenChange={(o) => { setModelsOpen(o); if (!o) setEditModel(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-equipment-models">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Monitor className="w-5 h-5" />
              Equipment Model Catalog
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b">
                    <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Name</th>
                    <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Category</th>
                    <th className="text-right py-2.5 px-3 text-xs font-medium text-muted-foreground">MSRP</th>
                    <th className="text-right py-2.5 px-3 text-xs font-medium text-muted-foreground">Our Cost</th>
                    <th className="text-center py-2.5 px-3 text-xs font-medium text-muted-foreground">Active</th>
                    <th className="py-2.5 px-3" />
                  </tr>
                </thead>
                <tbody>
                  {(models || []).map((m) => (
                    <tr key={m.id} className="border-b last:border-0" data-testid={`row-model-${m.id}`}>
                      {editModel?.id === m.id ? (
                        <td colSpan={6} className="py-3 px-3">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="col-span-2 sm:col-span-2">
                              <Label className="text-xs">Name</Label>
                              <Input value={editModel.name} onChange={(e) => setEditModel({ ...editModel, name: e.target.value })} data-testid="input-edit-model-name" />
                            </div>
                            <div>
                              <Label className="text-xs">Category</Label>
                              <Input value={editModel.category || ""} onChange={(e) => setEditModel({ ...editModel, category: e.target.value })} data-testid="input-edit-model-category" />
                            </div>
                            <div>
                              <Label className="text-xs">Active</Label>
                              <div className="flex items-center gap-2 mt-1.5">
                                <Switch checked={editModel.isActive} onCheckedChange={(v) => setEditModel({ ...editModel, isActive: v })} data-testid="switch-edit-model-active" />
                                <span className="text-sm">{editModel.isActive ? "Yes" : "No"}</span>
                              </div>
                            </div>
                            <div>
                              <Label className="text-xs">MSRP ($)</Label>
                              <Input type="number" value={editModel.msrp} onChange={(e) => setEditModel({ ...editModel, msrp: Number(e.target.value) })} data-testid="input-edit-model-msrp" />
                            </div>
                            <div>
                              <Label className="text-xs">Our Cost ($)</Label>
                              <Input type="number" value={editModel.libertyCost} onChange={(e) => setEditModel({ ...editModel, libertyCost: Number(e.target.value) })} data-testid="input-edit-model-cost" />
                            </div>
                            <div className="col-span-2 sm:col-span-2 flex gap-2 justify-end pt-1">
                              <Button size="sm" variant="outline" onClick={() => setEditModel(null)}>Cancel</Button>
                              <Button
                                size="sm"
                                disabled={updateModelMutation.isPending}
                                onClick={() => updateModelMutation.mutate({
                                  id: editModel.id,
                                  name: editModel.name,
                                  category: editModel.category || "Terminal",
                                  msrp: editModel.msrp,
                                  libertyCost: editModel.libertyCost,
                                  isActive: editModel.isActive,
                                })}
                                data-testid="button-save-model"
                              >
                                {updateModelMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                              </Button>
                            </div>
                          </div>
                        </td>
                      ) : (
                        <>
                          <td className="py-2.5 px-3 font-medium">{m.name}</td>
                          <td className="py-2.5 px-3 text-muted-foreground">{m.category}</td>
                          <td className="py-2.5 px-3 text-right font-mono">${m.msrp.toFixed(0)}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-primary">${m.libertyCost.toFixed(0)}</td>
                          <td className="py-2.5 px-3 text-center">
                            {m.isActive ? <CheckCircle2 className="w-4 h-4 text-green-600 mx-auto" /> : <span className="text-muted-foreground text-xs">Off</span>}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-1 justify-end">
                              <Button size="icon" variant="ghost" aria-label="Edit model" onClick={() => setEditModel(m)} data-testid={`button-edit-model-${m.id}`}>
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button size="icon" variant="ghost" aria-label="Delete model" onClick={() => { if (confirm(`Delete "${m.name}"?`)) deleteModelMutation.mutate(m.id); }} data-testid={`button-delete-model-${m.id}`}>
                                <Trash2 className="w-3.5 h-3.5 text-red-500" />
                              </Button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
              <h4 className="text-sm font-semibold flex items-center gap-1.5"><Plus className="w-4 h-4" /> Add New Model</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="col-span-2 sm:col-span-2">
                  <Label className="text-xs">Name</Label>
                  <Input value={newModelForm.name} onChange={(e) => setNewModelForm({ ...newModelForm, name: e.target.value })} placeholder="e.g. Clover Flex 3" data-testid="input-new-model-name" />
                </div>
                <div>
                  <Label className="text-xs">Category</Label>
                  <Input value={newModelForm.category} onChange={(e) => setNewModelForm({ ...newModelForm, category: e.target.value })} data-testid="input-new-model-category" />
                </div>
                <div>
                  <Label className="text-xs">Description</Label>
                  <Input value={newModelForm.description} onChange={(e) => setNewModelForm({ ...newModelForm, description: e.target.value })} data-testid="input-new-model-description" />
                </div>
                <div>
                  <Label className="text-xs">MSRP ($)</Label>
                  <Input type="number" value={newModelForm.msrp} onChange={(e) => setNewModelForm({ ...newModelForm, msrp: e.target.value })} data-testid="input-new-model-msrp" />
                </div>
                <div>
                  <Label className="text-xs">Our Cost ($)</Label>
                  <Input type="number" value={newModelForm.libertyCost} onChange={(e) => setNewModelForm({ ...newModelForm, libertyCost: e.target.value })} data-testid="input-new-model-cost" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!newModelForm.name || createModelMutation.isPending}
                  onClick={() => createModelMutation.mutate(newModelForm)}
                  className="gap-1.5"
                  data-testid="button-add-model"
                >
                  {createModelMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add Model
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
