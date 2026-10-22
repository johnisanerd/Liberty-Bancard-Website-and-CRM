import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import {useCrmQuery as useQuery} from "@/hooks/use-crm-query";
import { Helmet } from "react-helmet-async";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, CrmPage } from "@/components/crm/CrmPresentation";
import { DataState } from "@/components/ui/data-state";
import { boardingStatuses } from "@/lib/crm-destination-state";
import { useC4RetainedSelection } from "@/hooks/use-c4-retained-selection";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import {
  Search, RefreshCw, Loader2, ExternalLink, Building2,
} from "lucide-react";

type BoardingStatus =
  | "submitted"
  | "under_review"
  | "more_info_needed"
  | "approved"
  | "declined";

interface Submission {
  dealId: number;
  contactId: number | null;
  merchantName: string;
  processorApplicationId: string | null;
  boardingStatus: BoardingStatus | string;
  boardingSubmittedAt: string | null;
  boardingApprovedAt: string | null;
  daysPending: number | null;
  latestLogMessage: string | null;
  latestLogTimestamp: string | null;
  mid: string | null;
  midMasked?: string | null; // REV-05A: server returns masked value; prefer midMasked when present
  owner: string | null;
  pipeline: string | null;
  stage: string | null;
}

interface SubmissionsResponse {
  submissions: Submission[];
  counts: Record<string, number>;
  read:{source:string;asOf:string;timezone:string;consistency:string;completeness:string;ownerScope:string;status:string;meaning:string};
  snapshot:string;
  total: number;
}

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "under_review", label: "Under Review" },
  { value: "more_info_needed", label: "More Info Needed" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
];

function getStatusVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
      return "default";
    case "declined":
      return "destructive";
    case "more_info_needed":
      return "outline";
    case "under_review":
      return "secondary";
    case "submitted":
      return "secondary";
    default:
      return "secondary";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "submitted":
      return "Submitted";
    case "under_review":
      return "Under Review";
    case "more_info_needed":
      return "More Info Needed";
    case "approved":
      return "Approved";
    case "declined":
      return "Declined";
    default:
      return status;
  }
}

function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const IN_FLIGHT_STATUSES: BoardingStatus[] = [
  "submitted",
  "under_review",
  "more_info_needed",
];

