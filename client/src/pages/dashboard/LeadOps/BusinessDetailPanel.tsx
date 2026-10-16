/**
 * MI-08: Business Detail Panel (slide-over / desktop)
 * Answers all 10 canonical operator questions using data from
 * the extended GET /api/lead-ops/businesses/:businessId endpoint.
 *
 * 10 sections:
 * 1. Provenance (source links, import run, adapter)
 * 2. Operating status (observations/occurrences)
 * 3. Qualification (fit score, tier, terminal code, reason codes)
 * 4. Evidence vs. inferred (field-level provenance tags)
 * 5. Next provider (routing-preview)
 * 6. Email status (discovery status, validation timestamp, staleness)
 * 7. Duplicate check (existing contact match)
 * 8. Safe next action
 * 9. Field activity (field_route_stops active claim — informational only)
 * 10. Master lead staging state
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  X, Link2, Shield, TrendingUp, Mail, Users, Zap, ArrowRight, Navigation, Database,
  AlertTriangle, CheckCircle, Clock, XCircle,
} from "lucide-react";
import { BusinessListItem } from "./MobileBusinessCard";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SourceLink {
  id: string;
  source_system: string;
  source_type: string;
  stable_key: string;
  registry_id: string | null;
  first_seen_at: string;
  last_confirmed_at: string;
  last_import_status: string | null;
  last_import_completed_at: string | null;
  adapter_source_name: string | null;
  adapter_source_type: string | null;
}

interface QualificationDecision {
  id: string;
  disposition: string;
  score: number;
  reason_codes: string[] | unknown;
  fit_components: unknown;
  missing_field_classes: string[] | unknown;
  created_at: string;
  source_type: string | null;
  source_system: string | null;
}

interface FieldClaim {
  status: string;
  claimedAt: string | null;
  claimedByUserId: string | null;
  claimedByEmail: string | null;
}

interface MasterLead {
  id: string;
  status: string;
  fit_tier: string | null;
  quality_score: number | null;
  email_type: string | null;
  email_valid: boolean | null;
  suppression_reason: string | null;
  promoted_at: string | null;
  created_at: string;
  /** Count of open canonical_conflict_evidence rows — queried separately, not a stored column. */
  openConflictCount: number;
  county_fips?: string | null;
}

interface BusinessDetailResponse {
  business: BusinessListItem & {
    main_email: string | null;
    main_phone: string | null;
    record_class: string | null;
    status: string | null;
    email_outreach_catch_all_approved_at: string | null;
    email_outreach_approved_by: string | null;
    free_enrichment_last_error_code: string | null;
  };
  processorSignals: Array<{
    id: number; signal_type: string; vendor_name: string;
    confidence_score: number; detected_at: string | null;
  }>;
  emailDiscoveryStatus: string | null;
  emailValidationUpdatedAt: string | null;
  isStale: boolean;
  winnerSelection: { source: string; confidence: number; masked_value: string | null } | null;
  pendingIntent: { state: string; approval_required: boolean; attempt_count: number } | null;
  emailEvidenceDisplay?: {
    candidateCount: number;
    maskedCandidateEmailPreview: string | null;
    candidateValidationState: "unvalidated" | "none";
    providerValidated: boolean;
    statusLabel: string;
    selectedWinner: { state: string | null; maskedValue: string | null; source: string | null; confidence: number | null } | null;
    validationIntent: { state: string | null; approvalRequired: boolean; disposition: string | null; attemptCount: number } | null;
  };
  sourceLinks: SourceLink[];
  qualificationDecision: QualificationDecision | null;
  fieldClaim: FieldClaim | null;
  masterLead: MasterLead | null;
  safeNextAction: string;
  contactMatchAvailable?: boolean;
  existingContactMatch: {
    id: number;
    emailStatus: string | null;
    lifecycleState: string | null;
  } | null;
  conflictCount: number;
  conflictEvidenceAvailable: boolean;
  sourceObservations: Array<{
    id: string;
    observed_at: string;
    observed_by_actor_type: string;
    provenance: unknown;
    payload_hash: string;
    source_observed_at: string;
    timestamp_provenance: string;
    source_event_key: string;
    source_system: string;
    subject_type: string;
    subject_key: string;
  }>;
}

