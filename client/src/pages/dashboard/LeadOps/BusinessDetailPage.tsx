/**
 * MI-08: Full-screen Business Detail Page
 * Route: /dashboard/lead-ops/business/:id
 *
 * Replaces the cramped slide-over with a proper 2-column layout.
 * Left column: Provenance, Operating Status, Evidence & Enrichment, Duplicate Check, Staging
 * Right column: Qualification, Next Provider Plan, Email Status, Safe Next Action, Field Activity
 */
import { PageTitle } from "@/components/ui/page-header";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  X, Link2, Shield, TrendingUp, Mail, Users, Zap, ArrowRight,
  Navigation, Database, AlertTriangle, CheckCircle, Clock,
  XCircle, ChevronLeft, ExternalLink, Play, RefreshCw,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

// ─── Types (mirror BusinessDetailPanel) ───────────────────────────────────────

interface SourceLink {
  id: string; source_system: string; source_type: string; stable_key: string;
  registry_id: string | null; first_seen_at: string; last_confirmed_at: string;
  last_import_status: string | null; last_import_completed_at: string | null;
  adapter_source_name: string | null; adapter_source_type: string | null;
}

interface QualificationDecision {
  id: string; disposition: string; score: number;
  reason_codes: string[] | unknown; fit_components: unknown;
  missing_field_classes: string[] | unknown; created_at: string;
  source_type: string | null; source_system: string | null;
}

interface FieldClaim {
  status: string; claimedAt: string | null;
  claimedByUserId: string | null; claimedByEmail: string | null;
}

interface MasterLead {
  id: string; status: string; fit_tier: string | null; quality_score: number | null;
  email_type: string | null; email_valid: boolean | null; suppression_reason: string | null;
  promoted_at: string | null; created_at: string; openConflictCount: number; county_fips?: string | null;
}

interface BusinessDetail {
  id: number; canonical_name: string | null; vertical: string | null;
  city: string | null; state: string | null; website_domain: string | null;
  email_discovery_status: string | null; free_enrichment_status: string | null;
  free_enrichment_attempt_count: number | null; free_enrichment_last_error_code: string | null;
  fit_tier: string | null; field_claim_status: string | null;
  record_class: string | null; status: string | null;
  main_email: string | null; main_phone: string | null;
  email_outreach_catch_all_approved_at: string | null;
  email_outreach_approved_by: string | null;
}

interface BusinessDetailResponse {
  business: BusinessDetail;
  processorSignals: Array<{ id: number; signal_type: string; vendor_name: string; confidence_score: number; detected_at: string | null }>;
  emailDiscoveryStatus: string | null;
  emailValidationUpdatedAt: string | null;
  isStale: boolean;
  winnerSelection: { source: string; confidence: number; masked_value: string | null } | null;
  pendingIntent: { state: string; approval_required: boolean; attempt_count: number } | null;
  sourceLinks: SourceLink[];
  qualificationDecision: QualificationDecision | null;
  fieldClaim: FieldClaim | null;
  masterLead: MasterLead | null;
  safeNextAction: string;
  contactMatchAvailable?: boolean;
  existingContactMatch?: { id: number; emailStatus: string | null; lifecycleState: string | null } | null;
  conflictCount: number;
  conflictEvidenceAvailable: boolean;
  sourceObservations: Array<{
    id: string; observed_at: string; observed_by_actor_type: string; provenance: unknown;
    payload_hash: string; source_observed_at: string; timestamp_provenance: string;
    source_event_key: string; source_system: string; subject_type: string; subject_key: string;
  }>;
}

