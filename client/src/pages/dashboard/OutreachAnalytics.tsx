import { useMutation } from "@tanstack/react-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { CrmDataState } from "@/components/crm/CrmPresentation";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BarChart2, Send, Mail, Eye, MessageCircle, AlertTriangle, FlaskConical, Trophy, Clock } from "lucide-react";
import type { Campaign, OutboundMessage } from "@shared/schema";
import { outreachViews } from "@/lib/crm-destination-state";
import { useC4RetainedSelection } from "@/hooks/use-c4-retained-selection";

function getMessageStatusBadge(status: string | null | undefined) {
  switch (status) {
    case "queued":
      return "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/30 dark:text-gray-300 dark:border-gray-800";
    case "sent":
    case "sending":
      return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800";
    case "delivered":
      return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800";
    case "opened":
      return "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800";
    case "replied":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800";
    case "bounced":
    case "failed":
      return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/30 dark:text-gray-300 dark:border-gray-800";
  }
}

function getCampaignStatusBadge(status: string | null | undefined) {
  switch (status) {
    case "active":
      return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800";
    case "paused":
      return "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-800";
    case "completed":
      return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800";
    case "draft":
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/30 dark:text-gray-300 dark:border-gray-800";
  }
}

interface ABTestResult {
  sequenceId: number;
  sequenceName: string;
  stepId: number;
  stepOrder: number;
  actionType: string;
  variantA: { subject?: string; body?: string };
  variantB: { subject?: string; body?: string };
  abTestConfig: { splitRatio: number; minSampleSize: number; winnerCriteria: string };
  abTestResults: {
    variantASent?: number;
    variantBSent?: number;
    aOpens?: number;
    bOpens?: number;
    aClicks?: number;
    bClicks?: number;
    aReplies?: number;
    bReplies?: number;
    winnerSelected?: string | null;
    winnerAt?: string | null;
    statisticallySignificant?: boolean;
  };
}