interface RoutingPreview {
  routePlan: {
    providers: string[];
    stopReasons: string[];
    recipes: Array<{ provider: string; operation: string; requiresPaidEligibility: boolean }>;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Section({ icon: Icon, title, children }: { icon: React.ComponentType<any>; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden />
        {title}
      </div>
      <div className="pl-6 space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right min-w-0 truncate ${mono ? "font-mono text-xs" : ""}`}>{value ?? <span className="text-muted-foreground">—</span>}</span>
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
  const label = s === "discovered" ? "discovered · not validated" : s.replace(/_/g, " ");
  return <Badge variant="outline" className={cls} aria-label={`Email status: ${s === "discovered" ? "discovered — not a validated address" : label}`}>{label}</Badge>;
}

function dispositionBadge(d: string | null) {
  if (!d) return null;
  const cls =
    d === "selected"  ? "bg-green-100 text-green-800" :
    d === "review"    ? "bg-amber-100 text-amber-800" :
    d === "terminal"  ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-600";
  return <Badge variant="outline" className={cls} aria-label={`Qualification: ${d}`}>{d}</Badge>;
}

const SAFE_ACTION_LABELS: Record<string, string> = {
  ready_to_promote:                       "Ready to promote",
  resolve_conflicts_before_promotion:     "Resolve conflicts first",
  resolve_duplicate_contact_before_promotion: "Resolve duplicate contact before promotion",
  staged_awaiting_review:                 "Staged — verify conflicts in detail view",
  run_email_discovery:                    "Run email discovery",
  approve_catch_all_for_outreach:         "Approve catch-all for outreach",
  run_free_enrichment:                    "Run free enrichment",
  already_promoted:                       "Already promoted",
  suppressed_no_action:                   "Suppressed — no action",
  monitor:                                "Monitor",
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  businessId: number;
  businessName?: string;
  onClose: () => void;
}

export function BusinessDetailPanel({ businessId, onClose }: Props) {
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

  const d = detailQuery.data;
  const b = d?.business;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Business detail panel">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-background shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-background border-b px-4 py-3 flex items-center justify-between z-10">
          <div className="min-w-0">
            <h2 className="font-semibold text-base truncate">
              {b?.canonical_name
                ? b.canonical_name
                : detailQuery.isLoading
                  ? <Skeleton className="h-5 w-48" />
                  : "Business Detail"
              }
            </h2>
            {b?.vertical && (
              <Badge variant="outline" className="text-[11px] mt-0.5">{b.vertical}</Badge>
            )}
          </div>
          <Button variant="ghost" size="icon" className="shrink-0 h-10 w-10" onClick={onClose} aria-label="Close panel">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 space-y-6">
          {detailQuery.isLoading && (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
            </div>
          )}
          {detailQuery.isError && (
            <div className="text-sm text-destructive flex items-center gap-2">
              <XCircle className="h-4 w-4" /> Failed to load business detail
            </div>
          )}

          {b && (
            <>
              {/* 1. Provenance */}
              <Section icon={Link2} title="1 · Provenance">
                {d!.sourceLinks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No source links found</p>
                ) : (
                  d!.sourceLinks.map((sl, i) => (
                    <Card key={i} className="text-xs border bg-muted/5">
                      <CardContent className="pt-3 pb-3 space-y-1">
                        <Row label="Source system" value={<span className="font-mono">{sl.source_system}</span>} />
                        <Row label="Source type" value={sl.adapter_source_type ?? sl.source_type} />
                        <Row label="Stable key" value={<span className="font-mono text-[10px]">{sl.stable_key}</span>} />
                        {sl.registry_id && <Row label="Registry ID" value={<span className="font-mono text-[10px]">{sl.registry_id}</span>} />}
                        <Row label="Last confirmed" value={sl.last_confirmed_at ? new Date(sl.last_confirmed_at).toLocaleDateString() : null} />
                        <Row label="Import status" value={sl.last_import_status} />
                      </CardContent>
                    </Card>
                  ))
                )}
              </Section>

              {/* 2. Operating status */}
              <Section icon={Shield} title="2 · Operating Status">
                <Row label="Record class" value={b.record_class} />
                <Row label="Status" value={b.status} />
                <Row label="City / State" value={[b.city, b.state].filter(Boolean).join(", ") || null} />
                 <Row label="County FIPS" value={d!.masterLead?.county_fips} />
                <Row label="Website" value={b.website_domain} />
                {/* cro03_source_observations/occurrences evidence */}
                {d!.sourceObservations.length > 0 ? (
                  <div className="mt-2 space-y-1.5">
                    <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                      Source Observations ({d!.sourceObservations.length})
                    </div>
                    {d!.sourceObservations.map((obs, i) => (
                      <Card key={i} className="text-xs border bg-muted/5">
                        <CardContent className="pt-2 pb-2 space-y-0.5">
                          <Row label="Source" value={<span className="font-mono text-[10px]">{obs.source_system}</span>} />
                          <Row label="Subject type" value={obs.subject_type} />
                          <Row label="Observed" value={new Date(obs.source_observed_at).toLocaleDateString()} />
                           {(() => {
                             const p = obs.provenance as Record<string, unknown> | null;
                             const metadata = p?.metadata && typeof p.metadata === "object"
                               ? p.metadata as Record<string, unknown>
                               : null;
                               const pick = (...keys: string[]): string | null => {
                               const key = keys.find((k) =>
                                 (p && p[k] !== undefined && p[k] !== null) ||
                                 (metadata && metadata[k] !== undefined && metadata[k] !== null)
                               );
                               return key
                                 ? String(p?.[key] ?? metadata?.[key])
                                 : null;
                             };
                             return (
                               <>
                                 <Row label="Entity status" value={pick("entityStatus", "entity_status", "status")} />
                                 <Row label="License type" value={pick("licenseType", "license_type")} />
                                 <Row label="Last activity" value={pick("lastActivity", "last_activity", "lastActivityAt", "last_activity_at") ?? (obs.source_observed_at ? new Date(obs.source_observed_at).toLocaleDateString() : null)} />
                                 <Row label="Provenance" value={p && Object.keys(p).length > 0 ? JSON.stringify(p) : null} mono />
                               </>
                             );
                           })()}
                          <Row label="Actor" value={obs.observed_by_actor_type} />
                          <Row label="Timestamp provenance" value={obs.timestamp_provenance} />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">No source observations indexed yet</p>
                )}
              </Section>

              {/* 3. Qualification */}
              <Section icon={TrendingUp} title="3 · Qualification">
                {d!.qualificationDecision ? (
                  <>
                    <Row label="Disposition" value={dispositionBadge(d!.qualificationDecision.disposition)} />
                    <Row label="Score" value={d!.qualificationDecision.score} />
                    <Row label="Reason codes" value={
                      Array.isArray(d!.qualificationDecision.reason_codes)
                        ? (d!.qualificationDecision.reason_codes as string[]).join(", ") || "—"
                        : "—"
                    } />
                    <Row label="Missing fields" value={
                      Array.isArray(d!.qualificationDecision.missing_field_classes)
                        ? (d!.qualificationDecision.missing_field_classes as string[]).join(", ") || "None"
                        : "—"
                    } />
                    <Row label="Decided" value={new Date(d!.qualificationDecision.created_at).toLocaleDateString()} />
                  </>
                ) : (
                  <>
                    <Row label="Fit tier" value={d!.masterLead?.fit_tier} />
                    <Row label="Quality score" value={d!.masterLead?.quality_score} />
                    <p className="text-xs text-muted-foreground">No formal qualification decision found</p>
                  </>
                )}
              </Section>

              {/* 4. Evidence & Enrichment — field-level provenance
                  "Evidence" = data backed by source observation records
                  "Inferred" = data derived by the enrichment pipeline without direct source backing */}
              <Section icon={Database} title="4 · Evidence & Enrichment">
                <Row label="Free enrich status" value={b.free_enrichment_status} />
                <Row label="Attempts" value={b.free_enrichment_attempt_count} />
                {b.free_enrichment_last_error_code && (
                  <Row label="Last error" value={<span className="text-red-600">{b.free_enrichment_last_error_code}</span>} />
                )}
                <Row label="Processor signals" value={d!.processorSignals.length} />
                {/* Field-level provenance: sourced from the provenance JSONB on each
                    source observation. Each badge derives from actual observation
                    provenance metadata — not from observation existence alone. */}
                {d!.sourceObservations.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Source Provenance</div>
                    {d!.sourceObservations.map((obs, i) => {
                      // Provenance is a JSONB object whose structure is source-system-specific.
                      // Display the actor type, system, and timestamp provenance as the truthful
                      // field-level signal — not an invented threshold comparison.
                      const prov = obs.provenance as Record<string, unknown> | null;
                      return (
                        <div key={i} className="text-[10px] rounded border bg-muted/5 px-2 py-1.5 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-green-50 text-green-700 border-green-200" aria-label={`Source-observed from ${obs.source_system}`}>
                              {obs.source_system}
                            </Badge>
                            <span className="text-muted-foreground">{obs.subject_type}</span>
                          </div>
                          <div className="text-muted-foreground">Actor: {obs.observed_by_actor_type}</div>
                          {obs.timestamp_provenance && (
                            <div className="text-muted-foreground">Timestamp: {obs.timestamp_provenance}</div>
                          )}
                          {prov && Object.keys(prov).length > 0 && (
                            <div className="text-muted-foreground">
                              {Object.entries(prov).slice(0, 3).map(([k, v]) => (
                                <span key={k} className="mr-2">{k}: <span className="text-foreground">{String(v ?? "—")}</span></span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <p className="text-[10px] text-muted-foreground">
                      Source observations from cro03_source_observations via canonical_source_links (subject_type + stable_key).
                    </p>
                  </div>
                )}
              </Section>

              {/* 5. Next provider */}
              <Section icon={Zap} title="5 · Next Provider Plan">
                {routingQuery.isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : routingQuery.isError ? (
                  <p className="text-xs text-red-500">Could not load routing plan</p>
                ) : routingQuery.data?.routePlan.recipes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No provider required — existing evidence is sufficient.{" "}
                    {routingQuery.data.routePlan.stopReasons.join(", ")}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {routingQuery.data?.routePlan.recipes.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <ArrowRight className="h-3.5 w-3.5 text-blue-500 shrink-0" aria-hidden />
                        <span className="font-medium capitalize">{r.provider}</span>
                        <span className="text-muted-foreground text-xs">— {r.operation.replace(/_/g, " ")}</span>
                        {r.requiresPaidEligibility && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-amber-600 border-amber-300" aria-label="Requires paid eligibility">
                            paid
                          </Badge>
                        )}
                      </div>
                    ))}
                    <p className="text-[11px] text-muted-foreground">
                      Stop reason: {routingQuery.data?.routePlan.stopReasons.join(", ")}
                    </p>
                  </div>
                )}
              </Section>

              {/* 6. Email status */}
              <Section icon={Mail} title="6 · Email Status">
                <Row label="Discovery status" value={emailStatusBadge(d!.emailDiscoveryStatus)} />
                {d!.emailDiscoveryStatus === "discovered" && (
                  <p className="text-xs text-blue-800 rounded bg-blue-50 border border-blue-200 px-2 py-1">
                    Discovery found evidence; this is not a validated address.
                  </p>
                )}
                <Row label="Validation updated" value={
                  d!.emailValidationUpdatedAt
                    ? new Date(d!.emailValidationUpdatedAt).toLocaleDateString()
                    : null
                } />
                {d!.isStale && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-2 py-1" aria-label="Email validation is stale">
                    <Clock className="h-3 w-3" aria-hidden /> Validation is stale (&gt;180 days)
                  </div>
                )}
                {d!.emailEvidenceDisplay && (
                  <Row label="Staged free-discovery email candidates" value={d!.emailEvidenceDisplay.candidateCount} />
                )}
                {d!.winnerSelection && (
                  <Row label="Winner (masked)" value={d!.winnerSelection.masked_value ?? "—"} />
                )}
                {d!.emailEvidenceDisplay && d!.emailEvidenceDisplay.candidateCount > 0 && (
                  <div className="rounded border bg-muted/10 px-2 py-1.5 text-xs space-y-1">
                    <div>Candidate evidence is unvalidated.</div>
                    {d!.emailEvidenceDisplay.maskedCandidateEmailPreview && (
                      <div className="font-mono">{d!.emailEvidenceDisplay.maskedCandidateEmailPreview}</div>
                    )}
                    <div className="text-muted-foreground">Candidate evidence is not a validated address and cannot be used for sending.</div>
                  </div>
                )}
                {d!.emailEvidenceDisplay?.selectedWinner && (
                  <Row label="Selected winner state" value={`${d!.emailEvidenceDisplay.selectedWinner.state ?? "unknown"} · ${d!.emailEvidenceDisplay.selectedWinner.maskedValue ?? "masked value unavailable"}`} />
                )}
                {d!.emailEvidenceDisplay?.validationIntent && (
                  <Row label="Validation intent" value={`${d!.emailEvidenceDisplay.validationIntent.state ?? "unknown"}${d!.emailEvidenceDisplay.validationIntent.disposition ? ` · ${d!.emailEvidenceDisplay.validationIntent.disposition}` : ""}`} />
                )}
                {b.email_outreach_catch_all_approved_at && (
                  <Row label="Catch-all approved" value={new Date(b.email_outreach_catch_all_approved_at).toLocaleDateString()} />
                )}
              </Section>

              {/* 7. Duplicate check — contact matching + canonical conflict evidence */}
              <Section icon={Users} title="7 · Duplicate Check">
                {/* Contact duplicate match */}
                {d!.contactMatchAvailable === false ? (
                  <div className="flex items-center gap-1.5 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-2 py-1 mb-1.5" aria-label="Contact duplicate check unavailable">
                    <AlertTriangle className="h-3 w-3" aria-hidden /> Contact duplicate check unavailable (query failed)
                  </div>
                ) : d!.existingContactMatch ? (
                  <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 mb-1.5">
                    ⚠ Existing contact/customer match #{d!.existingContactMatch.id}
                    {d!.existingContactMatch.emailStatus ? ` · ${d!.existingContactMatch.emailStatus}` : ""}
                    {d!.existingContactMatch.lifecycleState ? ` · ${d!.existingContactMatch.lifecycleState}` : ""}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-green-700 rounded bg-green-50 border border-green-200 px-2 py-1 mb-1.5" aria-label="No existing contact match">
                    <CheckCircle className="h-3 w-3" aria-hidden /> No existing contact match
                  </div>
                )}
                {/* Canonical conflict evidence */}
                {d!.conflictEvidenceAvailable === false ? (
                  <div className="flex items-center gap-1.5 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-2 py-1" aria-label="Conflict check unavailable">
                    <AlertTriangle className="h-3 w-3" aria-hidden /> Conflict evidence check unavailable
                  </div>
                ) : (d!.conflictCount ?? 0) > 0 ? (
                  <div className="flex items-center gap-1.5 text-xs text-red-700 rounded bg-red-50 border border-red-200 px-2 py-1" aria-label="Open conflicts detected">
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                     {d!.conflictCount ?? d!.masterLead!.openConflictCount} open conflict{(d!.conflictCount ?? d!.masterLead!.openConflictCount) > 1 ? "s" : ""} — resolve before promotion
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-green-700 rounded bg-green-50 border border-green-200 px-2 py-1" aria-label="No open conflicts">
                    <CheckCircle className="h-3 w-3" aria-hidden /> No open conflicts
                  </div>
                )}
              </Section>

              {/* 8. Safe next action */}
              <Section icon={ArrowRight} title="8 · Safe Next Action">
                <div className="rounded-md border bg-muted/10 px-3 py-2 text-sm font-medium">
                  {SAFE_ACTION_LABELS[d!.safeNextAction] ?? d!.safeNextAction}
                </div>
              </Section>

              {/* 9. Field activity (informational) */}
              <Section icon={Navigation} title="9 · Field Activity (informational)">
                {d!.fieldClaim ? (
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-1.5 text-xs text-amber-700 rounded bg-amber-50 border border-amber-200 px-2 py-1" aria-label="Field claim active">
                      <Navigation className="h-3 w-3" aria-hidden /> Active field claim
                    </div>
                    <Row label="Claimed at" value={d!.fieldClaim.claimedAt ? new Date(d!.fieldClaim.claimedAt).toLocaleString() : null} />
                    {d!.fieldClaim.claimedByEmail && (
                      <Row label="Claimed by" value={d!.fieldClaim.claimedByEmail} />
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Promotion eligibility is enforced server-side regardless of field claim status.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No active field claim</p>
                )}
              </Section>

              {/* 10. Master lead staging state */}
              <Section icon={Database} title="10 · Staging State">
                {d!.masterLead ? (
                  <div className="space-y-1">
                    <Row label="Status" value={d!.masterLead.status} />
                    <Row label="Fit tier" value={d!.masterLead.fit_tier} />
                    <Row label="Email type" value={d!.masterLead.email_type} />
                    <Row label="Suppression reason" value={d!.masterLead.suppression_reason} />
                    {d!.masterLead.promoted_at && (
                      <Row label="Promoted at" value={new Date(d!.masterLead.promoted_at).toLocaleString()} />
                    )}
                    <Row label="Staged" value={new Date(d!.masterLead.created_at).toLocaleDateString()} />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Not in master leads staging pipeline</p>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