interface RoutingPreview {
  routePlan: {
    providers: string[];
    stopReasons: string[];
    recipes: Array<{ provider: string; operation: string; requiresPaidEligibility: boolean }>;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SAFE_ACTION_LABELS: Record<string, { label: string; actionLabel?: string; actionable: boolean }> = {
  ready_to_promote:                           { label: "Ready to promote",                           actionable: false },
  resolve_conflicts_before_promotion:         { label: "Resolve conflicts first",                    actionable: false },
  resolve_duplicate_contact_before_promotion: { label: "Resolve duplicate contact before promotion", actionable: false },
  staged_awaiting_review:                     { label: "Staged — verify conflicts in detail view",   actionable: false },
  run_email_discovery:                        { label: "Run email discovery",   actionLabel: "Run Discovery",    actionable: true },
  approve_catch_all_for_outreach:             { label: "Approve catch-all for outreach", actionLabel: "Approve Catch-All", actionable: true },
  run_free_enrichment:                        { label: "Run free enrichment",   actionLabel: "Run Enrichment",   actionable: true },
  already_promoted:                           { label: "Already promoted",                           actionable: false },
  suppressed_no_action:                       { label: "Suppressed — no action",                     actionable: false },
  monitor:                                    { label: "Monitor",                                    actionable: false },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, title }: { icon: React.ComponentType<any>; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground pb-2 border-b mb-3">
      <Icon className="h-4 w-4" aria-hidden />
      {title}
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 border-b border-muted/30 last:border-0 text-sm">
      <span className="text-muted-foreground shrink-0 min-w-[120px]">{label}</span>
      <span className={`text-right min-w-0 truncate font-medium ${mono ? "font-mono text-xs" : ""}`}>
        {value ?? <span className="text-muted-foreground font-normal">—</span>}
      </span>
    </div>
  );
}

function emailStatusBadge(s: string | null) {
  if (!s) return <Badge variant="outline" className="bg-gray-100 text-gray-600">None</Badge>;
  const cls =
    s === "provider_valid"     ? "bg-green-100 text-green-800" :
    s === "provider_catch_all" ? "bg-amber-100 text-amber-800" :
    s === "provider_invalid"   ? "bg-red-100 text-red-800" :
    s === "discovered"         ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-600";
  return <Badge variant="outline" className={cls}>{s.replace(/_/g, " ")}</Badge>;
}

function dispositionBadge(d: string | null) {
  if (!d) return null;
  const cls =
    d === "selected" ? "bg-green-100 text-green-800" :
    d === "review"   ? "bg-amber-100 text-amber-800" :
    d === "terminal" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-600";
  return <Badge variant="outline" className={cls}>{d}</Badge>;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function BusinessDetailPage() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const businessId = Number(params.id);

  const detailQuery = useQuery<BusinessDetailResponse>({
    queryKey: [`/api/lead-ops/businesses/${businessId}`],
    queryFn: async () => {
      const r = await fetch(`/api/lead-ops/businesses/${businessId}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: !!businessId,
  });

  const routingQuery = useQuery<RoutingPreview>({
    queryKey: [`/api/lead-ops/businesses/${businessId}/routing-preview`],
    queryFn: async () => {
      const r = await fetch(`/api/lead-ops/businesses/${businessId}/routing-preview`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: !!businessId,
  });

  const enrichMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/lead-ops/businesses/${businessId}/enrich-free`),
    onSuccess: () => {
      toast({ title: "Generic free enrichment requested", description: "The request was accepted for the shared free-enrichment queue. It does not run the specific provider operations listed in the plan, and acceptance is not completion." });
      queryClient.invalidateQueries({ queryKey: [`/api/lead-ops/businesses/${businessId}`] });
    },
    onError: (e: any) => {
      toast({ variant: "destructive", title: "Enrichment failed", description: e.message });
    },
  });

  const catchAllMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/lead-ops/businesses/${businessId}/approve-catch-all`),
    onSuccess: () => {
      toast({ title: "Catch-all email approved", description: "This records an approval only. It does not dispatch anything; sending still needs every send check and the outbound pause applies." });
      queryClient.invalidateQueries({ queryKey: [`/api/lead-ops/businesses/${businessId}`] });
    },
    onError: (e: any) => {
      toast({ variant: "destructive", title: "Approval failed", description: e.message });
    },
  });

  const handleSafeAction = (action: string) => {
    if (action === "run_email_discovery" || action === "run_free_enrichment") {
      enrichMutation.mutate();
    } else if (action === "approve_catch_all_for_outreach") {
      catchAllMutation.mutate();
    }
  };

  const d = detailQuery.data;
  const b = d?.business;
  const isLoading = detailQuery.isLoading;

  const websiteHref = b?.website_domain
    ? b.website_domain.startsWith("http") ? b.website_domain : `https://${b.website_domain}`
    : null;

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <div className="sticky top-0 z-20 bg-background border-b px-4 md:px-6 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={() => {
            // Return to the list the user came from, with its filters; fall back to the inventory.
            if (window.history.length > 1) window.history.back();
            else navigate("/dashboard/lead-ops?tab=businesses");
          }}
          aria-label="Back to the previous list"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>

