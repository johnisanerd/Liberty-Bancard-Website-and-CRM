import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { User, Bot, Settings, ChevronDown, ChevronUp, Filter, RotateCcw } from "lucide-react";
import { format } from "date-fns";

interface AuditLogEntry {
  id: number;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  details: Record<string, unknown> | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  actorType: string | null;
  actorId: string | null;
  createdAt: string;
}

const ENTITY_TYPES = [
  "all",
  "contact",
  "deal",
  "merchant_application",
  "onboarding_step",
  "commission_tier",
  "residual_report",
  "user",
];

const ACTOR_TYPES = ["all", "user", "ai", "system"];

const HIDDEN_FIELDS = new Set([
  "updatedAt", "createdAt", "archivedAt", "scoreBreakdown",
  "dealBlueprint", "savingsProposal", "boardingLog", "linkedinEnrichmentLog",
]);

function formatFieldName(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim();
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "string" && val === "") return "—";
  if (typeof val === "object") return JSON.stringify(val).slice(0, 80);
  return String(val);
}

function computeDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!after) return [];
  const allKeys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  const changes: Array<{ field: string; from: string; to: string }> = [];
  for (const key of allKeys) {
    if (HIDDEN_FIELDS.has(key)) continue;
    const oldStr = formatValue(before?.[key] ?? null);
    const newStr = formatValue(after[key] ?? null);
    if (oldStr !== newStr) changes.push({ field: formatFieldName(key), from: oldStr, to: newStr });
  }
  return changes;
}

function actorTypeBadge(actorType: string | null) {
  if (actorType === "ai") return (
    <Badge variant="secondary" className="text-xs gap-1 bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
      <Bot className="h-3 w-3" />AI
    </Badge>
  );
  if (actorType === "system") return (
    <Badge variant="outline" className="text-xs gap-1">
      <Settings className="h-3 w-3" />System
    </Badge>
  );
  return (
    <Badge variant="outline" className="text-xs gap-1">
      <User className="h-3 w-3" />User
    </Badge>
  );
}

function actorLabel(entry: AuditLogEntry): string {
  if (entry.actorType === "ai") return entry.actorId ? `AI: ${entry.actorId}` : "AI";
  if (entry.actorType === "system") return "System";
  return entry.userId ? `User ${entry.userId.slice(0, 8)}` : "Unknown";
}

function entityTypeBadge(entityType: string) {
  const colors: Record<string, string> = {
    contact: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    deal: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    merchant_application: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    onboarding_step: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
    commission_tier: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    residual_report: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
    user: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  };
  return (
    <Badge variant="outline" className={`text-xs ${colors[entityType] || ""}`}>
      {entityType.replace(/_/g, " ")}
    </Badge>
  );
}

function actionLabel(action: string): string {
  return action.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase());
}

