/**
 * #1410 — AI Learning Center Dashboard
 *
 * Panels:
 *   1. Today's Activity — decisions processed, classified, corrections
 *   2. Accuracy — override rate, confidence distribution
 *   3. Decision Type Breakdown — table of types with override rates
 *   4. Corrections Feed — recent rep corrections
 *   5. Prompt Versions — active prompt registry
 *   6. Golden Examples — labeled eval set
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Brain, CheckCircle, AlertTriangle, XCircle, BookOpen, Zap, RefreshCw } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";

type DecisionStats = {
  totalDecisions: number;
  overriddenDecisions: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  byDecisionType: Record<string, { total: number; overridden: number }>;
};

type CorrectionStats = {
  totalCorrections: number;
  byDecisionType: Record<string, number>;
  byReason: Record<string, number>;
};

type StatsResponse = {
  days: number;
  since: string;
  decisions: DecisionStats;
  corrections: CorrectionStats;
};

type Correction = {
  id: number;
  decisionType: string;
  originalValue: unknown;
  correctedValue: unknown;
  correctionReason: string | null;
  correctedBy: string | null;
  createdAt: string;
};

type PromptVersion = {
  id: number;
  promptKey: string;
  version: string;
  modelId: string | null;
  deployedBy: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  createdAt: string;
};

type GoldenExample = {
  id: number;
  decisionType: string;
  label: string | null;
  source: string;
  createdBy: string | null;
  createdAt: string;
};

const CONFIDENCE_COLORS = ["#22c55e", "#f59e0b", "#ef4444"];
const PERIOD_OPTIONS = ["1", "7", "30", "90"] as const;
type Period = typeof PERIOD_OPTIONS[number];

function ConfidencePie({ decisions }: { decisions: DecisionStats }) {
  const data = [
    { name: "High (≥85%)", value: decisions.highConfidenceCount },
    { name: "Medium (65–85%)", value: decisions.mediumConfidenceCount },
    { name: "Low (<65%)", value: decisions.lowConfidenceCount },
  ].filter(d => d.value > 0);
  if (data.length === 0) return <p className="text-xs text-muted-foreground text-center py-8">No decisions recorded yet</p>;
  return (
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}>
          {data.map((_, i) => <Cell key={i} fill={CONFIDENCE_COLORS[i]} />)}
        </Pie>
        <Tooltip />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

function DecisionTypeBar({ decisions }: { decisions: DecisionStats }) {
  const data = Object.entries(decisions.byDecisionType)
    .map(([type, { total, overridden }]) => ({
      type: type.replace(/_/g, " "),
      total,
      overrideRate: total > 0 ? Math.round((overridden / total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  if (data.length === 0) return <p className="text-xs text-muted-foreground text-center py-8">No decisions recorded</p>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ left: 16, right: 16 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" fontSize={11} />
        <YAxis type="category" dataKey="type" width={140} fontSize={11} />
        <Tooltip formatter={(v: number, n: string) => [n === "overrideRate" ? `${v}%` : v, n]} />
        <Bar dataKey="total" name="Total" fill="#6366f1" radius={[0, 4, 4, 0]} />
        <Bar dataKey="overrideRate" name="Override %" fill="#f59e0b" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function AiLearningCenter() {
  const { toast } = useToast();
  const [period, setPeriod] = useState<Period>("7");
  const [showAddPrompt, setShowAddPrompt] = useState(false);
  const [showAddGolden, setShowAddGolden] = useState(false);
  const [promptDraft, setPromptDraft] = useState({ promptKey: "", version: "1.0.0", promptText: "", modelId: "", notes: "" });
  const [goldenDraft, setGoldenDraft] = useState({ decisionType: "", inputSnapshot: "", expectedOutput: "", label: "" });

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<StatsResponse>({
    queryKey: ["/api/ai-memory/stats", period],
    queryFn: async () => {
      const res = await fetch(`/api/ai-memory/stats?days=${period}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch AI stats");
      return res.json();
    },
  });

  const { data: correctionsData } = useQuery<{ corrections: Correction[] }>({
    queryKey: ["/api/ai-memory/corrections"],
  });

  const { data: promptsData, refetch: refetchPrompts } = useQuery<{ versions: PromptVersion[] }>({
    queryKey: ["/api/ai-memory/prompt-versions"],
  });

  const { data: goldenData, refetch: refetchGolden } = useQuery<{ examples: GoldenExample[] }>({
    queryKey: ["/api/ai-memory/golden-examples"],
  });

  const addPromptMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ai-memory/prompt-versions", {
      promptKey: promptDraft.promptKey,
      version: promptDraft.version,
      promptText: promptDraft.promptText,
      modelId: promptDraft.modelId || null,
      notes: promptDraft.notes || null,
    }),
    onSuccess: () => {
      toast({ title: "Prompt version registered" });
      setShowAddPrompt(false);
      setPromptDraft({ promptKey: "", version: "1.0.0", promptText: "", modelId: "", notes: "" });
      refetchPrompts();
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const addGoldenMutation = useMutation({
    mutationFn: () => {
      let inp: unknown, out: unknown;
      try { inp = JSON.parse(goldenDraft.inputSnapshot); } catch { inp = goldenDraft.inputSnapshot; }
      try { out = JSON.parse(goldenDraft.expectedOutput); } catch { out = goldenDraft.expectedOutput; }
      return apiRequest("POST", "/api/ai-memory/golden-examples", {
        decisionType: goldenDraft.decisionType,
        inputSnapshot: inp,
        expectedOutput: out,
        label: goldenDraft.label || null,
      });
    },
    onSuccess: () => {
      toast({ title: "Golden example added" });
      setShowAddGolden(false);
      setGoldenDraft({ decisionType: "", inputSnapshot: "", expectedOutput: "", label: "" });
      refetchGolden();
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const d = stats?.decisions;
  const c = stats?.corrections;
  const overrideRate = d && d.totalDecisions > 0
    ? Math.round((d.overriddenDecisions / d.totalDecisions) * 100)
    : 0;

  return (
    <div className="space-y-8" data-testid="page-ai-learning-center">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="w-6 h-6 text-purple-600" />
            AI Learning Center
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Monitor AI decision accuracy, correction patterns, and prompt performance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={v => setPeriod(v as Period)}>
            <SelectTrigger className="w-28 h-8 text-xs" data-testid="select-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24h</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetchStats()} aria-label="Refresh learning statistics" data-testid="btn-refresh-stats">
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card data-testid="kpi-total-decisions">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-xs text-muted-foreground font-medium">AI Decisions</CardTitle>
            <Zap className="w-4 h-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
              <>
                <div className="text-2xl font-bold" data-testid="text-total-decisions">{d?.totalDecisions ?? 0}</div>
                <p className="text-xs text-muted-foreground">last {period}d</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="kpi-override-rate">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-xs text-muted-foreground font-medium">Override Rate</CardTitle>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
              <>
                <div className={`text-2xl font-bold ${overrideRate > 20 ? "text-red-600" : overrideRate > 10 ? "text-amber-600" : "text-green-600"}`} data-testid="text-override-rate">
                  {overrideRate}%
                </div>
                <p className="text-xs text-muted-foreground">{d?.overriddenDecisions ?? 0} overridden</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="kpi-corrections">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-xs text-muted-foreground font-medium">Rep Corrections</CardTitle>
            <XCircle className="w-4 h-4 text-red-500" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
              <>
                <div className="text-2xl font-bold" data-testid="text-corrections">{c?.totalCorrections ?? 0}</div>
                <p className="text-xs text-muted-foreground">logged corrections</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="kpi-golden-examples">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-xs text-muted-foreground font-medium">Golden Examples</CardTitle>
            <BookOpen className="w-4 h-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-golden-count">{goldenData?.examples.length ?? 0}</div>
            <p className="text-xs text-muted-foreground">eval set size</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Confidence Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : d ? <ConfidencePie decisions={d} /> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">By Decision Type (Total vs Override%)</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : d ? <DecisionTypeBar decisions={d} /> : null}
          </CardContent>
        </Card>
      </div>

      {/* Recent Corrections */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <XCircle className="w-4 h-4 text-red-500" />
            Recent Rep Corrections
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!correctionsData?.corrections.length ? (
            <p className="text-xs text-muted-foreground text-center py-4">No corrections recorded yet</p>
          ) : (
            <div className="space-y-2">
              {correctionsData.corrections.slice(0, 20).map(corr => (
                <div key={corr.id} className="flex items-start gap-3 p-2 rounded border text-xs" data-testid={`correction-row-${corr.id}`}>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {corr.decisionType.replace(/_/g, " ")}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <span className="text-muted-foreground">
                      {JSON.stringify(corr.originalValue)} → {JSON.stringify(corr.correctedValue)}
                    </span>
                    {corr.correctionReason && (
                      <span className="ml-2 text-amber-600">({corr.correctionReason})</span>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0">
                    {corr.correctedBy} · {new Date(corr.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Prompt Versions */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-blue-500" />
            Prompt Version Registry
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowAddPrompt(s => !s)} data-testid="btn-add-prompt-version">
            {showAddPrompt ? "Cancel" : "+ Register Version"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {showAddPrompt && (
            <div className="border rounded p-3 space-y-3 bg-muted/30" data-testid="form-add-prompt">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium">Prompt Key</label>
                  <Input
                    value={promptDraft.promptKey}
                    onChange={e => setPromptDraft(d => ({ ...d, promptKey: e.target.value }))}
                    placeholder="intent_classification"
                    className="h-7 text-xs mt-1"
                    data-testid="input-prompt-key"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Version</label>
                  <Input
                    value={promptDraft.version}
                    onChange={e => setPromptDraft(d => ({ ...d, version: e.target.value }))}
                    placeholder="1.0.0"
                    className="h-7 text-xs mt-1"
                    data-testid="input-prompt-version"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Model ID</label>
                  <Input
                    value={promptDraft.modelId}
                    onChange={e => setPromptDraft(d => ({ ...d, modelId: e.target.value }))}
                    placeholder="gpt-4o"
                    className="h-7 text-xs mt-1"
                    data-testid="input-prompt-model"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Notes</label>
                  <Input
                    value={promptDraft.notes}
                    onChange={e => setPromptDraft(d => ({ ...d, notes: e.target.value }))}
                    placeholder="optional notes"
                    className="h-7 text-xs mt-1"
                    data-testid="input-prompt-notes"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium">Prompt Text</label>
                <Textarea
                  value={promptDraft.promptText}
                  onChange={e => setPromptDraft(d => ({ ...d, promptText: e.target.value }))}
                  rows={4}
                  placeholder="Enter the full prompt template..."
                  className="text-xs mt-1 font-mono"
                  data-testid="input-prompt-text"
                />
              </div>
              <Button
                size="sm"
                onClick={() => addPromptMutation.mutate()}
                disabled={addPromptMutation.isPending || !promptDraft.promptKey || !promptDraft.version || !promptDraft.promptText}
                data-testid="btn-save-prompt"
              >
                {addPromptMutation.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                Register
              </Button>
            </div>
          )}

          {!promptsData?.versions.length ? (
            <p className="text-xs text-muted-foreground text-center py-4">No prompt versions registered yet</p>
          ) : (
            <div className="space-y-2">
              {promptsData.versions.slice(0, 20).map(pv => (
                <div key={pv.id} className="flex items-center gap-3 p-2 rounded border text-xs" data-testid={`prompt-row-${pv.id}`}>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{pv.promptKey}</Badge>
                  <span className="font-mono text-muted-foreground">v{pv.version}</span>
                  {pv.modelId && <span className="text-muted-foreground">· {pv.modelId}</span>}
                  <span className="flex-1" />
                  {!pv.effectiveTo ? (
                    <Badge variant="outline" className="text-[10px] text-green-600 border-green-400">active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">retired</Badge>
                  )}
                  <span className="text-muted-foreground">{pv.deployedBy}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Golden Examples */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-500" />
            Golden Evaluation Set
            <Badge variant="secondary" className="ml-1">{goldenData?.examples.length ?? 0} examples</Badge>
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowAddGolden(s => !s)} data-testid="btn-add-golden">
            {showAddGolden ? "Cancel" : "+ Add Example"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {showAddGolden && (
            <div className="border rounded p-3 space-y-3 bg-muted/30" data-testid="form-add-golden">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium">Decision Type</label>
                  <Input
                    value={goldenDraft.decisionType}
                    onChange={e => setGoldenDraft(d => ({ ...d, decisionType: e.target.value }))}
                    placeholder="intent_classification"
                    className="h-7 text-xs mt-1"
                    data-testid="input-golden-type"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Label (optional)</label>
                  <Input
                    value={goldenDraft.label}
                    onChange={e => setGoldenDraft(d => ({ ...d, label: e.target.value }))}
                    placeholder="descriptive label"
                    className="h-7 text-xs mt-1"
                    data-testid="input-golden-label"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium">Input Snapshot (JSON)</label>
                <Textarea
                  value={goldenDraft.inputSnapshot}
                  onChange={e => setGoldenDraft(d => ({ ...d, inputSnapshot: e.target.value }))}
                  rows={3}
                  placeholder='{"message": "Not interested right now"}'
                  className="text-xs mt-1 font-mono"
                  data-testid="input-golden-input"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Expected Output (JSON)</label>
                <Textarea
                  value={goldenDraft.expectedOutput}
                  onChange={e => setGoldenDraft(d => ({ ...d, expectedOutput: e.target.value }))}
                  rows={3}
                  placeholder='{"intent": "NOT_INTERESTED"}'
                  className="text-xs mt-1 font-mono"
                  data-testid="input-golden-output"
                />
              </div>
              <Button
                size="sm"
                onClick={() => addGoldenMutation.mutate()}
                disabled={addGoldenMutation.isPending || !goldenDraft.decisionType}
                data-testid="btn-save-golden"
              >
                {addGoldenMutation.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                Add Example
              </Button>
            </div>
          )}

          {!goldenData?.examples.length ? (
            <p className="text-xs text-muted-foreground text-center py-4">No golden examples yet. Add labeled ground-truth examples to measure accuracy offline.</p>
          ) : (
            <div className="space-y-2">
              {goldenData.examples.slice(0, 20).map(ex => (
                <div key={ex.id} className="flex items-center gap-3 p-2 rounded border text-xs" data-testid={`golden-row-${ex.id}`}>
                  <Badge variant="outline" className="text-[10px] shrink-0">{ex.decisionType.replace(/_/g, " ")}</Badge>
                  <span className="flex-1 truncate">{ex.label ?? `Example #${ex.id}`}</span>
                  <Badge variant="secondary" className="text-[10px]">{ex.source}</Badge>
                  <span className="text-muted-foreground">{ex.createdBy}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
