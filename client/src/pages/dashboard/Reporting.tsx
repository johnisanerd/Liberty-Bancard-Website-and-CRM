import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  TrendingUp,
  Ticket,
  ClipboardList,
  AlertTriangle,
  CheckCircle2,
  Clock,
} from "lucide-react";

interface PipelineData {
  sales: {
    total: number;
    active: number;
    closedWon: number;
    closedLost: number;
    nurture?: number;
    unclassifiedStage?: number;
    winRate: number | null;
    winRateBasis?: { numerator: number; denominator: number; available: boolean };
    stageDistribution: Record<string, number>;
    newLast30Days: number;
    wonLast30Days: number;
    stallingDeals: number;
  };
  onboarding: {
    total: number;
    active: number;
    completed: number;
  };
}

interface SupportData {
  total: number;
  open: number;
  resolved: number;
  slaBreaches: number;
  avgResolutionHours: number | null;
  categoryBreakdown: Record<string, number>;
  priorityBreakdown: Record<string, number>;
  meta: { exact: boolean; asOf: string; scope: string };
}

interface TaskData {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  overdue: number;
  priorityBreakdown: Record<string, number>;
  meta: { exact: boolean; asOf: string; scope: string };
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8" data-testid="reporting-loading">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4 rounded-full" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-6 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Reporting() {
  const { data: pipeline, isLoading: pipelineLoading, isError: pipelineError } = useQuery<PipelineData>({
    queryKey: ["/api/analytics/pipeline"],
  });

  const { data: support, isLoading: supportLoading, isError: supportError } = useQuery<SupportData>({
    queryKey: ["/api/analytics/support"],
  });

  const { data: tasks, isLoading: tasksLoading, isError: tasksError } = useQuery<TaskData>({
    queryKey: ["/api/analytics/tasks"],
  });

  const isLoading = pipelineLoading || supportLoading || tasksLoading;

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (pipelineError || supportError || tasksError || !pipeline?.sales || !pipeline.onboarding || !support || !tasks || !support.meta?.exact || !tasks.meta?.exact) {
    return (
      <div className="py-8 text-center text-destructive" data-testid="reporting-unavailable">
        Reporting data is unavailable. Please retry after the reporting services recover.
      </div>
    );
  }

  const sales = pipeline.sales;
  const onboarding = pipeline.onboarding;
  const stageMax = sales.stageDistribution
    ? Math.max(...Object.values(sales.stageDistribution), 1)
    : 1;
  const categoryMax = support.categoryBreakdown
    ? Math.max(...Object.values(support.categoryBreakdown), 1)
    : 1;
  const taskTotal = tasks.pending + tasks.inProgress + tasks.completed;

  return (
    <div className="space-y-8" data-testid="reporting-page">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card data-testid="card-kpi-winrate">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Win Rate</CardTitle>
            <TrendingUp className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold" data-testid="text-win-rate">
                 {sales.winRate == null ? "Not enough outcomes" : `${sales.winRate}%`}
              </span>
              {sales.winRate != null && (
                <span
                   className={`text-xs font-medium ${sales.winRate >= 50 ? "text-green-600" : "text-destructive"}`}
                  data-testid="text-win-rate-indicator"
                >
                   {sales.winRate >= 50 ? "On track" : "Below target"}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-win-rate-basis">
               {sales.closedWon} won of {sales.closedWon + sales.closedLost} decided deals
               {sales.winRate == null ? " (no deal has been won or lost yet)" : ""}
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-active-pipeline">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Pipeline</CardTitle>
            <BarChart3 className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-active-pipeline">
               {sales.active}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
               open pipeline stages · {sales.total} total sales deals
               {(sales.nurture ?? 0) > 0 ? ` · ${sales.nurture} nurture` : ""}
               {(sales.unclassifiedStage ?? 0) > 0 ? ` · ${sales.unclassifiedStage} in an unrecognized stage` : ""}
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-open-tickets">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Open Tickets</CardTitle>
            <Ticket className="w-4 h-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-open-tickets">
               {support.open}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
               {support.total} total tickets
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-overdue-tasks">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Overdue Tasks</CardTitle>
             <ClipboardList className={`w-4 h-4 ${tasks.overdue > 0 ? "text-destructive" : "text-muted-foreground"}`} />
          </CardHeader>
          <CardContent>
            <div
               className={`text-2xl font-bold ${tasks.overdue > 0 ? "text-destructive" : ""}`}
              data-testid="text-overdue-tasks"
            >
               {tasks.overdue}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
               {tasks.total} total tasks
            </p>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-pipeline-performance">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            Pipeline Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3" data-testid="pipeline-stage-distribution">
            <p className="text-sm font-medium text-muted-foreground">Stage Distribution</p>
             {Object.keys(sales.stageDistribution).length > 0 ? (
              Object.entries(sales.stageDistribution).map(([stage, count]) => (
                <div key={stage} className="space-y-1" data-testid={`stage-row-${stage.toLowerCase().replace(/\s+/g, "-")}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm">{stage}</span>
                    <span className="text-sm font-medium text-muted-foreground">{count}</span>
                  </div>
                  <Progress
                    value={(count / stageMax) * 100}
                    className="h-2"
                    data-testid={`progress-stage-${stage.toLowerCase().replace(/\s+/g, "-")}`}
                  />
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No stage data available</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="pipeline-key-stats">
            <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
              <TrendingUp className="w-4 h-4 text-primary shrink-0" />
              <div>
                 <p className="text-sm font-medium" data-testid="text-new-deals-30d">{sales.newLast30Days}</p>
                <p className="text-xs text-muted-foreground">New deals (30d)</p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
              <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
              <div>
                 <p className="text-sm font-medium" data-testid="text-won-deals-30d">{sales.wonLast30Days}</p>
                <p className="text-xs text-muted-foreground">Won deals (30d)</p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <div>
                 <p className="text-sm font-medium" data-testid="text-stalling-deals">{sales.stallingDeals}</p>
                <p className="text-xs text-muted-foreground">Stalling deals</p>
              </div>
            </div>
          </div>

          <div data-testid="pipeline-onboarding-summary">
            <p className="text-sm font-medium text-muted-foreground mb-2">Onboarding Summary</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" data-testid="badge-onboarding-active">
                 Active: {onboarding.active}
              </Badge>
              <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" data-testid="badge-onboarding-completed">
                 Completed: {onboarding.completed}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card data-testid="card-support-performance">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Ticket className="w-4 h-4 text-orange-500" />
              Support Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3" data-testid="support-category-breakdown">
              <p className="text-sm font-medium text-muted-foreground">Category Breakdown</p>
               {Object.keys(support.categoryBreakdown).length > 0 ? (
                Object.entries(support.categoryBreakdown).map(([category, count]) => (
                  <div key={category} className="space-y-1" data-testid={`category-row-${category.toLowerCase().replace(/[\s\/&]+/g, "-")}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm">{category}</span>
                      <span className="text-sm font-medium text-muted-foreground">{count}</span>
                    </div>
                    <Progress
                      value={(count / categoryMax) * 100}
                      className="h-2"
                    />
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No category data available</p>
              )}
            </div>

            <div data-testid="support-priority-breakdown">
              <p className="text-sm font-medium text-muted-foreground mb-2">Priority Breakdown</p>
              <div className="flex flex-wrap gap-2">
                 {Object.entries(support.priorityBreakdown).map(([priority, count]) => (
                  <Badge
                    key={priority}
                    variant={priority === "Urgent" ? "destructive" : "secondary"}
                    data-testid={`badge-priority-${priority.toLowerCase()}`}
                  >
                    {priority}: {count}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4" data-testid="support-metrics">
              <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
                <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium" data-testid="text-avg-resolution">{support.avgResolutionHours == null ? "—" : `${support.avgResolutionHours}h`}</p>
                  <p className="text-xs text-muted-foreground">Avg resolution</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
                <AlertTriangle className={`w-4 h-4 shrink-0 ${support.slaBreaches > 0 ? "text-destructive" : "text-green-600"}`} />
                <div>
                  <Badge
                    variant={support.slaBreaches > 0 ? "destructive" : "secondary"}
                    data-testid="badge-sla-breaches"
                  >
                    {support.slaBreaches} SLA breaches
                  </Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-task-performance">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-primary" />
              Task Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div data-testid="task-status-breakdown">
              <p className="text-sm font-medium text-muted-foreground mb-3">Status Breakdown</p>
              {taskTotal > 0 ? (
                <>
                  <div className="flex rounded-full overflow-hidden h-4 bg-muted" data-testid="task-status-bar">
                    <div
                      className="bg-amber-500 transition-all"
                      style={{ width: `${(tasks!.pending / taskTotal) * 100}%` }}
                      title={`Pending: ${tasks!.pending}`}
                    />
                    <div
                      className="bg-blue-500 transition-all"
                      style={{ width: `${(tasks!.inProgress / taskTotal) * 100}%` }}
                      title={`In Progress: ${tasks!.inProgress}`}
                    />
                    <div
                      className="bg-green-600 transition-all"
                      style={{ width: `${(tasks!.completed / taskTotal) * 100}%` }}
                      title={`Completed: ${tasks!.completed}`}
                    />
                  </div>
                  <div className="flex flex-wrap gap-3 mt-3 text-xs">
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full bg-amber-500" />
                      <span data-testid="text-task-pending">Pending: {tasks!.pending}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span data-testid="text-task-in-progress">In Progress: {tasks!.inProgress}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full bg-green-600" />
                      <span data-testid="text-task-completed">Completed: {tasks!.completed}</span>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No task data available</p>
              )}
            </div>

            <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50" data-testid="task-overdue-warning">
               {tasks.overdue > 0 ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
                  <span className="text-sm text-destructive font-medium" data-testid="text-task-overdue-count">
                    {tasks!.overdue} overdue tasks require attention
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                  <span className="text-sm text-green-600 font-medium" data-testid="text-task-overdue-count">
                    No overdue tasks
                  </span>
                </>
              )}
            </div>

            <div data-testid="task-priority-breakdown">
              <p className="text-sm font-medium text-muted-foreground mb-2">Priority Breakdown</p>
              <div className="flex flex-wrap gap-2">
                 {Object.entries(tasks.priorityBreakdown).map(([priority, count]) => (
                  <Badge
                    key={priority}
                    variant={priority === "urgent" ? "destructive" : "secondary"}
                    data-testid={`badge-task-priority-${priority.toLowerCase()}`}
                  >
                    {priority.charAt(0).toUpperCase() + priority.slice(1)}: {count}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
