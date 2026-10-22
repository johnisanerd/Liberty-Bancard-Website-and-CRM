import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { CrmDataState, CrmPage } from "@/components/crm/CrmPresentation";
import { AgentReportsNavigation } from "@/components/crm/AgentReportsNavigation";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader, ProvenanceNote } from "@/components/crm/CrmPresentation";
import { useAuth } from "@/hooks/use-auth";
import { leaderboardPeriods, leaderboardMetrics } from "@/lib/crm-destination-state";
import { useC4RetainedSelection } from "@/hooks/use-c4-retained-selection";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Trophy,
  TrendingUp,
  TrendingDown,
  Minus,
  Crown,
  Medal,
  Award,
  Settings,
  DollarSign,
  PhoneCall,
  Send,
  Target,
  Users,
  Percent,
} from "lucide-react";

type TimePeriod = "week" | "month" | "quarter" | "all";
type MetricKey = "deals" | "revenue" | "proposals" | "calls" | "responseRate" | "closeRate" | "contacts";
type BooleanSettingKey = "showDeals" | "showRevenue" | "showProposals" | "showCallsMade" | "showResponseRate" | "visibleToAgents";

interface LeaderboardEntry {
  agentId: number;
  name: string;
  initials: string;
  rank: number;
  dealsClosed: number;
  revenueManaged: number | null;
  proposalsSent: number;
  callsMade: number | null;
  responseRate: number | null;
  closeRate: number | null;   // #530
  contactsCreated: number | null; // #910
  prevDealsClosed: number;
  prevRevenueManaged: number | null;
  prevProposalsSent: number;
  prevCallsMade: number | null;
  prevResponseRate: number | null;
  prevCloseRate: number | null; // #530
  prevContactsCreated: number | null; // #910
  isCurrentUser: boolean;
  goalProgress?: number;
}

interface LeaderboardData {
  entries: LeaderboardEntry[];
  period: TimePeriod;
  visibility: "visible" | "disabled_by_configuration";
  read: {
    source:string; asOf:string; timezone:string; currentStart:string; currentEnd:string;
    completeness:"complete_returned_deal_population"|"incomplete_deal_population";
    loadedDealCount:number; totalDealCount:number; consistency:string; attribution:string;
    sources:{callLogs:"loaded"|"failed";creatorEvents:"loaded"|"failed"};
    attributionCompleteness:"ambiguous_legacy_aliases"|"unique_legacy_aliases";
    callAttribution:string;
  };
  settings: {
    showDeals: boolean;
    showRevenue: boolean;
    showProposals: boolean;
    showCallsMade: boolean;
    showResponseRate: boolean;
    visibleToAgents: boolean;
    monthlyDealGoal: number;
    monthlyRevenueGoal: string;
  };
}

const PERIOD_LABELS: Record<TimePeriod, string> = {
  week: "Last 7 Days",
  month: "This Month",
  quarter: "This Quarter",
  all: "All Time",
};

function TrendIndicator({ current, prev }: { current: number | null; prev: number | null }) {
  if(current==null||prev==null)return <span className="text-muted-foreground" aria-label="Comparison unavailable">—</span>;
  if (prev === 0 && current === 0) return <Minus className="w-3 h-3 text-muted-foreground" />;
  if (current > prev) return <TrendingUp className="w-3 h-3 text-green-600" />;
  if (current < prev) return <TrendingDown className="w-3 h-3 text-destructive" />;
  return <Minus className="w-3 h-3 text-muted-foreground" />;
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <Crown className="w-5 h-5 text-yellow-500" data-testid="icon-rank-1" />;
  if (rank === 2) return <Medal className="w-5 h-5 text-gray-400" data-testid={`icon-rank-${rank}`} />;
  if (rank === 3) return <Award className="w-5 h-5 text-amber-600" data-testid={`icon-rank-${rank}`} />;
  return <span className="text-sm font-bold text-muted-foreground w-5 text-center" data-testid={`text-rank-${rank}`}>{rank}</span>;
}

function formatRevenue(val: number | null) {
  if(val==null||!Number.isFinite(val))return "Unavailable";
  return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2}).format(val);
}