export default function BoardingTracker() {
  const { toast } = useToast();
  const statusState=useC4RetainedSelection("/dashboard/boarding","status",boardingStatuses,"all");
  const statusFilter=statusState.value;
  const setStatusFilter=(value:string)=>{if(boardingStatuses.includes(value as typeof statusFilter))statusState.setValue(value as typeof statusFilter);};
  const [search, setSearch] = useState("");

  const { data, isLoading,isError,error,refetch } = useQuery<SubmissionsResponse>({
    queryKey: ["/api/boarding/submissions", statusFilter],
    queryFn: async ({signal}) => {
      const url =
        statusFilter === "all"
          ? "/api/boarding/submissions"
          : `/api/boarding/submissions?status=${encodeURIComponent(statusFilter)}`;
      const res = await fetch(url, { credentials: "include",signal });
      if (!res.ok) throw new Error(`${res.status}: Boarding submissions unavailable`);
      const read=await res.json();
      if(!Array.isArray(read?.submissions)||read.submissions.some((row:any)=>!Number.isInteger(row?.dealId)||typeof row?.merchantName!=="string")||
        !read?.counts||typeof read.counts!=="object"||Array.isArray(read.counts)||
        read.read?.completeness!=="complete_authorized_recorded_cohort"||typeof read.read?.asOf!=="string"||
        typeof read.snapshot!=="string"||
        Object.values(read.counts).some(n=>!Number.isInteger(n)||Number(n)<0))
        throw new Error("Boarding submissions/counts shape unavailable");
      return read;
    },
  });

  const submissions = isLoading||isError?[]:data?.submissions || [];
  const counts = isLoading||isError?{}:data?.counts || {};

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return submissions;
    return submissions.filter((s) => {
      return (
        s.merchantName.toLowerCase().includes(q) ||
        (s.processorApplicationId?.toLowerCase().includes(q) ?? false) ||
        ((s.midMasked ?? s.mid)?.toLowerCase().includes(q) ?? false) ||
        String(s.dealId).includes(q)
      );
    });
  }, [submissions, search]);

  interface BulkRefreshResult {
    resultState: "success" | "partial_success" | "failed" | "no_op_with_reason";
    reason?: string;
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    results: Array<{
      dealId: number;
      outcome: "success" | "failed" | "skipped";
      status?: string;
      error?: string;
    }>;
  }

  const refreshAllMutation = useMutation({
    mutationFn: async () => {
      const inFlight = submissions.filter((s) =>
        IN_FLIGHT_STATUSES.includes(s.boardingStatus as BoardingStatus)
      );
      const res = await apiRequest("POST", "/api/boarding/refresh-all", {
        dealIds: inFlight.map((s) => s.dealId),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Refresh failed" }));
        throw new Error(err.message || "Refresh failed");
      }
      return res.json() as Promise<BulkRefreshResult>;
    },
    onSuccess: (result) => {
      if (result.resultState === "no_op_with_reason") {
        toast({ title: "Nothing to refresh", description: result.reason || "No in-flight deals." });
      } else if (result.resultState === "success") {
        toast({
          title: "Statuses refreshed",
          description: `${result.succeeded} of ${result.attempted} updated successfully.`,
        });
      } else if (result.resultState === "partial_success") {
        const firstFailure = result.results.find((r) => r.outcome === "failed" || r.outcome === "skipped");
        toast({
          title: "Refresh partially completed",
          description: `${result.succeeded} of ${result.attempted} updated · ${result.failed} failed · ${result.skipped} skipped.${
            firstFailure ? ` e.g. Deal #${firstFailure.dealId}: ${firstFailure.error}` : ""
          }`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Refresh failed",
          description: `All ${result.attempted} deals failed to refresh. ${result.results[0]?.error || ""}`,
          variant: "destructive",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/boarding/submissions"] });
    },
    onError: (err: any) => {
      toast({
        title: "Refresh failed",
        description: err.message || "Could not refresh statuses.",
        variant: "destructive",
      });
    },
  });

  const inFlightCount = submissions.filter((s) =>
    IN_FLIGHT_STATUSES.includes(s.boardingStatus as BoardingStatus)
  ).length;

  return (
    <CrmPage className="space-y-6" data-testid="page-boarding-tracker">
      <Helmet>
        <title>Boarding Submissions | Liberty Bancard</title>
      </Helmet>

      <PageHeader
        title="Boarding Submissions"
        subtitle="Underwriting tracker for all deals submitted to the processor."
        actions={
          <Button
            variant="outline"
            onClick={() => refreshAllMutation.mutate()}
            disabled={refreshAllMutation.isPending || inFlightCount === 0}
            data-testid="button-refresh-all"
          >
            {refreshAllMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Refresh All Statuses{inFlightCount > 0 ? ` (${inFlightCount})` : ""}
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(
          [
            "submitted",
            "under_review",
            "more_info_needed",
            "approved",
            "declined",
          ] as BoardingStatus[]
        ).map((s) => (
          <Card key={s} data-testid={`kpi-${s}`}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{getStatusLabel(s)}</p>
              <p className={`${isLoading||isError?"text-sm":"text-2xl"} font-bold text-foreground mt-1 break-words`}>
                {isLoading?"Loading":isError?"Unavailable":counts[s] ?? "—"}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by merchant, application ID, MID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-boarding"
          />
        </div>
      </div>

      <Tabs
        value={statusFilter}
        onValueChange={setStatusFilter}
        data-testid="tabs-boarding-status"
      >
        <TabsList className="flex-wrap h-auto gap-1">
          {STATUS_TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              data-testid={`tab-boarding-${tab.value}`}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {statusState.issues.map(issue=><p key={issue.key} role="status" className="text-sm text-destructive">{issue.reason}</p>)}

      {!isLoading&&!isError&&data&&<div className="space-y-1 text-xs text-muted-foreground">
        <p>Recorded boarding state, not a processor refresh receipt. Counts follow the selected status; search filters returned records locally.</p>
        <details><summary>Read scope and source</summary>
          <p>{data.read.ownerScope} · production, nonarchived deals · complete authorized recorded cohort · UTC as of {data.read.asOf}</p>
          <p className="break-all">Source: {data.read.source} · {data.read.consistency} · snapshot {data.snapshot}</p>
        </details>
      </div>}
      <DataState
        query={{ isLoading,isError,error,refetch, data: filtered }}
        emptyTitle="No boarding submissions found"
        emptyMessage={
          search || statusFilter !== "all"
            ? "Try adjusting your filters."
            : "Deals submitted to the processor will appear here."
        }
        testId="boarding"
      >
      <Card>
        <CardContent className="p-0">
          <ResponsiveTable
            data={filtered}
            keyExtractor={(s) => s.dealId}
            testId="boarding"
            columns={[
              {
                header: "Merchant",
                cell: (s) => (
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-foreground truncate" data-testid={`text-merchant-${s.dealId}`}>
                        {s.merchantName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Deal #{s.dealId}{s.owner ? ` · ${s.owner}` : ""}
                      </p>
                    </div>
                  </div>
                ),
              },
              {
                header: "Application ID",
                cell: (s) => (
                  <span className="font-mono text-xs" data-testid={`text-app-id-${s.dealId}`}>
                    {s.processorApplicationId || "—"}
                  </span>
                ),
              },
              {
                header: "Status",
                cell: (s) => (
                  <Badge variant={getStatusVariant(s.boardingStatus)} data-testid={`badge-status-${s.dealId}`}>
                    {getStatusLabel(s.boardingStatus)}
                  </Badge>
                ),
              },
              {
                header: "Submitted",
                cell: (s) => (
                  <span className="text-sm text-muted-foreground" data-testid={`text-submitted-${s.dealId}`}>
                    {formatDate(s.boardingSubmittedAt)}
                  </span>
                ),
              },
              {
                header: "Days Pending",
                cell: (s) => (
                  <span className="text-sm font-medium" data-testid={`text-days-${s.dealId}`}>
                    {s.daysPending !== null ? `${s.daysPending}d` : "—"}
                  </span>
                ),
              },
              {
                header: "Latest Log",
                className: "max-w-xs",
                cell: (s) => (
                  <div>
                    <p className="text-xs text-muted-foreground truncate" title={s.latestLogMessage || ""} data-testid={`text-log-${s.dealId}`}>
                      {s.latestLogMessage || "—"}
                    </p>
                    {s.latestLogTimestamp && (
                      <p className="text-[10px] text-muted-foreground/70">{formatDate(s.latestLogTimestamp)}</p>
                    )}
                  </div>
                ),
              },
              {
                header: "MID",
                cell: (s) => (
                  <span className="font-mono text-xs" data-testid={`text-mid-${s.dealId}`}>
                    {(s.midMasked ?? s.mid) || "—"}
                  </span>
                ),
              },
              {
                header: "Actions",
                className: "text-right",
                cell: (s) =>
                  s.contactId ? (
                    <Link href={`/dashboard/contacts/${s.contactId}`}>
                      <Button variant="ghost" size="sm" aria-label={`Open ${s.merchantName}`} data-testid={`button-open-${s.dealId}`}>
                        <ExternalLink className="w-4 h-4 mr-1" />
                        Open
                      </Button>
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  ),
              },
            ]}
            mobileCard={(s) => (
              <Card data-testid={`card-boarding-${s.dealId}`}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium text-foreground truncate" data-testid={`text-merchant-${s.dealId}`}>
                          {s.merchantName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Deal #{s.dealId}{s.owner ? ` · ${s.owner}` : ""}
                        </p>
                      </div>
                    </div>
                    <Badge variant={getStatusVariant(s.boardingStatus)} data-testid={`badge-status-${s.dealId}`}>
                      {getStatusLabel(s.boardingStatus)}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">App ID: </span>
                      <span className="font-mono">{s.processorApplicationId || "—"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">MID: </span>
                      <span className="font-mono">{(s.midMasked ?? s.mid) || "—"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Submitted: </span>
                      <span>{formatDate(s.boardingSubmittedAt)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Pending: </span>
                      <span className="font-medium">{s.daysPending !== null ? `${s.daysPending}d` : "—"}</span>
                    </div>
                  </div>
                  {s.latestLogMessage && (
                    <p className="text-xs text-muted-foreground truncate">{s.latestLogMessage}</p>
                  )}
                  {s.contactId && (
                    <Link href={`/dashboard/contacts/${s.contactId}`}>
                      <Button variant="outline" size="sm" className="w-full gap-1" aria-label={`Open ${s.merchantName}`} data-testid={`button-open-${s.dealId}`}>
                        <ExternalLink className="w-3.5 h-3.5" />
                        Open Contact
                      </Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            )}
          />
        </CardContent>
      </Card>
      </DataState>
    </CrmPage>
  );
}
