import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PauseCircle, RefreshCw } from "lucide-react";
import {
  BACKLOG_PROCESS_LIMITS, BACKLOG_STAGE_ORDER,
  type BacklogFamily, type BacklogProcessRequest, type BacklogProcessResponse, type BacklogState,
  type BacklogStageSummary, type CanonicalEnrichmentBacklog,
} from "@shared/canonical-enrichment-backlog";
import type { LaunchInventoryPopulation, SfpLaunchInventory } from "@shared/sfp-launch-inventory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

const numberFormat = new Intl.NumberFormat("en-US");
const n = (value: number) => numberFormat.format(value);
const humanize = (value: string) => value.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const when = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "Timestamp unavailable"
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(d);
};

const STATE_COLUMNS: { key: BacklogState; label: string; hint: string }[] = [
  { key: "eligible_now", label: "Eligible now", hint: "Can be worked by the next ordinary pass" },
  { key: "waiting", label: "Waiting", hint: "Already in progress or inside a remembered interval" },
  { key: "retryable", label: "Retryable", hint: "An earlier attempt expired or failed and will run again" },
  { key: "held", label: "Held", hint: "A specific blocker must clear first" },
];

const COST_LABEL = { retained_evidence: "Uses retained evidence", free: "No provider cost", provider: "Provider work" } as const;

function Funnel({ data }: { data: CanonicalEnrichmentBacklog }) {
  const f = data.funnel;
  const steps = [
    { label: "Supported business links", value: f.supportedBusinessLinks.contacts, note: `${n(f.supportedBusinessLinks.businesses)} businesses · contacts independently linked to a business` },
    { label: "Current accepted verticals", value: f.currentAcceptedVerticals.businesses, note: `${n(f.currentAcceptedVerticals.withSupportedLinkedContact)} have a supported linked contact` },
    { label: "Selected recipients", value: f.selectedRecipients, note: "Chosen by recipient preparation" },
    { label: "Pending validation", value: f.pendingValidation, note: "Selected; waiting for a validation answer" },
    { label: "Ready, held", value: f.readyHeld, note: "Prepared and held; outbound is paused" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {steps.map((step, index) => (
        <div key={step.label} className="rounded-xl border border-border/70 bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{index + 1}. {step.label}</p>
          <p className="mt-2 font-mono text-2xl font-semibold tracking-tight">{n(step.value)}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.note}</p>
        </div>
      ))}
    </div>
  );
}

