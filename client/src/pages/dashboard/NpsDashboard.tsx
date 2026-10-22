import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { readNpsStats, readNpsRecords } from "@/lib/nps-observation-reader";
import { CrmDataState } from "@/components/crm/CrmPresentation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { TrendingUp, Star, ThumbsDown, Minus, MessageSquare, BarChart3, Users } from "lucide-react";

function ScoreBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{count} <span className="text-muted-foreground text-xs">({pct}%)</span></span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function NpsDashboard() {
  const { data: stats, isLoading: statsLoading, isError:statsError, refetch:retryStats } = useQuery({
    queryKey: ["/api/nps/stats"],
    queryFn: ({signal}) => readNpsStats(signal),
  });

  const { data: responses = [], isLoading: responsesLoading, isError:responsesError, refetch:retryResponses } = useQuery({
    queryKey: ["/api/nps"],
    queryFn: ({signal}) => readNpsRecords(signal),
  });

  const recentSubmitted = responses.filter(r => r.submittedAt).slice(0, 10);

  const getScoreCategory = (score: number | null) => {
    if (score === null || score < 0 || score > 10) return { label: "Unassessed", variant: "secondary" as const };
    if (score >= 9) return { label: "Promoter", variant: "default" as const };
    if (score >= 7) return { label: "Passive", variant: "secondary" as const };
    return { label: "Detractor", variant: "destructive" as const };
  };

  const npsColor = (score: number) => {
    if (score >= 50) return "text-green-600 dark:text-green-400";
    if (score >= 0) return "text-amber-600 dark:text-amber-400";
    return "text-red-600 dark:text-red-400";
  };

  return (
    <div className="space-y-6" data-testid="nps-dashboard-page">
      <PageHeader
        title="NPS / CSAT Dashboard"
        subtitle="Net Promoter Score tracking and merchant satisfaction surveys"
      />

      {statsError && <CrmDataState state="unavailable" message="NPS aggregate unavailable; no zero score or survey count is inferred." onRetry={()=>void retryStats()}/>}
      {statsLoading && <p role="status">Loading NPS aggregate…</p>}
      {!statsError && !statsLoading && stats && <>
      <p className="text-xs text-muted-foreground">Source: {stats.metadata.source}; nonarchived production-contact survey records, all stored observations up to {stats.metadata.asOf}, UTC. One aggregate statement; independent records are not the same atomic snapshot. Counts are surveys, not unique merchants. {stats.scored} valid scored submissions; {stats.invalidSubmitted} submitted records lack a valid score.</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card data-testid="card-nps-score">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">NPS Score</CardTitle>
            <TrendingUp className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${stats.npsScore === null ? "text-muted-foreground" : npsColor(stats.npsScore)}`} data-testid="text-nps-score">
              {stats.npsScore ?? "Unassessed"}
            </div>
            <p className="text-xs text-muted-foreground mt-1">−100 to +100</p>
          </CardContent>
        </Card>

        <Card data-testid="card-avg-score">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Score</CardTitle>
            <Star className="w-4 h-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold" data-testid="text-avg-score">{stats?.avgScore ?? "—"}</div>
            <p className="text-xs text-muted-foreground mt-1">out of 10</p>
          </CardContent>
        </Card>

        <Card data-testid="card-submitted">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Responses</CardTitle>
            <MessageSquare className="w-4 h-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold" data-testid="text-submitted">{stats?.submitted ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-1">of {stats.total} stored surveys; not a sent count</p>
          </CardContent>
        </Card>

        <Card data-testid="card-promoters">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Promoters</CardTitle>
            <Users className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600 dark:text-green-400" data-testid="text-promoters">
              {stats?.promoters ?? 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">scores 9–10</p>
          </CardContent>
        </Card>
      </div>

      </>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {!statsError && !statsLoading && stats && <Card data-testid="card-score-breakdown">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              Score Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ScoreBar label="Promoters (9–10)" count={stats.promoters} total={stats.scored} color="bg-green-500" />
            <ScoreBar label="Passives (7–8)" count={stats.passives} total={stats.scored} color="bg-amber-400" />
            <ScoreBar label="Detractors (0–6)" count={stats.detractors} total={stats.scored} color="bg-red-500" />
            <div className="pt-2 border-t">
              <p className="text-xs text-muted-foreground">
                Submission share: {stats.total ? `${Math.round((stats.submitted / stats.total) * 100)}%` : "Unavailable"}
              </p>
            </div>
          </CardContent>
        </Card>}

        <Card data-testid="card-recent-responses">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" />
              Recent Responses
            </CardTitle>
          </CardHeader>
          <CardContent>
            {responsesError ? <CrmDataState state="unavailable" message="Independent NPS records unavailable; no empty response list is inferred." onRetry={()=>void retryResponses()}/> : responsesLoading ? <p role="status">Loading NPS records…</p> : recentSubmitted.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No responses yet</p>
            ) : (
              <div className="space-y-3">
                {recentSubmitted.map((r) => {
                  const category = getScoreCategory(r.score);
                  return (
                    <div key={r.id} className="flex items-start gap-3 p-3 rounded-md border" data-testid={`nps-response-${r.id}`}>
                      <div className="shrink-0">
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center font-bold text-sm">
                          {r.score ?? "?"}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={category.variant} className="text-xs">{category.label}</Badge>
                          <span className="text-xs text-muted-foreground">Day {r.dayTrigger} survey</span>
                          {r.submittedAt && (
                            <span className="text-xs text-muted-foreground">
                              {new Date(r.submittedAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        {r.comment && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{r.comment}</p>
                        )}
                        <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                          {r.reviewRequestQueued && <span className="text-green-600">Review requested ✓</span>}
                          {r.healthAlertCreated && <span className="text-amber-600">Alert created ⚠</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
