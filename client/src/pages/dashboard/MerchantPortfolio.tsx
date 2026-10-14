import { useState, useMemo, useEffect } from "react";
import {portfolioFollowupDay,portfolioFollowupDays,portfolioFollowupCarrier} from "@/lib/portfolio-followup-date";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Briefcase,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Search,
  Ticket,
  CheckSquare,
  Users,
  X,
} from "lucide-react";

interface PortfolioRow {
  id: number;
  dealId: number | null;
  editableDealId: number | null;
  firstName: string;
  lastName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  lastContactedAt: string | null;
  riskTier: string;
  churnScore: number;
  ownerEmail: string | null;
  nextFollowUp: string | null;
  dealStage: string | null;
  dealPipeline: string | null;
  openTickets: number;
  openTasks: number;
}

interface PortfolioSummary {
  total: number;
  critical: number;
  high: number;
  totalOpenTickets: number;
  totalOpenTasks: number;
}

interface PortfolioResponse {
  data: PortfolioRow[];
  total: number;
  summary: PortfolioSummary;
}

type SortKey = "risk" | "lastContact" | "nextFollowUp" | "churnScore" | "openTasks" | "openTickets";
type SortDir = "asc" | "desc";

const RISK_ORDER: Record<string, number> = {
  Critical: 1,
  High: 2,
  Medium: 3,
  Low: 4,
  Unknown: 5,
};

function riskBadgeVariant(tier: string): "destructive" | "secondary" | "outline" | "default" {
  if (tier === "Critical") return "destructive";
  if (tier === "High") return "secondary";
  if (tier === "Medium") return "outline";
  return "default";
}

function riskBadgeClass(tier: string): string {
  if (tier === "Critical") return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400";
  if (tier === "High") return "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400";
  if (tier === "Medium") return "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400";
  if (tier === "Low") return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400";
  return "bg-muted text-muted-foreground";
}

