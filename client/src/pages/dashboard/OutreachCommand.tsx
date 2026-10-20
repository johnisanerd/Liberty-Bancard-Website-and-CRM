import { ScopedMetricStrip } from "@/components/crm/CrmPresentation";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCrmQuery } from "@/hooks/use-crm-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Mail, Target, TrendingUp, Users, Building2,
  CheckCircle, Send, BarChart3, Pen, Settings,
  ArrowRightLeft, Upload, Briefcase, Layers, ExternalLink,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

import type { OutreachStatus } from "@/types/outreach-status";
export type { OutreachStatus } from "@/types/outreach-status";

interface SignatureData {
  signature: { name: string; title: string; phone: string; email: string; calendlyLink?: string };
  html: string;
}

/**
 * Outreach Command — narrowed to read-only pipeline visibility.
 *
 * Task #1963: import/Cordata import, enrichment/classification, GHL sync
 * (both directions), worker start/stop, daily-outreach execution, and
 * hot-lead bulk enrollment all moved out of this page. Each capability now
 * lives with its real owner:
 *   - Imports              → Lead Ops (Imports tab)
 *   - Enrichment/Promotion → Lead Ops (Businesses tab)
 *   - GHL sync             → GHL Integration
 * Signatures are kept here because campaign-engine.ts reads them on the
 * live "sales" send path.
 */
