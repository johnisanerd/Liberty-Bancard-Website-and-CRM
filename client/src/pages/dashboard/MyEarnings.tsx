import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { CrmDataState, CrmPage, CrmPageHeader, ScopedMetricStrip } from "@/components/crm/CrmPresentation";
import { AgentReportsNavigation } from "@/components/crm/AgentReportsNavigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { DollarSign, Clock, CheckCircle, Banknote, TrendingUp } from "lucide-react";

interface AgentPayout {
  id: number;
  agentUserId: string;
  periodMonth: string;
  grossResidual: string;
  agentShare: string;
  partnerShare: string;
  status: string;
  paidAt: string | null;
  notes: string | null;
  createdAt: string;
}

function formatCurrency(value: string | number | null | undefined): string {
  if(value==null || (typeof value==="string"&&!/^[-+]?\d+(\.\d+)?$/.test(value.trim())))return "Unavailable";
  const num = typeof value === "string" ? Number(value) : value;
  if(!Number.isFinite(num))return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

function PayoutStatusBadge({ status }: { status: string }) {
  if (status === "paid") {
    return (
      <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-0">
        <Banknote className="w-3 h-3 mr-1" />Paid
      </Badge>
    );
  }
  if (status === "approved") {
    return (
      <Badge className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-0">
        <CheckCircle className="w-3 h-3 mr-1" />Approved
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs">
      <Clock className="w-3 h-3 mr-1" />Pending
    </Badge>
  );
}

export default function MyEarnings() {
  const { data: payouts = [], isLoading, isError, refetch, dataUpdatedAt } = useQuery<AgentPayout[]>({
    queryKey: ["/api/payouts/my"],
    queryFn:async({signal})=>{
      const response=await fetch("/api/payouts/my",{credentials:"include",signal});
      if(!response.ok)throw new Error("Your payout ledger is unavailable");
      const data=await response.json();
      if(!Array.isArray(data) || data.some(p=>typeof p.agentShare!=="string" || !/^[-+]?\d+(\.\d+)?$/.test(p.agentShare.trim()) || !Number.isFinite(Number(p.agentShare)) || !["pending","approved","paid"].includes(p.status)))
        throw new Error("Payout amount observation incomplete");
      return data;
    },
  });

  const paidObservations=payouts.filter(p=>p.status==="paid");
  const pendingObservations=payouts.filter(p=>p.status!=="paid");
  const totalPaid = paidObservations.length ? paidObservations.reduce((acc,p)=>acc+Number(p.agentShare),0) : null;
  const totalPending = pendingObservations.length ? pendingObservations.reduce((acc,p)=>acc+Number(p.agentShare),0) : null;

  const latestPayout = payouts[0] ?? null;

  return (
    <CrmPage className="space-y-6" data-testid="page-my-earnings">
      <AgentReportsNavigation />
      <div>
        <CrmPageHeader title="My Earnings" description="Your residual commission history — period by period" titleTestId="text-page-title" />
        <p className="text-xs text-muted-foreground">Source: authorized /api/payouts/my ledger; client read {dataUpdatedAt?new Date(dataUpdatedAt).toISOString():"unavailable"}. USD display assumption; periods are the returned ledger periods. Recorded paid status is not a native settlement receipt or a complete earnings forecast.</p>
      </div>
      {isError ? <CrmDataState state="unavailable" message="Your payout ledger is unavailable; no zero earnings, empty history or pending assignment is inferred." onRetry={()=>void refetch()}/> : <>

      {/* KPI Cards */}
      <ScopedMetricStrip className="grid-cols-1 sm:grid-cols-3 md:grid-cols-3 xl:grid-cols-3" testId="section-earnings-kpis" scopeId="my-earnings">
        <Card data-testid="card-total-paid">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Recorded Paid Share</CardTitle>
            <Banknote className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold text-green-600" data-testid="text-total-paid">
                {payouts.length?formatCurrency(totalPaid):"Unavailable"}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Returned ledger records marked paid; not native settlement</p>
          </CardContent>
        </Card>

        <Card data-testid="card-pending-earnings">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending / Approved</CardTitle>
            <Clock className="w-4 h-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold" data-testid="text-pending-earnings">
                {payouts.length?formatCurrency(totalPending):"Unavailable"}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Returned records marked pending or approved; not a payment forecast</p>
          </CardContent>
        </Card>

        <Card data-testid="card-latest-period">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Latest Returned Record</CardTitle>
            <TrendingUp className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : latestPayout ? (
              <>
                <div className="text-2xl font-bold" data-testid="text-latest-period-amount">
                  {formatCurrency(latestPayout.agentShare)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{latestPayout.periodMonth}</p>
              </>
            ) : (
              <div className="text-2xl font-bold text-muted-foreground">—</div>
            )}
          </CardContent>
        </Card>
      </ScopedMetricStrip>

      {/* Payout History Table */}
      <Card data-testid="card-payout-history">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-primary" />
            Payout History
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Stored payout ledger records. Local status does not prove native payment or complete imported earnings.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : payouts.length === 0 ? (
            <div className="py-12 text-center" data-testid="text-no-earnings">
              <DollarSign className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No payout records returned in your authorized ledger.</p>
              <p className="text-xs text-muted-foreground mt-1">
                This does not establish zero earnings or native ingestion completeness.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="table-payout-history">
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Gross Residual</TableHead>
                    <TableHead className="text-right">Your Share</TableHead>
                    <TableHead className="text-right">Partner Share</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Paid On</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payouts.map((payout) => (
                    <TableRow key={payout.id} data-testid={`row-payout-${payout.id}`}>
                      <TableCell className="font-mono font-medium">{payout.periodMonth}</TableCell>
                      <TableCell className="text-right">{formatCurrency(payout.grossResidual)}</TableCell>
                      <TableCell className="text-right font-semibold text-green-600 dark:text-green-400">
                        {formatCurrency(payout.agentShare)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {parseFloat(payout.partnerShare || "0") > 0
                          ? formatCurrency(payout.partnerShare)
                          : <span className="text-xs">—</span>}
                      </TableCell>
                      <TableCell>
                        <PayoutStatusBadge status={payout.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {payout.paidAt
                          ? new Date(payout.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                          : <span className="text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                        {payout.notes || <span>—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      </>}
    </CrmPage>
  );
}