function fmtDate(val: string | null): string {
  if (!val) return "—";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtFollowUp(val: string | null): string {
  if (!val) return "—";
  const d = portfolioFollowupDay(val);
  const diffDays=portfolioFollowupDays(val);
  if(!d || diffDays===null)return "Unavailable";
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function followUpClass(val: string | null): string {
  if (!val) return "";
  const diffDays=portfolioFollowupDays(val);
  if(diffDays===null)return "";
  if (diffDays < 0) return "text-red-600 dark:text-red-400 font-medium";
  if (diffDays <= 1) return "text-orange-600 dark:text-orange-400";
  return "";
}

function displayName(row: PortfolioRow): string {
  const full = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
  return row.companyName ? `${row.companyName}` : full || "—";
}

function subName(row: PortfolioRow): string {
  const full = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
  if (row.companyName && full) return full;
  return row.email ?? "";
}

/**
 * Converts the local date selected by the user into a UTC-noon ISO string.
 * UTC noon is only a compatibility carrier. All calendar-day display/due
 * comparisons parse the explicit YYYY-MM-DD, never its shifted local instant.
 */
function toUtcNoonIso(d: Date): string {
  return portfolioFollowupCarrier(d);
}

/**
 * Parse a stored follow-up value back into a JS Date for Calendar selection.
 * Extracts the YYYY-MM-DD portion and constructs a LOCAL midnight date so the
 * calendar always highlights the correct day regardless of stored UTC offset.
 */
function parseFollowUpForCalendar(val: string | null): Date | undefined {
  return portfolioFollowupDay(val);
}

// ── Inline Follow-Up Date Picker ─────────────────────────────────────────────

interface FollowUpCellProps {
  row: PortfolioRow;
  /** Optimistic override from the mutation layer */
  overrideDate: string | null | undefined;
  onSave: (editableDealId: number, isoDate: string | null) => void;
  saving: boolean;
}

function FollowUpCell({ row, overrideDate, onSave, saving }: FollowUpCellProps) {
  const [open, setOpen] = useState(false);

  // Displayed value: prefer optimistic override when present
  const displayVal = overrideDate !== undefined ? overrideDate : row.nextFollowUp;

  // Can only edit if this user owns a deal they can PATCH
  const canEdit = !!row.editableDealId;

  // Parse current value for the Calendar — local date from YYYY-MM-DD portion
  const selectedDay = parseFollowUpForCalendar(displayVal);

  function handleSelect(day: Date | undefined) {
    if (!row.editableDealId) return;
    // Compatibility carrier for the explicitly parsed calendar day.
    const iso = day ? toUtcNoonIso(day) : null;
    setOpen(false);
    onSave(row.editableDealId, iso);
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    if (!row.editableDealId) return;
    onSave(row.editableDealId, null);
  }

  if (!canEdit) {
    return (
      <span className={`text-xs ${followUpClass(displayVal)}`}>
        {fmtFollowUp(displayVal)}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`group/cell flex items-center gap-1.5 text-xs rounded px-1.5 py-0.5 -mx-1.5 hover:bg-muted transition-colors ${followUpClass(displayVal)} ${saving ? "opacity-50 pointer-events-none" : ""}`}
          title="Click to reschedule follow-up"
        >
          <CalendarDays className="w-3 h-3 shrink-0 opacity-50 group-hover/cell:opacity-100 transition-opacity" />
          <span>{fmtFollowUp(displayVal)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" side="bottom">
        <div className="px-3 pt-3 pb-1 border-b flex items-center justify-between gap-4">
          <span className="text-xs font-medium text-muted-foreground">Set follow-up date</span>
          {displayVal && (
            <button
              onClick={handleClear}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
        <Calendar
          mode="single"
          selected={selectedDay}
          onSelect={handleSelect}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function MerchantPortfolio() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const role = (user as any)?.role ?? "agent";

  const [sortKey, setSortKey] = useState<SortKey>("risk");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);

  // Optimistic follow-up overrides keyed by dealId
  const [optimisticDates, setOptimisticDates] = useState<Record<number, string | null>>({});
  // Which dealId is currently saving
  const [savingDealId, setSavingDealId] = useState<number | null>(null);
  useEffect(()=>{
    setOffset(0);setOwnerFilter("all");setRiskFilter("all");setSearch("");
    setOptimisticDates({});setSavingDealId(null);
  },[user?.id,user?.accountVersion,user?.role]);

  // Server-side sort for the primary sort key used in the API
  const apiSort = sortKey === "risk" ? "risk" : sortKey === "lastContact" ? "lastContact" : sortKey === "nextFollowUp" ? "nextFollowUp" : "risk";

  const ownerParam = role === "agent" ? "" : ownerFilter !== "all" ? `&owner=${encodeURIComponent(ownerFilter)}` : "";

  const { data, isLoading, isError, refetch } = useQuery<PortfolioResponse>({
    queryKey: ["/api/portfolio", apiSort, ownerFilter, pageSize, offset],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/portfolio?sort=${apiSort}${ownerParam}&limit=${pageSize}&offset=${offset}`, { credentials: "include", signal });
      if (!res.ok) throw new Error(await res.text());
      const value=await res.json();
      if(!Array.isArray(value.data) || !Number.isSafeInteger(value.total) || value.total<0 ||
        typeof value.summary!=="object" || value.summary.total!==value.total)
        throw new Error("Portfolio population/completeness unavailable");
      return value;
    },
    staleTime: 60_000,
  });

  const { data: owners } = useQuery<string[]>({
    queryKey: ["/api/portfolio/owners"],
    enabled: role === "admin" || role === "manager",
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => {
    let list = data?.data ?? [];

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          displayName(r).toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q) ||
          (r.ownerEmail ?? "").toLowerCase().includes(q)
      );
    }

    if (riskFilter !== "all") {
      list = list.filter((r) => r.riskTier === riskFilter);
    }

    // Client-side secondary sorting
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "risk") {
        cmp = (RISK_ORDER[a.riskTier] ?? 5) - (RISK_ORDER[b.riskTier] ?? 5);
      } else if (sortKey === "churnScore") {
        cmp = (b.churnScore ?? 0) - (a.churnScore ?? 0);
      } else if (sortKey === "openTasks") {
        cmp = (b.openTasks ?? 0) - (a.openTasks ?? 0);
      } else if (sortKey === "openTickets") {
        cmp = (b.openTickets ?? 0) - (a.openTickets ?? 0);
      } else if (sortKey === "lastContact") {
        const aT = a.lastContactedAt ? new Date(a.lastContactedAt).getTime() : 0;
        const bT = b.lastContactedAt ? new Date(b.lastContactedAt).getTime() : 0;
        cmp = bT - aT;
      } else if (sortKey === "nextFollowUp") {
        const aT = a.nextFollowUp ? new Date(a.nextFollowUp).getTime() : Infinity;
        const bT = b.nextFollowUp ? new Date(b.nextFollowUp).getTime() : Infinity;
        cmp = aT - bT;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [data, search, riskFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 text-muted-foreground ml-1" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 ml-1 text-primary" />
      : <ArrowDown className="w-3 h-3 ml-1 text-primary" />;
  }

  async function handleSaveFollowUp(editableDealId: number, isoDate: string | null) {
    // Optimistic update
    setOptimisticDates((prev) => ({ ...prev, [editableDealId]: isoDate }));
    setSavingDealId(editableDealId);
    try {
      await apiRequest("PUT", `/api/deals/${editableDealId}`, { nextFollowUp: isoDate });
      // Build a human-readable date from the YYYY-MM-DD portion (local, no UTC drift)
      let description = "Follow-up date cleared";
      if (isoDate) {
        const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) {
          const localDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          description = `Rescheduled to ${localDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
        }
      }
      toast({ title: "Follow-up updated", description });
      // Invalidate so the table refreshes server values on next stale
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
    } catch (err: any) {
      toast({
        title: "Failed to update follow-up",
        description: (err as any)?.message ?? "Please try again.",
        variant: "destructive",
      });
      // Revert optimistic update
      setOptimisticDates((prev) => {
        const next = { ...prev };
        delete next[editableDealId];
        return next;
      });
    } finally {
      setSavingDealId(null);
    }
  }

  const summary = data?.summary;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Briefcase className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">My Portfolio</h1>
            <p className="text-sm text-muted-foreground">
              {role === "agent"
                ? "Your assigned merchants — health signals and open actions at a glance"
                : "All merchants — health signals and open actions across your team"}
            </p>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Total</span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <p className="text-3xl font-bold">{summary?.total ?? 0}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Critical / High</span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-3xl font-bold">
                <span className="text-red-600 dark:text-red-400">{summary?.critical ?? 0}</span>
                <span className="text-muted-foreground text-xl"> / </span>
                <span className="text-orange-600 dark:text-orange-400">{summary?.high ?? 0}</span>
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Ticket className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Open Tickets</span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <p className="text-3xl font-bold">{summary?.totalOpenTickets ?? 0}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <CheckSquare className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Open Tasks</span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <p className="text-3xl font-bold">{summary?.totalOpenTasks ?? 0}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Merchant Table</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-9"
                aria-label="Search merchants on this loaded page"
                placeholder="Search by name, company, or rep email…"
                value={search}
                    onChange={(e) => {setSearch(e.target.value);setOffset(0);}}
              />
            </div>
            <Select value={riskFilter} onValueChange={value=>{setRiskFilter(value);setOffset(0);}}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="All risk tiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All risk tiers</SelectItem>
                <SelectItem value="Critical">Critical</SelectItem>
                <SelectItem value="High">High</SelectItem>
                <SelectItem value="Medium">Medium</SelectItem>
                <SelectItem value="Low">Low</SelectItem>
                <SelectItem value="Unknown">Unknown</SelectItem>
              </SelectContent>
            </Select>
            {(role === "admin" || role === "manager") && (
              <Select value={ownerFilter} onValueChange={value=>{setOwnerFilter(value);setOffset(0);}}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue placeholder="All reps" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All reps</SelectItem>
                  {(owners ?? []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Table */}
          <div className="crm-portfolio-cards gap-3" aria-label="Merchant cards">
            {isLoading ? <p role="status">Loading authorized merchant page…</p> :
              isError ? <p role="alert">Merchant page unavailable. No empty Portfolio is inferred.</p> :
              rows.length===0 ? <p>{search || riskFilter!=="all" ? "No merchants match the loaded-page filters." : "No merchants returned on this authorized page."}</p> :
              rows.map(row=><article key={row.id} className="rounded-lg border bg-card p-4 space-y-3" data-contact-id={row.id}>
                <Link href={`/dashboard/contacts/${row.id}`}><a className="min-h-11 flex flex-col justify-center font-medium">
                  <span>{row.companyName || `${row.firstName} ${row.lastName}`}</span>
                  {row.companyName && <span className="text-xs text-muted-foreground">{row.firstName} {row.lastName}</span>}
                </a></Link>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted-foreground">Risk</dt><dd>{row.riskTier || "Unknown"}</dd></div>
                  <div><dt className="text-muted-foreground">Score</dt><dd className="tabular-nums">{row.riskTier==="unknown" || !Number.isFinite(row.churnScore) ? "Unassessed" : Math.round(row.churnScore)}</dd></div>
                  <div><dt className="text-muted-foreground">Open tasks</dt><dd className="tabular-nums">{Number.isFinite(row.openTasks)?row.openTasks:"Unavailable"}</dd></div>
                  <div><dt className="text-muted-foreground">Open tickets</dt><dd className="tabular-nums">{Number.isFinite(row.openTickets)?row.openTickets:"Unavailable"}</dd></div>
                  <div><dt className="text-muted-foreground">Last contact</dt><dd>{fmtDate(row.lastContactedAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Sales stage</dt><dd>{row.dealStage ?? "No linked eligible sales deal"}</dd></div>
                  {(role==="admin"||role==="manager") && <div className="col-span-2"><dt className="text-muted-foreground">Assigned rep</dt><dd className="break-words">{row.ownerEmail ?? "No assignment returned"}</dd></div>}
                </dl>
                <div><p className="text-sm text-muted-foreground">Next follow-up</p><FollowUpCell row={row}
                  overrideDate={row.editableDealId!==null?optimisticDates[row.editableDealId]:undefined}
                  onSave={handleSaveFollowUp} saving={row.editableDealId!==null&&savingDealId===row.editableDealId}/></div>
              </article>)}
          </div>
          <div className="crm-portfolio-table overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[220px]">Merchant</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                    <button
                      className="flex items-center hover:text-foreground transition-colors"
                      onClick={() => toggleSort("risk")}
                    >
                      Health Tier <SortIcon col="risk" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                    <button
                      className="flex items-center hover:text-foreground transition-colors"
                      onClick={() => toggleSort("churnScore")}
                    >
                      Churn Score <SortIcon col="churnScore" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                    <button
                      className="flex items-center hover:text-foreground transition-colors"
                      onClick={() => toggleSort("openTickets")}
                    >
                      Tickets <SortIcon col="openTickets" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                    <button
                      className="flex items-center hover:text-foreground transition-colors"
                      onClick={() => toggleSort("openTasks")}
                    >
                      Tasks <SortIcon col="openTasks" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                    <button
                      className="flex items-center hover:text-foreground transition-colors"
                      onClick={() => toggleSort("lastContact")}
                    >
                      Last Contact <SortIcon col="lastContact" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                    <button
                      className="flex items-center hover:text-foreground transition-colors"
                      onClick={() => toggleSort("nextFollowUp")}
                    >
                      Next Follow-Up <SortIcon col="nextFollowUp" />
                    </button>
                  </th>
                  {(role === "admin" || role === "manager") && (
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Rep</th>
                  )}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {Array.from({ length: role === "agent" ? 7 : 8 }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <Skeleton className="h-4 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : isError ? (
                  <tr>
                    <td
                      colSpan={role === "agent" ? 8 : 9}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      Failed to load portfolio data.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={role === "agent" ? 8 : 9}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      {search || riskFilter !== "all"
                        ? "No merchants match your filters."
                        : "No merchants found in your portfolio yet."}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b last:border-0 hover:bg-muted/30 transition-colors group"
                    >
                      {/* Merchant name */}
                      <td className="px-4 py-3">
                        <Link href={`/dashboard/contacts/${row.id}`}>
                          <a className="block">
                            <p className="font-medium text-foreground group-hover:text-primary transition-colors leading-tight">
                              {displayName(row)}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[180px]">
                              {subName(row)}
                            </p>
                          </a>
                        </Link>
                      </td>

                      {/* Health tier */}
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${riskBadgeClass(row.riskTier)}`}
                        >
                          {row.riskTier}
                        </span>
                      </td>

                      {/* Churn score */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-muted rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                row.churnScore >= 80
                                  ? "bg-red-500"
                                  : row.churnScore >= 60
                                  ? "bg-orange-500"
                                  : row.churnScore >= 40
                                  ? "bg-yellow-500"
                                  : "bg-green-500"
                              }`}
                              style={{ width: `${Math.min(100, Math.max(0, row.churnScore))}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {Math.round(row.churnScore)}
                          </span>
                        </div>
                      </td>

                      {/* Open tickets */}
                      <td className="px-4 py-3">
                        {row.openTickets > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-full px-2 py-0.5">
                            <Ticket className="w-3 h-3" /> {row.openTickets}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>

                      {/* Open tasks */}
                      <td className="px-4 py-3">
                        {row.openTasks > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-full px-2 py-0.5">
                            <CheckSquare className="w-3 h-3" /> {row.openTasks}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>

                      {/* Last contact */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarClock className="w-3 h-3 shrink-0" />
                          {fmtDate(row.lastContactedAt)}
                        </div>
                      </td>

                      {/* Next follow-up — inline date picker */}
                      <td className="px-4 py-3">
                        <FollowUpCell
                          row={row}
                          overrideDate={row.editableDealId !== null ? optimisticDates[row.editableDealId!] : undefined}
                          onSave={handleSaveFollowUp}
                          saving={row.editableDealId !== null && savingDealId === row.editableDealId}
                        />
                      </td>

                      {/* Rep email (admin/manager only) */}
                      {(role === "admin" || role === "manager") && (
                        <td className="px-4 py-3">
                          <span className="text-xs text-muted-foreground truncate max-w-[140px] block">
                            {row.ownerEmail ?? "—"}
                          </span>
                        </td>
                      )}

                      {/* Arrow */}
                      <td className="px-2 py-3">
                        <Link href={`/dashboard/contacts/${row.id}`}>
                          <a>
                            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                          </a>
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground" role="note">
            Search, risk and secondary sorting apply to this loaded page only. Summary metrics cover the authorized owner scope.
          </p>
          <nav aria-label="Portfolio pages" className="flex flex-wrap items-center gap-3">
            <label className="text-sm">Page size{" "}
              <select className="min-h-11 rounded border bg-background px-3" value={pageSize}
                onChange={event=>{setPageSize(Number(event.target.value) as 25 | 50 | 100);setOffset(0);}}>
                {[25,50,100].map(size=><option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <span className="text-sm">{data ? `${rows.length} displayed on page ${Math.floor(offset/pageSize)+1} · ${data.total} merchants in owner scope` : "Total unavailable"}</span>
            <Button variant="outline" disabled={isLoading || offset===0} onClick={()=>setOffset(Math.max(0,offset-pageSize))}>Previous</Button>
            <Button variant="outline" disabled={isLoading || isError || !data || offset+pageSize>=data.total} onClick={()=>setOffset(offset+pageSize)}>Next</Button>
            {isError && <Button variant="outline" onClick={()=>void refetch()}>Retry page</Button>}
          </nav>
        </CardContent>
      </Card>
    </div>
  );
}