        <div className="h-4 w-px bg-border" />

        <div className="flex-1 min-w-0">
          {isLoading ? (
            <Skeleton className="h-6 w-48" />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <PageTitle className="text-base font-semibold truncate">{b?.canonical_name ?? `Business #${businessId}`}</PageTitle>
              {b?.vertical && (
                <Badge variant="outline" className="text-[11px] shrink-0">{b.vertical}</Badge>
              )}
              {b?.fit_tier && (
                <Badge variant="outline" className={`text-[11px] font-bold shrink-0 ${
                  b.fit_tier === "A" ? "bg-emerald-100 text-emerald-800" :
                  b.fit_tier === "B" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-700"
                }`}>Tier {b.fit_tier}</Badge>
              )}
            </div>
          )}
        </div>

        {websiteHref && (
          <a
            href={websiteHref}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 shrink-0"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {b?.website_domain}
          </a>
        )}

        {/* Safe Action button in header for quick access */}
        {d && SAFE_ACTION_LABELS[d.safeNextAction]?.actionable && (
          <Button
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={() => handleSafeAction(d.safeNextAction)}
            disabled={enrichMutation.isPending || catchAllMutation.isPending}
          >
            <Play className="h-3.5 w-3.5" />
            {SAFE_ACTION_LABELS[d.safeNextAction]?.actionLabel ?? d.safeNextAction}
          </Button>
        )}
      </div>

