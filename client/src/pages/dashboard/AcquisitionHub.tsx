import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Target, TrendingUp, BarChart3, Zap, CheckCircle2, AlertTriangle,
  XCircle, Download, ExternalLink, Info, DollarSign, Users,
  PhoneCall, Upload, FileCheck, LineChart, MapPin, Megaphone,
  Activity, PauseCircle, CheckCircle, AlertCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";

// ─── Type Helpers ─────────────────────────────────────────────────────────────

interface FunnelData {
  days: number; totalLeads: number; googleLeads: number; statementUploads: number;
  bookedCalls: number; closedWon: number;
  funnelRates: { leadToUpload: number; uploadToBooked: number; bookedToClose: number; leadToClose: number };
  bySource: { source: string; leads: number }[];
  byCampaign: { campaign: string; medium: string; source: string; leads: number }[];
  byVertical: { vertical: string; leads: number }[];
  dealStages: { stage: string; count: number }[];
  planning: Record<string, any>;
  ghlConfigured: boolean;
  googleAdsApiConfigured: boolean;
}

interface VerticalRow {
  vertical: string; source: string; leads: number; hotLeads: number;
  warmLeads: number; coldLeads: number; deals: number; closedWon: number;
  avgScore: number; statementUploads: number; bookedRate: number; closeRate: number;
  estMonthlyResidual: number; scaleSignal: "scale" | "optimize" | "test";
}

interface LeadQuality {
  days: number;
  distribution: { hot: number; warm: number; cold: number };
  avgScore: number; maxScore: number;
  dataCompleteness: { hasPhone: number; hasEmail: number; hasStatement: number };
  bySource: { source: string; tier: string; count: number }[];
}

interface ReadinessCheck {
  id: string; category: string; label: string;
  status: "pass" | "warn" | "fail"; detail: string; blockerForScale: boolean;
}
interface ReadinessData {
  score: number; passCount: number; warnCount: number; failCount: number;
  scalingBlockers: string[]; readyToRunGoogleAds: boolean;
  checks: ReadinessCheck[]; summary: string;
}

interface SequencePerf {
  id: string; name: string; status: string; enrolled: number; active: number;
  completed: number; converted: number; bounced: number; unsubscribed: number;
  conversionRate: number;
}

interface VerticalKw {
  vertical: string; industry: string; priority: string; floridaFocus: boolean;
  keywords: string[]; negativeKeywords: string[];
  recommendedPage: string; primaryCta: string; primaryOffer: string;
  adGroup: string; estimatedCpl: number; estimatedCpa: number;
}

interface PlanningScenario {
  label: string; dailyBudget: number; monthlyBudget: number;
  estimatedLeads: number; estimatedBookedCalls: number; estimatedSignups: number;
  estimatedResidual: number; paybackMonths: number;
  verdict: "too_small" | "viable" | "scale" | "enterprise"; note: string;
}

// ─── Small reusable helpers ───────────────────────────────────────────────────

function StatusIcon({ status }: { status: "pass" | "warn" | "fail" }) {
  if (status === "pass") return <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />;
  if (status === "warn") return <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0" />;
  return <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />;
}

function StatusBadge({ status }: { status: "pass" | "warn" | "fail" }) {
  const v = status === "pass" ? "default" : status === "warn" ? "secondary" : "destructive";
  return <Badge variant={v}>{status.toUpperCase()}</Badge>;
}

function ScaleBadge({ signal }: { signal: string }) {
  if (signal === "scale") return <Badge className="bg-green-600 text-white">Scale</Badge>;
  if (signal === "optimize") return <Badge className="bg-yellow-500 text-white">Optimize</Badge>;
  return <Badge variant="secondary">Test</Badge>;
}

function fmt$(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n: number) {
  return `${Math.round(n * 100)}%`;
}

// ─── Tab: Overview (Acquisition Funnel) ──────────────────────────────────────

function OverviewTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<FunnelData>({ queryKey: ["/api/acquisition/funnel", days] });

  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Loading acquisition funnel…</div>;

  const d = data!;

  const kpis = [
    { label: "Total Leads", value: d.totalLeads.toLocaleString(), icon: Users, color: "text-blue-600" },
    { label: "Google / CPC Leads", value: d.googleLeads.toLocaleString(), icon: Target, color: "text-purple-600" },
    { label: "Statement Uploads", value: d.statementUploads.toLocaleString(), icon: Upload, color: "text-indigo-600" },
    { label: "Booked Calls", value: d.bookedCalls.toLocaleString(), icon: PhoneCall, color: "text-orange-600" },
    { label: "Closed Won", value: d.closedWon.toLocaleString(), icon: FileCheck, color: "text-green-600" },
    { label: "Lead → Close", value: fmtPct(d.funnelRates.leadToClose), icon: TrendingUp, color: "text-emerald-600" },
  ];

  return (
    <div className="space-y-6">
      {!d.googleAdsApiConfigured && (
        <Alert className="border-blue-200 bg-blue-50 dark:bg-blue-950">
          <Info className="w-4 h-4 text-blue-600" />
          <AlertDescription className="text-blue-800 dark:text-blue-200">
            <strong>Google Ads API not connected.</strong> Set <code className="text-xs bg-blue-100 px-1 rounded">GOOGLE_ADS_DEVELOPER_TOKEN</code> to pull live spend data.
            Until then, use the <strong>Offline Conversions</strong> tab to export events for manual import, and track spend directly in your Google Ads account.
          </AlertDescription>
        </Alert>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map(k => (
          <Card key={k.label}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-start gap-2">
                <k.icon className={`w-4 h-4 mt-0.5 shrink-0 ${k.color}`} />
                <div>
                  <p className="text-xs text-muted-foreground leading-tight">{k.label}</p>
                  <p className="text-xl font-bold mt-0.5">{k.value}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Funnel waterfall */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Acquisition Funnel — Last {days} Days</CardTitle>
          <CardDescription>Lead flow from first touch to closed merchant. Rates are estimates until Google Ads API is connected.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { stage: "Leads Captured", val: d.totalLeads, pct: 1, color: "bg-blue-500" },
              { stage: "Statement Uploaded", val: d.statementUploads, pct: d.funnelRates.leadToUpload, color: "bg-indigo-500" },
              { stage: "Call Booked", val: d.bookedCalls, pct: d.funnelRates.leadToClose / (d.funnelRates.bookedToClose || 1), color: "bg-orange-500" },
              { stage: "Closed Won", val: d.closedWon, pct: d.funnelRates.leadToClose, color: "bg-green-500" },
            ].map(s => (
              <div key={s.stage} className="flex items-center gap-3">
                <span className="text-sm w-36 shrink-0 text-muted-foreground">{s.stage}</span>
                <Progress value={Math.round(s.pct * 100)} className="flex-1 h-3" />
                <span className="text-sm font-semibold w-14 text-right">{s.val.toLocaleString()}</span>
                <span className="text-xs text-muted-foreground w-12 text-right">{fmtPct(s.pct)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* By Source */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Leads by Source</CardTitle>
          </CardHeader>
          <CardContent>
            {d.bySource.length === 0 ? (
              <p className="text-sm text-muted-foreground">No UTM-tagged leads yet. Add utm_source to your ad URLs.</p>
            ) : (
              <div className="space-y-2">
                {d.bySource.slice(0, 8).map(r => (
                  <div key={r.source} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate max-w-[140px]">{r.source}</span>
                    <div className="flex items-center gap-2">
                      <Progress value={d.totalLeads > 0 ? Math.round((r.leads / d.totalLeads) * 100) : 0} className="w-20 h-1.5" />
                      <span className="font-medium w-8 text-right">{r.leads}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* By Campaign */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Top Campaigns</CardTitle>
          </CardHeader>
          <CardContent>
            {d.byCampaign.length === 0 ? (
              <p className="text-sm text-muted-foreground">No campaign-tagged leads yet. Add utm_campaign to your ad URLs.</p>
            ) : (
              <div className="space-y-2">
                {d.byCampaign.slice(0, 8).map((r, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div className="min-w-0">
                      <p className="truncate max-w-[160px]">{r.campaign}</p>
                      <p className="text-xs text-muted-foreground">{r.source} / {r.medium}</p>
                    </div>
                    <Badge variant="secondary">{r.leads}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Deal pipeline by stage */}
      {d.dealStages.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Pipeline Stage Distribution (Leads from Last {days}d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {d.dealStages.map(s => (
                <div key={s.stage} className="flex items-center gap-1.5 bg-muted rounded-full px-3 py-1 text-sm">
                  <span className="text-muted-foreground">{s.stage}</span>
                  <Badge variant="outline">{s.count}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Tab: ROI by Vertical ─────────────────────────────────────────────────────

function RoiByVerticalTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<{ days: number; verticals: VerticalRow[] }>({
    queryKey: ["/api/acquisition/roi-by-vertical", days],
  });
  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Loading vertical ROI…</div>;
  const rows = data?.verticals ?? [];

  return (
    <div className="space-y-4">
      <Alert className="border-yellow-200 bg-yellow-50 dark:bg-yellow-950">
        <Info className="w-4 h-4 text-yellow-600" />
        <AlertDescription className="text-yellow-800 dark:text-yellow-200 text-xs">
          Residual estimates use planning assumptions ($35k avg volume, {45} bps). Actual results vary by merchant.
          Scale/Optimize/Test signals are based on close rate ≥15% with 5+ leads = Scale.
        </AlertDescription>
      </Alert>
      <div className="rounded-md border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vertical</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">Hot Leads</TableHead>
              <TableHead className="text-right">Deals</TableHead>
              <TableHead className="text-right">Won</TableHead>
              <TableHead className="text-right">Book Rate</TableHead>
              <TableHead className="text-right">Close Rate</TableHead>
              <TableHead className="text-right">Est. Residual/mo</TableHead>
              <TableHead>Signal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No leads in this window. Add UTM params to your forms and ads.</TableCell></TableRow>
            ) : rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{r.vertical}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{r.source}</TableCell>
                <TableCell className="text-right">{r.leads}</TableCell>
                <TableCell className="text-right text-orange-600 font-medium">{r.hotLeads}</TableCell>
                <TableCell className="text-right">{r.deals}</TableCell>
                <TableCell className="text-right text-green-600 font-medium">{r.closedWon}</TableCell>
                <TableCell className="text-right">{fmtPct(r.bookedRate)}</TableCell>
                <TableCell className="text-right">{fmtPct(r.closeRate)}</TableCell>
                <TableCell className="text-right text-green-700 dark:text-green-400">{fmt$(r.estMonthlyResidual)}</TableCell>
                <TableCell><ScaleBadge signal={r.scaleSignal} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Tab: Lead Quality ────────────────────────────────────────────────────────

function LeadQualityTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<LeadQuality>({ queryKey: ["/api/acquisition/lead-quality", days] });
  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Loading lead quality…</div>;
  const d = data!;
  const total = d.distribution.hot + d.distribution.warm + d.distribution.cold;

  const tiers = [
    { tier: "hot", label: "Hot (score ≥70)", count: d.distribution.hot, color: "bg-red-500", textColor: "text-red-700 dark:text-red-400" },
    { tier: "warm", label: "Warm (score 40–69)", count: d.distribution.warm, color: "bg-yellow-500", textColor: "text-yellow-700 dark:text-yellow-400" },
    { tier: "cold", label: "Cold (score <40)", count: d.distribution.cold, color: "bg-blue-400", textColor: "text-blue-700 dark:text-blue-400" },
  ];

  const sourceGroups: Record<string, { hot: number; warm: number; cold: number }> = {};
  for (const r of d.bySource) {
    if (!sourceGroups[r.source]) sourceGroups[r.source] = { hot: 0, warm: 0, cold: 0 };
    sourceGroups[r.source][r.tier as "hot" | "warm" | "cold"] = (sourceGroups[r.source][r.tier as "hot"|"warm"|"cold"] || 0) + r.count;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {tiers.map(t => (
          <Card key={t.tier}>
            <CardContent className="pt-5 pb-4">
              <p className="text-sm text-muted-foreground mb-1">{t.label}</p>
              <p className={`text-3xl font-bold ${t.textColor}`}>{t.count.toLocaleString()}</p>
              <Progress value={total > 0 ? Math.round((t.count / total) * 100) : 0} className={`mt-2 h-2`} />
              <p className="text-xs text-muted-foreground mt-1">{total > 0 ? Math.round((t.count / total) * 100) : 0}% of leads</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Scoring Stats</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Average Lead Score</span><span className="font-semibold">{d.avgScore}/100</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Best Lead Score</span><span className="font-semibold">{d.maxScore}/100</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Has Valid Phone</span><span className="font-semibold">{d.dataCompleteness.hasPhone.toLocaleString()}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Has Valid Email</span><span className="font-semibold">{d.dataCompleteness.hasEmail.toLocaleString()}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Has Statement Upload</span><span className="font-semibold">{d.dataCompleteness.hasStatement.toLocaleString()}</span></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Quality by Source</CardTitle></CardHeader>
          <CardContent>
            {Object.keys(sourceGroups).length === 0 ? (
              <p className="text-sm text-muted-foreground">No UTM-tagged sources yet.</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(sourceGroups).slice(0, 8).map(([src, counts]) => {
                  const srcTotal = counts.hot + counts.warm + counts.cold;
                  const hotPct = srcTotal > 0 ? Math.round((counts.hot / srcTotal) * 100) : 0;
                  return (
                    <div key={src}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-muted-foreground">{src}</span>
                        <span>{srcTotal} leads · <span className="text-orange-600">{hotPct}% hot</span></span>
                      </div>
                      <div className="flex gap-0.5 h-2 rounded overflow-hidden">
                        <div className="bg-red-500" style={{ width: `${hotPct}%` }} />
                        <div className="bg-yellow-500" style={{ width: `${srcTotal > 0 ? Math.round((counts.warm / srcTotal) * 100) : 0}%` }} />
                        <div className="bg-blue-300 flex-1" />
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

// ─── Tab: Keyword Map ─────────────────────────────────────────────────────────

function KeywordMapTab() {
  const { data, isLoading } = useQuery<{ verticalMap: VerticalKw[]; geoTargets: any[]; planning: any }>({
    queryKey: ["/api/acquisition/keyword-map"],
  });
  const [selected, setSelected] = useState<string | null>(null);
  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Loading keyword map…</div>;
  const { verticalMap = [], geoTargets = [] } = data ?? {};
  const focused = selected ? verticalMap.find(v => v.vertical === selected) : null;

  return (
    <div className="space-y-4">
      <Alert className="border-blue-200 bg-blue-50 dark:bg-blue-950">
        <MapPin className="w-4 h-4 text-blue-600" />
        <AlertDescription className="text-blue-800 dark:text-blue-200 text-xs">
          South Florida is the primary geo target. Run vertical-specific campaigns for each industry before expanding nationally.
          CPL / CPA estimates are planning targets — tune based on actual Google Ads data.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Vertical list */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">Verticals</p>
          {verticalMap.map(v => (
            <button
              key={v.vertical}
              onClick={() => setSelected(v.vertical === selected ? null : v.vertical)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                selected === v.vertical
                  ? "border-primary bg-primary/5 font-medium"
                  : "border-border hover:border-primary/40 hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <span>{v.vertical}</span>
                <div className="flex gap-1">
                  {v.floridaFocus && <Badge variant="outline" className="text-xs px-1.5">FL</Badge>}
                  <Badge variant={v.priority === "high" ? "default" : "secondary"} className="text-xs px-1.5">{v.priority}</Badge>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Est. CPL {fmt$(v.estimatedCpl)} · CPA {fmt$(v.estimatedCpa)}</p>
            </button>
          ))}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-2">
          {!focused ? (
            <Card className="h-full flex items-center justify-center">
              <CardContent className="text-center text-muted-foreground py-12">
                <Target className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Select a vertical to see keyword details</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>{focused.vertical}</CardTitle>
                <CardDescription>{focused.adGroup}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><p className="text-muted-foreground text-xs">Landing Page</p><p className="font-medium">{focused.recommendedPage}</p></div>
                  <div><p className="text-muted-foreground text-xs">Primary CTA</p><p className="font-medium">{focused.primaryCta}</p></div>
                  <div><p className="text-muted-foreground text-xs">Est. CPL</p><p className="font-semibold text-blue-600">{fmt$(focused.estimatedCpl)}</p></div>
                  <div><p className="text-muted-foreground text-xs">Est. CPA</p><p className="font-semibold text-indigo-600">{fmt$(focused.estimatedCpa)}</p></div>
                </div>
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">Offer / Value Prop</p>
                  <p className="text-sm font-medium italic">"{focused.primaryOffer}"</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Target Keywords</p>
                  <div className="flex flex-wrap gap-1.5">
                    {focused.keywords.map(kw => (
                      <Badge key={kw} variant="outline" className="text-xs">{kw}</Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Negative Keywords</p>
                  <div className="flex flex-wrap gap-1.5">
                    {focused.negativeKeywords.map(kw => (
                      <Badge key={kw} variant="secondary" className="text-xs opacity-70">–{kw}</Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Geo targets */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><MapPin className="w-4 h-4" /> Geographic Targeting Order</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {geoTargets.map(g => (
              <div key={g.label} className="p-3 border rounded-lg">
                <p className="text-xs font-semibold">{g.label}</p>
                <Badge variant={g.priority === "highest" ? "default" : "secondary"} className="text-xs mt-1">{g.priority}</Badge>
                {g.cities?.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">{g.cities.slice(0, 3).join(", ")}{g.cities.length > 3 ? "…" : ""}</p>
                )}
                {g.note && <p className="text-xs text-muted-foreground mt-1 italic">{g.note}</p>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tab: Sequences ───────────────────────────────────────────────────────────

function SequencesTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<{ sequences: SequencePerf[]; outboundPaused: boolean; note: string }>({
    queryKey: ["/api/acquisition/sequence-performance", days],
  });
  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Loading sequence data…</div>;
  const seqs = data?.sequences ?? [];

  return (
    <div className="space-y-4">
      <Alert className="border-orange-200 bg-orange-50 dark:bg-orange-950">
        <PauseCircle className="w-4 h-4 text-orange-600" />
        <AlertDescription className="text-orange-800 dark:text-orange-200 text-xs">
          <strong>outboundGlobalPaused = true.</strong> No new enrollments are being processed.
          Data below shows historical enrollment state only. Sequences will activate when outbound is unpaused by an admin.
        </AlertDescription>
      </Alert>
      <div className="rounded-md border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sequence</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Enrolled</TableHead>
              <TableHead className="text-right">Active</TableHead>
              <TableHead className="text-right">Completed</TableHead>
              <TableHead className="text-right">Converted</TableHead>
              <TableHead className="text-right">Bounced</TableHead>
              <TableHead className="text-right">Unsub</TableHead>
              <TableHead className="text-right">Conv. Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {seqs.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No sequences with enrollments in this window.</TableCell></TableRow>
            ) : seqs.map(s => (
              <TableRow key={s.id}>
                <TableCell className="font-medium max-w-[200px] truncate">{s.name}</TableCell>
                <TableCell>
                  <Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge>
                </TableCell>
                <TableCell className="text-right">{s.enrolled}</TableCell>
                <TableCell className="text-right">{s.active}</TableCell>
                <TableCell className="text-right">{s.completed}</TableCell>
                <TableCell className="text-right text-green-600 font-medium">{s.converted}</TableCell>
                <TableCell className="text-right text-red-500">{s.bounced}</TableCell>
                <TableCell className="text-right text-muted-foreground">{s.unsubscribed}</TableCell>
                <TableCell className="text-right font-semibold">{fmtPct(s.conversionRate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Statement SLA Alert Widget ───────────────────────────────────────────────

function StatementSlaAlert() {
  const { data, isLoading } = useQuery<{
    breachCount: number;
    message: string;
    slaMinutes: number;
    alerts: Array<{ dealId: number; contactName: string; companyName: string; email: string; hoursStuck: number }>;
  }>({ queryKey: ["/api/acquisition/statement-sla"] });

  if (isLoading || !data) return null;
  if (data.breachCount === 0) return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-300">
      <CheckCircle className="w-4 h-4 shrink-0" />
      Statement upload SLA: All followed up within {data.slaMinutes / 60} hours.
    </div>
  );

  return (
    <Card className="border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/10">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <CardTitle className="text-sm text-red-700 dark:text-red-400">Statement Upload SLA Breach — {data.breachCount} deal{data.breachCount !== 1 ? "s" : ""} need immediate follow-up</CardTitle>
        </div>
        <CardDescription className="text-xs">Deals in &quot;Statement Received&quot; with no call booked in the last {data.slaMinutes / 60} hours</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-red-200 dark:border-red-800">
                <th className="text-left py-1.5 text-xs font-medium text-muted-foreground">Contact / Company</th>
                <th className="text-left py-1.5 text-xs font-medium text-muted-foreground">Email</th>
                <th className="text-right py-1.5 text-xs font-medium text-muted-foreground">Hours Waiting</th>
                <th className="text-right py-1.5 text-xs font-medium text-muted-foreground">Deal</th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map(a => (
                <tr key={a.dealId} className="border-b border-red-100 dark:border-red-900/30">
                  <td className="py-2 font-medium">{a.contactName}{a.companyName ? <span className="text-muted-foreground font-normal"> · {a.companyName}</span> : null}</td>
                  <td className="py-2 text-muted-foreground text-xs">{a.email}</td>
                  <td className="py-2 text-right">
                    <Badge variant="destructive" className="text-xs">{a.hoursStuck}h</Badge>
                  </td>
                  <td className="py-2 text-right">
                    <a href={`/dashboard/deals/${a.dealId}`} className="text-xs text-primary hover:underline" data-testid={`link-deal-${a.dealId}`}>View</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Tab: Offline Conversions ─────────────────────────────────────────────────

function OfflineConversionsTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<{ totalRows: number; googleAdsApiConfigured: boolean; gclidCaptureActive: boolean; setupSteps: string[]; note: string }>({
    queryKey: ["/api/acquisition/offline-conversions/export", days],
  });
  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Checking conversion data…</div>;
  const d = data!;

  const handleDownload = () => {
    window.open(`/api/acquisition/offline-conversions/export?days=${days}&format=csv`, "_blank");
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-muted-foreground">Conversion Events</p>
            <p className="text-3xl font-bold mt-1">{d.totalRows.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">Last {days} days</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-muted-foreground">Google Ads API</p>
            <Badge className="mt-2" variant={d.googleAdsApiConfigured ? "default" : "secondary"}>
              {d.googleAdsApiConfigured ? "✓ Connected" : "Not Connected"}
            </Badge>
            {!d.googleAdsApiConfigured && <p className="text-xs text-muted-foreground mt-1">Set GOOGLE_ADS_DEVELOPER_TOKEN</p>}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-muted-foreground">gclid Capture</p>
            <Badge className="mt-2 bg-green-600" variant="default">Active</Badge>
            <p className="text-xs text-muted-foreground mt-1">Wired to all 3 lead forms — stored per contact</p>
          </CardContent>
        </Card>
      </div>

      <StatementSlaAlert />


      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Manual Import Flow (Until API Connected)</CardTitle>
          <CardDescription>{d.note}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            {d.setupSteps.map((step, i) => (
              <div key={i} className="flex gap-3 text-sm">
                <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-semibold shrink-0 mt-0.5">{i + 1}</span>
                <p className="text-muted-foreground">{step}</p>
              </div>
            ))}
          </div>
          <Button onClick={handleDownload} className="gap-2" data-testid="button-download-conversions">
            <Download className="w-4 h-4" />
            Download Conversion CSV ({d.totalRows} rows, last {days}d)
          </Button>
          <p className="text-xs text-muted-foreground">
            Upload this CSV in Google Ads → Tools &amp; Settings → Conversions → Upload.
            The CSV includes: StatementUpload, BookedCall, ApplicationSubmit, MerchantApproved, ClosedWon events.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tab: Budget Planner ──────────────────────────────────────────────────────

function BudgetPlannerTab() {
  const { data, isLoading } = useQuery<{ planning: any; scenarios: PlanningScenario[] }>({
    queryKey: ["/api/acquisition/planning"],
  });
  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Loading planner…</div>;
  const { scenarios = [], planning } = data ?? {};

  const verdictColors: Record<string, string> = {
    too_small: "border-red-200 bg-red-50 dark:bg-red-950",
    viable: "border-yellow-200 bg-yellow-50 dark:bg-yellow-950",
    scale: "border-green-200 bg-green-50 dark:bg-green-950",
    enterprise: "border-blue-200 bg-blue-50 dark:bg-blue-950",
  };

  return (
    <div className="space-y-4">
      <Alert className="border-yellow-200 bg-yellow-50 dark:bg-yellow-950">
        <DollarSign className="w-4 h-4 text-yellow-600" />
        <AlertDescription className="text-yellow-800 dark:text-yellow-200 text-xs">
          <strong>Budget reality check:</strong> {planning?.note}
          <br />Assumes CPL={fmt$(planning?.targetCpl)}, CPA={fmt$(planning?.targetCpa)},
          booked rate={Math.round((planning?.bookedRate ?? 0)*100)}%, close rate={Math.round((planning?.closeRate ?? 0)*100)}%,
          avg residual {planning?.avgResidualBps}bps on {fmt$(planning?.avgMonthlyVolume)}/mo.
          <strong> These are planning estimates — validate against real data.</strong>
        </AlertDescription>
      </Alert>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {scenarios.map(s => (
          <Card key={s.label} className={`border-2 ${verdictColors[s.verdict] ?? ""}`}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">{s.label}</CardTitle>
                <Badge variant={s.verdict === "scale" ? "default" : s.verdict === "viable" ? "secondary" : s.verdict === "enterprise" ? "outline" : "destructive"}>
                  {s.verdict === "too_small" ? "Too Small" : s.verdict === "viable" ? "Viable" : s.verdict === "scale" ? "Scale" : "Enterprise"}
                </Badge>
              </div>
              <CardDescription className="text-xs">{s.note}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><p className="text-xs text-muted-foreground">Daily Budget</p><p className="font-bold text-lg">{fmt$(s.dailyBudget)}</p></div>
                <div><p className="text-xs text-muted-foreground">Monthly</p><p className="font-bold text-lg">{fmt$(s.monthlyBudget)}</p></div>
                <div><p className="text-xs text-muted-foreground">Est. Leads/mo</p><p className="font-semibold">{s.estimatedLeads.toLocaleString()}</p></div>
                <div><p className="text-xs text-muted-foreground">Booked Calls</p><p className="font-semibold">{s.estimatedBookedCalls.toLocaleString()}</p></div>
                <div><p className="text-xs text-muted-foreground">Est. Signups</p><p className="font-semibold text-green-700 dark:text-green-400">{s.estimatedSignups.toLocaleString()}</p></div>
                <div><p className="text-xs text-muted-foreground">Est. Residual/mo</p><p className="font-semibold text-green-700 dark:text-green-400">{fmt$(s.estimatedResidual)}</p></div>
                <div><p className="text-xs text-muted-foreground">Payback</p><p className="font-semibold">{s.paybackMonths} months</p></div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── Tab: ROI Calculator (CPL / CPB / CPS) ───────────────────────────────────

interface RoiCalcData {
  days: number;
  totalLeads: number;
  bookedCalls: number;
  closedWon: number;
  bySource: { source: string; leads: number; bookedCalls: number; closedWon: number }[];
}

function RoiCalculatorTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<RoiCalcData>({ queryKey: ["/api/acquisition/roi-calculator", days] });
  const [adSpend, setAdSpend] = useState(0);

  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Loading ROI data…</div>;
  const d = data!;

  const cpl = adSpend > 0 && d.totalLeads > 0 ? adSpend / d.totalLeads : null;
  const cpb = adSpend > 0 && d.bookedCalls > 0 ? adSpend / d.bookedCalls : null;
  const cps = adSpend > 0 && d.closedWon > 0 ? adSpend / d.closedWon : null;

  const avgResidual = 35000 * (45 / 10000); // planning assumption
  const estRoi = adSpend > 0 && d.closedWon > 0 ? ((d.closedWon * avgResidual * 12) - adSpend) / adSpend : null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ad Spend Input</CardTitle>
          <p className="text-xs text-muted-foreground">
            Enter your total Google Ads spend for the selected period to calculate CPL, CPB, and CPS metrics.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 max-w-xs">
            <DollarSign className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              type="number"
              min="0"
              step="100"
              value={adSpend || ""}
              onChange={e => setAdSpend(Math.max(0, parseFloat(e.target.value) || 0))}
              placeholder="0"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="input-ad-spend"
            />
            <span className="text-sm text-muted-foreground shrink-0">total spend</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Leads", value: d.totalLeads.toLocaleString(), sub: "in period", color: "text-blue-600" },
          { label: "Booked Calls", value: d.bookedCalls.toLocaleString(), sub: "in period", color: "text-orange-600" },
          { label: "Closed Won", value: d.closedWon.toLocaleString(), sub: "in period", color: "text-green-600" },
          { label: "Ad Spend", value: adSpend > 0 ? fmt$(adSpend) : "—", sub: "entered above", color: "text-purple-600" },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className={`text-2xl font-bold mt-0.5 ${k.color}`}>{k.value}</p>
              <p className="text-xs text-muted-foreground">{k.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className={adSpend > 0 ? "" : "opacity-60"}>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Cost Per Lead (CPL)</p>
            <p className="text-3xl font-bold text-blue-600">{cpl !== null ? fmt$(cpl) : "—"}</p>
            <p className="text-xs text-muted-foreground mt-1">{adSpend > 0 ? `${fmt$(adSpend)} ÷ ${d.totalLeads} leads` : "Enter spend above"}</p>
          </CardContent>
        </Card>
        <Card className={adSpend > 0 ? "" : "opacity-60"}>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Cost Per Booked Call (CPB)</p>
            <p className="text-3xl font-bold text-orange-600">{cpb !== null ? fmt$(cpb) : "—"}</p>
            <p className="text-xs text-muted-foreground mt-1">{adSpend > 0 ? `${fmt$(adSpend)} ÷ ${d.bookedCalls} calls` : "Enter spend above"}</p>
          </CardContent>
        </Card>
        <Card className={adSpend > 0 ? "" : "opacity-60"}>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Cost Per Signed Merchant (CPS)</p>
            <p className="text-3xl font-bold text-green-600">{cps !== null ? fmt$(cps) : "—"}</p>
            <p className="text-xs text-muted-foreground mt-1">{adSpend > 0 ? `${fmt$(adSpend)} ÷ ${d.closedWon} signups` : "Enter spend above"}</p>
          </CardContent>
        </Card>
      </div>

      {adSpend > 0 && estRoi !== null && (
        <Card className={estRoi > 0 ? "border-green-200 bg-green-50/50 dark:bg-green-950/10" : "border-red-200 bg-red-50/50 dark:bg-red-950/10"}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <TrendingUp className={`w-5 h-5 ${estRoi > 0 ? "text-green-600" : "text-red-500"}`} />
              <div>
                <p className="text-sm font-semibold">
                  Estimated 12-Month ROI:{" "}
                  <span className={estRoi > 0 ? "text-green-700 dark:text-green-400" : "text-red-600"}>
                    {estRoi > 0 ? "+" : ""}{Math.round(estRoi * 100)}%
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Based on {d.closedWon} merchants × {fmt$(avgResidual)}/mo avg residual × 12 months vs {fmt$(adSpend)} spend.
                  Assumes 45 bps on $35k avg volume. Validate against actual merchant data.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {d.bySource.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">CPL/CPB/CPS by Source</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left pb-2 font-medium">Source</th>
                    <th className="text-right pb-2 font-medium">Leads</th>
                    <th className="text-right pb-2 font-medium">Booked</th>
                    <th className="text-right pb-2 font-medium">Won</th>
                    {adSpend > 0 && <>
                      <th className="text-right pb-2 font-medium">Est. CPL</th>
                      <th className="text-right pb-2 font-medium">Est. CPB</th>
                      <th className="text-right pb-2 font-medium">Est. CPS</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {d.bySource.map((r, i) => {
                    const totalLeads = d.bySource.reduce((s, x) => s + x.leads, 0);
                    const shareOfLeads = totalLeads > 0 ? r.leads / totalLeads : 0;
                    const sourceSpend = adSpend * shareOfLeads;
                    return (
                      <tr key={i} className="border-b border-muted/40">
                        <td className="py-2 truncate max-w-[140px]">{r.source}</td>
                        <td className="py-2 text-right">{r.leads}</td>
                        <td className="py-2 text-right">{r.bookedCalls}</td>
                        <td className="py-2 text-right text-green-600 font-medium">{r.closedWon}</td>
                        {adSpend > 0 && <>
                          <td className="py-2 text-right text-blue-600">{r.leads > 0 ? fmt$(sourceSpend / r.leads) : "—"}</td>
                          <td className="py-2 text-right text-orange-600">{r.bookedCalls > 0 ? fmt$(sourceSpend / r.bookedCalls) : "—"}</td>
                          <td className="py-2 text-right text-green-600">{r.closedWon > 0 ? fmt$(sourceSpend / r.closedWon) : "—"}</td>
                        </>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Tab: Readiness Audit ─────────────────────────────────────────────────────

function ReadinessAuditTab() {
  const { data, isLoading, refetch } = useQuery<ReadinessData>({ queryKey: ["/api/acquisition/readiness"] });
  if (isLoading) return <div className="py-12 text-center text-muted-foreground animate-pulse">Running readiness audit…</div>;
  const d = data!;

  const categories = [...new Set(d.checks.map(c => c.category))];

  return (
    <div className="space-y-4">
      {/* Score header */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="col-span-2">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-4">
              <div className="relative">
                <svg className="w-16 h-16 -rotate-90" viewBox="0 0 36 36">
                  <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted/30" />
                  <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" strokeWidth="2.5"
                    strokeDasharray={`${d.score} ${100 - d.score}`} strokeLinecap="round"
                    className={d.score >= 80 ? "text-green-500" : d.score >= 60 ? "text-yellow-500" : "text-red-500"} />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-lg font-bold">{d.score}</span>
              </div>
              <div>
                <p className="font-semibold text-base">Acquisition Readiness Score</p>
                <p className="text-sm text-muted-foreground mt-0.5">{d.summary}</p>
                <div className="flex gap-2 mt-2">
                  <Badge variant="default" className="bg-green-600">{d.passCount} Pass</Badge>
                  <Badge variant="secondary">{d.warnCount} Warn</Badge>
                  {d.failCount > 0 && <Badge variant="destructive">{d.failCount} Fail</Badge>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="col-span-2">
          <CardContent className="pt-5 pb-4">
            <p className="text-sm font-semibold mb-2">
              Google Ads Status:{" "}
              <Badge variant={d.readyToRunGoogleAds ? "default" : "secondary"} className={d.readyToRunGoogleAds ? "bg-green-600" : ""}>
                {d.readyToRunGoogleAds ? "Ready" : "Pre-Launch"}
              </Badge>
            </p>
            {d.scalingBlockers.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Blocking items:</p>
                {d.scalingBlockers.map(b => (
                  <div key={b} className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
                    <XCircle className="w-3 h-3 shrink-0" /> {b}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No critical blockers. Review warnings above before scaling budget.</p>
            )}
            <Button variant="outline" size="sm" className="mt-3 gap-1" onClick={() => refetch()} data-testid="button-refresh-readiness">
              <Activity className="w-3 h-3" /> Refresh Audit
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Checks by category */}
      {categories.map(cat => (
        <Card key={cat}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{cat}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {d.checks.filter(c => c.category === cat).map(c => (
              <div key={c.id} className="flex items-start gap-3">
                <StatusIcon status={c.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{c.label}</span>
                    {c.blockerForScale && c.status !== "pass" && (
                      <Badge variant="destructive" className="text-xs px-1.5 py-0">Blocker</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{c.detail}</p>
                </div>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Main AcquisitionHub Page ─────────────────────────────────────────────────

export default function AcquisitionHub() {
  const [, params] = useLocation();
  const [days, setDays] = useState(30);
  const [activeTab, setActiveTab] = useState("overview");

  const tabs = [
    { id: "overview", label: "Funnel" },
    { id: "roi", label: "ROI by Vertical" },
    { id: "roi-calc", label: "ROI Calculator" },
    { id: "quality", label: "Lead Quality" },
    { id: "keywords", label: "Keyword Map" },
    { id: "sequences", label: "Sequences" },
    { id: "conversions", label: "Offline Conversions" },
    { id: "planner", label: "Budget Planner" },
    { id: "readiness", label: "Readiness Audit" },
  ];

  const needsDays = ["overview", "roi", "roi-calc", "quality", "sequences", "conversions"];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <PageTitle className="text-2xl font-bold flex items-center gap-2">
            <Target className="w-6 h-6 text-primary" />
            Acquisition Command Center
          </PageTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Google Ads · UTM Attribution · Vertical ROI · Lead Quality · Readiness Audit
          </p>
        </div>
        {needsDays.includes(activeTab) && (
          <Select value={String(days)} onValueChange={v => setDays(parseInt(v, 10))}>
            <SelectTrigger className="w-32" data-testid="select-days-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="60">Last 60 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto gap-1" data-testid="tabs-acquisition">
          {tabs.map(t => (
            <TabsTrigger key={t.id} value={t.id} data-testid={`tab-acquisition-${t.id}`}>{t.label}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-4"><OverviewTab days={days} /></TabsContent>
        <TabsContent value="roi" className="mt-4"><RoiByVerticalTab days={days} /></TabsContent>
        <TabsContent value="roi-calc" className="mt-4"><RoiCalculatorTab days={days} /></TabsContent>
        <TabsContent value="quality" className="mt-4"><LeadQualityTab days={days} /></TabsContent>
        <TabsContent value="keywords" className="mt-4"><KeywordMapTab /></TabsContent>
        <TabsContent value="sequences" className="mt-4"><SequencesTab days={days} /></TabsContent>
        <TabsContent value="conversions" className="mt-4"><OfflineConversionsTab days={days} /></TabsContent>
        <TabsContent value="planner" className="mt-4"><BudgetPlannerTab /></TabsContent>
        <TabsContent value="readiness" className="mt-4"><ReadinessAuditTab /></TabsContent>
      </Tabs>
    </div>
  );
}