function FamilyCard({ family }: { family: BacklogFamily }) {
  const stages = BACKLOG_STAGE_ORDER
    .map(key => family.stages.find(s => s.stage === key))
    .filter((s): s is BacklogStageSummary => !!s);
  const totals = STATE_COLUMNS.map(col => ({ ...col, value: stages.reduce((sum, s) => sum + s[col.key], 0) }));
  const done = stages.reduce((sum, s) => sum + s.done, 0);
  const blockers = family.reasons.filter(r => r.state === "held").sort((a, b) => b.count - a.count).slice(0, 5);
  return (
    <details className="rounded-xl border border-border/70 bg-card p-4" data-testid={`backlog-family-${family.key}`}>
      <summary className="cursor-pointer">
        <span className="font-semibold">{family.label}</span>
        <span className="ml-2 font-mono text-sm text-muted-foreground">{n(family.total)} {family.unit}</span>
        <span className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {totals.map(t => <span key={t.key}><span className="font-mono text-foreground">{n(t.value)}</span> {t.label.toLowerCase()}</span>)}
          <span><span className="font-mono text-foreground">{n(done)}</span> done</span>
        </span>
      </summary>
      <p className="mt-3 text-sm text-muted-foreground">{family.handoff}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.1em] text-muted-foreground">
              <th className="py-1 pr-3 font-semibold">Next step</th>
              {STATE_COLUMNS.map(c => <th key={c.key} className="px-2 py-1 text-right font-semibold" title={c.hint}>{c.label}</th>)}
              <th className="px-2 py-1 text-right font-semibold">Done</th>
            </tr>
          </thead>
          <tbody>
            {stages.map(s => (
              <tr key={s.stage} className="border-t border-border/50">
                <td className="py-1.5 pr-3">{s.label}</td>
                {STATE_COLUMNS.map(c => <td key={c.key} className="px-2 py-1.5 text-right font-mono">{s[c.key] ? n(s[c.key]) : "–"}</td>)}
                <td className="px-2 py-1.5 text-right font-mono">{s.done ? n(s.done) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {blockers.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Largest specific blockers</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {blockers.map(r => (
              <li key={`${r.stage}|${r.code}`} className="flex items-baseline justify-between gap-4">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-mono">{n(r.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

function ProcessPanel({ isAdmin, last }: { isAdmin: boolean; last: CanonicalEnrichmentBacklog["lastPriorityRun"] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<BacklogProcessRequest["scope"]>("local_only");
  const [maxRows, setMaxRows] = useState<number>(BACKLOG_PROCESS_LIMITS.maxRows.default);
  const [timeBudgetSeconds, setTimeBudgetSeconds] = useState<number>(BACKLOG_PROCESS_LIMITS.timeBudgetSeconds.default);
  const limits = BACKLOG_PROCESS_LIMITS;
  const valid = Number.isInteger(maxRows) && maxRows >= limits.maxRows.min && maxRows <= limits.maxRows.max
    && Number.isInteger(timeBudgetSeconds) && timeBudgetSeconds >= limits.timeBudgetSeconds.min
    && timeBudgetSeconds <= limits.timeBudgetSeconds.max;
  const mutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/canonical-enrichment/backlog/process",
      { scope, maxRows, timeBudgetSeconds })).json() as Promise<BacklogProcessResponse>,
    onSuccess: (result) => {
      toast({ title: result.alreadyQueued ? "Already requested" : "Queued", description: result.message });
      queryClient.invalidateQueries({ queryKey: ["/api/canonical-enrichment/backlog"] });
    },
    onError: (error: Error) => toast({ title: "Nothing was started", description: error.message, variant: "destructive" }),
  });
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5" data-testid="backlog-process-panel">
      <h3 className="font-semibold">Process highest-priority backlog (optional)</h3>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
        Ordinary scheduled passes already work this backlog automatically; you never need this button. It asks the
        same background worker for a larger pass now: a bigger staged-email batch, up to three recipient-selection
        passes, and nothing that sends. Work already stored is reused, and nothing is bought twice.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Scope</span>
          <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={scope}
            onChange={e => setScope(e.target.value as BacklogProcessRequest["scope"])} disabled={!isAdmin}>
            <option value="local_only">Local work only (no provider calls)</option>
            <option value="local_and_governed_providers">Local work, then provider passes under existing limits</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Max staged emails ({limits.maxRows.min}–{limits.maxRows.max})
          </span>
          <input type="number" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={maxRows} min={limits.maxRows.min} max={limits.maxRows.max} step={100}
            onChange={e => setMaxRows(Number(e.target.value))} disabled={!isAdmin} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Time budget, seconds ({limits.timeBudgetSeconds.min}–{limits.timeBudgetSeconds.max})
          </span>
          <input type="number" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={timeBudgetSeconds} min={limits.timeBudgetSeconds.min} max={limits.timeBudgetSeconds.max} step={30}
            onChange={e => setTimeBudgetSeconds(Number(e.target.value))} disabled={!isAdmin} />
        </label>
      </div>
      {scope === "local_and_governed_providers" && (
        <p className="mt-3 text-sm text-muted-foreground">
          Provider passes still obey the existing pauses, allowances and approvals. If one is closed, it does not run and
          nothing is queued around it.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => mutation.mutate()} disabled={!isAdmin || !valid || mutation.isPending}>
          {mutation.isPending ? "Requesting…" : "Process highest-priority backlog"}
        </Button>
        {!isAdmin && <span className="text-sm text-muted-foreground">Only administrators can request a pass.</span>}
        {isAdmin && !valid && <span className="text-sm text-destructive">Enter whole numbers within the ranges shown.</span>}
      </div>
      {last && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm" data-testid="backlog-last-run">
          <p className="font-medium">Last requested pass · finished {when(last.finishedAt)}</p>
          <p className="mt-1 text-muted-foreground">
            {last.staged
              ? `Staged emails: ${n(last.staged.examined)} examined, ${n(last.staged.created + last.staged.linkedExisting)} linked to contacts, ${n(last.staged.held)} held, ${n(last.staged.failed)} failed. `
              : "Staged emails were not processed in that pass. "}
            Recipient selection: {last.preparationPasses} pass{last.preparationPasses === 1 ? "" : "es"}, {n(last.prepared)} recipients prepared.
            {" "}Provider passes: {humanize(last.providerTicks)}.
          </p>
        </div>
      )}
    </section>
  );
}

function PopulationCard({ title, note, pop }: { title: string; note: string; pop: LaunchInventoryPopulation }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-tight">{n(pop.qualified)} <span className="text-sm font-normal text-muted-foreground">of {n(pop.recorded)} pass every check now</span></p>
      <p className="mt-1 text-xs text-muted-foreground">
        {n(pop.qualifiedBusinesses)} businesses · {n(pop.primaryRecipients)} primary recipients · {n(pop.alternates)} alternates
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{note}</p>
      {pop.blocked.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {pop.blocked.slice(0, 6).map(r => (
            <li key={`${r.gate}-${r.code}`} className="flex justify-between gap-3">
              <span>{r.label}</span><span className="font-mono">{n(r.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ReleaseRecordView {
  releaseId: string; releasedAt: string; admissionClosesAt: string; journeyExpiresAt: string;
  admissionClosedAt: string | null; journeyEndedAt: string | null; revokedAt: string | null; enrollmentIds: number[];
}
interface ReleaseStatus {
  releases: ReleaseRecordView[]; latest: ReleaseRecordView | null; admissionOpen: boolean; live: boolean;
  journeys: Record<string, number>; holds: Record<string, number>;
  heldEnrollments: Array<{ id: number; hold: string; holdAt: string | null }>;
  policy: { maxRecipientsPerRelease: number; maxAdmissionWindowHours: number; journeyDays: number };
  capacity: { identityRemaining: number; identityLimit: number; globalRemaining: number; globalCeiling: number; committedNext24h: number; remaining: number; limitedBy: string; sender: { emailAddress: string; usable: boolean } | null } | null;
}
interface ReleasePreview {
  commandKey?: string; snapshotHash: string; size: number; dailyCapacityRemaining: number; qualifiedPrimaryRecipients: number;
  continuations: number; notes: string[];
}
const JOURNEY_LABELS: Record<string, string> = {
  in_progress: "In progress", journey_expired: "Journey period ended (can be continued)", package_content_changed: "Held: content changed (can be continued)",
  validation_not_current: "Held: validation lapsed (can be continued)", revoked: "Revoked", recipient_facts_changed: "Stopped: recipient facts changed",
  binding_changed: "Stopped: approved binding changed", duplicate_journey: "Stopped: duplicate address or business", completed: "Completed", paused: "Paused", cancelled: "Cancelled",
};
const HOLD_LABELS: Record<string, string> = {
  UNCERTAIN_DELIVERY: "Delivery outcome unknown", REPEATED_UNSENT: "Repeated send failures", SEND_ATTEMPT_FAILED: "Send attempt failed",
};

function ReleasePanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(10);
  const [hours, setHours] = useState(24);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const { data: status, isLoading, isError } = useQuery<ReleaseStatus>({ queryKey: ["/api/canonical-enrichment/release"] });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/canonical-enrichment/release"] });
    queryClient.invalidateQueries({ queryKey: ["/api/canonical-enrichment/launch-inventory"] });
  };
  const fail = (error: unknown) => toast({ title: "Release request failed", variant: "destructive",
    description: error instanceof Error ? error.message : "Nothing was released." });
  const previewMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/canonical-enrichment/release/preview", { limit })).json() as Promise<ReleasePreview>,
    onSuccess: p => setPreview({ ...p, commandKey: crypto.randomUUID() }), onError: fail,
  });
  const executeMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/canonical-enrichment/release/execute",
      { limit, snapshotHash: preview!.snapshotHash, expiresInHours: hours }, { "Idempotency-Key": preview!.commandKey! })).json(),
    onSuccess: () => { setPreview(null); refresh(); toast({ title: "Recipients released", description: "They are active but still need every send check, and the outbound pause is unchanged." }); },
    onError: fail,
  });
  const revokeMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/canonical-enrichment/release/revoke")).json(),
    onSuccess: () => { refresh(); toast({ title: "Release revoked", description: "Unsent recipients returned to held; started journeys stopped where they are." }); },
    onError: fail,
  });
  const resolveMutation = useMutation({
    mutationFn: async (v: { id: number; resolution: string }) =>
      (await apiRequest("POST", `/api/canonical-enrichment/release/enrollments/${v.id}/resolve`, { resolution: v.resolution })).json(),
    onSuccess: () => { refresh(); toast({ title: "Hold resolved" }); }, onError: fail,
  });
  const maxSize = status?.policy.maxRecipientsPerRelease ?? 1;
  const maxHours = status?.policy.maxAdmissionWindowHours ?? 72;
  const cap = status?.capacity ?? null;
  const latest = status?.latest ?? null;
  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-card p-4" data-testid="release-panel">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Operator release</p>
      <p className="mt-1 text-sm text-muted-foreground">
        A release starts first touches for qualified primary recipients during a short admission window. Each admitted recipient then
        follows the approved schedule within a finite journey period. Releasing does not lift the outbound pause; nothing sends until the
        pause is lifted separately and each recipient passes the ordinary send checks.
      </p>
      {isLoading && <p className="mt-3 text-sm text-muted-foreground" data-testid="release-loading">Reading release state…</p>}
      {isError && <p className="mt-3 text-sm text-destructive" data-testid="release-error">The release state could not be read. Nothing is shown as released.</p>}
      {status && (
        <>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="release-status">
            <div><dt className="inline text-muted-foreground">Admission window: </dt>
              <dd className="inline">{status.admissionOpen && latest ? `open until ${when(latest.admissionClosesAt)}` : latest ? `closed${latest.revokedAt ? " (revoked)" : ""}` : "no release yet"}</dd></div>
            <div><dt className="inline text-muted-foreground">Journey period: </dt>
              <dd className="inline">{latest ? (latest.revokedAt ? "revoked" : status.live ? `ends ${when(latest.journeyExpiresAt)}` : `ended ${when(latest.journeyExpiresAt)}`) : "none"} ({status.policy.journeyDays} days per release)</dd></div>
            <div><dt className="inline text-muted-foreground">Sender capacity today: </dt>
              <dd className="inline">{cap ? `${n(cap.remaining)} admittable (${cap.sender?.emailAddress ?? "no sender"}: ${n(cap.identityRemaining)} of ${n(cap.identityLimit)}; global ${n(cap.globalRemaining)} of ${n(cap.globalCeiling)}; ${n(cap.committedNext24h)} already due)` : "unavailable"}</dd></div>
            <div><dt className="inline text-muted-foreground">Journeys: </dt>
              <dd className="inline">{Object.keys(status.journeys).length === 0 ? "none" : Object.entries(status.journeys).map(([k, v]) => `${JOURNEY_LABELS[k] ?? k}: ${n(v)}`).join(" · ")}</dd></div>
          </dl>
          {status.heldEnrollments.length > 0 && (
            <ul className="mt-3 space-y-2 text-sm" data-testid="release-holds">
              {status.heldEnrollments.map(h => (
                <li key={h.id} className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{HOLD_LABELS[h.hold] ?? h.hold}</Badge><span className="font-mono text-xs">enrollment {h.id}</span>
                  {h.hold === "UNCERTAIN_DELIVERY" ? (<>
                    <Button size="sm" variant="outline" disabled={resolveMutation.isPending} onClick={() => resolveMutation.mutate({ id: h.id, resolution: "delivered" })}>Confirmed delivered</Button>
                    <Button size="sm" variant="outline" disabled={resolveMutation.isPending} onClick={() => resolveMutation.mutate({ id: h.id, resolution: "not_delivered" })}>Confirmed not delivered</Button>
                  </>) : (
                    <Button size="sm" variant="outline" disabled={resolveMutation.isPending} onClick={() => resolveMutation.mutate({ id: h.id, resolution: "clear_hold" })}>Resume</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            {status.live && (
              <Button variant="outline" size="sm" onClick={() => revokeMutation.mutate()} disabled={revokeMutation.isPending}>Revoke and re-hold</Button>
            )}
            {!status.admissionOpen && (<>
              <label className="text-sm"><span className="mb-1 block text-xs text-muted-foreground">Recipients (1–{maxSize})</span>
                <input type="number" min={1} max={maxSize} value={limit} onChange={e => { setLimit(Number(e.target.value)); setPreview(null); }}
                  className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-sm" /></label>
              <label className="text-sm"><span className="mb-1 block text-xs text-muted-foreground">Admission window, hours (1–{maxHours})</span>
                <input type="number" min={1} max={maxHours} value={hours} onChange={e => setHours(Number(e.target.value))}
                  className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-sm" /></label>
              <Button variant="outline" size="sm" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>Preview</Button>
              {preview && (
                <Button size="sm" onClick={() => executeMutation.mutate()} disabled={executeMutation.isPending || preview.size === 0}>
                  Release {n(preview.size)} recipient{preview.size === 1 ? "" : "s"}
                </Button>
              )}
            </>)}
          </div>
          {status.admissionOpen && <p className="mt-2 text-xs text-muted-foreground">A new release can be made once the admission window closes or the release is revoked.</p>}
          {preview && !status.admissionOpen && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="release-preview">
              {n(preview.size)} selected of {n(preview.qualifiedPrimaryRecipients)} primary candidates
              {preview.continuations > 0 ? ` (${n(preview.continuations)} continuing an earlier journey)` : ""}; {n(preview.dailyCapacityRemaining)} messages of sender capacity can still be admitted today.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function LaunchInventory({ isAdmin }: { isAdmin: boolean }) {
  const { data, isLoading, isError } = useQuery<SfpLaunchInventory>({
    queryKey: ["/api/canonical-enrichment/launch-inventory"],
    refetchInterval: 10 * 60 * 1000,
  });
  if (isLoading) return <div className="h-40 animate-pulse rounded-xl border border-border/60 bg-card" aria-busy="true" />;
  if (isError || !data) {
    return <p className="rounded-xl border border-destructive/25 bg-card p-4 text-sm text-muted-foreground">
      The launch inventory could not be read, so nothing is shown. Nothing has been inferred.</p>;
  }
  return (
    <section data-testid="launch-inventory">
      <h2 className="text-xl font-semibold tracking-tight">Launch inventory</h2>
      <p className="mb-4 mt-1 max-w-3xl text-sm text-muted-foreground">
        Prepared recipients re-checked now against every launch requirement. A recipient that passes is not authorized to send;
        sending stays held until an operator releases it. Observed {when(data.observedAt)}.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <PopulationCard title="Ready, held" pop={data.readyHeld}
          note="Validated, owned paused membership in place." />
        <PopulationCard title="Pending validation" pop={data.pendingValidation}
          note="Checked on every rule except validation and membership." />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-border/70 bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Before anything can send</p>
          <ul className="mt-3 space-y-2 text-sm">
            {data.releaseBlockers.map(b => (
              <li key={b.key}>
                <span className="font-medium">{b.label}</span>{" "}
                <Badge variant={b.state === "ok" ? "outline" : "secondary"}>{b.state === "ok" ? "Clear" : b.state === "blocked" ? "Blocked" : "Unknown"}</Badge>
                <p className="text-xs leading-5 text-muted-foreground">{b.detail}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            {data.sender.daysOfFirstTouches === null
              ? "No daily sending capacity, so the time to send first touches cannot be estimated."
              : `At ${n(data.sender.dailyCapacity)} messages per day, ${n(data.readyHeld.primaryRecipients)} primary recipients are about ${data.sender.daysOfFirstTouches} days of first touches.`}
          </p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Qualified ready-held businesses by county and vertical</p>
          {data.byCountyAndVertical.length === 0
            ? <p className="mt-3 text-sm text-muted-foreground">No ready-held recipient currently passes every check.</p>
            : <table className="mt-3 w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-1 font-medium">County</th><th className="pb-1 font-medium">Vertical</th><th className="pb-1 text-right font-medium">Businesses</th></tr></thead>
                <tbody>{data.byCountyAndVertical.map(c => (
                  <tr key={`${c.county}-${c.vertical}`}><td>{c.county}</td><td>{humanize(c.vertical)}</td><td className="text-right font-mono">{n(c.businesses)}</td></tr>
                ))}</tbody>
              </table>}
        </div>
      </div>
      {isAdmin && <ReleasePanel />}
    </section>
  );
}

export function CanonicalBacklog({ isAdmin }: { isAdmin: boolean }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<CanonicalEnrichmentBacklog>({
    queryKey: ["/api/canonical-enrichment/backlog"],
    refetchInterval: 5 * 60 * 1000,
  });
  if (isLoading) {
    return <div className="space-y-4" aria-busy="true" aria-label="Loading enrichment backlog">
      <div className="h-24 animate-pulse rounded-xl border border-border/60 bg-card" />
      <div className="h-64 animate-pulse rounded-xl border border-border/60 bg-card" />
    </div>;
  }
  if (isError || !data) {
    return <section className="rounded-2xl border border-destructive/25 bg-card p-6">
      <h2 className="font-semibold">The backlog could not be counted</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "The backlog service returned an error."} Nothing has been inferred.
      </p>
      <Button className="mt-4" onClick={() => refetch()} disabled={isFetching}>Retry</Button>
    </section>;
  }
  return (
    <div className="space-y-8" data-testid="canonical-backlog">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Every record waits on exactly one next step. Counts are live record counts from the last {Math.round(data.maxAgeSeconds / 60)} minutes,
          not guaranteed results, forecasts or provider charges.
          {" "}Observed {when(data.observedAt)}.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />Refresh
        </Button>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-amber-300/70 bg-amber-50/70 p-4 dark:border-amber-900/70 dark:bg-amber-950/20">
        <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <p className="text-sm leading-6">
          <span className="font-semibold">Sending authority: {humanize(data.separate.sendingAuthority.state)}.</span>{" "}
          {data.separate.sendingAuthority.note}
        </p>
      </div>

      <LaunchInventory isAdmin={isAdmin} />

      <section>
        <h2 className="text-xl font-semibold tracking-tight">Funnel</h2>
        <p className="mb-4 mt-1 max-w-3xl text-sm text-muted-foreground">
          Supported business links to recipients that are ready and held. These are separate from original-row receipts,
          provider operations and sending authority, shown below.
        </p>
        <Funnel data={data} />
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">What to work next</h2>
        <p className="mb-4 mt-1 max-w-3xl text-sm text-muted-foreground">
          Retained evidence first, then free work, then provider work. Counts are in different units and are not added together.
          Provider rows show what was measured so far, never a prediction.
        </p>
        <ol className="space-y-2">
          {data.priority.map(item => (
            <li key={`${item.rank}-${item.label}`} className="rounded-xl border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{item.rank}. {item.label}</span>
                <span className="flex items-center gap-2">
                  <Badge variant="outline">{COST_LABEL[item.cost]}</Badge>
                  <span className="font-mono text-sm">{n(item.eligibleNow)} {item.unit} eligible now</span>
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{item.rationale}</p>
              {item.observed && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Measured so far: {item.observed.description} ({n(item.observed.numerator)} of {n(item.observed.denominator)}). This is history, not a forecast.
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>

      <ProcessPanel isAdmin={isAdmin} last={data.lastPriorityRun ?? null} />

      <section>
        <h2 className="text-xl font-semibold tracking-tight">By intake family</h2>
        <p className="mb-4 mt-1 max-w-3xl text-sm text-muted-foreground">
          Open a family to see its next steps and the specific blockers behind its held records.
        </p>
        <div className="space-y-2">{data.families.map(f => <FamilyCard key={f.key} family={f} />)}</div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-border/70 bg-card p-4">
          <h3 className="font-semibold">Original-row receipts</h3>
          <dl className="mt-3 space-y-1 text-sm">
            {Object.entries(data.separate.originalRowReceipts).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{humanize(k)}</dt><dd className="font-mono">{n(v)}</dd></div>
            ))}
          </dl>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-4 lg:col-span-2">
          <h3 className="font-semibold">Provider operations</h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {Object.entries(data.separate.providerOperations).map(([provider, states]) => (
              <div key={provider}>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">{humanize(provider)}</p>
                <dl className="mt-2 space-y-1 text-sm">
                  {Object.entries(states).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{humanize(k)}</dt><dd className="font-mono">{n(v)}</dd></div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </div>
      </section>

      {data.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {data.notes.map(note => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}
