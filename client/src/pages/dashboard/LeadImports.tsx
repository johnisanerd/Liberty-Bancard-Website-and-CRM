import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCrmQuery } from "@/hooks/use-crm-query";
import { queryClient, getCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { DataState } from "@/components/ui/data-state";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Loader2,
  TrendingUp, Users, Database, BarChart3, Flame, Thermometer, Snowflake,
  Calendar, ArrowRight, FileText, RefreshCw, ListChecks, OctagonAlert,
  ShieldCheck, Trash2, ChevronRight, Archive, ClipboardList,
  Sparkles, CloudDownload, Info, ExternalLink,
} from "lucide-react";
import type { ProspectList } from "@shared/schema";
import type { CsvImport, MasterLeadBatch } from "@shared/schema";
import { importDispositionCompatibility, type ImportDisposition } from "@shared/import-disposition-summary";

/** Normalize opt-out counts from either camelCase or snake_case API responses. */
function normalizeOptOut(data: Record<string, unknown>): { optOutPreserved: number; optOutApplied: number } {
  return {
    optOutPreserved: Number(data.optOutPreserved ?? data.opt_out_preserved ?? 0),
    optOutApplied: Number(data.optOutApplied ?? data.opt_out_applied ?? 0),
  };
}

function formatDate(date: string | Date | null | undefined) {
  if (!date) return "--";
  return new Date(date).toLocaleString();
}

function getStatusBadge(status: string | null) {
  switch (status) {
    case "completed":
      return <Badge variant="default" className="bg-green-600" data-testid="badge-status-completed"><CheckCircle2 className="h-3 w-3 mr-1" />Completed</Badge>;
    case "processing":
      return <Badge variant="default" className="bg-blue-600" data-testid="badge-status-processing"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Processing</Badge>;
    case "failed":
      return <Badge variant="destructive" data-testid="badge-status-failed"><AlertCircle className="h-3 w-3 mr-1" />Failed</Badge>;
    case "interrupted":
      return <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400" data-testid="badge-status-interrupted"><OctagonAlert className="h-3 w-3 mr-1" />Interrupted</Badge>;
    case "legacy_interrupted":
      return <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400" data-testid="badge-status-legacy-interrupted"><OctagonAlert className="h-3 w-3 mr-1" />Legacy (Partial)</Badge>;
    case "stale":
      return <Badge variant="outline" className="border-orange-500 text-orange-700 dark:text-orange-400" data-testid="badge-status-stale"><OctagonAlert className="h-3 w-3 mr-1" />Stale</Badge>;
    default:
      return <Badge variant="outline" data-testid="badge-status-unknown">{status || "unknown"}</Badge>;
  }
}

const INTERRUPTED_STATUSES = new Set(["interrupted", "legacy_interrupted", "stale"]);

/** Returns true when the duplicate/invalid/skipped/errors buckets cannot be
 *  trusted (they are null or the import is a legacy_interrupted record where
 *  they were never computed). Used to render "—" instead of 0. */
function hasUnknownBuckets(imp: CsvImport): boolean {
  if (imp.status === "legacy_interrupted") return true;
  if (INTERRUPTED_STATUSES.has(imp.status ?? "")) {
    return imp.duplicatesSkipped == null || imp.invalidRows == null;
  }
  return false;
}

function fmtOrUnknown(value: number | null | undefined, imp: CsvImport): string {
  if (hasUnknownBuckets(imp) && value == null) return "—";
  return (value ?? 0).toLocaleString();
}

function durableDispositionOutcomes(imp: CsvImport) {
  const row = imp as CsvImport & { dispositionCounts?: Partial<Record<ImportDisposition, number>> };
  return importDispositionCompatibility(row.dispositionCounts ?? {
    created: imp.newRecords,
    matched_noop: imp.duplicatesSkipped,
    updated: imp.updatedRecords,
    rejected: imp.invalidRows,
    deferred: imp.skippedRows,
    failed: imp.errorsCount,
  });
}

function getOutcomeSummary(imp: CsvImport): { label: string; className: string } {
  if (imp.status === "failed") {
    return { label: "Import failed — server/API error", className: "text-red-600 dark:text-red-400" };
  }
  if (imp.status === "processing") {
    const processed = imp.processedRows ?? 0;
    if (processed > 0 && imp.lastProgressAt) {
      const ageSec = Math.round((Date.now() - new Date(imp.lastProgressAt).getTime()) / 1000);
      const ageText = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
      return { label: `In progress — ${processed.toLocaleString()} rows processed (last progress ${ageText})`, className: "text-blue-600 dark:text-blue-400" };
    }
    if (processed > 0) {
      return { label: `In progress — ${processed.toLocaleString()} rows processed so far`, className: "text-blue-600 dark:text-blue-400" };
    }
    return { label: "Processing...", className: "text-blue-600 dark:text-blue-400" };
  }
  if (INTERRUPTED_STATUSES.has(imp.status ?? "")) {
    const created = imp.newRecords ?? 0;
    const processed = imp.processedRows ?? created;
    const total = imp.totalRows ?? 0;
    const unprocessed = total > 0 ? Math.max(0, total - processed) : null;
    const isUnknownBuckets = imp.status === "legacy_interrupted" || (imp.duplicatesSkipped == null && imp.invalidRows == null);
    let label = `Created: ${created.toLocaleString()}`;
    if (unprocessed !== null && unprocessed > 0) {
      label += ` | Unprocessed (import interrupted): ${unprocessed.toLocaleString()}`;
    }
    if (isUnknownBuckets) {
      label += " | Already Exists: unavailable | Invalid: unavailable";
    }
    return { label, className: "text-amber-600 dark:text-amber-400" };
  }
  const total = imp.totalRows ?? 0;
  if (total === 0) return { label: "--", className: "text-muted-foreground" };

  const newRecords = imp.newRecords ?? 0;
  const alreadyExists = (imp.duplicatesSkipped ?? 0) + (imp.skippedRows ?? 0);
  const invalidOrErrored = (imp.invalidRows ?? 0) + (imp.errorsCount ?? 0);

  if (newRecords === 0 && alreadyExists > 0 && invalidOrErrored === 0) {
    return {
      label: `Processed successfully — no new contacts, ${alreadyExists.toLocaleString()} already exist`,
      className: "text-blue-600 dark:text-blue-400",
    };
  }
  if (newRecords === 0 && invalidOrErrored === total) {
    return { label: "Completed — all rows invalid", className: "text-amber-600 dark:text-amber-400" };
  }
  if (invalidOrErrored > 0) {
    return {
      label: `${newRecords.toLocaleString()} new, ${invalidOrErrored.toLocaleString()} invalid`,
      className: "text-amber-600 dark:text-amber-400",
    };
  }
  return { label: `${newRecords.toLocaleString()} new contacts added`, className: "text-green-600 dark:text-green-400" };
}