      {/* Body */}
      <div className="p-4 md:p-6 max-w-7xl mx-auto">
        {isLoading && (
          <div className="grid md:grid-cols-2 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-xl" />
            ))}
          </div>
        )}

        {detailQuery.isError && (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-destructive">
            <XCircle className="h-8 w-8" />
            <p className="font-medium">Failed to load business detail</p>
            <p className="text-sm text-muted-foreground">{(detailQuery.error as Error)?.message}</p>
          </div>
        )}

        {b && d && (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]" data-testid="business-detail-layout">
            <div className="grid min-w-0 gap-6 md:grid-cols-2 xl:grid-cols-1" data-testid="business-detail-main">
            {/* 1. Provenance */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Link2} title="1 · Provenance" />
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {d.sourceLinks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No source links found</p>
                ) : (
                  <div className="space-y-3">
                    {d.sourceLinks.map((sl, i) => (
                      <div key={i} className="rounded-lg border bg-muted/20 p-3 text-sm space-y-1">
                        <Row label="Source system" value={<span className="font-mono">{sl.source_system}</span>} />
                        <Row label="Source type" value={sl.adapter_source_type ?? sl.source_type} />
                        <Row label="Stable key" value={<span className="font-mono text-xs break-all">{sl.stable_key}</span>} />
                        {sl.registry_id && <Row label="Registry ID" value={<span className="font-mono text-xs">{sl.registry_id}</span>} />}
                        <Row label="Last confirmed" value={sl.last_confirmed_at ? new Date(sl.last_confirmed_at).toLocaleDateString() : null} />
                        <Row label="Import status" value={sl.last_import_status} />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 2. Operating Status */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Shield} title="2 · Operating Status" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">
                <Row label="Record class" value={b.record_class} />
                <Row label="Status" value={b.status} />
                <Row label="City / State" value={[b.city, b.state].filter(Boolean).join(", ") || null} />
                <Row label="County FIPS" value={d.masterLead?.county_fips} />
                <Row
                  label="Website"
                  value={
                    websiteHref ? (
                      <a
                        href={websiteHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-blue-600 hover:text-blue-800"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {b.website_domain}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : null
                  }
                />
                {d.sourceObservations.length > 0 && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Source Observations ({d.sourceObservations.length})
                    </div>
                    {d.sourceObservations.map((obs, i) => {
                      const p = obs.provenance as Record<string, unknown> | null;
                      const meta = p?.metadata && typeof p.metadata === "object"
                        ? p.metadata as Record<string, unknown> : null;
                      const pick = (...keys: string[]): string | null => {
                        const k = keys.find((k) =>
                          (p && p[k] != null) || (meta && meta[k] != null)
                        );
                        return k ? String(p?.[k] ?? meta?.[k]) : null;
                      };
                      return (
                        <div key={i} className="rounded border bg-muted/10 px-3 py-2 text-xs space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-green-50 text-green-700 border-green-200">
                              {obs.source_system}
                            </Badge>
                            <span className="text-muted-foreground">{obs.subject_type}</span>
                          </div>
                          <Row label="Observed" value={new Date(obs.source_observed_at).toLocaleDateString()} />
                          <Row label="Entity status" value={pick("entityStatus", "entity_status", "status")} />
                          <Row label="Actor" value={obs.observed_by_actor_type} />
                        </div>
                      );
                    })}
                  </div>
                )}
                {d.sourceObservations.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-2">No source observations indexed yet</p>
                )}
              </CardContent>
            </Card>

            {/* 4. Evidence & Enrichment */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Database} title="4 · Evidence & Enrichment" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">
                <Row label="Free enrich status" value={b.free_enrichment_status} />
                <Row label="Attempts" value={b.free_enrichment_attempt_count} />
                {b.free_enrichment_last_error_code && (
                  <Row label="Last error" value={<span className="text-red-600">{b.free_enrichment_last_error_code}</span>} />
                )}
                <Row label="Processor signals" value={d.processorSignals.length} />
                <Row label="Email (masked)" value={d.winnerSelection?.masked_value} />
                <Row label="Main phone" value={b.main_phone} />
                {d.processorSignals.length > 0 && (
                  <div className="mt-3 pt-3 border-t space-y-1">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Processor Signals</div>
                    {d.processorSignals.map((s, i) => (
                      <div key={i} className="flex items-center justify-between text-xs border-b border-muted/30 py-1.5 last:border-0">
                        <span className="font-medium">{s.vendor_name}</span>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px] px-1.5 h-4">{s.signal_type}</Badge>
                          <span className="text-muted-foreground">{Math.round(s.confidence_score * 100)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 5. Next Provider Plan — actionable */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Zap} title="5 · Next Provider Plan" />
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {routingQuery.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : routingQuery.isError ? (
                  <p className="text-sm text-red-500">Could not load routing plan</p>
                ) : routingQuery.data?.routePlan.recipes.length === 0 ? (
                  <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-3 text-sm text-green-800">
                    <div className="font-medium">No provider required</div>
                    <p className="text-xs mt-1 text-green-700">
                      Existing evidence is sufficient.{" "}
                      {routingQuery.data.routePlan.stopReasons.join(", ")}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {routingQuery.data?.routePlan.recipes.map((r, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 rounded-lg border bg-muted/10 px-3 py-2.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <ArrowRight className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium capitalize">{r.provider}</div>
                            <div className="text-xs text-muted-foreground">{r.operation.replace(/_/g, " ")}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {r.requiresPaidEligibility && (
                            <Badge variant="outline" className="text-[10px] px-1.5 h-5 text-amber-600 border-amber-300">
                              paid
                            </Badge>
                          )}
                          {!r.requiresPaidEligibility && (
                            <Badge variant="outline" className="text-[10px] px-1.5 h-5">diagnostic only</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                    <div className="pt-2">
                      <p className="mb-2 text-xs text-muted-foreground">
                        The rows above describe the planned provider operations and are read-only. The button below requests the
                        shared generic free-enrichment queue for this business; it does not run a listed operation or any paid provider.
                      </p>
                      <Button size="sm" variant="outline" className="h-8 text-xs gap-1"
                        onClick={() => enrichMutation.mutate()} disabled={enrichMutation.isPending}
                        data-testid="button-generic-free-enrichment">
                        <Play className="h-3 w-3" />
                        Request generic free enrichment
                      </Button>
                    </div>
                    {(routingQuery.data?.routePlan.stopReasons?.length ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground pt-1">
                        Stop reason: {routingQuery.data?.routePlan.stopReasons.join(", ")}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 7. Duplicate Check */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Users} title="7 · Duplicate Check" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                {d.contactMatchAvailable === false ? (
                  <div className="flex items-center gap-2 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Contact duplicate check unavailable
                  </div>
                ) : d.existingContactMatch ? (
                  <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <div className="font-medium">Potential contact candidate · not a verified link</div>
                    <div className="text-xs mt-1 space-y-0.5">
                      <div>Contact #{d.existingContactMatch.id}</div>
                      {d.existingContactMatch.emailStatus && <div>Email: {d.existingContactMatch.emailStatus}</div>}
                      {d.existingContactMatch.lifecycleState && <div>Lifecycle: {d.existingContactMatch.lifecycleState}</div>}
                      <div className="pt-1">
                        Match evidence and an authoritative identity-review decision are not included in this response.
                        Do not treat this suggestion or a contact business ID as a verified association.
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 text-xs gap-1"
                      onClick={() => navigate(`/dashboard/contacts/${d.existingContactMatch!.id}`)}
                    >
                      Inspect Candidate <ArrowRight className="h-3 w-3" />
                    </Button>
                  </div>
                ) : d.contactMatchAvailable === true ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground rounded bg-muted/40 border px-3 py-2">
                    No potential contact candidate was returned. This is not a verified-link determination.
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Contact candidate and verification status unavailable
                  </div>
                )}

                {d.conflictEvidenceAvailable === false ? (
                  <div className="flex items-center gap-2 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Conflict evidence check unavailable
                  </div>
                ) : (d.conflictCount ?? 0) > 0 ? (
                  <div className="flex items-center gap-2 text-sm text-red-700 rounded bg-red-50 border border-red-200 px-3 py-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {d.conflictCount ?? d.masterLead?.openConflictCount} open conflict{(d.conflictCount ?? 1) > 1 ? "s" : ""} — resolve before promotion
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-green-700 rounded bg-green-50 border border-green-200 px-3 py-2">
                    <CheckCircle className="h-4 w-4 shrink-0" /> No open conflicts
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 10. Staging State */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Database} title="10 · Staging State" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">
                {d.masterLead ? (
                  <>
                    <Row label="Status" value={d.masterLead.status} />
                    <Row label="Fit tier" value={d.masterLead.fit_tier} />
                    <Row label="Quality score" value={d.masterLead.quality_score} />
                    <Row label="Email type" value={d.masterLead.email_type} />
                    <Row label="Email valid" value={d.masterLead.email_valid == null ? null : d.masterLead.email_valid ? "Yes" : "No"} />
                    <Row label="Suppression reason" value={d.masterLead.suppression_reason} />
                    {d.masterLead.promoted_at && (
                      <Row label="Promoted at" value={new Date(d.masterLead.promoted_at).toLocaleString()} />
                    )}
                    <Row label="Staged" value={new Date(d.masterLead.created_at).toLocaleDateString()} />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Not in master leads staging pipeline</p>
                )}
              </CardContent>
            </Card>

            </div>
            <aside className="grid min-w-0 content-start gap-6 md:grid-cols-2 xl:grid-cols-1" aria-label="Record actions and status" data-testid="business-detail-rail">
            {/* 8. Safe Next Action — actionable */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={ArrowRight} title="8 · Safe Next Action" />
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {(() => {
                  const action = SAFE_ACTION_LABELS[d.safeNextAction];
                  const label = action?.label ?? d.safeNextAction;
                  const isActionable = action?.actionable ?? false;
                  const actionLabel = action?.actionLabel ?? "Run";

                  const borderColor =
                    d.safeNextAction === "ready_to_promote" ? "border-green-200 bg-green-50" :
                    d.safeNextAction === "already_promoted" ? "border-green-200 bg-green-50" :
                    d.safeNextAction === "suppressed_no_action" ? "border-gray-200 bg-gray-50" :
                    isActionable ? "border-blue-200 bg-blue-50" : "border-amber-200 bg-amber-50";

                  const textColor =
                    d.safeNextAction === "ready_to_promote" ? "text-green-800" :
                    d.safeNextAction === "already_promoted" ? "text-green-800" :
                    d.safeNextAction === "suppressed_no_action" ? "text-gray-600" :
                    isActionable ? "text-blue-800" : "text-amber-800";

                  return (
                    <div className={`rounded-lg border px-4 py-3 ${borderColor}`}>
                      <div className={`font-semibold text-sm ${textColor}`}>{label}</div>
                      {isActionable && (
                        <Button
                          className="mt-3 gap-1.5"
                          size="sm"
                          onClick={() => handleSafeAction(d.safeNextAction)}
                          disabled={enrichMutation.isPending || catchAllMutation.isPending}
                        >
                          {enrichMutation.isPending || catchAllMutation.isPending
                            ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            : <Play className="h-3.5 w-3.5" />
                          }
                          {actionLabel}
                        </Button>
                      )}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* 3. Qualification */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={TrendingUp} title="3 · Qualification" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">
                {d.qualificationDecision ? (
                  <>
                    <Row label="Disposition" value={dispositionBadge(d.qualificationDecision.disposition)} />
                    <Row label="Score" value={d.qualificationDecision.score} />
                    <Row label="Reason codes" value={
                      Array.isArray(d.qualificationDecision.reason_codes)
                        ? (d.qualificationDecision.reason_codes as string[]).join(", ") || "—"
                        : "—"
                    } />
                    <Row label="Missing fields" value={
                      Array.isArray(d.qualificationDecision.missing_field_classes)
                        ? (d.qualificationDecision.missing_field_classes as string[]).join(", ") || "None"
                        : "—"
                    } />
                    <Row label="Decided" value={new Date(d.qualificationDecision.created_at).toLocaleDateString()} />
                  </>
                ) : (
                  <>
                    <Row label="Fit tier" value={d.masterLead?.fit_tier} />
                    <Row label="Quality score" value={d.masterLead?.quality_score} />
                    <p className="text-xs text-muted-foreground mt-2">No formal qualification decision found</p>
                  </>
                )}
              </CardContent>
            </Card>

            {/* 6. Email Status */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Mail} title="6 · Email Status" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">
                <Row label="Discovery status" value={emailStatusBadge(d.emailDiscoveryStatus)} />
                <Row label="Validation updated" value={
                  d.emailValidationUpdatedAt
                    ? new Date(d.emailValidationUpdatedAt).toLocaleDateString()
                    : null
                } />
                {b.email_outreach_catch_all_approved_at && (
                  <Row label="Catch-all approved" value={new Date(b.email_outreach_catch_all_approved_at).toLocaleDateString()} />
                )}
                {d.isStale && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-3 py-2">
                    <Clock className="h-3.5 w-3.5 shrink-0" /> Validation is stale (&gt;180 days)
                  </div>
                )}
                {d.pendingIntent && (
                  <div className="mt-2 rounded border bg-muted/10 px-3 py-2 text-xs space-y-0.5">
                    <Row label="Pending intent" value={d.pendingIntent.state} />
                    <Row label="Approval required" value={d.pendingIntent.approval_required ? "Yes" : "No"} />
                    <Row label="Attempts" value={d.pendingIntent.attempt_count} />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 9. Field Activity */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <SectionHeader icon={Navigation} title="9 · Field Activity" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">
                {d.fieldClaim ? (
                  <>
                    <div className="flex items-center gap-2 text-sm text-amber-700 rounded bg-amber-50 border border-amber-200 px-3 py-2 mb-3">
                      <Navigation className="h-3.5 w-3.5 shrink-0" /> Active field claim
                    </div>
                    <Row label="Claimed at" value={d.fieldClaim.claimedAt ? new Date(d.fieldClaim.claimedAt).toLocaleString() : null} />
                    {d.fieldClaim.claimedByEmail && (
                      <Row label="Claimed by" value={d.fieldClaim.claimedByEmail} />
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      Promotion eligibility is enforced server-side regardless of field claim status.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No active field claim</p>
                )}
              </CardContent>
            </Card>

            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
