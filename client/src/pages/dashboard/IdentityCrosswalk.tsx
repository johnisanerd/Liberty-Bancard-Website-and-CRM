/**
 * Identity Crosswalk — admin-only page for Gen-1 cross-system identity evidence.
 * Route: /dashboard/identity-crosswalk
 * Access: admin only
 */

import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle, RefreshCw, Play, Pause, X, CheckCircle2,
  GitMerge, Shield, Search, ChevronLeft, ChevronRight, Eye,
  ListTodo, Target, Layers, GitFork,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
interface IdentityRun {
  id: string;
  generation: number;
  rules_version: string;
  status: string;
  environment: string;
  requested_by_user_id: number;
  started_at: string | null;
  completed_at: string | null;
  pause_reason: string | null;
  fail_reason: string | null;
  sunbiz_denominator: number | null;
  prospects_denominator: number | null;
  master_leads_denominator: number | null;
  sunbiz_processed: number;
  prospects_processed: number;
  master_leads_processed: number;
  explicit_link_count: number;
  deterministic_match_count: number;
  strong_candidate_count: number;
  ambiguous_count: number;
  source_conflict_count: number;
  insufficient_evidence_count: number;
  no_match_count: number;
  created_at: string;
}

interface Subject {
  id: string;
  run_id: string;
  source_table: string;
  source_id: string;
  disposition: string;
  candidate_count: number;
  existing_fk_contact_id: number | null;
  created_at: string;
}

interface Candidate {
  id: string;
  candidate_type: string;
  candidate_id: number;
  evidence_class: string;
  confidence_score: number;
  match_tier: number;
  evidence: unknown[];
  created_at: string;
}

interface DuplicateCluster {
  contact_id: number;
  source_count: number;
  sample_sources: string[];
  last_seen_at: string;
}

interface VerticalCandidate {
  id: string;
  contact_id: number;
  source_table: string;
  source_id: string;
  source_vertical: string | null;
  current_contact_vertical: string | null;
  conflict_state: string;
  resolver_output: unknown;
  created_at: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending:   "bg-yellow-100 text-yellow-800 border-yellow-200",
    running:   "bg-blue-100 text-blue-800 border-blue-200",
    paused:    "bg-amber-100 text-amber-800 border-amber-200",
    completed: "bg-green-100 text-green-800 border-green-200",
    cancelled:    "bg-gray-100 text-gray-600 border-gray-200",
    failed:       "bg-red-100 text-red-800 border-red-200",
    interrupted:  "bg-orange-100 text-orange-800 border-orange-200",
  };
  return map[status] ?? "bg-muted text-muted-foreground border-border";
}

function evidenceClassColor(ec: string) {
  const map: Record<string, string> = {
    EXPLICIT_LINK:            "bg-green-100 text-green-800 border-green-300",
    DETERMINISTIC_MATCH:      "bg-blue-100 text-blue-800 border-blue-300",
    STRONG_REVIEW_CANDIDATE:  "bg-indigo-100 text-indigo-800 border-indigo-300",
    AMBIGUOUS_MATCH:          "bg-amber-100 text-amber-800 border-amber-300",
    SOURCE_CONFLICT:          "bg-red-100 text-red-800 border-red-300",
    INSUFFICIENT_EVIDENCE:    "bg-gray-100 text-gray-700 border-gray-300",
  };
  return map[ec] ?? "bg-muted text-muted-foreground border-border";
}