function VerticalBreakdownChart({ breakdown }: { breakdown: Record<string, number> | null }) {
  if (!breakdown || Object.keys(breakdown).length === 0) return null;

  const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);

  const verticalColors: Record<string, string> = {
    "Restaurant": "bg-orange-500",
    "Auto": "bg-blue-500",
    "Healthcare": "bg-green-500",
    "Salon/Spa": "bg-pink-500",
    "Construction": "bg-yellow-600",
    "Retail": "bg-purple-500",
    "Legal": "bg-slate-600",
    "Technology": "bg-cyan-500",
    "Real Estate": "bg-emerald-500",
    "Fitness/Recreation": "bg-red-500",
    "Food/Beverage": "bg-amber-500",
    "Professional Services": "bg-indigo-500",
    "Other": "bg-gray-400",
  };

  return (
    <div className="space-y-2" data-testid="vertical-breakdown">
      {sorted.slice(0, 10).map(([vertical, count]) => {
        const pct = Math.round((count / total) * 100);
        const color = verticalColors[vertical] || "bg-gray-400";
        return (
          <div key={vertical} className="space-y-1" data-testid={`vertical-item-${vertical.toLowerCase().replace(/[/ ]/g, "-")}`}>
            <div className="flex justify-between text-xs">
              <span className="font-medium">{vertical}</span>
              <span className="text-muted-foreground">{count.toLocaleString()} ({pct}%)</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
      {sorted.length > 10 && (
        <p className="text-xs text-muted-foreground">+{sorted.length - 10} more verticals</p>
      )}
    </div>
  );
}

const LEAD_SOURCES = [
  { value: "google_ads", label: "Google Ads" },
  { value: "sunbiz", label: "Sunbiz / FL Secretary of State" },
  { value: "imported_list", label: "Purchased / Imported List" },
  { value: "referral", label: "Referral" },
  { value: "outbound", label: "Outbound Prospecting" },
] as const;

const READINESS_STAGES = [
  { key: "uploaded", label: "Uploaded", description: "File received, not yet mapped" },
  { key: "mapped", label: "Mapped", description: "Columns mapped to contact fields" },
  { key: "validated", label: "Validated", description: "Email/phone validation complete" },
  { key: "scored", label: "Scored", description: "Lead scoring applied" },
  { key: "suppressed", label: "Suppressed", description: "DNC, duplicates, and unsubscribes removed" },
  { key: "ready", label: "Ready", description: "Approved for controlled cohort enrollment" },
] as const;

type ReadinessState = typeof READINESS_STAGES[number]["key"];

function ReadinessPipeline({ list, onAdvance, isPending }: {
  list: ProspectList;
  onAdvance: (state: ReadinessState) => void;
  isPending: boolean;
}) {
  const currentIdx = READINESS_STAGES.findIndex(s => s.key === (list as any).readinessState);
  const effectiveIdx = currentIdx >= 0 ? currentIdx : 0;

  return (
    <div className="space-y-2" data-testid={`pipeline-${list.id}`}>
      <div className="flex items-center gap-1 flex-wrap">
        {READINESS_STAGES.map((stage, idx) => {
          const done = idx < effectiveIdx;
          const current = idx === effectiveIdx;
          return (
            <div key={stage.key} className="flex items-center gap-1">
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border ${
                  done
                    ? "bg-green-100 border-green-300 text-green-800 dark:bg-green-900/30 dark:border-green-700 dark:text-green-300"
                    : current
                    ? "bg-blue-100 border-blue-300 text-blue-800 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-300"
                    : "bg-muted border-muted text-muted-foreground"
                }`}
                title={stage.description}
                data-testid={`stage-${stage.key}-${list.id}`}
              >
                {done ? <CheckCircle2 className="h-3 w-3" /> : current ? <ClipboardList className="h-3 w-3" /> : null}
                {stage.label}
              </div>
              {idx < READINESS_STAGES.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
            </div>
          );
        })}
      </div>
      {effectiveIdx < READINESS_STAGES.length - 1 && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onAdvance(READINESS_STAGES[effectiveIdx + 1].key)}
          disabled={isPending}
          data-testid={`btn-advance-${list.id}`}
        >
          {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowRight className="h-3 w-3 mr-1" />}
          Advance to {READINESS_STAGES[effectiveIdx + 1].label}
        </Button>
      )}
      {effectiveIdx === READINESS_STAGES.length - 1 && (
        <Badge className="bg-green-600 text-xs" data-testid={`badge-ready-${list.id}`}>
          <CheckCircle2 className="h-3 w-3 mr-1" />Ready for controlled cohort
        </Badge>
      )}
    </div>
  );
}

// ─── Master Lead Import Component ───────────────────────────────────────────

function statusColor(status: string) {
  switch (status) {
    case "completed": return "bg-green-600";
    case "processing": return "bg-blue-600";
    case "failed": return "bg-red-600";
    default: return "bg-gray-400";
  }
}

type WizardStep = "choose" | "review" | "result";
const HEADER_TARGETS: Array<{ label: string; match: RegExp }> = [
  { label: "Business name", match: /^(company|company name|business|business name|name|organization)$/ },
  { label: "Email", match: /^(email|e-mail|email address|owner email)$/ },
  { label: "Phone", match: /^(phone|telephone|phone number|mobile)$/ },
  { label: "Category / vertical", match: /^(category|type|industry|vertical|subtypes)$/ },
  { label: "Address", match: /^(address|full address|street|city|state|zip|postal code)$/ },
  { label: "Website", match: /^(website|site|domain|url)$/ },
  { label: "First / last name", match: /^(first name|last name|owner name|full name)$/ },
];
/** Header-only preview of a CSV (first 64 KB). Returns null when the file cannot be read as text. */
export function parseCsvHeader(text: string): string[] | null {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  if (!line.trim()) return null;
  const cells: string[] = [];
  let cell = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell.trim()); cell = ""; }
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells.filter(Boolean);
}
export function describeHeader(header: string): string {
  const key = header.toLowerCase().trim();
  return HEADER_TARGETS.find(t => t.match.test(key))?.label ?? "Kept only in the original row";
}

function MasterLeadImportSection() {
  const { toast } = useToast();
  const [sheetId, setSheetId] = useState("");
  const [tabName, setTabName] = useState("CRM Staging");
  const [apiTestResult, setApiTestResult] = useState<{
    success?: boolean;
    apiError?: string;
    rowCount?: number;
    headers?: string[];
  } | null>(null);
  const [testingApi, setTestingApi] = useState(false);
  const [csvDragging, setCsvDragging] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);

  // Poll active batch
  const { data: activeBatch } = useCrmQuery<MasterLeadBatch>({
    queryKey: ["/api/master-leads/batches", activeBatchId],
    queryFn: async ({ signal }) => {
      if (!activeBatchId) throw new Error("no batch");
      const r = await fetch(`/api/master-leads/batches/${activeBatchId}`, { credentials: "include", signal });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: !!activeBatchId,
    refetchInterval: (q) => {
      const data = q.state.data as MasterLeadBatch | undefined;
      return data?.status === "processing" ? 2000 : false;
    },
  });

  // All batches list
  const { data: batches = [], refetch: refetchBatches } = useCrmQuery<MasterLeadBatch[]>({
    queryKey: ["/api/master-leads/batches"],
  });

  useEffect(() => {
    if (activeBatch && activeBatch.status !== "processing") {
      refetchBatches();
    }
  }, [activeBatch?.status]);

  // Test Sheets API
  async function testSheetsApi() {
    if (!sheetId.trim()) {
      toast({ title: "Sheet ID required", variant: "destructive" });
      return;
    }
    setTestingApi(true);
    setApiTestResult(null);
    try {
      const csrf = getCsrfToken();
      const r = await fetch("/api/master-leads/try-sheets-api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ sheetId: sheetId.trim(), tabName }),
      });
      const data = await r.json();
      setApiTestResult(data);
    } catch (err: any) {
      setApiTestResult({ success: false, apiError: err.message });
    } finally {
      setTestingApi(false);
    }
  }

  // Import from Sheets API
  const sheetImportMutation = useMutation({
    mutationFn: async () => {
      const csrf = getCsrfToken();
      const r = await fetch("/api/master-leads/import-from-sheet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          sheetId: sheetId.trim(),
          tabName,
          sheetName: "Liberty Bancard Priority Domain Enrichment - 2026-07-20",
        }),
      });
      if (!r.ok) throw new Error((await r.json()).message);
      return r.json() as Promise<{ batchId: string }>;
    },
    onSuccess: (data) => {
      setActiveBatchId(data.batchId);
      toast({ title: "Import started", description: "Processing 23,464 rows in the background…" });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  // CSV upload mutation
  const csvImportMutation = useMutation({
    mutationFn: async (file: File) => {
      const csrf = getCsrfToken();
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sheetName", "Liberty Bancard Priority Domain Enrichment - 2026-07-20");
      fd.append("tabName", "CRM Staging");
      const r = await fetch("/api/master-leads/import-csv", {
        method: "POST",
        headers: csrf ? { "X-CSRF-Token": csrf } : {},
        credentials: "include",
        body: fd,
      });
      if (!r.ok) throw new Error((await r.json()).message);
      return r.json() as Promise<{ batchId: string; totalRows: number }>;
    },
    onSuccess: (data) => {
      setActiveBatchId(data.batchId);
      setCsvFile(null);
      toast({ title: "CSV import started", description: `${data.totalRows.toLocaleString()} rows processing…` });
    },
    onError: (err: Error) => {
      toast({ title: "CSV import failed", description: err.message, variant: "destructive" });
    },
  });

  const handleCsvFile = (f: File | null) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) {
      toast({ title: "Invalid file", description: "Please upload a CSV file", variant: "destructive" });
      return;
    }
    setCsvFile(f);
  };

  return (
    <Card data-testid="card-master-lead-import" className="border-2 border-blue-200 dark:border-blue-900">
      <CardHeader className="bg-blue-50 dark:bg-blue-950/30 rounded-t-lg">
        <CardTitle className="flex items-center gap-2 text-blue-800 dark:text-blue-300">
          <Sparkles className="h-5 w-5" />
          Priority Lead Sheet Import — Liberty Bancard 2026-07-20
          <Badge className="bg-blue-600 text-white ml-2">23,464 rows</Badge>
        </CardTitle>
        <p className="text-sm text-blue-700 dark:text-blue-400 mt-1">
          Staged import only — no enrollment or outbound. Rows land in <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">master_leads</code> with deduplication and suppression checks.
        </p>
      </CardHeader>
      <CardContent className="pt-5 space-y-5">

        {/* Step 1 — Try Google Sheets API */}
        <div className="space-y-3">
          <h3 className="font-semibold flex items-center gap-2">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white text-xs">1</span>
            Attempt Direct Google Sheets Access
          </h3>
          <p className="text-sm text-muted-foreground">
            Enter the Sheet ID (from the URL: <code className="bg-muted px-1 rounded">…/spreadsheets/d/<strong>SHEET_ID</strong>/edit</code>) and test API access.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="Google Sheet ID (e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms)"
              value={sheetId}
              onChange={(e) => setSheetId(e.target.value)}
              className="flex-1 font-mono text-sm"
              data-testid="input-sheet-id"
            />
            <Input
              placeholder="Tab name"
              value={tabName}
              onChange={(e) => setTabName(e.target.value)}
              className="w-40"
              data-testid="input-tab-name"
            />
            <Button
              onClick={testSheetsApi}
              disabled={testingApi || !sheetId.trim()}
              variant="outline"
              data-testid="btn-test-sheets-api"
            >
              {testingApi ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ExternalLink className="h-4 w-4 mr-2" />}
              Test API Access
            </Button>
          </div>

          {apiTestResult && (
            <div className={`rounded-lg p-4 border ${apiTestResult.success ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800" : "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800"}`}>
              {apiTestResult.success ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-400 font-medium">
                    <CheckCircle2 className="h-4 w-4" />
                    API access confirmed — {apiTestResult.rowCount?.toLocaleString()} rows found
                  </div>
                  <p className="text-xs text-muted-foreground">Headers: {apiTestResult.headers?.join(", ")}</p>
                  <Button
                    onClick={() => sheetImportMutation.mutate()}
                    disabled={sheetImportMutation.isPending}
                    className="mt-2"
                    data-testid="btn-import-from-sheet"
                  >
                    {sheetImportMutation.isPending
                      ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Starting…</>
                      : <><CloudDownload className="h-4 w-4 mr-2" />Import All {apiTestResult.rowCount?.toLocaleString()} Rows</>}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium">
                    <AlertCircle className="h-4 w-4" />
                    Google Sheets API access failed — use CSV export below
                  </div>
                  <p className="text-xs font-mono bg-amber-100 dark:bg-amber-900/40 rounded p-2 mt-1 break-all">
                    {apiTestResult.apiError}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Step 2 — CSV Fallback */}
        <div className="space-y-3 border-t pt-4">
          <h3 className="font-semibold flex items-center gap-2">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-slate-500 text-white text-xs">2</span>
            CSV Fallback — Export &amp; Upload
          </h3>

          <div className="bg-slate-50 dark:bg-slate-900/30 rounded-lg p-4 border space-y-3">
            <div className="flex items-start gap-2 text-sm">
              <Info className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">How to export the sheet as CSV:</p>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-xs">
                  <li>Open the sheet: <strong>Liberty Bancard Priority Domain Enrichment - 2026-07-20</strong></li>
                  <li>Switch to the <strong>CRM Staging</strong> tab</li>
                  <li>Click <strong>File → Download → Comma Separated Values (.csv)</strong></li>
                  <li>Drag and drop the downloaded file into the upload zone below</li>
                </ol>
                <p className="text-xs text-muted-foreground mt-1">
                  Expected columns (auto-mapped): Company, Normalized_Company, Domain, Email, Email_Type, Phone, Normalized_Phone, Contact_Name, Contact_Title, Merchant_Vertical, Liberty_Quality_Score, Liberty_Fit_Tier, Outreach_Readiness, Readiness_Reason, Source, Source_Path, Source_Modified_Date
                </p>
              </div>
            </div>
          </div>

          <div
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${csvDragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20" : "border-border hover:border-muted-foreground/50"}`}
            onDragOver={(e) => { e.preventDefault(); setCsvDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setCsvDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setCsvDragging(false); handleCsvFile(e.dataTransfer.files[0] || null); }}
            onClick={() => csvRef.current?.click()}
            data-testid="dropzone-master-leads-csv"
          >
            <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => handleCsvFile(e.target.files?.[0] || null)} />
            {csvFile ? (
              <div className="flex items-center justify-center gap-3">
                <FileSpreadsheet className="h-8 w-8 text-green-600" />
                <div>
                  <p className="font-medium" data-testid="text-master-leads-filename">{csvFile.name}</p>
                  <p className="text-sm text-muted-foreground">{(csvFile.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-10 w-10 text-muted-foreground" />
                <p className="font-medium">Drop the exported CSV here, or click to browse</p>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              onClick={() => csvFile && csvImportMutation.mutate(csvFile)}
              disabled={!csvFile || csvImportMutation.isPending}
              data-testid="btn-import-master-leads-csv"
            >
              {csvImportMutation.isPending
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Importing…</>
                : <><Upload className="h-4 w-4 mr-2" />Import CSV</>}
            </Button>
            {csvFile && (
              <Button variant="outline" onClick={() => setCsvFile(null)}>Clear</Button>
            )}
          </div>
        </div>

        {/* Active batch progress */}
        {activeBatch && (
          <div className="border-t pt-4 space-y-3" data-testid="card-active-batch-progress">
            <h3 className="font-semibold flex items-center gap-2">
              {activeBatch.status === "processing"
                ? <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                : activeBatch.status === "completed"
                ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                : <AlertCircle className="h-4 w-4 text-red-500" />}
              Import Progress — {activeBatch.batchName}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Staged", value: activeBatch.stagedCount ?? 0, color: "text-green-600 dark:text-green-400" },
                { label: "Duplicate", value: activeBatch.duplicateCount ?? 0, color: "text-blue-600 dark:text-blue-400" },
                { label: "Suppressed", value: activeBatch.suppressedCount ?? 0, color: "text-amber-600 dark:text-amber-400" },
                { label: "Invalid", value: activeBatch.invalidCount ?? 0, color: "text-red-600 dark:text-red-400" },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-lg border p-3 space-y-1">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-xl font-bold ${color}`}>{value.toLocaleString()}</p>
                </div>
              ))}
            </div>
            {activeBatch.totalRows && activeBatch.totalRows > 0 && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Staged</span>
                  <span>{((activeBatch.stagedCount ?? 0) / activeBatch.totalRows * 100).toFixed(1)}% of {activeBatch.totalRows.toLocaleString()} rows</span>
                </div>
                <Progress value={((activeBatch.stagedCount ?? 0) + (activeBatch.duplicateCount ?? 0) + (activeBatch.suppressedCount ?? 0) + (activeBatch.invalidCount ?? 0)) / activeBatch.totalRows * 100} />
              </div>
            )}
            {activeBatch.status === "failed" && (
              <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 rounded p-2">
                Error: {activeBatch.errorMessage}
              </p>
            )}
            {activeBatch.status === "completed" && (
              <p className="text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 rounded p-2">
                ✓ Import complete. Batch ID: <code className="font-mono">{activeBatch.id}</code> · Sheet: {activeBatch.sheetName} · Tab: {activeBatch.tabName}
              </p>
            )}
          </div>
        )}

        {/* Batch history */}
        {batches.length > 0 && (
          <div className="border-t pt-4 space-y-3" data-testid="card-master-lead-batches">
            <h3 className="font-semibold flex items-center gap-2">
              <Database className="h-4 w-4" />
              Import Batch History
            </h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch Name</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Staged</TableHead>
                    <TableHead>Duplicate</TableHead>
                    <TableHead>Suppressed</TableHead>
                    <TableHead>Invalid</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow key={b.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setActiveBatchId(b.id)}>
                      <TableCell className="max-w-[200px] truncate font-medium">{b.batchName}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{(b.sourceMethod ?? "csv_upload").replace(/_/g, " ")}</Badge>
                      </TableCell>
                      <TableCell>{(b.totalRows ?? 0).toLocaleString()}</TableCell>
                      <TableCell className="text-green-600 dark:text-green-400 font-medium">{(b.stagedCount ?? 0).toLocaleString()}</TableCell>
                      <TableCell className="text-blue-600 dark:text-blue-400">{(b.duplicateCount ?? 0).toLocaleString()}</TableCell>
                      <TableCell className="text-amber-600 dark:text-amber-400">{(b.suppressedCount ?? 0).toLocaleString()}</TableCell>
                      <TableCell className="text-red-600 dark:text-red-400">{(b.invalidCount ?? 0).toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge className={statusColor(b.status ?? "processing")}>{b.status}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {b.importedAt ? new Date(b.importedAt).toLocaleString() : "--"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main LeadImports Page ───────────────────────────────────────────────────

/** An unavailable statistic is shown as a dash, never as zero. */
const fmtStat = (v: number | undefined) => (typeof v === "number" ? v.toLocaleString() : "—");

export default function LeadImports() {
  const { toast } = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedLeadSource, setSelectedLeadSource] = useState<string>("");
  const [wizardStep, setWizardStep] = useState<WizardStep>("choose");
  const [headerPreview, setHeaderPreview] = useState<{ state: "none" | "reading" | "xlsx" | "unreadable" | "ready"; columns: string[] }>({ state: "none", columns: [] });
  const [lastResult, setLastResult] = useState<{ fileName: string; source: string; status: string | null; totalRows: number | null; summary: string } | null>(null);
  const [expandedImport, setExpandedImport] = useState<number | null>(null);
  const [showArchivedLists, setShowArchivedLists] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    data: importsRaw,
    isLoading: importsLoading,
    isError: importsError,
    error: importsErrorObj,
    refetch: refetchImports,
  } = useCrmQuery<CsvImport[]>({
    queryKey: ["/api/csv-imports"],
    refetchInterval: (query) => query.state.data?.some(imp => imp.status === "processing") ? 15_000 : false,
  });
  const imports = Array.isArray(importsRaw) ? importsRaw : [];

  const { data: importStats, isError: statsError, refetch: refetchStats, isFetching: statsFetching } = useCrmQuery<{
    totalImports: number;
    totalRowsProcessed: number;
    totalRecordsImported: number;
    totalDuplicatesSkipped: number;
    totalSkippedRows: number;
    totalAlreadyExists: number;
    totalInvalidRows: number;
    totalErrors: number;
    totalDealsCreated: number;
    totalHot: number;
    totalWarm: number;
    verticalBreakdown: Record<string, number>;
  }>({
    queryKey: ["/api/csv-imports/stats"],
  });

  const { data: prospectListsRaw, isLoading: prospectListsLoading } = useCrmQuery<ProspectList[]>({
    queryKey: ["/api/prospect-lists", showArchivedLists ? "archived" : "active"],
    queryFn: async ({ signal }) => {
      const url = showArchivedLists ? "/api/prospect-lists?includeArchived=true" : "/api/prospect-lists";
      const res = await fetch(url, { credentials: "include", signal });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
  });
  const prospectLists = Array.isArray(prospectListsRaw) ? prospectListsRaw : [];

  const advanceReadinessMutation = useMutation({
    mutationFn: async ({ listId, state }: { listId: number; state: string }) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch(`/api/prospect-lists/${listId}/readiness`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ state }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Request failed" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: (_, { state }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospect-lists"] });
      const stage = READINESS_STAGES.find(s => s.key === state);
      toast({ title: "Stage advanced", description: `List moved to: ${stage?.label || state}` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to advance stage", description: err.message, variant: "destructive" });
    },
  });

  const archiveListMutation = useMutation({
    mutationFn: async (listId: number) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch(`/api/prospect-lists/${listId}/archive`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ reason: "manual_archive" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Request failed" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospect-lists"] });
      toast({ title: "List archived", description: "The prospect list has been archived." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to archive", description: err.message, variant: "destructive" });
    },
  });

  const markInterruptedMutation = useMutation({
    mutationFn: async (importId: number) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch(`/api/csv-imports/${importId}/mark-interrupted`, {
        method: "POST",
        headers,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Request failed" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/csv-imports"] });
      toast({ title: "Import marked as interrupted", description: "The stuck import has been marked interrupted." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch("/api/leads/import-csv", {
        method: "POST",
        body: formData,
        headers,
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(error.message);
      }
      return res.json();
    },
    onSuccess: (data, formData) => {
      queryClient.invalidateQueries({ queryKey: ["/api/csv-imports"] });
      queryClient.invalidateQueries({ queryKey: ["/api/csv-imports/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      const accepted = formData.get("file");
      setLastResult({
        fileName: accepted instanceof File ? accepted.name : "uploaded file",
        source: String(formData.get("leadSource") ?? ""),
        status: typeof data.status === "string" ? data.status : null,
        totalRows: Number.isFinite(Number(data.totalRows)) ? Number(data.totalRows) : null,
        summary: data.status === "processing"
          ? "Original rows accepted; processing continues in the background. Accepted is not completed."
          : "The server returned a final summary; the per-import record below is the authority.",
      });
      setWizardStep("result");
      setHeaderPreview({ state: "none", columns: [] });
      setSelectedFile(null);
      setSelectedLeadSource("");
      if (fileInputRef.current) fileInputRef.current.value = "";

      if (data.status === "processing") {
        toast({
          title: "Import Processing",
          description: `${Number(data.totalRows).toLocaleString()} original rows accepted. Processing continues automatically; progress is shown in Import History. This is not a completed import.`,
        });
        return;
      }
      const inserted = data.inserted || 0;
      const alreadyExists = (data.duplicatesSkipped || 0) + (data.skippedRows || 0);
      const invalidOrErrored = (data.invalidRows || 0) + (data.errors || 0);
      const { optOutPreserved, optOutApplied } = normalizeOptOut(data as Record<string, unknown>);

      const deferredToStaging = data.deferredToStaging || 0;

      let title = "Import Complete";
      let description = `${inserted.toLocaleString()} new contact(s) imported. ${data.dealsCreated || 0} deal(s) created. Format: ${data.sourceFormat?.replace(/_/g, " ")}`;

      if (deferredToStaging > 0 && inserted === 0) {
        // Outscraper / Apollo rows go to compliance staging — not directly to contacts
        title = "Rows Staged for Compliance Review";
        description = `${deferredToStaging.toLocaleString()} row(s) from this ${data.sourceFormat?.replace(/_/g, " ")} file were queued for qualification review. Go to Lead Ops Center → South Florida Qualification to promote them to contacts.`;
      } else if (deferredToStaging > 0) {
        description += ` ${deferredToStaging.toLocaleString()} row(s) staged for compliance review (Lead Ops Center).`;
      } else if (inserted === 0 && alreadyExists > 0) {
        title = "Import Processed — No New Contacts";
        description = `All ${alreadyExists.toLocaleString()} row(s) already exist in your CRM — no new contacts were added.`;
        if (invalidOrErrored > 0) {
          description += ` ${invalidOrErrored.toLocaleString()} row(s) were invalid or skipped.`;
        }
      } else if (invalidOrErrored > 0) {
        description += ` ${invalidOrErrored.toLocaleString()} row(s) were invalid or skipped.`;
      }

      if (optOutPreserved > 0 || optOutApplied > 0) {
        const parts: string[] = [];
        if (optOutPreserved > 0) parts.push(`${optOutPreserved.toLocaleString()} existing opt-out${optOutPreserved !== 1 ? "s" : ""} preserved`);
        if (optOutApplied > 0) parts.push(`${optOutApplied.toLocaleString()} new opt-out${optOutApplied !== 1 ? "s" : ""} applied`);
        description += ` · Opt-out protection: ${parts.join(" · ")}.`;
      }

      toast({ title, description });
    },
    onError: (err: Error) => {
      toast({ title: "Import Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileSelect = (file: File | null) => {
    if (!file) return;
    const isValid = /\.(csv|xlsx)$/i.test(file.name);
    if (!isValid) {
      toast({ title: "Invalid file type", description: "Please upload a CSV or XLSX file.", variant: "destructive" });
      return;
    }
    setSelectedFile(file);
    setWizardStep("choose");
    setLastResult(null);
    if (/\.xlsx$/i.test(file.name)) { setHeaderPreview({ state: "xlsx", columns: [] }); return; }
    setHeaderPreview({ state: "reading", columns: [] });
    file.slice(0, 65536).text().then(text => {
      const columns = parseCsvHeader(text);
      setHeaderPreview(columns ? { state: "ready", columns } : { state: "unreadable", columns: [] });
    }).catch(() => setHeaderPreview({ state: "unreadable", columns: [] }));
  };

  const handleUpload = () => {
    if (!selectedFile) return;
    if (!selectedLeadSource) {
      toast({ title: "Source required", description: "Please select the lead source before importing.", variant: "destructive" });
      return;
    }
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("leadSource", selectedLeadSource);
    uploadMutation.mutate(formData);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFileSelect(file || null);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Lead Imports</h2>
        <p className="text-muted-foreground mt-1" data-testid="text-page-description">
          Import CSV or XLSX files from Outscraper, Apollo, or other sources. Original rows are retained for recovery. Provider evidence is not email validation, enrollment, or outreach.
        </p>
      </div>

      <ol className="grid gap-2 sm:grid-cols-3" aria-label="Import steps" data-testid="import-steps">
        {[
          { id: "choose" as const, n: 1, title: "Choose source and file", detail: "CSV or XLSX with a named lead source. Choosing a file sends nothing." },
          { id: "review" as const, n: 2, title: "Review and upload", detail: "Check the detected columns, then upload. Original bytes and rows are retained first." },
          { id: "result" as const, n: 3, title: "Read the result", detail: "Accepted is not complete. Completion, row errors and recovery are per import below; none of it is a deal or a delivered email." },
        ].map(step => {
          const order = ["choose", "review", "result"];
          const state = order.indexOf(step.id) < order.indexOf(wizardStep) ? "done" : step.id === wizardStep ? "current" : "upcoming";
          return (
            <li key={step.id} className="rounded-lg border p-3 text-sm" aria-current={state === "current" ? "step" : undefined} data-testid={`import-step-${step.id}`} data-state={state}>
              <p className="font-medium">{step.n}. {step.title}{state === "done" ? " (done)" : state === "current" ? (step.id === "review" && uploadMutation.isPending ? " (uploading)" : " (current)") : ""}</p>
              <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>
            </li>
          );
        })}
      </ol>

      <Card data-testid="card-upload-section">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import CSV
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {wizardStep === "choose" && (
            <>
          {/* Required: lead source selection */}
          <div>
            <label className="text-sm font-medium mb-1.5 block" htmlFor="lead-source-select">
              Lead Source <span className="text-destructive">*</span>
            </label>
            <Select value={selectedLeadSource} onValueChange={setSelectedLeadSource}>
              <SelectTrigger id="lead-source-select" className="w-full md:w-64" data-testid="select-lead-source">
                <SelectValue placeholder="Select source…" />
              </SelectTrigger>
              <SelectContent>
                {LEAD_SOURCES.map(s => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Required for compliance attribution — where did this list come from?</p>
          </div>

          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragging
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20"
                : "border-border hover:border-muted-foreground/50"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            data-testid="dropzone-csv-upload"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
              data-testid="input-csv-file"
            />
            <div className="flex flex-col items-center gap-3">
              {selectedFile ? (
                <>
                  <FileSpreadsheet className="h-12 w-12 text-green-600 dark:text-green-400" />
                  <div>
                    <p className="font-medium" data-testid="text-selected-filename">{selectedFile.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Upload className="h-12 w-12 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Drag and drop a CSV or XLSX file here, or click to browse</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Supports Outscraper (Google Maps), Apollo, and custom CSV formats up to 300MB
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>

            </>
          )}

          {wizardStep === "choose" && (
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                onClick={() => setWizardStep("review")}
                disabled={!selectedFile || !selectedLeadSource}
                data-testid="button-import-continue"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Continue to review
              </Button>
              {selectedFile && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelectedFile(null);
                    setHeaderPreview({ state: "none", columns: [] });
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  data-testid="button-clear-file"
                >
                  Clear
                </Button>
              )}
              {selectedFile && !selectedLeadSource && (
                <span className="text-xs text-muted-foreground" data-testid="text-continue-blocked">Select the lead source to continue.</span>
              )}
            </div>
          )}

          {wizardStep === "review" && selectedFile && (
            <div className="space-y-4" data-testid="import-review-step">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-muted-foreground">File</dt><dd className="font-medium break-all" data-testid="review-filename">{selectedFile.name}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Size</dt><dd className="font-medium">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</dd></div>
                <div><dt className="text-xs text-muted-foreground">Lead source</dt><dd className="font-medium" data-testid="review-source">{LEAD_SOURCES.find(x => x.value === selectedLeadSource)?.label ?? selectedLeadSource}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Format</dt><dd className="font-medium">{/\.xlsx$/i.test(selectedFile.name) ? "XLSX workbook" : "CSV"}</dd></div>
              </dl>
              <div data-testid="import-column-preview">
                <p className="text-sm font-medium">Detected columns</p>
                {headerPreview.state === "reading" && <p className="text-xs text-muted-foreground">Reading the header row…</p>}
                {headerPreview.state === "xlsx" && (
                  <p className="text-xs text-muted-foreground">Workbook columns are read by the server after upload; there is no browser preview for XLSX. Every original row is retained.</p>
                )}
                {headerPreview.state === "unreadable" && (
                  <p role="alert" className="text-xs text-destructive">The header row could not be read as text. You can still upload; the server validates the file and reports row errors per import.</p>
                )}
                {headerPreview.state === "ready" && (
                  <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
                    {headerPreview.columns.map((column, index) => (
                      <li key={`${column}-${index}`} className="flex justify-between gap-3 rounded border px-2 py-1">
                        <span className="font-mono break-all">{column}</span>
                        <span className="text-muted-foreground shrink-0">{describeHeader(column)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-muted-foreground">This is a header-only preview. The server decides the final mapping and reports invalid rows per import. Provider evidence is not email validation, enrollment, or outreach.</p>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <Button variant="outline" onClick={() => setWizardStep("choose")} disabled={uploadMutation.isPending} data-testid="button-import-back">Back</Button>
                <Button onClick={handleUpload} disabled={!selectedFile || !selectedLeadSource || uploadMutation.isPending} data-testid="button-import-csv">
                  {uploadMutation.isPending ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />Uploading…</>) : (<><Upload className="h-4 w-4 mr-2" />Upload original file</>)}
                </Button>
              </div>
            </div>
          )}

          {wizardStep === "result" && lastResult && (
            <div className="space-y-3" role="status" data-testid="import-result-step">
              <p className="text-sm font-medium">
                {lastResult.fileName} was {lastResult.status === "processing" ? "accepted" : "processed"}
                {lastResult.totalRows !== null ? ` (${lastResult.totalRows.toLocaleString()} original rows)` : ""}.
              </p>
              <p className="text-sm text-muted-foreground">{lastResult.summary} Find this import in Import History below for row counts, errors and recovery.</p>
              <Button variant="outline" onClick={() => { setWizardStep("choose"); setLastResult(null); }} data-testid="button-import-another">Start another import</Button>
            </div>
          )}

          <div className="text-xs text-muted-foreground space-y-1 border-t pt-3 mt-3">
            <p className="font-medium">Supported CSV Formats (auto-detected):</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2">
              <div className="flex items-start gap-2">
                <ArrowRight className="h-3 w-3 mt-0.5 shrink-0 text-blue-500" />
                <span><strong>Outscraper / Google Maps:</strong> Name, Telephone, Category, Rating, Reviews, Address</span>
              </div>
              <div className="flex items-start gap-2">
                <ArrowRight className="h-3 w-3 mt-0.5 shrink-0 text-green-500" />
                <span><strong>Apollo / Lead List:</strong> First Name, Last Name, Company, Email, Phone, Industry</span>
              </div>
              <div className="flex items-start gap-2">
                <ArrowRight className="h-3 w-3 mt-0.5 shrink-0 text-purple-500" />
                <span><strong>Custom:</strong> Any CSV file with company, email, or phone columns</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="intake-accounting-title" className="space-y-3" data-testid="section-intake-accounting">
        <div>
          <h3 id="intake-accounting-title" className="text-lg font-semibold">Intake accounting (all imports)</h3>
          <p className="text-sm text-muted-foreground">
            Immutable counts of what each import accepted and how every original row was dispositioned. Later business linking,
            recipient selection, preparation and native fulfillment are separate measures, shown in the Canonical Enrichment imports view and upload ledger.
          </p>
        </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card data-testid="card-stat-total-imports">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                <Database className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Imports</p>
                <p className="text-2xl font-bold" data-testid="text-total-imports">{fmtStat(importStats?.totalImports)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-rows-processed">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-slate-100 dark:bg-slate-900/30 rounded-lg">
                <ListChecks className="h-5 w-5 text-slate-600 dark:text-slate-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Rows Processed</p>
                <p className="text-2xl font-bold" data-testid="text-total-rows-processed">{fmtStat(importStats?.totalRowsProcessed)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-records-imported">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg">
                <Users className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">New Contacts Added</p>
                <p className="text-2xl font-bold" data-testid="text-total-records">{fmtStat(importStats?.totalRecordsImported)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-already-exists">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                <RefreshCw className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Already Exists</p>
                <p className="text-2xl font-bold" data-testid="text-total-already-exists">{fmtStat(importStats?.totalAlreadyExists)}</p>
                <p className="text-xs text-muted-foreground">Duplicates + DB matches — not new, not a failure</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-invalid">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Invalid / Error Rows</p>
                <p className="text-2xl font-bold" data-testid="text-total-invalid">{importStats ? (importStats.totalInvalidRows + importStats.totalErrors).toLocaleString() : "—"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-deals-created">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-orange-100 dark:bg-orange-900/30 rounded-lg">
                <TrendingUp className="h-5 w-5 text-orange-600 dark:text-orange-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Deals Created</p>
                <p className="text-2xl font-bold" data-testid="text-total-deals">{fmtStat(importStats?.totalDealsCreated)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      {statsError && (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive" data-testid="import-stats-unavailable">
          Import totals could not be loaded; the cards show a dash, not zero.
          <Button variant="outline" size="sm" onClick={() => refetchStats()} disabled={statsFetching}>Retry totals</Button>
        </div>
      )}
      {importStats && (
      <p className="text-xs text-muted-foreground" data-testid="text-stats-reconciliation">
        Across all imports in this scope: rows processed ({fmtStat(importStats.totalRowsProcessed)}) = new contacts added ({fmtStat(importStats.totalRecordsImported)}) + already exists ({fmtStat(importStats.totalAlreadyExists)}) + invalid or error rows ({(importStats.totalInvalidRows + importStats.totalErrors).toLocaleString()}). These are intake row counts; they do not show later enrichment, deals or delivery.
      </p>
      )}

      </section>

      {importStats?.verticalBreakdown && Object.keys(importStats.verticalBreakdown).length > 0 && (
        <Card data-testid="card-overall-vertical-breakdown">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Overall Vertical Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <VerticalBreakdownChart breakdown={importStats.verticalBreakdown} />
          </CardContent>
        </Card>
      )}

      {/* ===== STAGED LEAD PIPELINE ===== */}
      <Card data-testid="card-staged-pipeline">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="h-5 w-5" />
              Lead List Staging Pipeline
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowArchivedLists(!showArchivedLists)}
                data-testid="button-toggle-archived-lists"
              >
                <Archive className="h-4 w-4 mr-1" />
                {showArchivedLists ? "Hide Archived" : "Show Archived"}
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Each imported list moves through a readiness pipeline before leads can be enrolled. No list auto-enrolls — explicit admin approval required at each stage.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {prospectListsLoading ? (
            <div className="p-6 space-y-4">
              {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : prospectLists.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm" data-testid="text-no-prospect-lists">
              {showArchivedLists ? "No prospect lists found." : "No active prospect lists. Upload a CSV above to start the pipeline."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>List Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Records</TableHead>
                  <TableHead>Pipeline Stage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prospectLists.map(list => {
                  const isArchived = !!(list as any).archivedAt;
                  const leadSource = (list as any).leadSource as string | null;
                  return (
                    <TableRow key={list.id} data-testid={`row-pl-${list.id}`} className={isArchived ? "opacity-60" : ""}>
                      <TableCell className="font-medium" data-testid={`text-pl-name-${list.id}`}>
                        {list.name}
                        {isArchived && (
                          <Badge variant="outline" className="ml-2 text-xs border-amber-500 text-amber-700 dark:text-amber-400">Archived</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {leadSource ? (
                          <Badge variant="outline" className="text-xs capitalize" data-testid={`badge-source-${list.id}`}>
                            {LEAD_SOURCES.find(s => s.value === leadSource)?.label ?? leadSource.replace(/_/g, " ")}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell data-testid={`text-pl-records-${list.id}`}>
                        {(list.totalRecords ?? 0).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {isArchived ? (
                          <span className="text-xs text-muted-foreground">Archived — {(list as any).archivedReason ?? "manual"}</span>
                        ) : (
                          <ReadinessPipeline
                            list={list}
                            onAdvance={(state) => advanceReadinessMutation.mutate({ listId: list.id, state })}
                            isPending={advanceReadinessMutation.isPending}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-xs ${list.status === "completed" ? "border-green-500 text-green-700 dark:text-green-400" : "border-muted"}`}
                          data-testid={`badge-pl-status-${list.id}`}
                        >
                          {list.status ?? "unknown"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {!isArchived && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              if (confirm(`Archive "${list.name}"? It will be hidden from the main view but recoverable.`)) {
                                archiveListMutation.mutate(list.id);
                              }
                            }}
                            disabled={archiveListMutation.isPending}
                            data-testid={`btn-archive-pl-${list.id}`}
                          >
                            <Archive className="h-3 w-3 mr-1" />
                            Archive
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-import-history">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Import History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Total Rows</TableHead>
                <TableHead>New</TableHead>
                <TableHead>Duplicates</TableHead>
                <TableHead>Already Exists</TableHead>
                <TableHead>Invalid</TableHead>
                <TableHead>Errors</TableHead>
                <TableHead>Deals</TableHead>
                <TableHead>Lead Breakdown</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {importsLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  </TableRow>
                ))
              ) : importsError ? (
                <TableRow>
                  <TableCell colSpan={13} className="p-0">
                    <DataState
                      query={{ isLoading: false, isError: true, error: importsErrorObj, refetch: refetchImports }}
                      errorTitle="Failed to load import history"
                      testId="lead-imports"
                    >
                      <></>
                    </DataState>
                  </TableCell>
                </TableRow>
              ) : imports.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="text-center h-24 text-muted-foreground" data-testid="text-no-imports">
                    No imports yet. Upload a CSV or XLSX file above to get started.
                  </TableCell>
                </TableRow>
              ) : (
                imports.map((imp) => (
                  <TableRow
                    key={imp.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedImport(expandedImport === imp.id ? null : imp.id)}
                    data-testid={`row-import-${imp.id}`}
                  >
                    <TableCell className="font-medium max-w-[200px] truncate" data-testid={`text-filename-${imp.id}`}>
                      <div className="flex items-center gap-2">
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
                        {imp.fileName}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" data-testid={`badge-format-${imp.id}`}>
                        {(imp.sourceFormat || "custom").replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell data-testid={`text-total-rows-${imp.id}`}>
                      {(imp.totalRows ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell data-testid={`text-new-records-${imp.id}`}>
                      <span className="text-green-600 dark:text-green-400 font-medium">
                        {(imp.newRecords ?? 0).toLocaleString()}
                      </span>
                    </TableCell>
                    <TableCell data-testid={`text-skipped-${imp.id}`}>
                      <span className="text-muted-foreground">
                        {fmtOrUnknown(imp.duplicatesSkipped, imp)}
                      </span>
                    </TableCell>
                    <TableCell data-testid={`text-already-exists-${imp.id}`}>
                      <span className="text-blue-600 dark:text-blue-400">
                        {fmtOrUnknown(imp.skippedRows, imp)}
                      </span>
                    </TableCell>
                    <TableCell data-testid={`text-invalid-${imp.id}`}>
                      <span className={(imp.invalidRows ?? 0) > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                        {fmtOrUnknown(imp.invalidRows, imp)}
                      </span>
                    </TableCell>
                    <TableCell data-testid={`text-errors-${imp.id}`}>
                      <span className={(imp.errorsCount ?? 0) > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>
                        {fmtOrUnknown(imp.errorsCount, imp)}
                      </span>
                    </TableCell>
                    <TableCell data-testid={`text-deals-${imp.id}`}>
                      {(imp.dealsCreated ?? 0) > 0 ? (
                        <span className="text-orange-600 dark:text-orange-400 font-medium">
                          {imp.dealsCreated}
                        </span>
                      ) : "--"}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const { optOutPreserved, optOutApplied } = normalizeOptOut(imp as unknown as Record<string, unknown>);
                        const hasLeadBreakdown = (imp.hotLeads ?? 0) > 0 || (imp.warmLeads ?? 0) > 0 || (imp.coldLeads ?? 0) > 0;
                        const hasOptOut = optOutPreserved > 0 || optOutApplied > 0;
                        return (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              {(imp.hotLeads ?? 0) > 0 && (
                                <span className="flex items-center gap-0.5 text-xs" data-testid={`text-hot-${imp.id}`}>
                                  <Flame className="h-3 w-3 text-red-500" />{imp.hotLeads}
                                </span>
                              )}
                              {(imp.warmLeads ?? 0) > 0 && (
                                <span className="flex items-center gap-0.5 text-xs" data-testid={`text-warm-${imp.id}`}>
                                  <Thermometer className="h-3 w-3 text-amber-500" />{imp.warmLeads}
                                </span>
                              )}
                              {(imp.coldLeads ?? 0) > 0 && (
                                <span className="flex items-center gap-0.5 text-xs" data-testid={`text-cold-${imp.id}`}>
                                  <Snowflake className="h-3 w-3 text-blue-400" />{imp.coldLeads}
                                </span>
                              )}
                              {!hasLeadBreakdown && !hasOptOut && "--"}
                            </div>
                            {hasOptOut && (
                              <span
                                className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"
                                title={`Preserved: contacts that were already opted out and stayed protected during import. Applied: contacts newly marked opted out by this import.`}
                                data-testid={`text-optout-${imp.id}`}
                              >
                                <ShieldCheck className="h-3 w-3 shrink-0" />
                                {optOutPreserved > 0 && optOutApplied > 0
                                  ? `Preserved: ${optOutPreserved.toLocaleString()} · Applied: ${optOutApplied.toLocaleString()}`
                                  : optOutPreserved > 0
                                  ? `Preserved: ${optOutPreserved.toLocaleString()}`
                                  : `Applied: ${optOutApplied.toLocaleString()}`}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {getStatusBadge(imp.status)}
                        {imp.status === "processing" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-xs text-amber-600 hover:text-amber-700"
                            data-testid={`btn-mark-interrupted-${imp.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              markInterruptedMutation.mutate(imp.id);
                            }}
                            disabled={markInterruptedMutation.isPending}
                            title="Mark this stuck import as interrupted"
                          >
                            Mark Interrupted
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[220px]" data-testid={`text-result-${imp.id}`}>
                      {(() => {
                        const outcome = getOutcomeSummary(imp);
                        return <span className={`text-xs font-medium ${outcome.className}`}>{outcome.label}</span>;
                      })()}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-date-${imp.id}`}>
                      <div className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatDate(imp.createdAt)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {expandedImport && (() => {
        const imp = imports.find(i => i.id === expandedImport);
        if (!imp) return null;
        const breakdown = imp.verticalBreakdown as Record<string, number> | null;
        return (
          <Card data-testid={`card-import-detail-${imp.id}`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <FileSpreadsheet className="h-5 w-5" />
                Import Details: {imp.fileName}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Source Format</p>
                  <p className="font-medium">{(imp.sourceFormat || "custom").replace(/_/g, " ")}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Total Rows</p>
                  <p className="font-medium">{(imp.totalRows ?? 0).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">New Records</p>
                  <p className="font-medium text-green-600 dark:text-green-400">{(imp.newRecords ?? 0).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Duplicates Skipped</p>
                  <p className="font-medium">{fmtOrUnknown(imp.duplicatesSkipped, imp)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Invalid Rows</p>
                  <p className="font-medium text-amber-600 dark:text-amber-400" data-testid={`text-detail-invalid-${imp.id}`}>{fmtOrUnknown(imp.invalidRows, imp)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    {imp.sourceFormat === "google_maps_outscraper" || imp.sourceFormat === "apollo_lead_list"
                      ? "Staged for Review"
                      : "Already Exists (DB Match)"}
                  </p>
                  <p className="font-medium text-blue-600 dark:text-blue-400" data-testid={`text-detail-skipped-${imp.id}`}>{fmtOrUnknown(imp.skippedRows, imp)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Errors</p>
                  <p className="font-medium text-red-600 dark:text-red-400" data-testid={`text-detail-errors-${imp.id}`}>{fmtOrUnknown(imp.errorsCount, imp)}</p>
                </div>
                {/* #266 — CSV error row summary download */}
                {((imp.invalidRows ?? 0) + (imp.errorsCount ?? 0)) > 0 && (
                  <div className="col-span-2 md:col-span-4 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      data-testid={`button-download-error-rows-${imp.id}`}
                      onClick={() => {
                        const rows = [
                          ["Import ID", "Filename", "Invalid Rows", "Errors", "Duplicates"],
                          [
                            String(imp.id),
                            String((imp as any).filename ?? "unknown"),
                            String(imp.invalidRows ?? 0),
                            String(imp.errorsCount ?? 0),
                            String(imp.duplicatesSkipped ?? 0),
                          ]
                        ];
                        const csv = rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
                        const blob = new Blob([csv], { type: "text/csv" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `import-errors-${imp.id}.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      <CloudDownload className="h-3.5 w-3.5" />
                      Download Error Summary
                    </Button>
                  </div>
                )}
                {hasUnknownBuckets(imp) && (
                  <div className="col-span-2 md:col-span-4">
                    <p className="text-xs text-amber-600 dark:text-amber-400" data-testid={`text-unknown-buckets-${imp.id}`}>
                      Import was interrupted before all row categories could be computed. Duplicate, invalid, and already-exists counts show "—" where unavailable.
                    </p>
                  </div>
                )}
              </div>

              {(() => {
                const outcomes = durableDispositionOutcomes(imp);
                const buckets: Array<[ImportDisposition, string, string]> = [
                  ["created", "Created", "text-green-600 dark:text-green-400"],
                  ["matched_noop", "Matched (no change)", "text-blue-600 dark:text-blue-400"],
                  ["updated", "Updated", "text-cyan-600 dark:text-cyan-400"],
                  ["rejected", "Rejected", "text-amber-600 dark:text-amber-400"],
                  ["deferred", "Deferred", "text-muted-foreground"],
                  ["failed", "Failed", "text-red-600 dark:text-red-400"],
                ];
                return (
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-3" data-testid={`import-disposition-ledger-${imp.id}`}>
                    {buckets.map(([key, label, className]) => (
                      <div key={key} className="rounded border p-2">
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <p className={`font-medium ${className}`} data-testid={`import-${key}-${imp.id}`}>
                          {outcomes[key].toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {(() => {
                const { optOutPreserved, optOutApplied } = normalizeOptOut(imp as unknown as Record<string, unknown>);
                if (optOutPreserved === 0 && optOutApplied === 0) return null;
                const parts: string[] = [];
                if (optOutPreserved > 0) parts.push(`${optOutPreserved.toLocaleString()} existing opt-out${optOutPreserved !== 1 ? "s" : ""} preserved`);
                if (optOutApplied > 0) parts.push(`${optOutApplied.toLocaleString()} new opt-out${optOutApplied !== 1 ? "s" : ""} applied`);
                return (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800" data-testid={`card-optout-detail-${imp.id}`}>
                    <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">Opt-Out Protection</p>
                      <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">{parts.join(" · ")}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Preserved: contacts that were already opted out and stayed protected during import.
                        Applied: contacts newly marked opted out by this import.
                      </p>
                    </div>
                  </div>
                );
              })()}

              {(imp.totalRows ?? 0) > 0 && (() => {
                const outcomes = durableDispositionOutcomes(imp);
                const reconciled = outcomes.total;
                const mismatch = reconciled !== (imp.totalRows ?? 0);
                return mismatch ? (
                  <p className="text-xs text-destructive" data-testid={`text-reconciliation-mismatch-${imp.id}`}>
                    Warning: accounted rows ({reconciled}) do not match total rows ({imp.totalRows}).
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground" data-testid={`text-reconciliation-ok-${imp.id}`}>
                    Durable ledger reconciles all {(imp.totalRows ?? 0).toLocaleString()} rows: {outcomes.created.toLocaleString()} created + {outcomes.matched_noop.toLocaleString()} matched/no-op + {outcomes.updated.toLocaleString()} updated + {outcomes.rejected.toLocaleString()} rejected + {outcomes.deferred.toLocaleString()} deferred + {outcomes.failed.toLocaleString()} failed.
                  </p>
                );
              })()}

              {(imp.totalRows ?? 0) > 0 && (() => {
                const outcome = getOutcomeSummary(imp);
                return (
                  <p className={`text-sm font-medium ${outcome.className}`} data-testid={`text-detail-outcome-${imp.id}`}>
                    {outcome.label}
                  </p>
                );
              })()}

              {(imp.totalRows ?? 0) > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>New Contact Rate (of total rows)</span>
                    <span>{Math.round(((imp.newRecords ?? 0) / (imp.totalRows ?? 1)) * 100)}%</span>
                  </div>
                  <Progress value={((imp.newRecords ?? 0) / (imp.totalRows ?? 1)) * 100} />
                </div>
              )}

              {breakdown && Object.keys(breakdown).length > 0 && (
                <div>
                  <h4 className="font-medium mb-3">Vertical Breakdown</h4>
                  <VerticalBreakdownChart breakdown={breakdown} />
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      <Card data-testid="card-outscraper-reference">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Outscraper Search Reference (FL Hot Verticals)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { vertical: "Auto Repair", searches: ["auto repair in Miami, FL", "auto body shop in Orlando, FL", "mechanic in Tampa, FL", "tire shop in Jacksonville, FL", "oil change in Fort Lauderdale, FL"] },
              { vertical: "Med Spa / Aesthetics", searches: ["med spa in Miami, FL", "medical spa in Boca Raton, FL", "aesthetics clinic in Tampa, FL", "botox in Fort Lauderdale, FL", "laser hair removal in Orlando, FL"] },
              { vertical: "Dentist", searches: ["dentist in Miami, FL", "dental office in Orlando, FL", "cosmetic dentist in Tampa, FL", "orthodontist in Jacksonville, FL", "family dentist in Fort Lauderdale, FL"] },
              { vertical: "Restaurant", searches: ["restaurant in Miami, FL", "restaurant in Orlando, FL", "restaurant in Tampa, FL", "restaurant in Jacksonville, FL", "restaurant in Fort Lauderdale, FL"] },
              { vertical: "Salon / Spa", searches: ["hair salon in Miami, FL", "nail salon in Orlando, FL", "beauty salon in Tampa, FL", "barber shop in Jacksonville, FL", "day spa in Boca Raton, FL"] },
              { vertical: "Fitness", searches: ["gym in Miami, FL", "fitness center in Orlando, FL", "yoga studio in Tampa, FL", "crossfit in Fort Lauderdale, FL", "personal trainer in Jacksonville, FL"] },
            ].map((item) => (
              <div key={item.vertical} className="border rounded-lg p-4 space-y-2" data-testid={`card-vertical-ref-${item.vertical.toLowerCase().replace(/[/ ]/g, "-")}`}>
                <h4 className="font-medium text-sm">{item.vertical}</h4>
                <ul className="space-y-1">
                  {item.searches.map((s) => (
                    <li key={s} className="text-xs text-muted-foreground flex items-start gap-1">
                      <ArrowRight className="h-3 w-3 mt-0.5 shrink-0" />
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Historical privileged operation. Staged, no outbound; collapsed so ordinary upload and history come first. */}
      <details className="rounded-lg border p-3" data-testid="section-historical-priority-import">
        <summary className="cursor-pointer text-sm font-medium">Historical priority lead sheet import (privileged, staged only)</summary>
        <div className="mt-4"><MasterLeadImportSection /></div>
      </details>
    </div>
  );
}
