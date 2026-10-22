/**
 * /dashboard/partner-portal — Admin/Manager view of partner program health.
 *
 * Shows:
 * - Live merchants per partner and their residual earnings
 * - Referral pipeline status (pending → boarded → earning)
 * - Go-live notifications sent
 * - Monthly digest status
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, CrmPage, ScopedMetricStrip } from "@/components/crm/CrmPresentation";
import { CrmDataState } from "@/components/crm/CrmPresentation";
import { readFailureKind, metricAvailability } from "@/lib/query-state";
import {
  Users, DollarSign, TrendingUp, Building2, Search,
  RefreshCw, Loader2, CheckCircle, Clock, ArrowRight,
} from "lucide-react";
import type { PartnerPipelineRecord } from "@shared/partner-response";

type PipelineRow = {
  id: number;
  merchantName: string;
  status: string;
  pipelineStage: "pending" | "contacted" | "boarded" | "earning";
  commissionEarned: number;
  convertedAt: string | null;
  createdAt: string | null;
};

type EnrichedPartner = PartnerPipelineRecord;

const STAGE_COLORS: Record<string, string> = {
  pending:   "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  contacted: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  boarded:   "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  earning:   "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
};

function stageLabel(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtCurrency(value: string | number | null | undefined): string {
  const num = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  if (isNaN(num)) return "$0";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function PartnerPipelineCard({ partner }: { partner: EnrichedPartner }) {
  const [expanded, setExpanded] = useState(false);

  // Only fetch referrals when expanded (admin route via partner ID)
  const referralsRead = useQuery<PipelineRow[]>({
    queryKey: ["/api/referrals", { partnerId: partner.id }],
    queryFn: async () => {
      const res = await fetch(`/api/referrals?partnerId=${partner.id}`, { credentials: "include" });
      // A non-OK read is an error, not an empty referral list: throw so the card shows unavailable/denied with Retry.
      if (!res.ok) throw new Error(`${res.status}: referrals could not be read`);
      const data: any[] = await res.json();
      // map referral records to pipeline view
      return data.map(r => {
        let pipelineStage: PipelineRow["pipelineStage"];
        if (r.status === "paid") pipelineStage = "earning";
        else if (r.status === "converted") pipelineStage = "boarded";
        else if (r.status === "contacted") pipelineStage = "contacted";
        else pipelineStage = "pending";
        return {
          id: r.id,
          merchantName: r.referredCompany || r.referredName || "—",
          status: r.status,
          pipelineStage,
          commissionEarned: parseFloat(r.commissionAmount || r.incentiveAmount || "0"),
          convertedAt: r.convertedAt,
          createdAt: r.createdAt,
        };
      });
    },
    enabled: expanded,
  });

  const { isLoading } = referralsRead;
  const referrals = referralsRead.data ?? [];
  const stageCounts = { pending: 0, contacted: 0, boarded: 0, earning: 0 };
  for (const r of referrals) stageCounts[r.pipelineStage]++;

  return (
    <Card data-testid={`partner-card-${partner.id}`}>
      <button className="w-full text-left" onClick={() => setExpanded(e => !e)}>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">{partner.companyName}</CardTitle>
              <Badge variant={partner.status === "active" ? "default" : "secondary"} className="text-xs">
                {partner.status}
              </Badge>
              {partner.partnerCategory && (
                <Badge variant="outline" className="text-xs capitalize">{partner.partnerCategory}</Badge>
              )}
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-muted-foreground">
                {partner.referredMerchantCount || 0} merchants
              </span>
              <span className="text-primary font-semibold">
                {fmtCurrency(partner.openPipelineVolume)} open volume
              </span>
              <span className="text-muted-foreground text-xs">
                {partner.email}
              </span>
            </div>
          </div>
        </CardHeader>
      </button>

      {expanded && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading referrals…
            </div>
          ) : referralsRead.isError && referralsRead.data === undefined ? (
            <CrmDataState state={readFailureKind(referralsRead.error)} message={readFailureKind(referralsRead.error) === "denied" ? "You do not have access to this partner's referrals." : "This partner's referrals could not be loaded."} onRetry={() => void referralsRead.refetch()} />
          ) : referrals.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3" data-testid="partner-referrals-empty">No referrals on record for this partner yet.</p>
          ) : (
            <>
              {/* Stage summary */}
              <div className="grid grid-cols-4 gap-2 mb-4">
                {(["pending", "contacted", "boarded", "earning"] as const).map(stage => (
                  <div key={stage} className="rounded-lg border border-border p-2 text-center">
                    <p className="text-xs text-muted-foreground capitalize">{stage}</p>
                    <p className="text-lg font-bold">{stageCounts[stage]}</p>
                  </div>
                ))}
              </div>

              {/* Referral rows */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left pb-2 text-muted-foreground font-medium">Merchant</th>
                      <th className="text-left pb-2 text-muted-foreground font-medium">Stage</th>
                      <th className="text-right pb-2 text-muted-foreground font-medium">Commission</th>
                      <th className="text-right pb-2 text-muted-foreground font-medium">Referred</th>
                      <th className="text-right pb-2 text-muted-foreground font-medium">Converted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {referrals.map(r => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="py-2 font-medium text-foreground">{r.merchantName}</td>
                        <td className="py-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STAGE_COLORS[r.pipelineStage] || ""}`}>
                            {stageLabel(r.pipelineStage)}
                          </span>
                        </td>
                        <td className="py-2 text-right text-foreground">
                          {r.commissionEarned > 0 ? fmtCurrency(r.commissionEarned) : "—"}
                        </td>
                        <td className="py-2 text-right text-muted-foreground text-xs">{fmtDate(r.createdAt)}</td>
                        <td className="py-2 text-right text-muted-foreground text-xs">{fmtDate(r.convertedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function PartnerPortalAdmin() {
  const [search, setSearch] = useState("");

  const partnersRead = useQuery<EnrichedPartner[]>({
    queryKey: ["/api/partners/referral-pipeline"],
  });
  const { isLoading, refetch } = partnersRead;
  const partners = partnersRead.data ?? [];
  const readFailed = partnersRead.isError;
  // Pending, real zero, forbidden and unavailable stay distinct; a failed read is never shown as zero.
  const metric = (value: string | number) => isLoading ? "…" : partnersRead.data === undefined && readFailed ? "Unavailable" : value;

  const filtered = partners.filter(p => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      p.companyName?.toLowerCase().includes(q) ||
      p.contactName?.toLowerCase().includes(q) ||
      p.email?.toLowerCase().includes(q)
    );
  });

  const activePartners = partners.filter(p => p.status === "active").length;
  const totalReferrals = partners.reduce((s, p) => s + (p.referredMerchantCount || 0), 0);
  const totalPipeline = partners.reduce((s, p) => s + Number(p.openPipelineVolume || 0), 0);
  const earningPartners = partners.filter(p => (p.totalConversions ?? 0) > 0).length;

  return (
    <CrmPage className="space-y-6" data-testid="page-partner-portal-admin">
      <PageHeader
        title="Partner Portal"
        subtitle="Track referring partners, their merchant pipeline, and residual earnings"
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh">
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        }
      />

      {/* KPIs */}
      <ScopedMetricStrip className="grid-cols-2 sm:grid-cols-4 md:grid-cols-4 xl:grid-cols-4" scopeId="PartnerPortalAdmin" availability={metricAvailability(partnersRead)}>
        <Card data-testid="kpi-active-partners">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Users className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Active Partners</p>
                <p className="text-xl font-bold">{metric(activePartners)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-total-referrals">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                <Building2 className="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Referrals</p>
                <p className="text-xl font-bold">{metric(totalReferrals)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-pipeline-value">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                <DollarSign className="w-4 h-4 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground" title="Total processing volume on open sales deals for referred contacts. Not revenue.">Open Pipeline Volume</p>
                <p className="text-xl font-bold">{metric(fmtCurrency(totalPipeline))}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-earning-partners">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-purple-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Earning Partners</p>
                <p className="text-xl font-bold">{metric(earningPartners)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </ScopedMetricStrip>

      {/* Pipeline automation status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Automation Status</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-green-50 dark:bg-green-900/10">
            <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
            <div>
              <p className="text-sm font-medium">Go-Live Notifications</p>
              <p className="text-xs text-muted-foreground">Auto-email to referring partner when deal reaches Closed Won</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-green-50 dark:bg-green-900/10">
            <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
            <div>
              <p className="text-sm font-medium">Monthly Residuals Digest</p>
              <p className="text-xs text-muted-foreground">Auto-email on 1st of each month with earnings summary</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Partner list */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search partners…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            data-testid="input-search-partners"
          />
        </div>
        <p className="text-sm text-muted-foreground">{filtered.length} partner{filtered.length !== 1 ? "s" : ""}</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : readFailed && partnersRead.data === undefined ? (
        <CrmDataState state={readFailureKind(partnersRead.error)} message={readFailureKind(partnersRead.error) === "denied" ? "You do not have access to the partner list." : "The partner list could not be loaded."} onRetry={() => void refetch()} />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {search ? "No partners match your search." : "No partners in the program yet."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map(p => (
            <PartnerPipelineCard key={p.id} partner={p} />
          ))}
        </div>
      )}
    </CrmPage>
  );
}
