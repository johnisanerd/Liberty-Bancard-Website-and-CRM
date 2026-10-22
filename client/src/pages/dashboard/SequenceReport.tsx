import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import type { SequenceRuntimeStatus } from "@shared/sequence-runtime-status";
import { SequenceRuntimeFacts } from "@/components/dashboard/SequenceRuntimeFacts";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Mail, MessageSquare, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Send, Zap, RefreshCw, BarChart3, Users, ShieldAlert, Activity, Inbox,
} from "lucide-react";

interface SequenceRow {
  id: number;
  name: string;
  status: string;
  trigger_type: string;
  sequence_family: string | null;
  description: string | null;
  eligible_consent_tiers: string[] | null;
  channels_allowed: string[] | null;
  lifecycle_stages_allowed: string[] | null;
  step_count: number;
  email_steps: number;
  sms_steps: number;
  ghl_steps: number;
  task_steps: number;
  max_delay_days: string | null;
  active_enrollments: number;
  completed_enrollments: number;
}

interface SendingIdentity {
  id: number;
  label: string;
  domain: string;
  email_address: string;
  mailbox_type: string;
  provider: string | null;
  is_active: boolean;
  warmup_status: string;
  daily_limit: number;
  sent_today: number;
  bounces_today: number;
  complaints_today: number;
  health_score: number;
  vertical_assignment: string | null;
  last_used_at: string | null;
}

interface ReportData {
  runtime: SequenceRuntimeStatus;
  generatedAt: string;
  summary: {
    total: number;
    active: number;
    paused: number;
    totalEmailSteps: number;
    totalSmsSteps: number;
    dailyCap: number;
    stallCount: number;
    activeIdentities: number;
  };
  sendingIdentities: SendingIdentity[];
  activeSequences: SequenceRow[];
  stalledEnrollments: SequenceRow[];
  enrollmentTotals: Record<string, number>;
  pausedByFamily: Record<string, SequenceRow[]>;
  sequences: SequenceRow[];
}

function StatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge className="bg-green-100 text-green-800 border-green-200 border text-xs">active</Badge>;
  if (status === "paused") return <Badge className="bg-amber-100 text-amber-800 border-amber-200 border text-xs">paused</Badge>;
  return <Badge variant="outline" className="text-xs">{status}</Badge>;
}

function WarmupBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    warm: "bg-green-100 text-green-800 border-green-200",
    warming: "bg-blue-100 text-blue-800 border-blue-200",
    cold: "bg-gray-100 text-gray-700 border-gray-200",
    paused: "bg-amber-100 text-amber-800 border-amber-200",
  };
  const cls = map[status] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>{status}</span>;
}