function ABTestCard({ test }: { test: ABTestResult }) {
  const r = test.abTestResults;
  const rate = (numerator: number | undefined, denominator: number | undefined) =>
    denominator != null && denominator > 0 && numerator != null ? ((numerator / denominator) * 100).toFixed(1) : "—";
  const aOpenRate = rate(r.aOpens, r.variantASent);
  const bOpenRate = rate(r.bOpens, r.variantBSent);
  const aClickRate = rate(r.aClicks, r.variantASent);
  const bClickRate = rate(r.bClicks, r.variantBSent);
  const aReplyRate = rate(r.aReplies, r.variantASent);
  const bReplyRate = rate(r.bReplies, r.variantBSent);
  const winnerCriteria = test.abTestConfig.winnerCriteria;
  const aConversionRate = winnerCriteria === "reply_rate" ? aReplyRate : winnerCriteria === "click_rate" ? aClickRate : aOpenRate;
  const bConversionRate = winnerCriteria === "reply_rate" ? bReplyRate : winnerCriteria === "click_rate" ? bClickRate : bOpenRate;
  const conversionLabel = winnerCriteria === "reply_rate" ? "Reply Rate" : winnerCriteria === "click_rate" ? "Click Rate" : "Open Rate";
  const totalSent = (r.variantASent ?? 0) + (r.variantBSent ?? 0);
  const minSample = test.abTestConfig.minSampleSize;
  const hasWinner = !!r.winnerSelected;
  const isRunning = !hasWinner && totalSent < minSample;
  const isReadyForWinner = !hasWinner && totalSent >= minSample;

  return (
    <Card data-testid={`ab-test-card-${test.stepId}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-sm font-semibold">{test.sequenceName}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Step {test.stepOrder} · {test.actionType}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {hasWinner && (
              <Badge variant="default" className="bg-green-600 gap-1" data-testid={`badge-ab-winner-${test.stepId}`}>
                <Trophy className="w-3 h-3" /> Winner: {r.winnerSelected}
              </Badge>
            )}
            {hasWinner && r.statisticallySignificant && (
              <Badge variant="outline" className="gap-1 text-green-700 border-green-400 text-[10px]" data-testid={`badge-ab-sig-${test.stepId}`}>
                95% confidence
              </Badge>
            )}
            {isRunning && (
              <Badge variant="outline" className="gap-1 text-yellow-600 border-yellow-400" data-testid={`badge-ab-running-${test.stepId}`}>
                <Clock className="w-3 h-3" /> Running ({totalSent}/{minSample} sent)
              </Badge>
            )}
            {isReadyForWinner && (
              <Badge variant="outline" className="gap-1 text-blue-600 border-blue-400" data-testid={`badge-ab-ready-${test.stepId}`}>
                Ready to pick winner
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className={`rounded-lg border p-3 ${r.winnerSelected === "A" ? "border-green-400 bg-green-50 dark:bg-green-950/20" : ""}`} data-testid={`ab-variant-a-${test.stepId}`}>
            <div className="flex items-center gap-1 mb-2">
              <span className="text-xs font-bold">Variant A</span>
              {r.winnerSelected === "A" && <Trophy className="w-3 h-3 text-green-600" />}
            </div>
            {test.variantA.subject && (
              <p className="text-xs text-muted-foreground truncate mb-1" title={test.variantA.subject}>
                "{test.variantA.subject}"
              </p>
            )}
            <div className="grid grid-cols-2 gap-1 text-xs">
              <div>
                <span className="text-muted-foreground">Sent</span>
                <p className="font-semibold" data-testid={`text-ab-a-sent-${test.stepId}`}>{r.variantASent ?? "—"}</p>
              </div>
              <div className="col-span-2 border-t pt-1 mt-1">
                <span className="text-muted-foreground font-medium">Conversion Rate ({conversionLabel})</span>
                <p className="font-bold text-sm text-primary" data-testid={`text-ab-a-conversion-${test.stepId}`}>{aConversionRate}{aConversionRate !== "—" ? "%" : ""}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Open Rate</span>
                <p className="font-semibold" data-testid={`text-ab-a-open-${test.stepId}`}>{aOpenRate}{aOpenRate !== "—" ? "%" : ""}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Click Rate</span>
                <p className="font-semibold" data-testid={`text-ab-a-click-${test.stepId}`}>{aClickRate}{aClickRate !== "—" ? "%" : ""}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Reply Rate</span>
                <p className="font-semibold" data-testid={`text-ab-a-reply-${test.stepId}`}>{aReplyRate}{aReplyRate !== "—" ? "%" : ""}</p>
              </div>
            </div>
          </div>
          <div className={`rounded-lg border p-3 ${r.winnerSelected === "B" ? "border-green-400 bg-green-50 dark:bg-green-950/20" : ""}`} data-testid={`ab-variant-b-${test.stepId}`}>
            <div className="flex items-center gap-1 mb-2">
              <span className="text-xs font-bold">Variant B</span>
              {r.winnerSelected === "B" && <Trophy className="w-3 h-3 text-green-600" />}
            </div>
            {test.variantB.subject && (
              <p className="text-xs text-muted-foreground truncate mb-1" title={test.variantB.subject}>
                "{test.variantB.subject}"
              </p>
            )}
            <div className="grid grid-cols-2 gap-1 text-xs">
              <div>
                <span className="text-muted-foreground">Sent</span>
                <p className="font-semibold" data-testid={`text-ab-b-sent-${test.stepId}`}>{r.variantBSent ?? "—"}</p>
              </div>
              <div className="col-span-2 border-t pt-1 mt-1">
                <span className="text-muted-foreground font-medium">Conversion Rate ({conversionLabel})</span>
                <p className="font-bold text-sm text-primary" data-testid={`text-ab-b-conversion-${test.stepId}`}>{bConversionRate}{bConversionRate !== "—" ? "%" : ""}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Open Rate</span>
                <p className="font-semibold" data-testid={`text-ab-b-open-${test.stepId}`}>{bOpenRate}{bOpenRate !== "—" ? "%" : ""}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Click Rate</span>
                <p className="font-semibold" data-testid={`text-ab-b-click-${test.stepId}`}>{bClickRate}{bClickRate !== "—" ? "%" : ""}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Reply Rate</span>
                <p className="font-semibold" data-testid={`text-ab-b-reply-${test.stepId}`}>{bReplyRate}{bReplyRate !== "—" ? "%" : ""}</p>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <span>Split: {test.abTestConfig.splitRatio}% A / {100 - test.abTestConfig.splitRatio}% B</span>
          <span>·</span>
          <span>Min sample: {minSample}</span>
          <span>·</span>
          <span>Winner by: {winnerCriteria === "open_rate" ? "Open Rate" : winnerCriteria === "click_rate" ? "Click Rate" : "Reply Rate"}</span>
          {r.winnerAt && (
            <>
              <span>·</span>
              <span>Decided: {new Date(r.winnerAt).toLocaleDateString()}</span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function OutreachAnalytics() {
  const { toast } = useToast();
  const child=useC4RetainedSelection("/dashboard/reporting","outreachView",outreachViews,"campaigns");

  const { data: campaigns, isLoading: campaignsLoading, isError: campaignsError, refetch: retryCampaigns } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
    queryFn:async({signal})=>{
      const response=await fetch("/api/campaigns",{credentials:"include",signal});
      if(!response.ok)throw new Error("Campaign observations unavailable");
      const rows=await response.json();
      if(!Array.isArray(rows)||rows.some(c=>!Number.isInteger(c?.id)||typeof c?.name!=="string"))
        throw new Error("Campaign collection shape unavailable");
      return rows;
    },
  });

  const { data: messages, isLoading: messagesLoading, isError: messagesError, refetch: retryMessages } = useQuery<OutboundMessage[]>({
    queryKey: ["/api/outbound-messages", "?limit=50"],
    queryFn: async ({signal}) => {
      const res = await fetch("/api/outbound-messages?limit=50", { credentials: "include",signal });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const rows=await res.json();
      if (!Array.isArray(rows)) throw new Error("Invalid outbound-message collection");
      return rows;
    },
  });

  const { data: abTestResults, isLoading: abLoading, isError: abError, refetch: retryAb } = useQuery<ABTestResult[]>({
    queryKey: ["/api/sequences/ab-test-results"],
  });

  const refreshAbMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sequences/trigger-ab-check");
      return res.json();
    },
    onSuccess: (data: { checked: number; updated: number; winnersSelected: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequences/ab-test-results"] });
      toast({
        title: "A/B tests refreshed",
        description: `Checked ${data.checked} test${data.checked !== 1 ? "s" : ""}. ${data.winnersSelected > 0 ? `${data.winnersSelected} winner${data.winnersSelected !== 1 ? "s" : ""} selected.` : "No new winners yet."}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "A/B refresh failed", description: err.message, variant: "destructive" });
    },
  });

  const campaignMetricsAvailable = !!campaigns && campaigns.every(c =>
    [c.totalSent, c.totalOpened, c.totalReplied, c.totalBounced].every(value => typeof value === "number"&&Number.isFinite(value)&&value>=0),
  );
  const totalCampaigns = campaigns?.length;
  const totalSent = campaignMetricsAvailable ? campaigns.reduce((sum, c) => sum + c.totalSent!, 0) : null;
  const totalOpened = campaignMetricsAvailable ? campaigns.reduce((sum, c) => sum + c.totalOpened!, 0) : null;
  const totalReplied = campaignMetricsAvailable ? campaigns.reduce((sum, c) => sum + c.totalReplied!, 0) : null;
  const totalBounced = campaignMetricsAvailable ? campaigns.reduce((sum, c) => sum + c.totalBounced!, 0) : null;
  const campaignRate = (value: number | null) => totalSent != null && totalSent > 0 && value != null ? ((value / totalSent) * 100).toFixed(1) : "—";
  const openRate = campaignRate(totalOpened);
  const replyRate = campaignRate(totalReplied);
  const bounceRate = campaignRate(totalBounced);

  const sortedCampaigns = campaigns
    ? [...campaigns].sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      })
    : [];

  const activeTests = (abTestResults || []).filter(t => !t.abTestResults.winnerSelected);
  const completedTests = (abTestResults || []).filter(t => !!t.abTestResults.winnerSelected);

  return (
    <div className="space-y-6">
      <div>
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-outreach-analytics-title">Outreach Analytics</h2>
           <p className="text-sm text-muted-foreground">Campaign performance, outbound message tracking, and A/B test results. Summary metrics cover loaded campaign records, not a global aggregate.</p>
        </div>
      </div>

      {campaignsLoading ? <CrmDataState state="loading" message="Loading campaign observations; independent report sections remain available."/>
      : campaignsError||!campaigns ? <CrmDataState state="unavailable" message="Campaign reporting is unavailable; no empty campaign population or zero performance is inferred." onRetry={()=>void retryCampaigns()}/>
      : <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card data-testid="card-kpi-total-campaigns">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Loaded Campaigns</CardTitle>
            <BarChart2 className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-campaigns">{totalCampaigns}</div>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-total-sent">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Messages Sent (loaded)</CardTitle>
            <Send className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-sent">{totalSent ?? "—"}</div>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-open-rate">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Open Rate</CardTitle>
            <Eye className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-open-rate">{openRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">{totalOpened ?? "—"} opened</p>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-reply-rate">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Reply Rate</CardTitle>
            <MessageCircle className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-reply-rate">{replyRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">{totalReplied ?? "—"} replied</p>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-bounce-rate">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bounce Rate</CardTitle>
            <AlertTriangle className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-bounce-rate">{bounceRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">{totalBounced ?? "—"} bounced</p>
          </CardContent>
        </Card>
      </div>

      }
      {child.issues.map(issue=><p key={issue.key} role="status" className="text-sm text-destructive">{issue.reason}</p>)}
      <Tabs value={child.value} onValueChange={value=>{if(outreachViews.includes(value as typeof child.value))child.setValue(value as typeof child.value);}} data-testid="outreach-tabs">
        <TabsList>
          <TabsTrigger value="campaigns" data-testid="tab-campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="ab-testing" data-testid="tab-ab-testing">
            <FlaskConical className="w-3.5 h-3.5 mr-1.5" />
            A/B Testing
            {!abLoading&&!abError&&abTestResults&&activeTests.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">{activeTests.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="messages" data-testid="tab-messages">Recent Messages</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="mt-4">
          <Card data-testid="card-campaign-performance">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart2 className="w-4 h-4" />
                Campaign Performance
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              {campaignsLoading ? <CrmDataState state="loading" message="Loading campaign observations."/>
              : campaignsError||!campaigns ? <CrmDataState state="unavailable" message="Campaign records unavailable; independent A/B results and message history remain selectable." onRetry={()=>void retryCampaigns()}/>
              : <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Opened</TableHead>
                    <TableHead className="text-right">Replied</TableHead>
                    <TableHead className="text-right">Bounced</TableHead>
                    <TableHead className="text-right">Open Rate</TableHead>
                    <TableHead className="text-right">Reply Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedCampaigns.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center h-24 text-muted-foreground" data-testid="text-no-campaigns">
                        No campaigns found
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedCampaigns.map((campaign) => {
                      const cSent = campaign.totalSent;
                      const cOpened = campaign.totalOpened;
                      const cReplied = campaign.totalReplied;
                      const cBounced = campaign.totalBounced;
                      const cRate = (value: number | null | undefined) =>
                        cSent != null && cSent > 0 && value != null ? ((value / cSent) * 100).toFixed(1) : "—";
                      const cOpenRate = cRate(cOpened);
                      const cReplyRate = cRate(cReplied);

                      return (
                        <TableRow key={campaign.id} data-testid={`row-campaign-${campaign.id}`}>
                          <TableCell className="font-medium" data-testid={`text-campaign-name-${campaign.id}`}>
                            {campaign.name}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`no-default-hover-elevate no-default-active-elevate ${getCampaignStatusBadge(campaign.status)}`}
                              data-testid={`badge-campaign-status-${campaign.id}`}
                            >
                              {campaign.status || "draft"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-campaign-sent-${campaign.id}`}>{cSent ?? "—"}</TableCell>
                          <TableCell className="text-right" data-testid={`text-campaign-opened-${campaign.id}`}>{cOpened ?? "—"}</TableCell>
                          <TableCell className="text-right" data-testid={`text-campaign-replied-${campaign.id}`}>{cReplied ?? "—"}</TableCell>
                          <TableCell className="text-right" data-testid={`text-campaign-bounced-${campaign.id}`}>{cBounced ?? "—"}</TableCell>
                          <TableCell className="text-right" data-testid={`text-campaign-open-rate-${campaign.id}`}>{cOpenRate}%</TableCell>
                          <TableCell className="text-right" data-testid={`text-campaign-reply-rate-${campaign.id}`}>{cReplyRate}%</TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ab-testing" className="mt-4 space-y-4" data-testid="tab-content-ab-testing">
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshAbMutation.mutate()}
              disabled={refreshAbMutation.isPending}
              className="gap-2"
              data-testid="button-refresh-ab"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {refreshAbMutation.isPending ? "Checking..." : "Refresh A/B Data"}
            </Button>
          </div>
          {abError ? <CrmDataState state="unavailable" message="A/B results unavailable; this is not a no-tests result." onRetry={()=>void retryAb()}/> : abLoading ? (
            <div className="space-y-4">
              {[1, 2].map(i => <Skeleton key={i} className="h-48 w-full" />)}
            </div>
          ) : (!abTestResults || abTestResults.length === 0) ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FlaskConical className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground mb-2">No A/B tests configured</p>
                <p className="text-sm text-muted-foreground">
                  When creating or editing a sequence step, toggle "A/B Test" on email or SMS steps to add a variant and start testing.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {activeTests.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-yellow-500" />
                    Active Tests ({activeTests.length})
                  </h3>
                  <div className="space-y-3">
                    {activeTests.map(t => <ABTestCard key={t.stepId} test={t} />)}
                  </div>
                </div>
              )}
              {completedTests.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-green-500" />
                    Completed Tests ({completedTests.length})
                  </h3>
                  <div className="space-y-3">
                    {completedTests.map(t => <ABTestCard key={t.stepId} test={t} />)}
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="messages" className="mt-4">
          <Card data-testid="card-recent-messages">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="w-4 h-4" />
                Recent Outbound Messages
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              {messagesError ? <CrmDataState state="unavailable" message="Message source unavailable; this is not an empty history." onRetry={()=>void retryMessages()}/> : messagesLoading ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Recipient</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Sent</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!messages || messages.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center h-24 text-muted-foreground" data-testid="text-no-messages">
                          No outbound messages found
                        </TableCell>
                      </TableRow>
                    ) : (
                      messages.map((msg) => (
                        <TableRow key={msg.id} data-testid={`row-message-${msg.id}`}>
                          <TableCell className="font-medium" data-testid={`text-message-recipient-${msg.id}`}>
                            {msg.toEmail || msg.toPhone || "N/A"}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate" data-testid={`text-message-subject-${msg.id}`}>
                            {msg.personalizedSubject || msg.subject || "--"}
                          </TableCell>
                          <TableCell data-testid={`text-message-channel-${msg.id}`}>
                            {msg.channel || "email"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`no-default-hover-elevate no-default-active-elevate ${getMessageStatusBadge(msg.status)}`}
                              data-testid={`badge-message-status-${msg.id}`}
                            >
                              {msg.status || "queued"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm" data-testid={`text-message-sent-at-${msg.id}`}>
                            {msg.sentAt
                              ? new Date(msg.sentAt).toLocaleString()
                              : msg.scheduledFor
                                ? `Scheduled: ${new Date(msg.scheduledFor).toLocaleString()}`
                                : "--"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
