import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import {
  RefreshCw, CheckCircle2, AlertTriangle, XCircle, Database,
  Loader2, Play, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";

// ── Types ──────────────────────────────────────────────────────────────────────

interface DataHealthSummary {
  orphanedDeals: number;
  orphanedEnrollments: number;
  contactsNullLifecycle: number;
  activeEnrollmentsNoNextAction: number;
  contactsEmailInconsistency: number;
  dealsNoGhlOpportunityId: number;
}

interface OrphanedDeal { id: number; stage: string; created_at: string }
interface OrphanedEnrollment { id: number; contact_id: number; sequence_id: number; status: string }
interface NullLifecycleContact { id: number; email: string; created_at: string }

interface DataHealthPopulations {
  headlineIssueTotalIncludes: string[];
  headlineIssueTotalExcludes: string[];
  dealsNoGhlOpportunityId: {
    definition: string; total: number; productionActive: number; archived: number; nonProduction: number;
    sales: number; onboarding: number; overlap: string;
  };
  readAt: string;
}

interface DataHealthReport {
  generatedAt: string;
  summary: DataHealthSummary;
  populations?: DataHealthPopulations;
  samples: {
    orphanedDeals: OrphanedDeal[];
    orphanedEnrollments: OrphanedEnrollment[];
    contactsNullLifecycle: NullLifecycleContact[];
  };
}

type ActionOutcomeStatus = "applied" | "already_applied" | "not_current" | "failed";

interface ReconcilePlan {
  generatedAt: string;
  window: number;
  populations: {
    orphanedDeals: { total: number; considered: number; actionable: number; unresolved: Record<string, number> };
    orphanedEnrollments: { total: number; considered: number; actionable: number };
    nullLifecycleContacts: { total: number; note: string };
    activeEnrollmentsNoNextAction: { total: number; note: string };
  };
  actions: Array<{ key: string; type: string; label: string; effect: string }>;
  unresolvedDeals: Array<{ dealId: number; stage: string | null; reason: string; candidateContactIds: number[] }>;
  outboundPause: string;
}

interface ReconcileReceipt {
  operationId: string;
  status: "in_progress" | "complete";
  requested: number;
  startedAt: string;
  completedAt: string | null;
  counts: Record<ActionOutcomeStatus, number>;
  outcomes: Array<{ key: string; status: ActionOutcomeStatus; detail: string }>;
}

const UNRESOLVED_REASON_LABEL: Record<string, string> = {
  no_email_in_notes: "No email in the deal notes",
  no_contact_match: "No contact has that email",
  ambiguous_multiple_contacts: "More than one contact has that email (needs a person to decide)",
  ineligible_contact: "The only match is archived or non-production",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function severityClass(n: number, warn = 1, error = 10): "ok" | "warn" | "error" {
  if (n === 0) return "ok";
  if (n < error) return "warn";
  return "error";
}

function SeverityIcon({ n, warn, error }: { n: number; warn?: number; error?: number }) {
  const s = severityClass(n, warn, error);
  if (s === "ok") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (s === "warn") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  return <XCircle className="h-4 w-4 text-red-500" />;
}

function CountBadge({ n }: { n: number }) {
  const cls = n === 0
    ? "bg-green-50 text-green-700 border-green-200"
    : n < 10
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-red-50 text-red-700 border-red-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${cls}`}>
      {n.toLocaleString()}
    </span>
  );
}

function MetricRow({
  label,
  description,
  value,
  warn,
  error,
}: {
  label: string;
  description: string;
  value: number;
  warn?: number;
  error?: number;
}) {
  return (
    <div className="flex items-center justify-between py-2 text-sm border-b last:border-0">
      <div className="flex items-start gap-2">
        <div className="pt-0.5"><SeverityIcon n={value} warn={warn} error={error} /></div>
        <div>
          <p className="font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <CountBadge n={value} />
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function DataHealth() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const qc = useQueryClient();
  const [dealsOpen, setDealsOpen] = useState(false);
  const [enrollmentsOpen, setEnrollmentsOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [plan, setPlan] = useState<ReconcilePlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [receipt, setReceipt] = useState<ReconcileReceipt | null>(null);
  // One operation id per selection; kept until the request completes so a lost response can be replayed safely.
  const [operationId, setOperationId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<DataHealthReport>({
    queryKey: ["/api/admin/data-health"],
    refetchInterval: 120_000,
  });

  const planMutation = useMutation<ReconcilePlan>({
    mutationFn: () => apiRequest("GET", "/api/admin/data-health/reconcile/plan").then(r => r.json()),
    onSuccess: (result) => { setPlan(result); setSelected(new Set()); setReceipt(null); setOperationId(null); setConfirming(false); },
    onError: (err: any) => toast({ title: "Could not build the plan", description: err.message, variant: "destructive" }),
  });

  const applyMutation = useMutation<{ replayed: boolean; receipt: ReconcileReceipt }, Error, { operationId: string; actionKeys: string[] }>({
    mutationFn: (body) => apiRequest("POST", "/api/admin/data-health/reconcile/apply", body).then(r => r.json()),
    onSuccess: ({ receipt: r, replayed }) => {
      setReceipt(r);
      setConfirming(false);
      if (r.status === "complete") {
        setOperationId(null);
        toast({ title: replayed ? "Result recovered" : "Reconcile finished",
          description: `${r.counts.applied} applied, ${r.counts.already_applied} already done, ${r.counts.not_current} no longer current, ${r.counts.failed} failed.` });
        qc.invalidateQueries({ queryKey: ["/api/admin/data-health"] });
      } else {
        toast({ title: "Still running", description: "Another request owns this operation. Check the result again shortly." });
      }
    },
    onError: (err: any) => toast({ title: "Result not confirmed", description: `${err.message} Re-submit to recover the saved result; nothing is applied twice.`, variant: "destructive" }),
  });

  const toggle = (key: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    setOperationId(null); setConfirming(false);
  };
  const submitApply = () => {
    const id = operationId ?? crypto.randomUUID();
    setOperationId(id);
    applyMutation.mutate({ operationId: id, actionKeys: [...selected].sort() });
  };

  const summary = data?.summary;
  const totalIssues = summary
    ? summary.orphanedDeals + summary.orphanedEnrollments + summary.contactsNullLifecycle + summary.activeEnrollmentsNoNextAction + summary.contactsEmailInconsistency
    : 0;

  const overallStatus: "ok" | "warn" | "error" = !summary
    ? "ok"
    : (summary.orphanedDeals > 10 || summary.orphanedEnrollments > 10 || summary.contactsNullLifecycle > 10 || summary.activeEnrollmentsNoNextAction > 10)
      ? "error"
      : totalIssues > 0
        ? "warn"
        : "ok";

  const overallColor = overallStatus === "ok" ? "text-green-600" : overallStatus === "warn" ? "text-amber-600" : "text-red-600";
  const overallLabel = overallStatus === "ok" ? "Clean" : overallStatus === "warn" ? "Needs Attention" : "Critical";

  return (
    <>
      <Helmet>
        <title>Data Health — Liberty Bancard</title>
      </Helmet>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Database className="h-6 w-6 text-primary" />
              Data Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Detect orphaned records, missing lifecycle states, and enrollment gaps.
              {data && (
                <span className="ml-2 text-xs">
                  Last checked {new Date(data.generatedAt).toLocaleTimeString()}
                </span>
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>

        {/* Overall status banner */}
        {summary && (
          <div className={`flex items-center gap-3 p-4 rounded-lg border ${
            overallStatus === "ok" ? "bg-green-50 border-green-200" :
            overallStatus === "warn" ? "bg-amber-50 border-amber-200" :
            "bg-red-50 border-red-200"
          }`}>
            {overallStatus === "ok"
              ? <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
              : overallStatus === "warn"
                ? <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                : <XCircle className="h-5 w-5 text-red-600 shrink-0" />}
            <div>
              <p className={`font-semibold ${overallColor}`}>{overallLabel}</p>
              <p className="text-sm text-muted-foreground">
                {totalIssues === 0
                  ? "No integrity issues in the five headline metrics."
                  : `${totalIssues.toLocaleString()} issue(s) across the five headline metrics.`}
                {" "}The GHL opportunity diagnostic below is a separate historical count and is not included in this total.
              </p>
            </div>
          </div>
        )}

        {/* Metrics grid */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Integrity Metrics</CardTitle>
            <CardDescription>
              Counts are read directly from the database{data?.populations ? ` at ${new Date(data.populations.readAt).toLocaleTimeString()}` : ""}.
              Each row states the population it counts; rows are not expected to match other pages.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : isError ? (
              <p className="text-sm text-red-600 py-4">Failed to load data health. Check server logs.</p>
            ) : summary ? (
              <div className="divide-y">
                <MetricRow
                  label="Orphaned deals"
                  description="Deals with no linked contact (all classes). Linked only when exactly one active production contact matches."
                  value={summary.orphanedDeals}
                  warn={1}
                  error={10}
                />
                <MetricRow
                  label="Orphaned sequence enrollments"
                  description="Active/paused enrollments whose sequence has been deleted — stuck forever."
                  value={summary.orphanedEnrollments}
                  warn={1}
                  error={10}
                />
                <MetricRow
                  label="Contacts with null lifecycle state"
                  description="Non-archived contacts missing lifecycle_state — may be invisible to NBA engine."
                  value={summary.contactsNullLifecycle}
                  warn={1}
                  error={25}
                />
                <MetricRow
                  label="Active enrollments with no next_action_at"
                  description="Enrollments that will never fire — sequence worker skips them."
                  value={summary.activeEnrollmentsNoNextAction}
                  warn={1}
                  error={10}
                />
                <MetricRow
                  label="No-email contacts flagged active"
                  description="Contacts with email_status='active' but no email address — misleadingly contactable."
                  value={summary.contactsEmailInconsistency}
                  warn={5}
                  error={50}
                />
                <MetricRow
                  label="Historical diagnostic: deals missing GHL opportunity ID"
                  description={data?.populations
                    ? `${data.populations.dealsNoGhlOpportunityId.definition} Of these, ${data.populations.dealsNoGhlOpportunityId.productionActive.toLocaleString()} are active production deals; ${data.populations.dealsNoGhlOpportunityId.archived.toLocaleString()} archived and ${data.populations.dealsNoGhlOpportunityId.nonProduction.toLocaleString()} non-production (these can overlap). Not the same population as the Pipeline board.`
                    : "Sales/onboarding deals over 1 hour old with no GHL opportunity ID, across all classes and archived rows."}
                  value={summary.dealsNoGhlOpportunityId}
                  warn={10}
                  error={100}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Sample rows — orphaned deals */}
        {data?.samples?.orphanedDeals?.length ? (
          <Collapsible open={dealsOpen} onOpenChange={setDealsOpen}>
            <Card>
              <CardHeader className="pb-2">
                <CollapsibleTrigger className="flex items-center justify-between w-full text-left">
                  <div>
                    <CardTitle className="text-sm font-semibold">Orphaned Deals (sample)</CardTitle>
                    <CardDescription className="text-xs mt-0.5">Up to 25 most recent — fix by linking to a contact or archiving.</CardDescription>
                  </div>
                  {dealsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Deal ID</TableHead>
                          <TableHead>Stage</TableHead>
                          <TableHead>Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.samples.orphanedDeals.map(d => (
                          <TableRow key={d.id}>
                            <TableCell className="font-mono text-xs">#{d.id}</TableCell>
                            <TableCell>{d.stage}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{new Date(d.created_at).toLocaleDateString()}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ) : null}

        {/* Sample rows — orphaned enrollments */}
        {data?.samples?.orphanedEnrollments?.length ? (
          <Collapsible open={enrollmentsOpen} onOpenChange={setEnrollmentsOpen}>
            <Card>
              <CardHeader className="pb-2">
                <CollapsibleTrigger className="flex items-center justify-between w-full text-left">
                  <div>
                    <CardTitle className="text-sm font-semibold">Orphaned Enrollments (sample)</CardTitle>
                    <CardDescription className="text-xs mt-0.5">Enrollments whose sequence no longer exists. The governed reconcile cancels these; nothing is deleted.</CardDescription>
                  </div>
                  {enrollmentsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Enrollment ID</TableHead>
                          <TableHead>Contact ID</TableHead>
                          <TableHead>Sequence ID</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.samples.orphanedEnrollments.map(e => (
                          <TableRow key={e.id}>
                            <TableCell className="font-mono text-xs">#{e.id}</TableCell>
                            <TableCell className="font-mono text-xs">#{e.contact_id}</TableCell>
                            <TableCell className="font-mono text-xs">#{e.sequence_id}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">{e.status}</Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ) : null}

        {/* Sample rows — null lifecycle contacts */}
        {data?.samples?.contactsNullLifecycle?.length ? (
          <Collapsible open={lifecycleOpen} onOpenChange={setLifecycleOpen}>
            <Card>
              <CardHeader className="pb-2">
                <CollapsibleTrigger className="flex items-center justify-between w-full text-left">
                  <div>
                    <CardTitle className="text-sm font-semibold">Contacts Missing Lifecycle State (sample)</CardTitle>
                    <CardDescription className="text-xs mt-0.5">The database requires a value here, so any rows listed indicate a bypassed constraint; investigate before changing.</CardDescription>
                  </div>
                  {lifecycleOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Contact ID</TableHead>
                          <TableHead>Email</TableHead>
                          <TableHead>Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.samples.contactsNullLifecycle.map(c => (
                          <TableRow key={c.id}>
                            <TableCell className="font-mono text-xs">#{c.id}</TableCell>
                            <TableCell className="text-xs">{c.email}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ) : null}

        {/* Governed reconcile: read-only plan first, then explicitly selected actions. Admin-only on the server too. */}
        {isAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Reconcile plan</CardTitle>
            <CardDescription>
              Build a read-only plan, select the exact actions to apply, then confirm. Each action is re-checked at the moment it runs and
              recorded with your name. Nothing is sent, enrolled, rescheduled or unpaused, and nothing is deleted.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button variant="outline" onClick={() => planMutation.mutate()} disabled={planMutation.isPending || applyMutation.isPending}>
              {planMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Building plan…</> : <><RefreshCw className="h-4 w-4 mr-2" /> {plan ? "Rebuild plan" : "Build read-only plan"}</>}
            </Button>

            {plan && (
              <div className="space-y-4" data-testid="reconcile-plan">
                <p className="text-xs text-muted-foreground">
                  Plan built {new Date(plan.generatedAt).toLocaleTimeString()}. Shows up to {plan.window} items per category. {plan.outboundPause}
                </p>
                <div className="grid gap-2 text-sm sm:grid-cols-3">
                  <div className="rounded border p-3">
                    <p className="font-medium">Unlinked deals</p>
                    <p>{plan.populations.orphanedDeals.total.toLocaleString()} total, {plan.populations.orphanedDeals.considered.toLocaleString()} reviewed</p>
                    <p>{plan.populations.orphanedDeals.actionable.toLocaleString()} have one clear match</p>
                  </div>
                  <div className="rounded border p-3">
                    <p className="font-medium">Enrollments with a missing sequence</p>
                    <p>{plan.populations.orphanedEnrollments.total.toLocaleString()} total, {plan.populations.orphanedEnrollments.considered.toLocaleString()} reviewed</p>
                  </div>
                  <div className="rounded border p-3">
                    <p className="font-medium">Contacts without a lifecycle state</p>
                    <p>{plan.populations.nullLifecycleContacts.total.toLocaleString()} total (reported only)</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {plan.populations.activeEnrollmentsNoNextAction.total.toLocaleString()} active enrollments have no next action time. {plan.populations.activeEnrollmentsNoNextAction.note}
                  {" "}{plan.populations.nullLifecycleContacts.note}
                </p>
                {Object.entries(plan.populations.orphanedDeals.unresolved).some(([, n]) => n > 0) && (
                  <div className="rounded border p-3 text-sm" data-testid="reconcile-unresolved">
                    <p className="font-medium">Deals left for a person to resolve</p>
                    <ul className="list-disc pl-5 text-xs text-muted-foreground">
                      {Object.entries(plan.populations.orphanedDeals.unresolved).filter(([, n]) => n > 0).map(([reason, n]) => (
                        <li key={reason}>{n.toLocaleString()} — {UNRESOLVED_REASON_LABEL[reason] ?? reason}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.actions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No safe actions are available. Nothing will change.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">{selected.size} of {plan.actions.length} actions selected (max 100 per run)</p>
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set(plan.actions.slice(0, 100).map(a => a.key))); setOperationId(null); }}>Select first 100</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setOperationId(null); setConfirming(false); }}>Clear</Button>
                      </div>
                    </div>
                    <ul className="max-h-72 overflow-y-auto divide-y rounded border">
                      {plan.actions.map(a => (
                        <li key={a.key} className="flex items-start gap-3 p-3 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            aria-label={`Select action: ${a.label}`}
                            checked={selected.has(a.key)}
                            onChange={() => toggle(a.key)}
                            disabled={!selected.has(a.key) && selected.size >= 100}
                          />
                          <div>
                            <p className="font-medium">{a.label}</p>
                            <p className="text-xs text-muted-foreground">{a.effect}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {!confirming ? (
                      <Button disabled={selected.size === 0 || applyMutation.isPending} onClick={() => setConfirming(true)}>
                        <Play className="h-4 w-4 mr-2" /> Review {selected.size} selected
                      </Button>
                    ) : (
                      <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2" role="alert">
                        <p className="text-sm">
                          Apply exactly these {selected.size} actions? Each is re-checked first; anything that changed since the plan is skipped and reported.
                        </p>
                        <div className="flex gap-2">
                          <Button onClick={submitApply} disabled={applyMutation.isPending}>
                            {applyMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Applying…</> : "Confirm and apply"}
                          </Button>
                          <Button variant="outline" onClick={() => setConfirming(false)} disabled={applyMutation.isPending}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {receipt && (
              <div className="rounded border p-3 text-sm space-y-2" data-testid="reconcile-receipt">
                <p className="font-medium">
                  {receipt.status === "complete" ? "Result (saved)" : "In progress"} — operation {receipt.operationId.slice(0, 8)}
                </p>
                <p>
                  {receipt.counts.applied} applied · {receipt.counts.already_applied} already done · {receipt.counts.not_current} no longer current · {receipt.counts.failed} failed (of {receipt.requested})
                </p>
                <ul className="max-h-48 overflow-y-auto text-xs text-muted-foreground space-y-1">
                  {receipt.outcomes.map(o => (<li key={o.key}><span className="font-mono">{o.key}</span> — {o.status.replace("_", " ")}: {o.detail}</li>))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
        )}
      </div>
    </>
  );
}