function CadencePill({ email, sms, days }: { email: number; sms: number; days: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {email > 0 && <span className="inline-flex items-center gap-0.5"><Mail className="h-3 w-3 text-blue-500" />{email}</span>}
      {sms > 0 && <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3 text-purple-500" />{sms}</span>}
      {days && <span className="text-gray-400">/ {days}d</span>}
    </span>
  );
}

function TriggerChip({ type }: { type: string }) {
  const labels: Record<string, string> = {
    manual: "Manual",
    form_submission: "Form",
    form_submitted: "Form",
    inbound_classification: "Inbound Intent",
    contact_created: "Contact Created",
    call_outcome: "Call Outcome",
    deal_stage_changed: "Deal Stage",
  };
  return <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{labels[type] ?? type}</span>;
}

function KpiCard({ label, value, sub, icon: Icon, warn }: { label: string; value: string | number; sub?: string; icon: any; warn?: boolean }) {
  return (
    <Card className={warn ? "border-amber-300 bg-amber-50" : ""}>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
            <p className={`text-3xl font-bold mt-1 ${warn ? "text-amber-700" : ""}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <Icon className={`h-5 w-5 mt-0.5 ${warn ? "text-amber-500" : "text-muted-foreground"}`} />
        </div>
      </CardContent>
    </Card>
  );
}

function AnalysisPanel({ data }: { data: ReportData }) {
  const { toast } = useToast();
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisTime, setAnalysisTime] = useState<string | null>(null);

  const analyze = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sequence-report/analyze", {
      summary: data.summary,
      activeSequences: data.activeSequences,
      stalledEnrollments: data.stalledEnrollments,
      sendingIdentities: data.sendingIdentities,
      enrollmentTotals: data.enrollmentTotals,
      pausedByFamily: Object.fromEntries(
        Object.entries(data.pausedByFamily).map(([k, v]) => [k, v.map(s => s.name)])
      ),
    }),
    onSuccess: (res: any) => {
      setAnalysis(res.analysis);
      setAnalysisTime(res.generatedAt);
      toast({ title: "Analysis complete", description: "AI audit report generated." });
    },
    onError: () => {
      toast({ title: "Analysis failed", description: "Could not generate AI analysis.", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-500" />
              AI Business Alignment Audit
            </CardTitle>
            <CardDescription>GPT-4o analysis of sequences vs. Liberty Bancard business model</CardDescription>
          </div>
          <Button
            onClick={() => analyze.mutate()}
            disabled={analyze.isPending}
            data-testid="button-run-analysis"
            size="sm"
          >
            {analyze.isPending ? (
              <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />Analyzing…</>
            ) : (
              <><Zap className="h-3.5 w-3.5 mr-1.5" />Run Analysis</>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!analysis && !analyze.isPending && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Click "Run Analysis" to generate a business-aligned audit of your sequences, sending infrastructure, and coverage gaps.
          </p>
        )}
        {analyze.isPending && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Running audit… this takes 15–20 seconds
          </div>
        )}
        {analysis && (
          <div className="space-y-1">
            {analysisTime && (
              <p className="text-xs text-muted-foreground mb-3">Generated {new Date(analysisTime).toLocaleString()}</p>
            )}
            <div className="prose prose-sm max-w-none text-sm leading-relaxed whitespace-pre-wrap font-mono bg-slate-50 rounded-md p-4 border text-slate-800 overflow-auto max-h-[600px]">
              {analysis}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PausedFamilyGroup({ family, sequences }: { family: string; sequences: SequenceRow[] }) {
  const [open, setOpen] = useState(false);
  const totalE = sequences.reduce((a, s) => a + s.email_steps, 0);
  const totalS = sequences.reduce((a, s) => a + s.sms_steps, 0);
  const hasStalled = sequences.some(s => s.active_enrollments > 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 rounded-lg border cursor-pointer transition-colors">
          <div className="flex items-center gap-2 text-left">
            {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="text-sm font-medium">{family}</span>
            {hasStalled && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
          </div>
          <div className="flex items-center gap-3">
            <CadencePill email={totalE} sms={totalS} days={null} />
            <span className="text-xs text-muted-foreground">{sequences.length} seq</span>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-6 space-y-1 pb-2">
          {sequences.map(s => (
            <div key={s.id} className="flex items-center justify-between px-3 py-2 rounded bg-muted/20 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <TriggerChip type={s.trigger_type} />
                <span className="truncate text-sm">{s.name}</span>
                {s.active_enrollments > 0 && (
                  <span className="text-xs text-amber-600 font-medium">⚠ {s.active_enrollments} stalled</span>
                )}
              </div>
              <CadencePill email={s.email_steps} sms={s.sms_steps} days={s.max_delay_days} />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function SequenceReport() {
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery<ReportData>({
    queryKey: ["/api/sequence-report"],
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm gap-2">
        <RefreshCw className="h-4 w-4 animate-spin" /> Building report…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        Failed to load sequence report. Check API.
      </div>
    );
  }

  const { summary, sendingIdentities, activeSequences, stalledEnrollments, enrollmentTotals, pausedByFamily } = data;
  const activeEnroll = enrollmentTotals["active"] ?? 0;
  const completedEnroll = enrollmentTotals["completed"] ?? 0;

  return (
    <>
      <Helmet>
        <title>Sequence Report | Liberty Bancard</title>
      </Helmet>

      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <PageTitle className="text-2xl font-bold">Sequence & Sending Report</PageTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              Full audit of all sequences, sending infrastructure, and enrollment status.
              {dataUpdatedAt ? ` Last loaded ${new Date(dataUpdatedAt).toLocaleTimeString()}.` : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-report">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
          </Button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <KpiCard label="Total Sequences" value={summary.total} icon={BarChart3} />
          <KpiCard label="Active" value={summary.active} sub="sequence state; not delivery proof" icon={CheckCircle2} />
          <KpiCard label="Paused" value={summary.paused} sub="sequence state; reason not recorded" icon={Activity} />
          <KpiCard label="Sending Identities" value={summary.activeIdentities} sub={`${summary.dailyCap} emails/day cap`} icon={Inbox} />
          <KpiCard label="Active Enrollments" value={activeEnroll} sub={`${completedEnroll} completed`} icon={Users} />
          <KpiCard label="Held Memberships" value={summary.stallCount} sub="active members in paused sequences" icon={ShieldAlert} warn={summary.stallCount > 0} />
        </div>

        {/* Stalled Enrollments Warning */}
        {stalledEnrollments.length > 0 && (
          <Card className="border-amber-300 bg-amber-50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-amber-800 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                {summary.stallCount} Active Memberships Held in Paused Sequences
              </CardTitle>
              <CardDescription className="text-amber-700 text-xs">
                Memberships are held by sequence state. These are not unique-contact counts or delivery evidence; activation alone does not authorize sending.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {stalledEnrollments.map(s => (
                  <div key={s.id} className="flex items-center justify-between text-sm bg-white/60 rounded px-3 py-2 border border-amber-200">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      <span className="font-medium text-amber-900">{s.name}</span>
                      <TriggerChip type={s.trigger_type} />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-amber-700 font-semibold">{s.active_enrollments} contacts</span>
                      <CadencePill email={s.email_steps} sms={s.sms_steps} days={s.max_delay_days} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-amber-700 mt-3 font-medium">
                Review sequence state and membership status in Campaigns. Changing sequence state does not by itself authorize sending or releasing held work.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Sending Infrastructure */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Send className="h-4 w-4" />
              Sending Infrastructure
            </CardTitle>
            <CardDescription>Email sending identities, warmup status, and capacity</CardDescription>
          </CardHeader>
          <CardContent>
            {sendingIdentities.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sending identities configured.</p>
            ) : (
              <div className="space-y-3">
                {sendingIdentities.map(si => (
                  <div key={si.id} className="border rounded-lg p-4">
                    <div className="flex items-start justify-between flex-wrap gap-2">
                      <div>
                        <p className="font-semibold text-sm">{si.label}</p>
                        <p className="text-xs text-muted-foreground">{si.email_address}</p>
                        <p className="text-xs text-muted-foreground">{si.domain} · {si.mailbox_type}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <WarmupBadge status={si.warmup_status} />
                        {si.is_active
                          ? <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">active</span>
                          : <span className="text-xs text-gray-600 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded">inactive</span>}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                      <div className="bg-muted/30 rounded p-2">
                        <p className="text-muted-foreground">Daily Cap</p>
                        <p className="font-semibold text-sm mt-0.5">{si.daily_limit}</p>
                      </div>
                      <div className="bg-muted/30 rounded p-2">
                        <p className="text-muted-foreground">Sent Today</p>
                        <p className="font-semibold text-sm mt-0.5">{si.sent_today}</p>
                      </div>
                      <div className="bg-muted/30 rounded p-2">
                        <p className="text-muted-foreground">Bounces</p>
                        <p className={`font-semibold text-sm mt-0.5 ${si.bounces_today > 0 ? "text-red-600" : ""}`}>{si.bounces_today}</p>
                      </div>
                      <div className="bg-muted/30 rounded p-2">
                        <p className="text-muted-foreground">Complaints</p>
                        <p className={`font-semibold text-sm mt-0.5 ${si.complaints_today > 0 ? "text-red-600" : ""}`}>{si.complaints_today}</p>
                      </div>
                      <div className="bg-muted/30 rounded p-2">
                        <p className="text-muted-foreground">Health Score</p>
                        <p className={`font-semibold text-sm mt-0.5 ${si.health_score >= 80 ? "text-green-600" : si.health_score >= 60 ? "text-amber-600" : "text-red-600"}`}>
                          {si.health_score}
                        </p>
                      </div>
                    </div>
                    {si.vertical_assignment && (
                      <p className="text-xs text-muted-foreground mt-2">Vertical assignment: {si.vertical_assignment}</p>
                    )}
                    {si.last_used_at && (
                      <p className="text-xs text-muted-foreground mt-1">Last used: {new Date(si.last_used_at).toLocaleDateString()}</p>
                    )}
                  </div>
                ))}
                <div className="bg-slate-50 rounded-lg p-3 border text-xs text-slate-600 space-y-1">
                  <p className="font-medium text-slate-700">Capacity Summary</p>
                  <p>• <strong>{summary.activeIdentities}</strong> active sending {summary.activeIdentities === 1 ? "identity" : "identities"} · combined daily cap: <strong>{summary.dailyCap} emails/day</strong></p>
                  <p>• Total email steps across all sequences: <strong>{summary.totalEmailSteps}</strong> · SMS steps: <strong>{summary.totalSmsSteps}</strong></p>
                  {summary.dailyCap < 100 && (
                    <p className="text-amber-700 font-medium mt-1">Configured identity limit: {summary.dailyCap} emails/day. This is not verified transport throughput or send permission.</p>
                  )}
                </div>
              </div>
            )}
            <div className="mt-3 bg-slate-50 rounded-lg p-3 border text-xs text-slate-600 space-y-1">
              <SequenceRuntimeFacts runtime={data?.runtime} />
            </div>
          </CardContent>
        </Card>

        {/* Active Sequences */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Active Sequences ({activeSequences.length})
            </CardTitle>
            <CardDescription>Active sequence state is not send permission. Pause, consent, readiness and execution authority still apply.</CardDescription>
          </CardHeader>
          <CardContent>
            {activeSequences.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active sequences. All sequences are paused.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left pb-2 pr-4 font-medium">Sequence</th>
                      <th className="text-left pb-2 pr-4 font-medium">Trigger</th>
                      <th className="text-left pb-2 pr-4 font-medium">Cadence</th>
                      <th className="text-left pb-2 pr-4 font-medium">Consent Tiers</th>
                      <th className="text-right pb-2 font-medium">Enrolled</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {activeSequences.map(s => (
                      <tr key={s.id} className="hover:bg-muted/30 transition-colors" data-testid={`row-sequence-${s.id}`}>
                        <td className="py-2.5 pr-4">
                          <p className="font-medium leading-tight">{s.name}</p>
                          {s.sequence_family && <p className="text-xs text-muted-foreground mt-0.5">{s.sequence_family}</p>}
                        </td>
                        <td className="py-2.5 pr-4">
                          <TriggerChip type={s.trigger_type} />
                        </td>
                        <td className="py-2.5 pr-4">
                          <CadencePill email={s.email_steps} sms={s.sms_steps} days={s.max_delay_days} />
                        </td>
                        <td className="py-2.5 pr-4">
                          {s.eligible_consent_tiers && s.eligible_consent_tiers.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {s.eligible_consent_tiers.map(t => (
                                <span key={t} className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded">{t.replace(/_/g, " ")}</span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">all tiers</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right">
                          <span className={`text-sm font-semibold ${s.active_enrollments > 0 ? "text-green-700" : "text-muted-foreground"}`}>
                            {s.active_enrollments}
                          </span>
                          {s.completed_enrollments > 0 && (
                            <span className="text-xs text-muted-foreground ml-1">/ {s.completed_enrollments} done</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI Analysis */}
        <AnalysisPanel data={data} />

        {/* Paused Sequences by Family */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-500" />
              Paused Sequences by Family ({summary.paused})
            </CardTitle>
            <CardDescription>All paused sequences grouped by category. Click a group to expand.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.keys(pausedByFamily).length === 0 ? (
              <p className="text-sm text-muted-foreground">No paused sequences.</p>
            ) : (
              Object.entries(pausedByFamily)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([family, sequences]) => (
                  <PausedFamilyGroup key={family} family={family} sequences={sequences} />
                ))
            )}
          </CardContent>
        </Card>

        {/* Enrollment Summary */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" />
              Enrollment Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              {Object.entries(enrollmentTotals).map(([status, count]) => (
                <div key={status} className="bg-muted/30 rounded-lg p-4 text-center">
                  <p className="text-2xl font-bold">{count}</p>
                  <p className="text-xs text-muted-foreground mt-1 capitalize">{status}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