export default function OutreachCommand() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("overview");
  const [editingSig, setEditingSig] = useState<string | null>(null);
  const [sigForm, setSigForm] = useState({ name: "", title: "", phone: "", email: "", calendlyLink: "" });

  // Loaded on entry and on explicit refresh; no background recount.
  const { data: status, isLoading, isError, error, refetch, isFetching } = useCrmQuery<OutreachStatus>({
    queryKey: ["/api/outreach/status"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: signatures, isLoading: signaturesLoading, isError: signaturesError, refetch: refetchSignatures } = useCrmQuery<Record<string, SignatureData>>({
    queryKey: ["/api/email-signatures"],
  });

  const saveSignatureMutation = useMutation({
    mutationFn: ({ type, data }: { type: string; data: any }) => apiRequest("PUT", `/api/email-signatures/${type}`, data),
    onSuccess: () => { toast({ title: "Signature saved" }); queryClient.invalidateQueries({ queryKey: ["/api/email-signatures"] }); setEditingSig(null); },
    onError: (err: Error) => toast({ title: "Signature not saved", description: `${err.message || "The server did not accept the change."} The form is still open with your edits.`, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
      </div>
    );
  }

  if (isError || !status) {
    const denied = error instanceof Error && /^40[13]:/.test(error.message);
    return (
      <div className="space-y-3 rounded-lg border border-destructive/30 p-4" role="alert" data-testid="outreach-status-unavailable">
        <h2 className="font-semibold">{denied ? "Pipeline counts are not available for your role" : "Pipeline counts could not be loaded"}</h2>
        <p className="text-sm text-muted-foreground">
          {denied ? "Your account is not permitted to read these aggregate counts." : "Nothing is shown as zero. The counts are unknown until the read succeeds."}
          {error instanceof Error ? ` (${error.message})` : ""}
        </p>
        {!denied && <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>Retry</Button>}
      </div>
    );
  }

  const s = status;

  return (
    <div className="space-y-6" data-testid="outreach-command-center">
      <div>
        <h2 className="text-2xl font-bold">Outreach Command</h2>
        <p className="text-muted-foreground text-sm">Read-only pipeline visibility. Import, enrichment, promotion, and GHL sync are managed on their owning pages.</p>
      </div>

      <Card data-testid="card-pipeline-owners">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Where to manage the pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-3 gap-3">
            <Link href="/dashboard/lead-ops?tab=imports" data-testid="link-owner-imports">
              <div className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm hover-elevate cursor-pointer">
                <span className="flex items-center gap-2"><Upload className="w-4 h-4 text-muted-foreground" /> Imports</span>
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
            </Link>
            <Link href="/dashboard/lead-ops?tab=businesses" data-testid="link-owner-enrichment">
              <div className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm hover-elevate cursor-pointer">
                <span className="flex items-center gap-2"><Target className="w-4 h-4 text-muted-foreground" /> Enrichment & Promotion</span>
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
            </Link>
            <Link href="/dashboard/ghl-integration" data-testid="link-owner-ghl">
              <div className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm hover-elevate cursor-pointer">
                <span className="flex items-center gap-2"><ArrowRightLeft className="w-4 h-4 text-muted-foreground" /> GHL Sync</span>
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
            </Link>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground" role="note" data-testid="outreach-status-scope">
        Counts come from the aggregate pipeline reader{s.asOf ? `, as of ${new Date(s.asOf).toLocaleString()}` : ""}. They use different scopes and units
        and will not equal production-contact or open-deal totals on other pages. Nothing here refreshes in the background.{" "}
        <button type="button" className="underline" onClick={() => refetch()} disabled={isFetching}>Refresh</button>
      </p>
      <ScopedMetricStrip scopeId="sunbiz-source-entities" sourceLabel="Source: Sunbiz entity table, raw entities (not CRM contacts)"
        asOf={s.asOf ? new Date(s.asOf).toLocaleString() : undefined}>
        <StatCard icon={Building2} color="blue" value={s.entities.total.toLocaleString()} label="Sunbiz source entities (raw)" testId="card-total-entities" />
        <StatCard icon={Target} color="green" value={s.entities.classified} label="Classified" testId="card-classified" />
        <StatCard icon={Mail} color="purple" value={s.entities.withEmail} label="With Email" testId="card-with-email" />
      </ScopedMetricStrip>
      <ScopedMetricStrip scopeId="crm-contacts-and-deals" sourceLabel="Source: CRM contacts and deals, scopes labelled on each card"
        asOf={s.asOf ? new Date(s.asOf).toLocaleString() : undefined}
        availability={s.commEventsUnavailable ? "partial" : "available"}>
        <StatCard icon={Users} color="amber" value={s.contacts.total} label="All stored contacts (no archive or record-class filter)" testId="card-contacts" />
        <StatCard icon={Briefcase} color="indigo" value={typeof s.deals.openSalesProduction === "number" ? s.deals.openSalesProduction.toLocaleString() : "—"}
          label="Open production sales deals (unarchived, open stage, all owners)" testId="card-open-deals" />
        <StatCard icon={Briefcase} color="indigo" value={s.deals.total} label="All unarchived deals (every pipeline and class)" testId="card-deals" />
      </ScopedMetricStrip>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <ScoreCard value={s.entities.hot} label="Hot" emoji="🔥" color="red" />
        <ScoreCard value={s.entities.warm} label="Warm" emoji="🟠" color="orange" />
        <ScoreCard value={s.entities.cold} label="Cold" emoji="❄️" color="blue" />
        <ScoreCard value={s.entities.unqualified} label="Unqualified" emoji="⛔" color="gray" />
        <ScoreCard value={s.entities.pendingPromotion} label="Ready" emoji="📤" color="green" />
        <ScoreCard value={s.contacts.syncedToGhl} label="In GHL" emoji="🔗" color="indigo" />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="overview" data-testid="tab-overview">Pipeline</TabsTrigger>
          <TabsTrigger value="outreach-sources" data-testid="tab-outreach-sources">Outreach Sources</TabsTrigger>
          <TabsTrigger value="signatures" data-testid="tab-signatures">Signatures</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Building2 className="w-4 h-4" /> Sunbiz Entities</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <Row label="Total" value={s.entities.total.toLocaleString()} />
                <Row label="Enriched" value={s.entities.enriched} />
                <Row label="Pending" value={s.entities.pending} highlight />
                <Row label="With Email" value={s.entities.withEmail} color="green" />
                <Row label="With Phone" value={s.entities.withPhone} color="green" />
                <Row label="Classified" value={s.entities.classified} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Users className="w-4 h-4" /> Prospects</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <Row label="Total" value={s.prospects.total} />
                <Row label="With Email" value={s.prospects.withEmail} />
                <Row label="Qualified (A/B)" value={s.prospects.qualified} color="green" />
                <Row label="Converted" value={s.prospects.converted} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Contacts</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <Row label="Total" value={s.contacts.total} />
                <Row label="From Sunbiz" value={s.contacts.fromSunbiz} />
                <Row label="New Leads" value={s.contacts.newLeads} color="blue" />
                <Row label="Synced to GHL" value={s.contacts.syncedToGhl} color="green" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Briefcase className="w-4 h-4" /> Deals</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <Row label="Total" value={s.deals.total} />
                <Row label="New Lead" value={s.deals.newLead} color="blue" />
                <Row label="Contacted" value={s.deals.contacted} />
                <Row label="Qualified" value={s.deals.qualified} color="green" />
                <Row label="Won" value={s.deals.won} color="green" />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Industry Classification</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {Object.entries(s.verticalBreakdown).sort((a, b) => b[1] - a[1]).map(([v, c]) => (
                  <Badge key={v} variant={v === "Unclassified" ? "outline" : "secondary"} className="no-default-hover-elevate" data-testid={`badge-vertical-${v.toLowerCase().replace(/\s+/g, '-')}`}>
                    {v}: {c.toLocaleString()}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Sales Pipeline Funnel</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <FunnelStep label="Entities" value={s.entities.total} color="bg-slate-200 dark:bg-slate-700" />
                <span className="text-muted-foreground">→</span>
                <FunnelStep label="Enriched" value={s.entities.enriched} color="bg-blue-100 dark:bg-blue-900" />
                <span className="text-muted-foreground">→</span>
                <FunnelStep label="Hot/Warm" value={s.entities.hot + s.entities.warm} color="bg-orange-100 dark:bg-orange-900" />
                <span className="text-muted-foreground">→</span>
                <FunnelStep label="Contacts" value={s.contacts.fromSunbiz} color="bg-green-100 dark:bg-green-900" />
                <span className="text-muted-foreground">→</span>
                <FunnelStep label="Deals" value={s.deals.fromSunbiz} color="bg-purple-100 dark:bg-purple-900" />
                <span className="text-muted-foreground">→</span>
                <FunnelStep label="Won" value={s.deals.won} color="bg-emerald-100 dark:bg-emerald-900" />
              </div>
            </CardContent>
          </Card>

          {s.sourceBreakdown && s.sourceBreakdown.length > 0 && (
            <Card data-testid="card-source-breakdown">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Layers className="w-4 h-4" /> Contact Sources
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left py-2 pr-4 font-medium">Source</th>
                        <th className="text-right py-2 px-4 font-medium">Contacts</th>
                        <th className="text-right py-2 px-4 font-medium">Deals</th>
                        <th className="text-right py-2 pl-4 font-medium">Conversion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.sourceBreakdown.map((row) => {
                        const rate = row.contactCount > 0 ? Math.round((row.dealCount / row.contactCount) * 100) : 0;
                        return (
                          <tr key={row.source} className="border-b last:border-0 hover:bg-muted/30" data-testid={`source-row-${row.source}`}>
                            <td className="py-2 pr-4">
                              <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{row.source}</code>
                            </td>
                            <td className="text-right py-2 px-4 font-medium">{row.contactCount.toLocaleString()}</td>
                            <td className="text-right py-2 px-4 font-medium">{row.dealCount.toLocaleString()}</td>
                            <td className="text-right py-2 pl-4">
                              <span className={rate >= 50 ? "text-green-600 dark:text-green-400 font-medium" : rate >= 20 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                                {rate}%
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="outreach-sources" className="space-y-4" data-testid="tab-content-outreach-sources">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Send className="w-4 h-4" /> Outreach Events by Source (last 90 days)
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Counts of outbound communication events grouped by originating source (sequence automation, manual sends, SDR, campaign, etc.).
              </p>
            </CardHeader>
            <CardContent>
              {s.commEventsUnavailable ? (
                <p className="text-sm text-destructive" role="alert" data-testid="comm-events-unavailable">
                  The outbound event breakdown could not be read. That is unknown, not zero events.
                </p>
              ) : (!s.commEventSourceBreakdown || s.commEventSourceBreakdown.length === 0) ? (
                <p className="text-sm text-muted-foreground italic">No outbound events recorded in the last 90 days.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground text-xs">
                        <th className="text-left py-2 pr-4 font-medium">Source</th>
                        <th className="text-right py-2 px-3 font-medium">Email</th>
                        <th className="text-right py-2 px-3 font-medium">SMS</th>
                        <th className="text-right py-2 px-3 font-medium">Call</th>
                        <th className="text-right py-2 pl-3 font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.commEventSourceBreakdown.map((row) => (
                        <tr key={row.source} className="border-b last:border-0 hover:bg-muted/30" data-testid={`comm-source-row-${row.source}`}>
                          <td className="py-2 pr-4">
                            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{row.source}</code>
                          </td>
                          <td className="text-right py-2 px-3 text-blue-700 dark:text-blue-400">{row.emailCount.toLocaleString()}</td>
                          <td className="text-right py-2 px-3 text-green-700 dark:text-green-400">{row.smsCount.toLocaleString()}</td>
                          <td className="text-right py-2 px-3 text-amber-700 dark:text-amber-400">{row.callCount.toLocaleString()}</td>
                          <td className="text-right py-2 pl-3 font-semibold">{row.total.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="signatures" className="space-y-4">
          <Alert data-testid="alert-signatures-live">
            <Mail className="h-4 w-4" />
            <AlertDescription>
              These signatures are appended to live campaign emails sent via the "sales" sender profile — edits take effect on the next send.
            </AlertDescription>
          </Alert>
          {signaturesLoading && <p className="text-sm text-muted-foreground" data-testid="signatures-loading">Loading signatures…</p>}
          {signaturesError && (
            <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm" data-testid="signatures-unavailable">
              <p className="font-medium">Signatures could not be loaded.</p>
              <p className="text-muted-foreground">This is a failed read, not an empty list; the stored signatures are unchanged.</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchSignatures()} data-testid="button-retry-signatures">Retry</Button>
            </div>
          )}
          {signatures && Object.entries(signatures).map(([type, data]) => (
            <Card key={type}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2 capitalize"><Pen className="w-5 h-5" /> {type} Signature</CardTitle>
                  <Button variant="outline" size="sm" className="gap-1" onClick={() => { setEditingSig(type); setSigForm({ name: data.signature.name, title: data.signature.title, phone: data.signature.phone, email: data.signature.email, calendlyLink: data.signature.calendlyLink || "" }); }} data-testid={`button-edit-sig-${type}`}>
                    <Settings className="w-3 h-3" /> Edit
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="border rounded-lg p-4 bg-white dark:bg-gray-950" data-testid={`sig-preview-${type}`}>
                  <div dangerouslySetInnerHTML={{ __html: data.html }} />
                </div>
              </CardContent>
            </Card>
          ))}

          {editingSig && (
            <Dialog open={!!editingSig} onOpenChange={() => setEditingSig(null)}>
              <DialogContent data-testid="dialog-edit-signature">
                <DialogHeader><DialogTitle className="capitalize">Edit {editingSig} Signature</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  {["name", "title", "phone", "email", "calendlyLink"].map(field => (
                    <div key={field} className="space-y-1">
                      <Label className="capitalize">{field === "calendlyLink" ? "Calendar Link" : field}</Label>
                      <Input value={(sigForm as any)[field]} onChange={e => setSigForm(p => ({ ...p, [field]: e.target.value }))} data-testid={`input-sig-${field}`} />
                    </div>
                  ))}
                  <Button onClick={() => saveSignatureMutation.mutate({ type: editingSig, data: sigForm })} disabled={saveSignatureMutation.isPending} className="w-full gap-2" data-testid="button-save-signature">
                    {saveSignatureMutation.isPending ? <CheckCircle className="w-4 h-4 animate-pulse" /> : <CheckCircle className="w-4 h-4" />}
                    Save
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ icon: Icon, color, value, label, testId }: { icon: any; color: string; value: any; label: string; testId: string }) {
  const colorClasses: Record<string, string> = {
    blue: "bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400",
    green: "bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-400",
    purple: "bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-400",
    amber: "bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400",
    indigo: "bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-400",
  };
  return (
    <Card data-testid={testId}>
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colorClasses[color]}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xl font-bold">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ScoreCard({ value, label, emoji, color }: { value: number; label: string; emoji: string; color: string }) {
  const borderColors: Record<string, string> = {
    red: "border-red-200 dark:border-red-800", orange: "border-orange-200 dark:border-orange-800",
    blue: "border-blue-200 dark:border-blue-800", gray: "border-gray-200 dark:border-gray-700",
    green: "border-green-200 dark:border-green-800", indigo: "border-indigo-200 dark:border-indigo-800",
  };
  const textColors: Record<string, string> = {
    red: "text-red-600 dark:text-red-400", orange: "text-orange-600 dark:text-orange-400",
    blue: "text-blue-600 dark:text-blue-400", gray: "text-muted-foreground",
    green: "text-green-600 dark:text-green-400", indigo: "text-indigo-600 dark:text-indigo-400",
  };
  return (
    <Card className={borderColors[color]}>
      <CardContent className="p-2 text-center">
        <p className={`text-lg font-bold ${textColors[color]}`}>{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{emoji} {label}</p>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, color, highlight }: { label: string; value: any; color?: string; highlight?: boolean }) {
  const textColor = color === "green" ? "text-green-600 dark:text-green-400" : color === "blue" ? "text-blue-600 dark:text-blue-400" : color === "red" ? "text-red-600 dark:text-red-400" : "";
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${textColor} ${highlight ? "text-amber-600 dark:text-amber-400" : ""}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
    </div>
  );
}

function FunnelStep({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`${color} rounded-lg px-3 py-2 text-center min-w-[80px]`}>
      <p className="font-bold text-sm">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