// Can this evidence class have a decision recorded against it?
function isDecidable(ec: string) {
  return ["EXPLICIT_LINK", "DETERMINISTIC_MATCH", "STRONG_REVIEW_CANDIDATE"].includes(ec);
}

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString();
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────
function RunProgress({ run }: { run: IdentityRun }) {
  const total = (run.sunbiz_denominator ?? 0)
    + (run.prospects_denominator ?? 0)
    + (run.master_leads_denominator ?? 0);
  const processed = run.sunbiz_processed + run.prospects_processed + run.master_leads_processed;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{processed.toLocaleString()} / {total.toLocaleString()} processed</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RunDetailCard({ run, onAction }: { run: IdentityRun; onAction: (action: string) => void }) {
  const isActive = run.status === "running" || run.status === "pending";
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base">Run Scan #{run.generation}</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {run.id.slice(0, 8)}… · {run.environment} · {run.rules_version}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-xs ${statusBadge(run.status)}`}>
              {run.status}
            </Badge>
            {run.status === "running" && (
              <Button size="sm" variant="outline" onClick={() => onAction("pause")}>
                <Pause className="h-3.5 w-3.5 mr-1" /> Pause
              </Button>
            )}
            {run.status === "paused" && (
              <Button size="sm" variant="outline" onClick={() => onAction("resume")}>
                <Play className="h-3.5 w-3.5 mr-1" /> Resume
              </Button>
            )}
            {(run.status === "pending" || run.status === "running" || run.status === "paused" || run.status === "interrupted") && (
              <Button size="sm" variant="outline" className="text-red-600 border-red-300 hover:bg-red-50"
                      onClick={() => onAction("cancel")}>
                <X className="h-3.5 w-3.5 mr-1" /> Cancel
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {(run.status === "running" || run.status === "paused") && <RunProgress run={run} />}
        {run.pause_reason && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-400">{run.pause_reason}</p>
          </div>
        )}
        {run.fail_reason && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700 dark:text-red-400">{run.fail_reason}</p>
          </div>
        )}
        {/* Evidence-class tiles */}
        <div>
          <p className="text-xs font-semibold mb-2">Evidence Distribution</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {[
              { label: "Explicit Link",       key: "explicit_link_count",           color: "bg-green-50 border-green-200 dark:bg-green-950/20" },
              { label: "Deterministic Match", key: "deterministic_match_count",     color: "bg-blue-50 border-blue-200 dark:bg-blue-950/20" },
              { label: "Strong Candidate",    key: "strong_candidate_count",        color: "bg-indigo-50 border-indigo-200 dark:bg-indigo-950/20" },
              { label: "Ambiguous",           key: "ambiguous_count",               color: "bg-amber-50 border-amber-200 dark:bg-amber-950/20" },
              { label: "Source Conflict",     key: "source_conflict_count",         color: "bg-red-50 border-red-200 dark:bg-red-950/20" },
              { label: "Insufficient",        key: "insufficient_evidence_count",   color: "bg-gray-50 border-gray-200 dark:bg-gray-950/20" },
              { label: "No Match",            key: "no_match_count",                color: "bg-muted border-border" },
            ].map(({ label, key, color }) => (
              <div key={key} className={`rounded-lg border p-2.5 ${color}`}>
                <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                <div className="text-base font-bold">{fmt((run as any)[key])}</div>
              </div>
            ))}
          </div>
        </div>
        {/* Population counters */}
        <div>
          <p className="text-xs font-semibold mb-2">Population Totals</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Sunbiz Entities",   processed: run.sunbiz_processed,      total: run.sunbiz_denominator },
              { label: "Prospects",          processed: run.prospects_processed,   total: run.prospects_denominator },
              { label: "Master Leads",       processed: run.master_leads_processed,total: run.master_leads_denominator },
            ].map(({ label, processed, total }) => (
              <div key={label} className="rounded-lg border bg-muted/20 p-2.5">
                <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                <div className="text-sm font-bold">
                  {fmt(processed)} <span className="text-muted-foreground font-normal text-[10px]">/ {fmt(total)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {run.completed_at && (
          <p className="text-xs text-muted-foreground">
            Completed {new Date(run.completed_at).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SubjectsPanel({ run }: { run: IdentityRun }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);
  const [evidenceFilter, setEvidenceFilter] = useState<string>("all");
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const { toast } = useToast();

  const classes = [
    "all",
    "EXPLICIT_LINK",
    "DETERMINISTIC_MATCH",
    "STRONG_REVIEW_CANDIDATE",
    "AMBIGUOUS_MATCH",
    "SOURCE_CONFLICT",
    "INSUFFICIENT_EVIDENCE",
  ];

  const params = new URLSearchParams({ limit: "30", run_id: run.id });
  if (cursor) params.set("cursor", cursor);
  if (evidenceFilter !== "all") params.set("evidence_class", evidenceFilter);

  const { data, isLoading } = useQuery<{ subjects: Subject[]; nextCursor: string | null }>({
    queryKey: [`/api/admin/identity-crosswalk/subjects?${params.toString()}`],
  });

  const candidatesQuery = useQuery<{ candidates: Candidate[] }>({
    queryKey: [`/api/admin/identity-crosswalk/subjects/${selectedSubjectId}/candidates`],
    enabled: !!selectedSubjectId,
  });

  const decideMutation = useMutation({
    mutationFn: async ({ candidateId, decision }: { candidateId: string; decision: string }) => {
      const r = await apiRequest("POST", `/api/admin/identity-crosswalk/candidates/${candidateId}/decide`, {
        decision,
        target_type: "identity_candidate",
      });
      return r.json();
    },
    onSuccess: (data) => {
      if (data.existing) {
        toast({ title: "Already decided", description: "An identical decision already exists." });
      } else {
        toast({ title: "Decision recorded", description: `Decision '${data.decision?.decision}' saved.` });
      }
      queryClient.invalidateQueries({ queryKey: [`/api/admin/identity-crosswalk/subjects/${selectedSubjectId}/candidates`] });
    },
    onError: (e: Error) => toast({ title: "Decision failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3">
      {/* Evidence-class filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {classes.map((c) => (
          <button
            key={c}
            onClick={() => { setEvidenceFilter(c); setCursor(null); setPrevCursors([]); }}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              evidenceFilter === c
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border hover:bg-muted"
            }`}
          >
            {c === "all" ? "All" : c.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {/* Subject list */}
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
            </div>
          ) : !data || data.subjects.length === 0 ? (
            <div className="px-6 py-8 text-sm text-muted-foreground text-center">
              No subjects found {evidenceFilter !== "all" ? `for class ${evidenceFilter}` : ""}.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Source</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Source ID</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Disposition</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Candidates</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">FK Contact</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.subjects.map((s) => (
                    <tr key={s.id} className={`border-b transition-colors ${selectedSubjectId === s.id ? "bg-muted/50" : "hover:bg-muted/20"}`}>
                      <td className="px-4 py-2 font-mono text-muted-foreground">
                        {s.source_table.replace("_entities", "").replace("_leads", " leads")}
                      </td>
                      <td className="px-4 py-2 font-mono">{s.source_id}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-[10px]">{s.disposition}</Badge>
                      </td>
                      <td className="px-4 py-2 text-center">{s.candidate_count}</td>
                      <td className="px-4 py-2">
                        {s.existing_fk_contact_id ? (
                          <a href={`/dashboard/contacts/${s.existing_fk_contact_id}`}
                             className="text-blue-600 hover:underline">
                            #{s.existing_fk_contact_id}
                          </a>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <Button size="sm" variant="ghost" className="h-6 text-[10px]"
                                onClick={() => setSelectedSubjectId(selectedSubjectId === s.id ? null : s.id)}>
                          <Eye className="h-3 w-3 mr-1" />
                          {selectedSubjectId === s.id ? "Hide" : "Candidates"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Candidates drawer */}
      {selectedSubjectId && (
        <Card className="border-2 border-primary/20 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Candidates for {selectedSubjectId.slice(0, 8)}…</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {candidatesQuery.isLoading && <Skeleton className="h-20" />}
            {candidatesQuery.data?.candidates.map((c) => (
              <div key={c.id} className={`rounded-lg border p-3 space-y-2 ${evidenceClassColor(c.evidence_class)}`}>
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <Badge variant="outline" className={`text-[10px] ${evidenceClassColor(c.evidence_class)}`}>
                      {c.evidence_class}
                    </Badge>
                    <span className="ml-2 text-xs text-muted-foreground">
                      Tier {c.match_tier} · Score {c.confidence_score}
                    </span>
                  </div>
                  <a href={`/dashboard/contacts/${c.candidate_id}`}
                     className="text-xs text-blue-600 hover:underline font-medium">
                    Contact #{c.candidate_id}
                  </a>
                </div>
                {/* Evidence providers */}
                {Array.isArray(c.evidence) && c.evidence.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {c.evidence.map((e: any) => (
                      <span key={e.id} className="px-1.5 py-0.5 rounded bg-white/60 border text-[10px] font-mono">
                        {e.evidence_provider}
                      </span>
                    ))}
                  </div>
                )}
                {/* Decision buttons — only for decidable evidence classes */}
                {isDecidable(c.evidence_class) && (
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 text-green-700 border-green-300"
                            disabled={decideMutation.isPending}
                            onClick={() => decideMutation.mutate({ candidateId: c.id, decision: "confirm" })}>
                      <CheckCircle2 className="h-3 w-3" /> Confirm
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 text-red-700 border-red-300"
                            disabled={decideMutation.isPending}
                            onClick={() => decideMutation.mutate({ candidateId: c.id, decision: "reject" })}>
                      <X className="h-3 w-3" /> Reject
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1"
                            disabled={decideMutation.isPending}
                            onClick={() => decideMutation.mutate({ candidateId: c.id, decision: "defer" })}>
                      Defer
                    </Button>
                  </div>
                )}
                {!isDecidable(c.evidence_class) && (
                  <p className="text-[10px] text-muted-foreground italic">
                    Decisions not allowed for {c.evidence_class} — admin review required before action.
                  </p>
                )}
              </div>
            ))}
            {candidatesQuery.data?.candidates.length === 0 && (
              <p className="text-xs text-muted-foreground">No candidates found for this subject.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between pt-1">
        <Button variant="outline" size="sm" disabled={prevCursors.length === 0}
                onClick={() => {
                  const prev = [...prevCursors];
                  const p = prev.pop();
                  setPrevCursors(prev);
                  setCursor(p ?? null);
                }}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!data?.nextCursor}
                onClick={() => {
                  if (data?.nextCursor) {
                    setPrevCursors((p) => [...p, cursor ?? ""]);
                    setCursor(data.nextCursor);
                  }
                }}>
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

function VerticalCandidatesPanel({ run }: { run: IdentityRun }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);
  const [conflictFilter, setConflictFilter] = useState("all");

  const params = new URLSearchParams({ limit: "30", run_id: run.id });
  if (cursor) params.set("cursor", cursor);
  if (conflictFilter !== "all") params.set("conflict_state", conflictFilter);

  const { data, isLoading } = useQuery<{ candidates: VerticalCandidate[]; nextCursor: string | null }>({
    queryKey: [`/api/admin/identity-crosswalk/vertical-candidates?${params.toString()}`],
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {["all", "agree", "proposed_upgrade", "proposed_change", "resolver_null", "no_source_vertical"].map((s) => (
          <button
            key={s}
            onClick={() => { setConflictFilter(s); setCursor(null); setPrevCursors([]); }}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              conflictFilter === s
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border hover:bg-muted"
            }`}
          >
            {s === "all" ? "All" : s.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : !data || data.candidates.length === 0 ? (
            <div className="px-6 py-8 text-sm text-muted-foreground text-center">No vertical candidates found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Contact</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Source</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Source Vertical</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Current Vertical</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.candidates.map((vc) => (
                    <tr key={vc.id} className="border-b hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2">
                        <a href={`/dashboard/contacts/${vc.contact_id}`} className="text-blue-600 hover:underline">
                          #{vc.contact_id}
                        </a>
                      </td>
                      <td className="px-4 py-2 font-mono text-muted-foreground">
                        {vc.source_table.replace("_entities", "")} #{vc.source_id}
                      </td>
                      <td className="px-4 py-2">{vc.source_vertical ?? "—"}</td>
                      <td className="px-4 py-2">{vc.current_contact_vertical ?? "—"}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-[10px]">
                          {vc.conflict_state.replace(/_/g, " ")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between pt-1">
        <Button variant="outline" size="sm" disabled={prevCursors.length === 0}
                onClick={() => {
                  const prev = [...prevCursors];
                  const p = prev.pop();
                  setPrevCursors(prev);
                  setCursor(p ?? null);
                }}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!data?.nextCursor}
                onClick={() => {
                  if (data?.nextCursor) {
                    setPrevCursors((p) => [...p, cursor ?? ""]);
                    setCursor(data.nextCursor);
                  }
                }}>
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

function ClustersPanel({ run }: { run: IdentityRun }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);

  const params = new URLSearchParams({ limit: "30" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery<{ clusters: DuplicateCluster[]; nextCursor: string | null }>({
    queryKey: [`/api/admin/identity-crosswalk/runs/${run.id}/clusters?${params.toString()}`],
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Contacts referenced by multiple source rows with a <strong>SOURCE_CONFLICT</strong> classification.
        Each row is a candidate duplicate cluster — select the contact to investigate.
      </p>
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : !data || data.clusters.length === 0 ? (
            <div className="px-6 py-8 text-sm text-muted-foreground text-center">
              No duplicate clusters found for this run.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Contact</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Sources</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Sample Sources</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clusters.map((cl) => (
                    <tr key={cl.contact_id} className="border-b hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2">
                        <a href={`/dashboard/contacts/${cl.contact_id}`}
                           className="text-blue-600 hover:underline font-medium">
                          #{cl.contact_id}
                        </a>
                      </td>
                      <td className="px-4 py-2 text-right font-bold text-red-700">{cl.source_count}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1">
                          {cl.sample_sources.map((s) => (
                            <span key={s} className="px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-[10px] font-mono">
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {new Date(cl.last_seen_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between pt-1">
        <Button variant="outline" size="sm" disabled={prevCursors.length === 0}
                onClick={() => {
                  const prev = [...prevCursors]; const p = prev.pop();
                  setPrevCursors(prev); setCursor(p ?? null);
                }}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!data?.nextCursor}
                onClick={() => {
                  if (data?.nextCursor) {
                    setPrevCursors((p) => [...p, cursor ?? ""]);
                    setCursor(data.nextCursor);
                  }
                }}>
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────────────────────────────────────
export default function IdentityCrosswalk() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"subjects" | "verticals" | "clusters">("subjects");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runsQuery = useQuery<{ runs: IdentityRun[]; nextCursor: string | null }>({
    queryKey: ["/api/admin/identity-crosswalk/runs"],
    refetchInterval: 8_000,
  });

  const runs = runsQuery.data?.runs ?? [];
  const activeRun = runs.find((r) => ["pending", "running", "paused"].includes(r.status)) ?? null;
  const selectedRun = selectedRunId
    ? runs.find((r) => r.id === selectedRunId) ?? null
    : (activeRun ?? runs[0] ?? null);

  const startMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/identity-crosswalk/runs", {});
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(body.error ?? "Failed to start run");
      }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: "Run started", description: `Scan #${data.generation} created (${data.runId.slice(0, 8)}…).` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/identity-crosswalk/runs"] });
    },
    onError: (e: Error) => toast({ title: "Failed to start run", description: e.message, variant: "destructive" }),
  });

  const controlMutation = useMutation({
    mutationFn: async ({ runId, action }: { runId: string; action: string }) => {
      const r = await apiRequest("POST", `/api/admin/identity-crosswalk/runs/${runId}/${action}`, {});
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(body.error ?? `Failed to ${action} run`);
      }
      return r.json();
    },
    onSuccess: (_data, vars) => {
      toast({ title: `Run ${vars.action}d` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/identity-crosswalk/runs"] });
    },
    onError: (e: Error) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6 pb-12">
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <PageTitle className="text-2xl font-bold flex items-center gap-2">
            <GitMerge className="h-6 w-6" /> Identity Crosswalk
          </PageTitle>
          <p className="text-sm text-muted-foreground mt-0.5">
            Gen-1 read-only evidence sweep — cross-system identity matching across sunbiz, prospects, and master leads.
            No canonical fields are written. All evidence is HMAC-fingerprinted; no raw PII stored.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => runsQuery.refetch()} disabled={runsQuery.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${runsQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending || !!activeRun}
            className="gap-1.5"
          >
            {startMutation.isPending
              ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              : <Play className="h-3.5 w-3.5" />}
            Start New Run
          </Button>
        </div>
      </div>

      {/* ── Safety banner ───────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20 px-4 py-3">
        <Shield className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold text-blue-800 dark:text-blue-300">Read-only evidence layer — Gen-1</p>
          <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
            This sweep does not modify contacts, businesses, deals, or any canonical field. Evidence is stored as HMAC
            digests only. Decisions recorded here require a separate Gen-2 authorization step before any write is performed.
            Vertical approvals via the reconciliation panel are blocked until Gen-2 authorization.
          </p>
        </div>
      </div>

      {/* ── Run list sidebar + detail ────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Run selector */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground px-1">Recent Runs</p>
          {runsQuery.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground text-center">
              No runs yet. Start one above.
            </div>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedRunId(r.id)}
                className={`w-full text-left rounded-xl border p-3 transition-colors space-y-1 ${
                  (selectedRun?.id === r.id) ? "bg-muted/50 border-primary/40" : "bg-card border-border hover:bg-muted/20"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">Scan #{r.generation}</span>
                  <Badge variant="outline" className={`text-[10px] ${statusBadge(r.status)}`}>{r.status}</Badge>
                </div>
                <p className="text-[10px] text-muted-foreground font-mono">{r.id.slice(0, 8)}…</p>
                <p className="text-[10px] text-muted-foreground">
                  {new Date(r.created_at).toLocaleDateString()}
                </p>
              </button>
            ))
          )}
        </div>

        {/* Run detail */}
        <div className="lg:col-span-3 space-y-4">
          {!selectedRun ? (
            <div className="rounded-xl border border-dashed p-8 text-sm text-muted-foreground text-center">
              Select a run to view evidence details.
            </div>
          ) : (
            <>
              <RunDetailCard
                run={selectedRun}
                onAction={(action) => controlMutation.mutate({ runId: selectedRun.id, action })}
              />

              {/* Tab nav */}
              <div className="flex gap-1 border-b">
                {[
                  { id: "subjects" as const, label: "Subjects & Candidates", icon: Search },
                  { id: "verticals" as const, label: "Vertical Candidates", icon: Layers },
                  { id: "clusters" as const, label: "Duplicate Clusters", icon: GitFork },
                ].map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                      activeTab === id
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {activeTab === "subjects" && <SubjectsPanel run={selectedRun} />}
              {activeTab === "verticals" && <VerticalCandidatesPanel run={selectedRun} />}
              {activeTab === "clusters" && <ClustersPanel run={selectedRun} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