function AuditLogRow({ entry }: { entry: AuditLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const diff = computeDiff(entry.beforeState, entry.afterState);
  const isCreate = entry.action.endsWith("_created") || entry.beforeState === null;

  return (
    <div className="border-b last:border-0 py-3 px-4" data-testid={`audit-row-${entry.id}`}>
      <div className="flex flex-wrap items-start gap-2 justify-between">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {actorTypeBadge(entry.actorType)}
          {entityTypeBadge(entry.entityType)}
          <span className="text-sm font-medium" data-testid={`audit-action-${entry.id}`}>
            {actionLabel(entry.action)}
          </span>
          {entry.entityId && (
            <span className="text-xs text-muted-foreground">#{entry.entityId}</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground whitespace-nowrap" data-testid={`audit-time-${entry.id}`}>
          {format(new Date(entry.createdAt), "MMM d, yyyy HH:mm")}
        </div>
      </div>

      <div className="mt-1 text-xs text-muted-foreground" data-testid={`audit-actor-${entry.id}`}>
        {actorLabel(entry)}
      </div>

      {!isCreate && diff.length > 0 && (
        <div className="mt-2">
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(!expanded)}
            data-testid={`audit-toggle-${entry.id}`}
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {diff.length} field{diff.length !== 1 ? "s" : ""} changed
          </button>
          {expanded && (
            <div className="mt-2 space-y-1 rounded-md border p-2 bg-muted/30" data-testid={`audit-diff-${entry.id}`}>
              {diff.map((d, i) => (
                <div key={i} className="text-xs grid grid-cols-[auto_1fr] gap-x-2 items-start">
                  <span className="font-medium text-muted-foreground whitespace-nowrap">{d.field}:</span>
                  <span className="min-w-0 break-all">
                    {d.from !== "—" && (
                      <span className="line-through text-red-500 dark:text-red-400 mr-1">{d.from}</span>
                    )}
                    <span className="text-green-700 dark:text-green-400">{d.to}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isCreate && (
        <p className="mt-1 text-xs text-muted-foreground italic">Record created</p>
      )}
    </div>
  );
}

function buildQueryString(filters: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v && v !== "all") params.set(k, v);
  }
  return params.toString();
}

const AUDIT_PAGE_SIZE = 100;

export default function AuditLogs() {
  const [filters, setFilters] = useState({
    entityType: "all",
    actorType: "all",
    entityId: "",
    actorId: "",
    startDate: "",
    endDate: "",
  });
  const [applied, setApplied] = useState(filters);
  const [pageLimit, setPageLimit] = useState(AUDIT_PAGE_SIZE);

  const qs = buildQueryString({
    entityType: applied.entityType,
    actorType: applied.actorType,
    entityId: applied.entityId,
    actorId: applied.actorId,
    startDate: applied.startDate ? new Date(applied.startDate).toISOString() : "",
    endDate: applied.endDate ? new Date(applied.endDate + "T23:59:59").toISOString() : "",
    limit: String(pageLimit),
  });

  const { data: logs, isLoading, refetch } = useQuery<AuditLogEntry[]>({
    queryKey: ["/api/audit-logs", qs],
    queryFn: async () => {
      const base = "/api/audit-logs";
      const res = await fetch(qs ? `${base}?${qs}` : base, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch audit logs");
      return res.json();
    },
    staleTime: 30000,
  });

  const applyFilters = () => {
    setApplied({ ...filters });
    setPageLimit(AUDIT_PAGE_SIZE);
  };
  const resetFilters = () => {
    const empty = { entityType: "all", actorType: "all", entityId: "", actorId: "", startDate: "", endDate: "" };
    setFilters(empty);
    setApplied(empty);
    setPageLimit(AUDIT_PAGE_SIZE);
  };

  const aiCount = logs?.filter((l) => l.actorType === "ai").length ?? 0;
  const humanCount = logs?.filter((l) => l.actorType === "user").length ?? 0;
  const systemCount = logs?.filter((l) => l.actorType === "system").length ?? 0;

  return (
    <div className="space-y-6" data-testid="audit-logs-page">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Audit Log</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Immutable record of all entity changes — who changed what and when
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-logs">
          <RotateCcw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Summary KPIs */}
      {!isLoading && logs && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-2xl font-bold" data-testid="kpi-total">{logs.length}</div>
              <div className="text-xs text-muted-foreground">Entries loaded (this view{logs.length >= pageLimit ? `, capped at ${pageLimit}` : ""})</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-2xl font-bold text-blue-600" data-testid="kpi-human">{humanCount}</div>
              <div className="text-xs text-muted-foreground">Human Changes</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-2xl font-bold text-purple-600" data-testid="kpi-ai">{aiCount}</div>
              <div className="text-xs text-muted-foreground">AI-Initiated</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-2xl font-bold text-gray-500" data-testid="kpi-system">{systemCount}</div>
              <div className="text-xs text-muted-foreground">System Changes</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card data-testid="audit-filters">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Entity Type</label>
              <Select value={filters.entityType} onValueChange={(v) => setFilters((f) => ({ ...f, entityType: v }))}>
                <SelectTrigger data-testid="filter-entity-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t === "all" ? "All Types" : t.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Actor Type</label>
              <Select value={filters.actorType} onValueChange={(v) => setFilters((f) => ({ ...f, actorType: v }))}>
                <SelectTrigger data-testid="filter-actor-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTOR_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t === "all" ? "All Actors" : t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Entity ID</label>
              <Input
                placeholder="e.g. 42"
                value={filters.entityId}
                onChange={(e) => setFilters((f) => ({ ...f, entityId: e.target.value }))}
                data-testid="filter-entity-id"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Actor / Advisor</label>
              <Input
                placeholder="e.g. user ID or ai-advisor name"
                value={filters.actorId}
                onChange={(e) => setFilters((f) => ({ ...f, actorId: e.target.value }))}
                data-testid="filter-actor-id"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date Range</label>
              <div className="flex gap-1">
                <Input
                  type="date"
                  value={filters.startDate}
                  onChange={(e) => setFilters((f) => ({ ...f, startDate: e.target.value }))}
                  className="flex-1"
                  data-testid="filter-start-date"
                />
                <Input
                  type="date"
                  value={filters.endDate}
                  onChange={(e) => setFilters((f) => ({ ...f, endDate: e.target.value }))}
                  className="flex-1"
                  data-testid="filter-end-date"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={applyFilters} size="sm" data-testid="button-apply-filters">
              Apply Filters
            </Button>
            <Button variant="outline" size="sm" onClick={resetFilters} data-testid="button-reset-filters">
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Log entries */}
      <Card data-testid="audit-log-list">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {isLoading
              ? "Loading..."
              : logs && logs.length >= pageLimit
              ? `${logs.length} entries (showing first ${pageLimit})`
              : `${logs?.length ?? 0} entries`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="space-y-2">
                  <div className="flex gap-2">
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="h-5 w-20" />
                    <Skeleton className="h-5 w-32" />
                  </div>
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </div>
          ) : !logs || logs.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground" data-testid="audit-empty">
              No audit log entries found
            </div>
          ) : (
            <div data-testid="audit-entries">
              {logs.map((entry) => (
                <AuditLogRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </CardContent>
        {logs && logs.length >= pageLimit && (
          <div className="flex justify-center px-4 py-3 border-t" data-testid="audit-load-more-row">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPageLimit((p) => p + AUDIT_PAGE_SIZE)}
              data-testid="button-audit-load-more"
            >
              Load {AUDIT_PAGE_SIZE} more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