export default function Leaderboard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const periodState=useC4RetainedSelection("/dashboard/leaderboard","period",leaderboardPeriods,"month");
  const metricState=useC4RetainedSelection("/dashboard/leaderboard","metric",leaderboardMetrics,"deals");
  const period=periodState.value,setPeriod=periodState.setValue;
  const activeMetric=metricState.value,setActiveMetric=metricState.setValue;
  const [editingSettings, setEditingSettings] = useState(false);
  const [localSettings, setLocalSettings] = useState<LeaderboardData["settings"] | null>(null);

  const role = (user?.role as string) || "merchant";
  const isAdmin = role === "admin" || role === "manager";

  const { data, isLoading, isError, refetch } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard", period],
    queryFn: async ({signal}) => {
      const res = await fetch(`/api/leaderboard?period=${period}`, { credentials: "include",signal });
      if (!res.ok) throw new Error("Failed to load leaderboard");
      const data=await res.json();
      if(!Array.isArray(data?.entries)||!data.read?.asOf||!data.read?.timezone||
        !["complete_returned_deal_population","incomplete_deal_population"].includes(data.read?.completeness)||
        !["loaded","failed"].includes(data.read?.sources?.callLogs)||!["loaded","failed"].includes(data.read?.sources?.creatorEvents)||
        !["ambiguous_legacy_aliases","unique_legacy_aliases"].includes(data.read?.attributionCompleteness))
        throw new Error("Leaderboard population response incomplete");
      return data;
    },
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async (settings: Partial<LeaderboardData["settings"]>) =>
      apiRequest("PUT", "/api/leaderboard/settings", settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      toast({ title: "Settings saved" });
      setEditingSettings(false);
    },
    onError: (err: any) => toast({ title: "Failed to save settings", description: err.message, variant: "destructive" }),
  });

  const settings = data?.settings;
  const complete=data?.read.completeness==="complete_returned_deal_population"&&data.read.attributionCompleteness==="unique_legacy_aliases";
  const entries = complete ? data?.entries || [] : [];

  const metricKey: Record<string, keyof LeaderboardEntry> = {
    deals: "dealsClosed",
    revenue: "revenueManaged",
    proposals: "proposalsSent",
    calls: "callsMade",
    responseRate: "responseRate",
    closeRate: "closeRate", // #530
    contacts: "contactsCreated", // #910
  };

  const prevMetricKey: Record<string, keyof LeaderboardEntry> = {
    deals: "prevDealsClosed",
    revenue: "prevRevenueManaged",
    proposals: "prevProposalsSent",
    calls: "prevCallsMade",
    responseRate: "prevResponseRate",
    closeRate: "prevCloseRate", // #530
    contacts: "prevContactsCreated", // #910
  };

  const sortedEntries = [...entries].sort((a, b) => {
    const key = metricKey[activeMetric];
    return (b[key] as number) - (a[key] as number);
  }).map((e, i) => ({ ...e, rank: i + 1 }));

  const currentUserEntry = sortedEntries.find(e => e.isCurrentUser);
  const visibleEntries = sortedEntries.filter(e => !e.isCurrentUser || sortedEntries.indexOf(e) < 10);
  const top10 = sortedEntries.slice(0, 10);
  const needsSeparator = currentUserEntry && currentUserEntry.rank > 10;

  const formatMetricValue = (entry: LeaderboardEntry, metric: string): string => {
    if(entry[metricKey[metric]]==null)return "Unavailable";
    switch (metric) {
      case "deals": return `${entry.dealsClosed} deals`;
      case "revenue": return formatRevenue(entry.revenueManaged);
      case "proposals": return `${entry.proposalsSent} sent`;
      case "calls": return `${entry.callsMade} calls`;
      case "responseRate": return `${entry.responseRate}%`;
      case "closeRate": return `${entry.closeRate ?? 0}%`; // #530
      case "contacts": return `${entry.contactsCreated ?? 0} added`; // #910
      default: return "";
    }
  };

  type MetricTab = { key: string; label: string; icon: React.ElementType };
  const tabs = [
    settings?.showDeals !== false && { key: "deals", label: "Deals", icon: Trophy },
    settings?.showRevenue !== false && { key: "revenue", label: "Recorded Volume", icon: DollarSign },
    settings?.showProposals !== false && { key: "proposals", label: "Proposals", icon: Send },
    settings?.showCallsMade !== false && { key: "calls", label: "Calls", icon: PhoneCall },
    settings?.showResponseRate && { key: "responseRate", label: "Proposal Ratio (proxy)", icon: Percent },
    { key: "closeRate", label: "Close Rate", icon: Percent }, // #530
    { key: "contacts", label: "Contacts Added", icon: Users }, // #910
  ].filter(Boolean) as MetricTab[];

  function openSettings() {
    if (settings) setLocalSettings({ ...settings });
    setEditingSettings(true);
  }

  return (
    <CrmPage className="space-y-6" data-testid="leaderboard-page">
      {role==="agent"&&<AgentReportsNavigation />}
      <PageHeader
        title="Team Leaderboard"
        subtitle="Active agent roster and recorded operational observations"
        testId="text-leaderboard-title"
        actions={
          <>
            <Select value={period} onValueChange={(v) => setPeriod(v as TimePeriod)}>
              <SelectTrigger className="w-40" data-testid="select-time-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(PERIOD_LABELS) as [TimePeriod, string][]).map(([val, label]) => (
                  <SelectItem key={val} value={val}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isAdmin && (
              <Button variant="outline" size="icon" disabled={isError||isLoading||!settings} aria-label="Leaderboard settings" onClick={openSettings} data-testid="button-leaderboard-settings">
                <Settings className="w-4 h-4" />
              </Button>
            )}
          </>
        }
      />

      <ProvenanceNote testId="leaderboard-provenance"
        summary={<>Current period {data?.read.currentStart?.slice(0,10)??"unavailable"} through {data?.read.currentEnd?.slice(0,10)??"unavailable"} ({data?.read.timezone??"unavailable"}) · as of {data?.read.asOf??"unavailable"} · {data?.read.loadedDealCount??"unavailable"} of {data?.read.totalDealCount??"unavailable"} deals loaded ({data?.read.completeness??"unavailable"}). Stored closed-won volume is not observed revenue or native receipts.</>}>
        <p>Source: {data?.read.source??"unavailable"}; period {data?.read.currentStart??"unavailable"} through {data?.read.currentEnd??"unavailable"}; read asOf {data?.read.asOf??"unavailable"}; {data?.read.consistency??"no snapshot assumed"}.</p>
        <p>USD is a display assumption. Attribution: {data?.read.attribution??"unavailable"}. Call logs and immutable creator events are separate event populations, not merchant counts.</p>
        <p>Call records {data?.read.sources.callLogs??"unavailable"}; per-agent call attribution unavailable because stored calls lack a canonical actor. Creator-event source {data?.read.sources.creatorEvents??"unavailable"}. Proposal ratio is a touched-deal proxy, not a prospect response receipt.</p>
      </ProvenanceNote>
      {editingSettings && localSettings && (
        <Card data-testid="card-leaderboard-settings">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="w-4 h-4" />
              Leaderboard Configuration
            </CardTitle>
            <CardDescription>Choose which metrics appear and set monthly targets</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {(
                [
                  { key: "showDeals" as BooleanSettingKey, label: "Show Deals Closed" },
                  { key: "showRevenue" as BooleanSettingKey, label: "Show Recorded Volume" },
                  { key: "showProposals" as BooleanSettingKey, label: "Show Proposals Sent" },
                  { key: "showCallsMade" as BooleanSettingKey, label: "Show Calls Made" },
                  { key: "showResponseRate" as BooleanSettingKey, label: "Show Proposal Ratio (proxy)" },
                  { key: "visibleToAgents" as BooleanSettingKey, label: "Visible to All Reps" },
                ] as { key: BooleanSettingKey; label: string }[]
              ).map(({ key, label }) => (
                <div key={key} className="flex items-center gap-3">
                  <Switch
                    id={`switch-${key}`}
                    checked={localSettings[key]}
                    onCheckedChange={(val) => setLocalSettings(s => s ? { ...s, [key]: val } : s)}
                    data-testid={`switch-${key}`}
                  />
                  <Label htmlFor={`switch-${key}`} className="text-sm">{label}</Label>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4 pt-2 border-t">
              <div className="space-y-1.5">
                <Label className="text-sm">Monthly Deal Goal</Label>
                <Input
                  type="number"
                  min={0}
                  value={localSettings.monthlyDealGoal}
                  onChange={(e) => setLocalSettings(s => s ? { ...s, monthlyDealGoal: Number(e.target.value) } : s)}
                  data-testid="input-monthly-deal-goal"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Modeled Monthly Volume Target (USD assumed)</Label>
                <Input
                  type="number"
                  min={0}
                  value={localSettings.monthlyRevenueGoal}
                  onChange={(e) => setLocalSettings(s => s ? { ...s, monthlyRevenueGoal: e.target.value } : s)}
                  data-testid="input-monthly-revenue-goal"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditingSettings(false)} data-testid="button-cancel-settings">Cancel</Button>
              <Button onClick={() => localSettings && saveSettingsMutation.mutate(localSettings)} disabled={saveSettingsMutation.isPending} data-testid="button-save-settings">
                {saveSettingsMutation.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {[...periodState.issues,...metricState.issues].map(issue=><p key={issue.key} role="status" className="text-sm text-destructive">{issue.reason}</p>)}
      <Tabs value={activeMetric} onValueChange={(v) => setActiveMetric(v as MetricKey)}>
        <TabsList className="h-auto flex-wrap gap-1" data-testid="tabs-leaderboard-metrics">
          {tabs.map(({ key, label, icon: Icon }) => (
            <TabsTrigger key={key} value={key} data-testid={`tab-metric-${key}`}>
              <Icon className="w-3.5 h-3.5 mr-1.5" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {tabs.map(({ key }) => (
          <TabsContent key={key} value={key} className="mt-4">
            {isError||(!isLoading&&!complete) ? <CrmDataState state="unavailable" message="Complete leaderboard population unavailable; no empty team or zero performance is inferred." onRetry={()=>void refetch()}/>
            : data?.visibility==="disabled_by_configuration" ? <CrmDataState state="unavailable" message="Leaderboard visibility is disabled by configuration; the team is not assumed empty."/>
            : entries.some(e=>e[metricKey[key]]==null) ? <CrmDataState state="unavailable" message="Required observations, attribution or ratio denominator unavailable; no zero performance or revenue ranking is inferred."/>
            : isLoading ? (
              <Card>
                <CardContent className="pt-4">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-4 py-3 border-b last:border-0">
                      <Skeleton className="w-6 h-6 rounded-full" />
                      <Skeleton className="w-8 h-8 rounded-full" />
                      <Skeleton className="h-4 flex-1" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : entries.length === 0 ? (
              <Card data-testid="card-empty-leaderboard">
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="w-12 h-12 text-muted-foreground mb-3" />
                  <p className="font-medium">No data yet</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Leaderboard data will appear once agents have activity for this period.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card data-testid="card-leaderboard-rankings">
                <CardContent className="p-0">
                  <div className="divide-y">
                    {top10.map((entry) => {
                      const metricVal = entry[metricKey[activeMetric]] as number;
                      const prevVal = entry[prevMetricKey[activeMetric]] as number;
                      const goalPct = settings?.monthlyDealGoal && key === "deals"
                        ? Math.min(100, Math.round((entry.dealsClosed / settings.monthlyDealGoal) * 100))
                        : null;
                      return (
                        <div
                          key={entry.agentId}
                          className={`flex items-center gap-3 px-4 py-3 transition-colors ${entry.isCurrentUser ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/30"}`}
                          data-testid={`row-agent-${entry.agentId}`}
                        >
                          <div className="w-6 flex justify-center shrink-0">
                            <RankBadge rank={entry.rank} />
                          </div>
                          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">
                            {entry.initials}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate" data-testid={`text-agent-name-${entry.agentId}`}>
                                {entry.name}
                              </span>
                              {entry.isCurrentUser && (
                                <Badge variant="secondary" className="text-xs shrink-0" data-testid="badge-you">You</Badge>
                              )}
                            </div>
                            {goalPct !== null && (
                              <div className="mt-1 flex items-center gap-2">
                                <Progress value={goalPct} className="h-1.5 flex-1" />
                                <span className="text-xs text-muted-foreground shrink-0">{goalPct}% of goal</span>
                              </div>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <div className="flex items-center gap-1 justify-end">
                              <span className="font-semibold text-sm" data-testid={`text-metric-${entry.agentId}`}>
                                {key === "revenue" ? formatRevenue(metricVal) : key === "responseRate" || key === "closeRate" ? `${metricVal}%` : metricVal}
                              </span>
                              <TrendIndicator current={metricVal} prev={prevVal} />
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {key === "deals" ? "deals" : key === "revenue" ? "recorded volume" : key === "proposals" ? "proposals" : key === "responseRate" ? "proposal ratio (proxy)" : key === "contacts" ? "creator events" : "calls"}
                            </span>
                            {/* #1001 — Avg deal size when sorting by deals or revenue */}
                            {(key === "deals" || key === "revenue") && entry.dealsClosed > 0 && entry.revenueManaged!=null && (
                              <span className="text-[10px] text-muted-foreground block" data-testid={`text-avg-deal-${entry.agentId}`}>
                                avg {formatRevenue(Math.round(entry.revenueManaged / entry.dealsClosed))}
                              </span>
                            )}
                            {/* #1101 — Rep efficiency score (deals closed ÷ contacts worked) */}
                            {key === "deals" && (() => {
                              const contactsWorked = (entry as any).contactsWorked as number | undefined;
                              if (!contactsWorked || contactsWorked === 0) return null;
                              const eff = entry.dealsClosed / contactsWorked;
                              return (
                                <span className="text-[10px] text-primary/70 block" data-testid={`text-efficiency-${entry.agentId}`}>
                                  {Math.round(eff * 100)}% efficiency
                                </span>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })}

                    {needsSeparator && currentUserEntry && (
                      <>
                        <div className="px-4 py-2 text-xs text-muted-foreground text-center bg-muted/30">
                          · · ·
                        </div>
                        <div
                          className="flex items-center gap-3 px-4 py-3 bg-primary/5 border-l-2 border-l-primary"
                          data-testid={`row-agent-${currentUserEntry.agentId}-pinned`}
                        >
                          <div className="w-6 flex justify-center shrink-0">
                            <RankBadge rank={currentUserEntry.rank} />
                          </div>
                          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">
                            {currentUserEntry.initials}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">{currentUserEntry.name}</span>
                              <Badge variant="secondary" className="text-xs shrink-0">You</Badge>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="flex items-center gap-1 justify-end">
                              <span className="font-semibold text-sm">
                                {key === "revenue"
                                  ? formatRevenue(currentUserEntry[metricKey[activeMetric]] as number)
                                  : key === "responseRate"
                                  ? `${currentUserEntry[metricKey[activeMetric]]}%`
                                  : currentUserEntry[metricKey[activeMetric]]}
                              </span>
                              <TrendIndicator
                                current={currentUserEntry[metricKey[activeMetric]] as number}
                                prev={currentUserEntry[prevMetricKey[activeMetric]] as number}
                              />
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {settings?.monthlyDealGoal && key === "deals" && !isLoading && entries.length > 0 && (
              <Card className="mt-4" data-testid="card-goal-summary">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Target className="w-4 h-4 text-primary" />
                    Monthly Deal Goal: {settings.monthlyDealGoal} deals
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {sortedEntries.slice(0, 5).map((entry) => {
                      const pct = Math.min(100, Math.round((entry.dealsClosed / settings.monthlyDealGoal) * 100));
                      return (
                        <div key={entry.agentId} className="space-y-1" data-testid={`goal-row-${entry.agentId}`}>
                          <div className="flex justify-between text-xs">
                            <span className={entry.isCurrentUser ? "font-semibold" : ""}>{entry.name}</span>
                            <span className="text-muted-foreground">{entry.dealsClosed}/{settings.monthlyDealGoal}</span>
                          </div>
                          <Progress value={pct} className="h-1.5" />
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </CrmPage>
  );
}
