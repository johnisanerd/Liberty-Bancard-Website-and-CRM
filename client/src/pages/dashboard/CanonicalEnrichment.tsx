import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Database,
  FileClock,
  FileInput,
  GitBranch,
  HeartPulse,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import type { CanonicalEnrichmentStatus } from "@shared/canonical-enrichment-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { UploadLedger } from "./UploadLedger";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ViewKey = "pipeline" | "records" | "imports" | "exceptions" | "health";

const views: { key: ViewKey; label: string; eyebrow: string }[] = [
  { key: "pipeline", label: "Pipeline", eyebrow: "At a glance" },
  { key: "records", label: "Records", eyebrow: "Evidence & identity" },
  { key: "imports", label: "Imports & Sources", eyebrow: "Source history" },
  { key: "exceptions", label: "Exceptions", eyebrow: "Needs attention" },
  { key: "health", label: "Settings & Health", eyebrow: "System context" },
];

const numberFormat = new Intl.NumberFormat("en-US");

function formatCount(value: number|null) {
  return value===null ? "Unavailable" : numberFormat.format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Timestamp unavailable"
    : new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatOptionalDate(value: string | null) {
  return value ? formatDate(value) : "Not yet observed";
}

function sumStates(states: Record<string, number>) {
  return Object.values(states).reduce((total, count) => total + count, 0);
}

function stateLabel(state: string) {
  return state.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatTile({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  note: string;
  icon: typeof Users;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/80 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
          <p className="mt-2 font-mono text-2xl font-semibold tracking-tight text-foreground">{value}</p>
        </div>
        <span className="rounded-lg bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{note}</p>
    </div>
  );
}

function NavCard({
  href,
  title,
  description,
  label,
  icon: Icon,
}: {
  href: string;
  title: string;
  description: string;
  label: string;
  icon: typeof Database;
}) {
  return (
    <Link
      href={href}
      className="group flex h-full items-start gap-4 rounded-xl border border-border/70 bg-card p-4 transition-colors hover:border-primary/40 hover:bg-primary/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="mt-0.5 rounded-lg bg-primary/10 p-2.5 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="font-semibold text-foreground">{title}</span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1 block text-sm leading-5 text-muted-foreground">{description}</span>
        <span className="mt-3 inline-flex text-xs font-semibold uppercase tracking-[0.1em] text-primary">{label}</span>
      </span>
    </Link>
  );
}

function StateList({
  title,
  total,
  states,
}: {
  title: string;
  total: number;
  states: Record<string, number>;
}) {
  const entries = Object.entries(states).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold text-foreground">{title}</h3>
        <span className="font-mono text-sm text-muted-foreground">{formatCount(total)} historical</span>
      </div>
      {entries.length ? (
        <div className="mt-4 space-y-3">
          {entries.map(([state, count]) => {
            const percent = total > 0 ? Math.min(100, (count / total) * 100) : 0;
            return (
              <div key={state}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="capitalize text-muted-foreground">{stateLabel(state)}</span>
                  <span className="font-mono text-foreground">{formatCount(count)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-muted/60 px-3 py-4 text-sm text-muted-foreground">
          No historical states are currently reported.
        </p>
      )}
    </div>
  );
}

function SectionHeading({
  kicker,
  title,
  description,
}: {
  kicker: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{kicker}</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

function CurrentSignal({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/65 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

export default function CanonicalEnrichment() {
  const [activeView, setActiveView] = useState<ViewKey>("pipeline");
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, isLoading, isError, error, refetch, isFetching } =
    useQuery<CanonicalEnrichmentStatus>({
      queryKey: ["/api/canonical-enrichment/status"],
    });

  const content = data ? (
    <>
      {activeView === "pipeline" && (
        <div className="space-y-8">
          <section>
            <SectionHeading
              kicker="Automatic progress · current signals"
              title="Preparation cursor and validation queue"
              description="These are the status service's current automatic-progress observations. Preparation values are cumulative pass transitions, not distinct recipients; validation figures describe pending intents linked to persisted preparation, not a fresh eligibility decision."
            />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <CurrentSignal
                label="Preparation observation"
                value={data.automaticProgress.preparation.observed ? "Observed" : "Not yet observed"}
                detail={data.automaticProgress.preparation.observed
                  ? "A preparation cursor record was present in this status read."
                  : "No preparation cursor record was present. This is not evidence of success or failure."}
              />
              <CurrentSignal
                label="Cursor · last cycle"
                value={data.automaticProgress.preparation.lastCycleAt
                  ? formatDate(data.automaticProgress.preparation.lastCycleAt)
                  : "Not yet observed"}
                detail={`Cycle ${formatCount(data.automaticProgress.preparation.cycles)} · after contact ID ${formatCount(data.automaticProgress.preparation.afterContactId)}`}
              />
              <CurrentSignal
                label="Preparation counters"
                value={`${formatCount(data.automaticProgress.preparation.scanned)} scanned`}
                detail={`${formatCount(data.automaticProgress.preparation.prepared)} prepared · ${formatCount(data.automaticProgress.preparation.held)} held. Cumulative pass transitions, not unique recipients.`}
              />
              <CurrentSignal
                label="Preparation-linked validation queue"
                value={data.automaticProgress.validation.available ? `${formatCount(data.automaticProgress.validation.pending)} pending` : "Unavailable"}
                detail={data.automaticProgress.validation.available ? `${formatCount(data.automaticProgress.validation.processing)} processing · oldest pending ${formatOptionalDate(data.automaticProgress.validation.oldestPendingAt)}` : "Programme preparation fields are not installed. Missing queue observations are not zero work."}
              />
            </div>
            {data.automaticProgress.preparation.priority ? (
              <div className="mt-3">
                <CurrentSignal
                  label="Bound-recipient priority pass"
                  value={`${formatCount(data.automaticProgress.preparation.priority.scanned)} scanned`}
                  detail={`${formatCount(data.automaticProgress.preparation.priority.prepared)} prepared · ${formatCount(data.automaticProgress.preparation.priority.held)} held · cycle ${formatCount(data.automaticProgress.preparation.priority.cycles)} · after contact ID ${formatCount(data.automaticProgress.preparation.priority.afterContactId)}. Separate from population coverage; cumulative transitions, not unique recipients.`}
                />
              </div>
            ) : null}
            <div className="mt-3 flex items-start gap-3 rounded-xl border border-amber-300/70 bg-amber-50/70 p-4 dark:border-amber-900/70 dark:bg-amber-950/20">
              <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
              <p className="text-sm leading-6 text-muted-foreground">
                Outbound remains paused. These observations do not establish deployed scheduled progression, qualification, enrollment, or send authorization. Native verification is not deployed-flow acceptance.
              </p>
            </div>
          </section>

          <section>
            <SectionHeading
              kicker="Production record inventory"
              title="A clear view of work in motion"
              description="Current production contact and business counts, alongside historical preparation, import, and provider state totals. Historical activity is context—not recipient qualification."
            />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile label="Contacts" value={formatCount(data.contacts.total)} note={`${formatCount(data.contacts.valid)} valid · ${formatCount(data.contacts.unvalidated)} unvalidated · ${formatCount(data.contacts.blocked)} blocked`} icon={Users} />
              <StatTile label="Businesses" value={formatCount(data.businesses.total)} note={`${formatCount(data.businesses.mapped)} mapped · ${formatCount(data.businesses.unresolved)} unresolved · ${formatCount(data.businesses.excluded)} excluded`} icon={Building2} />
              <StatTile label={data.preparations.currentAvailable ? "Preparation history" : "Legacy preparation history"} value={formatCount(data.preparations.total)} note={data.preparations.currentAvailable ? "Historical preparation states; not enrollment or send success." : "Canonical preparation counts are unavailable until native fields install; only legacy history is shown."} icon={GitBranch} />
              <StatTile label="Import / provider history" value={`${formatCount(data.imports.total)} / ${formatCount(data.providers.total)}`} note="Historical import and provider state totals." icon={FileInput} />
            </div>
          </section>

          <section>
            <SectionHeading
              kicker="Stage ledger"
              title="Existing work, by recorded state"
              description="These state totals summarize recorded history. They do not establish a live queue age, automatic retry, downstream advancement, or outreach authorization."
            />
            <div className="grid gap-3 lg:grid-cols-3">
              <StateList title={data.preparations.currentAvailable ? "Preparation history" : "Legacy preparation history · current unavailable"} total={data.preparations.total} states={data.preparations.byState} />
              <StateList title="Import history" total={data.imports.total} states={data.imports.byState} />
              <StateList title="Provider history" total={data.providers.total} states={data.providers.byState} />
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <Card className="border-border/70 bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  {data.nativeContracts.state === "verified" ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  ) : (
                    <XCircle className="h-5 w-5 text-destructive" />
                  )}
                  <CardTitle className="text-base">Native contract</CardTitle>
                  <Badge variant={data.nativeContracts.state === "verified" ? "default" : "destructive"} className="ml-auto capitalize">
                    {data.nativeContracts.state}
                  </Badge>
                </div>
                <CardDescription>
                  Verified means the expected database safeguards were observed only; it does not establish runtime operation, record qualification, enrollment, or sending.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.nativeContracts.reason ? (
                  <p className="rounded-lg border border-border bg-muted/50 p-3 text-sm leading-6 text-muted-foreground">{data.nativeContracts.reason}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">No additional contract reason was reported.</p>
                )}
              </CardContent>
            </Card>
            <div className="rounded-xl border border-amber-300/70 bg-amber-50/70 p-5 dark:border-amber-900/70 dark:bg-amber-950/20">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400" />
                <div>
                  <h3 className="font-semibold text-foreground">Read the evidence, not the totals</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    This summary does not qualify recipients, confirm enrollment, or authorize outreach. Follow a record into its existing detail and evidence screens before preparing any action.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {activeView === "records" && (
        <div>
          <SectionHeading
            kicker="Record investigation"
            title="Follow identity back to the source"
            description="Open the current contact, business, and census tools for underlying records and evidence. The snapshot is not a substitute for inspecting a record."
          />
          <div className="grid gap-3 md:grid-cols-2">
            <NavCard href="/dashboard/contacts-leads" title="Contacts & Leads" description="Search the unified CRM record list and open contact details." label="Production contacts" icon={Users} />
            <NavCard href="/dashboard/lead-ops?tab=businesses" title="Lead Ops businesses" description="Inspect existing business identity and canonical mapping records." label="Business records" icon={Building2} />
            {isAdmin ? (
              <NavCard href="/dashboard/contact-census" title="Contact Census" description="Review the existing census and its source-backed contact evidence." label="Inventory & evidence" icon={Database} />
            ) : (
              <div className="flex h-full items-start gap-4 rounded-xl border border-dashed border-border bg-muted/35 p-4">
                <span className="mt-0.5 rounded-lg bg-muted p-2.5 text-muted-foreground"><Database className="h-4 w-4" /></span>
                <span>
                  <span className="block font-semibold text-foreground">Contact Census</span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">This existing inventory screen is restricted to administrators.</span>
                  <span className="mt-3 inline-flex text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Admin access only</span>
                </span>
              </div>
            )}
            <NavCard href="/dashboard/lead-ops?tab=quality" title="Data Quality" description="Use existing quality views to investigate unresolved and inconsistent records." label="Quality review" icon={CircleHelp} />
          </div>
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-sm leading-6 text-muted-foreground">
              Valid, unvalidated, and blocked counts describe observed contact state only. They do not imply consent, campaign enrollment, or that a person is ready to receive outreach.
            </p>
          </div>
        </div>
      )}

      {activeView === "imports" && (
        <div>
          <SectionHeading
            kicker="Provenance"
            title="Imports and source history"
            description="Use the existing import, lead operations, and integration surfaces for batch details and provider history. No source records are created or edited here."
          />
          <UploadLedger />
          <Card>
            <CardHeader>
              <CardTitle>Source-registry canonical projection</CardTitle>
              <CardDescription>Original registry work items progressing to canonical businesses. Geography qualification and paid validation remain separate.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="Fulfilled source items" value={formatCount(data.registryProjection.fulfilled)} note="Committed canonical business/source bindings, not distinct qualified recipients." icon={Building2} />
                <StatTile label="Pending source items" value={formatCount(data.registryProjection.pending)} note={`Oldest pending: ${formatOptionalDate(data.registryProjection.oldestPendingAt)}`} icon={Clock3} />
                <StatTile label="Held source items" value={formatCount(data.registryProjection.held)} note={`${formatCount(data.registryProjection.processing)} processing. Held items retain their evidence and retry time.`} icon={AlertTriangle} />
              </div>
              <p className="text-xs text-muted-foreground">{formatCount(data.registryProjection.sourceUnavailable)} retained source items have incomplete/failed imports or retired source identities. They are not actionable pending work.</p>
              {data.registryProjection.recent.map(row=>(
                <div key={row.itemId} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{row.sourceSystem}</span>
                    <Badge variant="outline">{stateLabel(row.reason ?? row.state)}</Badge>
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">Source item {row.itemId} · Import {row.importRunId}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {row.businessId ? <Link href={`/dashboard/lead-ops/business/${row.businessId}`} className="text-primary underline">Business #{row.businessId}</Link> : <span>No canonical business binding</span>}
                    {row.state!=="completed" && <span className="text-xs text-muted-foreground">Next attempt: {formatOptionalDate(row.nextAttemptAt)}</span>}
                  </div>
                </div>
              ))}
              {!data.registryProjection.recent.length && <p className="text-sm text-muted-foreground">No retained source-registry work observed.</p>}
            </CardContent>
          </Card>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <StatTile label="Import history" value={formatCount(data.imports.total)} note={`${formatCount(sumStates(data.imports.byState))} represented across reported states.`} icon={FileClock} />
            <StatTile label="Provider history" value={formatCount(data.providers.total)} note="Historical provider state total, not a live delivery result." icon={Activity} />
            <StatTile label={data.preparations.currentAvailable ? "Preparation history" : "Legacy preparation history"} value={formatCount(data.preparations.total)} note={data.preparations.currentAvailable ? "Separate from imports, validation, and enrollment." : "Current canonical counts unavailable; required native fields are absent."} icon={GitBranch} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <NavCard href="/dashboard/lead-ops?tab=imports" title="Lead Ops · Imports" description="Review existing import batches and source-origin details." label="Import records" icon={FileInput} />
            {isAdmin ? (
              <NavCard href="/dashboard/lead-ops?tab=staging&stagingTab=master-leads" title="Master Leads" description="Open the existing administrator-only staged-record inventory and source fields." label="Admin access only" icon={Database} />
            ) : (
              <div className="flex h-full items-start gap-4 rounded-xl border border-dashed border-border bg-muted/35 p-4">
                <span className="mt-0.5 rounded-lg bg-muted p-2.5 text-muted-foreground"><Database className="h-4 w-4" /></span>
                <span>
                  <span className="block font-semibold text-foreground">Master Leads</span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">The staged-record inventory is restricted to administrators.</span>
                  <span className="mt-3 inline-flex text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Admin access only</span>
                </span>
              </div>
            )}
            <NavCard href="/dashboard/lead-ops?tab=sources" title="Lead Ops · Sources" description="Review the existing source inventory and provenance context." label="Source evidence" icon={Database} />
            <NavCard href="/dashboard/lead-ops?tab=provider-results" title="Provider Results" description="Inspect the existing per-call provider evidence log; results are not qualification or send authorization." label="Provider history" icon={Activity} />
            <NavCard href="/dashboard/ghl-integration" title="GHL integration" description="Open the established integration surface for provider connection and sync context." label="Provider context" icon={Activity} />
            <NavCard href="/dashboard/settings/integrations" title="Integration settings" description="Inspect configured integrations using the existing admin settings view." label="Source configuration" icon={HeartPulse} />
          </div>
        </div>
      )}

      {activeView === "exceptions" && (
        <div>
          <SectionHeading
            kicker="Resolve with evidence"
            title="Exceptions stay visible"
            description="Current held reasons and observed inventory exceptions point toward focused existing review tools. This page does not resolve, suppress, approve, or advance records."
          />
          <UploadLedger initialFilter="unfulfilled" />
          <section className="mb-5 rounded-xl border border-border/70 bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Current automatic preparation</p>
                <h3 className="mt-1 font-semibold text-foreground">Held reasons reported by the cursor</h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {data.automaticProgress.preparation.observed
                    ? `Cumulative held pass transitions: ${formatCount(data.automaticProgress.preparation.held)}. Counts are not unique recipients.`
                    : "Preparation cursor not yet observed; no held-reason result can be inferred."}
                </p>
              </div>
              <Badge variant={data.automaticProgress.preparation.observed ? "outline" : "secondary"}>
                {data.automaticProgress.preparation.observed ? "Observed" : "Not yet observed"}
              </Badge>
            </div>
            {data.automaticProgress.preparation.observed && Object.keys(data.automaticProgress.preparation.reasons).length > 0 ? (
              <div className="mt-4 divide-y divide-border/70 rounded-lg border border-border/70">
                {Object.entries(data.automaticProgress.preparation.reasons)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <div key={reason} className="flex items-center justify-between gap-3 px-4 py-3">
                      <span className="text-sm text-foreground">{stateLabel(reason)}</span>
                      <span className="font-mono text-sm text-muted-foreground">{formatCount(count)}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="mt-4 rounded-lg border border-dashed border-border bg-muted/35 px-4 py-3 text-sm leading-5 text-muted-foreground">
                {data.automaticProgress.preparation.observed
                  ? "No held reasons were reported in the current cursor observation."
                  : "Reason counts are unavailable until a preparation cursor is observed."}
              </p>
            )}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Last cycle: {formatOptionalDate(data.automaticProgress.preparation.lastCycleAt)} · {data.automaticProgress.validation.available ? `Preparation-linked validation queue: ${formatCount(data.automaticProgress.validation.pending)} pending, ${formatCount(data.automaticProgress.validation.processing)} processing · oldest pending ${formatOptionalDate(data.automaticProgress.validation.oldestPendingAt)}.` : "Preparation-linked validation queue unavailable: required native fields are absent."}
            </p>
          </section>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Blocked contacts" value={formatCount(data.contacts.blocked)} note="Observed blocked contact count." icon={XCircle} />
            <StatTile label="Unvalidated contacts" value={formatCount(data.contacts.unvalidated)} note="Validation state is not a send decision." icon={Clock3} />
            <StatTile label="Unresolved businesses" value={formatCount(data.businesses.unresolved)} note="Canonical relationship still needs evidence review." icon={AlertTriangle} />
            <StatTile label="Excluded businesses" value={formatCount(data.businesses.excluded)} note="Retained as a distinct reported status." icon={CircleHelp} />
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <NavCard href="/dashboard/blocked-contacts" title="Blocked Contacts" description="Open the existing blocked-contact investigation view." label="Contact exceptions" icon={XCircle} />
            <NavCard href="/dashboard/lead-ops?tab=quality" title="Lead Ops · Quality" description="Review unresolved, conflicting, or incomplete business evidence." label="Business exceptions" icon={AlertTriangle} />
            <NavCard href="/dashboard/lead-ops?tab=businesses" title="Business identity" description="Trace business mapping and inspect recorded source evidence." label="Association evidence" icon={Building2} />
            <NavCard href="/dashboard/data-health" title="Data Health" description="Open existing data health checks and their supporting details." label="Record health" icon={HeartPulse} />
          </div>
        </div>
      )}

      {activeView === "health" && (
        <div>
          <SectionHeading
            kicker="Operational context"
            title="Settings & Health"
            description="Jump to the existing system and integration surfaces. The canonical snapshot only reports the contract state and historical totals available to this page."
          />
          <div className="mb-5 rounded-xl border border-border/70 bg-card p-5">
            <div className="flex flex-wrap items-center gap-3">
              {data.nativeContracts.state === "verified" ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              ) : (
                <XCircle className="h-5 w-5 text-destructive" />
              )}
              <span className="font-semibold">Native database safeguards</span>
              <Badge variant={data.nativeContracts.state === "verified" ? "default" : "destructive"} className="capitalize">
                {data.nativeContracts.state}
              </Badge>
              {data.nativeContracts.reason && <span className="text-sm text-muted-foreground">{data.nativeContracts.reason}</span>}
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Verified is limited to the expected database safeguards being observed. It does not establish runtime operation, record qualification, enrollment, or sending.
            </p>
          </div>
          <div className="mb-5 rounded-xl border border-border/70 bg-card p-5">
            <h3 className="font-semibold">Local vertical-projection coverage</h3>
            {data.automaticProgress.projection.observed ? (
              <div className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                <p>Current frozen ID-range pass: {formatCount(data.automaticProgress.projection.businessesScanned)} businesses and {formatCount(data.automaticProgress.projection.contactsScanned)} contacts scanned. Captured populations: {formatCount(data.automaticProgress.projection.populationBusinesses)} businesses and {formatCount(data.automaticProgress.projection.populationContacts)} contacts.</p>
                <p>Verified local coverage cycles: {formatCount(data.automaticProgress.projection.verifiedCycles)}.</p>
                {data.automaticProgress.projection.lastCompletedCoverage && (
                  <p>Last completed pass: {formatCount(data.automaticProgress.projection.lastCompletedCoverage.businessesScanned)} businesses and {formatCount(data.automaticProgress.projection.lastCompletedCoverage.contactsScanned)} contacts, completed {formatDate(data.automaticProgress.projection.lastCompletedCoverage.completedAt)}.</p>
                )}
                <p>This projection covers all record classes. It does not establish business affiliation, qualification, validation, preparation or deployed acceptance.</p>
              </div>
            ) : <p className="mt-3 text-sm text-muted-foreground">No frozen-range coverage pass has been observed. Older cursor or cycle counters are not treated as verified coverage.</p>}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <NavCard href="/dashboard/system-health" title="System Health" description="Review the current system and operational health surface." label="Health checks" icon={HeartPulse} />
            <NavCard href="/dashboard/admin-hub" title="Admin Hub" description="Open existing administrative settings and governance tools." label="Settings" icon={ShieldCheck} />
            <NavCard href="/dashboard/settings/integrations" title="Integrations" description="Inspect integration configuration in the established settings view." label="Provider settings" icon={Activity} />
            <NavCard href="/dashboard/ghl-integration" title="GHL Integration" description="Review current provider integration status and related history." label="Provider history" icon={Database} />
          </div>
        </div>
      )}

      {data.limitations.length > 0 && (
        <section className="mt-8 rounded-xl border border-border/70 bg-muted/35 p-5">
          <div className="flex items-start gap-3">
            <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Known evidence limitations</h2>
              <ul className="mt-2 space-y-1.5">
                {data.limitations.map((limitation, index) => (
                  <li key={`${index}-${limitation}`} className="text-sm leading-6 text-muted-foreground">{limitation}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
    </>
  ) : null;

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <Helmet>
        <title>Canonical Enrichment | Liberty Bancard</title>
        <meta name="description" content="Review canonical record, import, exception, and system evidence." />
      </Helmet>
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 overflow-hidden rounded-2xl border border-border/70 bg-card">
          <div className="border-b border-border/70 bg-gradient-to-r from-primary/[0.09] via-transparent to-primary/[0.035] px-5 py-6 sm:px-7">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="max-w-3xl">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-md bg-primary/10 p-1.5 text-primary"><GitBranch className="h-4 w-4" /></span>
                  <span className="text-xs font-bold uppercase tracking-[0.17em] text-primary">Liberty Bancard · Record intelligence</span>
                </div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Canonical Enrichment</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                  One place to orient across merchant records, source evidence, and exceptions—without blending discovery, validation, enrollment, or sending.
                </p>
              </div>
              <div className="flex flex-col items-start gap-2 sm:items-end">
                <Badge variant="outline" className="border-primary/25 bg-background/70 px-2.5 py-1 text-primary">Read-only status view</Badge>
                <span className="text-xs text-muted-foreground">
                  {data ? `Observed ${formatDate(data.observedAt)}` : "Awaiting current status"}
                </span>
                <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
                  <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
                  Refresh status
                </Button>
              </div>
            </div>
          </div>

          <nav aria-label="Canonical enrichment views" className="flex gap-1 overflow-x-auto px-3 py-2 sm:px-5">
            {views.map((view) => {
              const selected = activeView === view.key;
              return (
                <button
                  key={view.key}
                  type="button"
                  onClick={() => setActiveView(view.key)}
                  aria-current={selected ? "page" : undefined}
                  className={`shrink-0 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <span className="block text-sm font-semibold">{view.label}</span>
                  <span className={`mt-0.5 hidden text-[10px] uppercase tracking-[0.11em] sm:block ${selected ? "text-primary-foreground/75" : "text-muted-foreground"}`}>
                    {view.eyebrow}
                  </span>
                </button>
              );
            })}
          </nav>
        </header>

        {isLoading && (
          <div className="space-y-5" aria-label="Loading canonical enrichment status" aria-busy="true">
            <div className="h-5 w-56 animate-pulse rounded bg-muted" />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((item) => <div key={item} className="h-32 animate-pulse rounded-xl border border-border/60 bg-card" />)}
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              {[0, 1, 2].map((item) => <div key={item} className="h-48 animate-pulse rounded-xl border border-border/60 bg-card" />)}
            </div>
          </div>
        )}

        {isError && (
          <section className="rounded-2xl border border-destructive/25 bg-card p-6 sm:p-8" role="alert">
            <div className="mx-auto max-w-xl text-center">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-lg font-semibold">Status could not be loaded</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {error instanceof Error ? error.message : "The canonical status service returned an error."}
                {" "}No stage or recipient readiness has been inferred.
              </p>
              <Button className="mt-5" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                Retry status
              </Button>
            </div>
          </section>
        )}

        {!isLoading && !isError && data && content}

        {!isLoading && !isError && !data && (
          <section className="rounded-2xl border border-border bg-card p-8 text-center">
            <Database className="mx-auto h-6 w-6 text-muted-foreground" />
            <h2 className="mt-3 font-semibold">No status snapshot available</h2>
            <p className="mt-1 text-sm text-muted-foreground">The status service returned no record summary. Refresh to try again.</p>
            <Button className="mt-4" variant="outline" onClick={() => refetch()}>Refresh status</Button>
          </section>
        )}

        {data && data.contacts.total === 0 && data.businesses.total === 0 && (
          <p className="mt-5 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            The current production inventory is empty. No record workflow or recipient activity is implied.
          </p>
        )}

        {data && (
          <footer className="mt-7 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/70 py-4 text-xs text-muted-foreground">
            <span>Production inventory with historical work · source-reported status</span>
            <span>Snapshot time: {formatDate(data.observedAt)}</span>
          </footer>
        )}
      </div>
    </main>
  );
}