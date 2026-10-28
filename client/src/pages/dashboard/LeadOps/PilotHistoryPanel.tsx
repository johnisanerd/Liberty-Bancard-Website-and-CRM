import { useQuery } from "@tanstack/react-query";

/**
 * Read-only history of the retired paid-pilot ceremony. It only issues GET requests, renders no buttons, inputs or
 * confirmations, and never calls a mutation endpoint. The current paid-provider emergency stop lives in Program Health
 * (PaidProviderControlsPanel), not here.
 */

type Section<T> = { data: T | undefined; isLoading: boolean; error: Error | null };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (r.status === 401 || r.status === 403) throw new Error("Access denied: administrator role required");
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.json();
}

function useHistoryQuery<T>(url: string): Section<T> {
  const q = useQuery<T>({ queryKey: [url], queryFn: () => getJson<T>(url), staleTime: 30_000, retry: false });
  return { data: q.data, isLoading: q.isLoading, error: q.error as Error | null };
}

function StateBadge({ state }: { state: string }) {
  const cls =
    state === "completed" ? "bg-green-100 text-green-800" :
    state === "running"   ? "bg-blue-100 text-blue-800" :
    state === "stopped"   ? "bg-red-100 text-red-800" :
    state === "paused"    ? "bg-yellow-100 text-yellow-800" :
    "bg-gray-100 text-gray-800";
  return <span className={`px-1.5 py-0.5 rounded-full font-medium text-xs ${cls}`}>{state}</span>;
}

function SectionShell({ title, testId, children, section }: {
  title: string; testId: string; children: React.ReactNode; section: Section<unknown>;
}) {
  return (
    <section className="rounded-lg border bg-card p-4 space-y-3" data-testid={testId} aria-label={title}>
      <h3 className="font-semibold text-sm">{title}</h3>
      {section.isLoading && <p className="text-xs text-muted-foreground" data-testid={`${testId}-loading`}>Loading…</p>}
      {section.error && (
        <p className="text-xs text-red-500" role="alert" data-testid={`${testId}-error`}>
          {section.error.message}. History for this section is unavailable, not empty.
        </p>
      )}
      {!section.isLoading && !section.error && children}
    </section>
  );
}

const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");

export function PilotHistoryPanel() {
  const preflight = useHistoryQuery<{ passed: boolean; checks: Record<string, { passed: boolean; detail?: string }> }>("/api/lead-ops/pilot/preflight");
  const runs = useHistoryQuery<any[]>("/api/lead-ops/pilot/runs");
  const defs = useHistoryQuery<any[]>("/api/lead-ops/pilot/definitions");
  const pool = useHistoryQuery<{ decision: { pool: string; decidedBy: string; decidedAt: string; revision: number } | null }>("/api/lead-ops/pilot/pool-authority");
  const paid = useHistoryQuery<{ authorization: any }>("/api/lead-ops/pilot/paid-provider-approval");
  const schedules = useHistoryQuery<any[]>("/api/admin/cro08a/schedule-definitions");

  const checks = preflight.data ? Object.entries(preflight.data.checks) : [];
  const runList = runs.data ?? [];
  const defList = defs.data ?? [];
  const scheduleList = schedules.data ?? [];
  const approval = paid.data?.authorization;

  return (
    <div className="space-y-4" data-testid="pilot-history-panel">
      <SectionShell title="Pre-pilot checklist (as recorded now, read-only)" testId="pilot-history-checklist" section={preflight}>
        {checks.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="pilot-history-checklist-empty">No checklist entries.</p>
        ) : (
          <div className="grid gap-1">
            {checks.map(([key, check]) => (
              <div key={key} className="flex items-start gap-2 text-xs">
                <span className={check.passed ? "text-green-600" : "text-red-500"}>{check.passed ? "✓" : "✗"}</span>
                <span className="font-mono">{key}</span>
                {check.detail && <span className="text-muted-foreground">{check.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </SectionShell>

      <SectionShell title="Recorded pool authority decision" testId="pilot-history-pool" section={pool}>
        {pool.data?.decision ? (
          <div className="text-xs">
            <span className="font-mono px-2 py-0.5 rounded bg-muted">{pool.data.decision.pool}</span>{" "}
            <span className="text-muted-foreground">
              rev {pool.data.decision.revision}, by {pool.data.decision.decidedBy}, {when(pool.data.decision.decidedAt)}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No pool decision was recorded.</p>
        )}
      </SectionShell>

      <SectionShell title="Recorded paid-provider approval" testId="pilot-history-approval" section={paid}>
        {approval ? (
          <p className="text-xs text-muted-foreground">
            Approved by {approval.authorizedBy} at {when(approval.authorizedAt)}
            {approval.revokedAt ? `; revoked ${when(approval.revokedAt)}` : "; not revoked in this record"}.
            This is history, not the current provider state. See Program Health for current provider controls.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No paid-provider approval is recorded.</p>
        )}
      </SectionShell>

      <SectionShell title={`Pilot definitions (${defList.length})`} testId="pilot-history-definitions" section={defs}>
        {defList.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="pilot-history-definitions-empty">No pilot definitions recorded.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {defList.map((d: any) => (
              <li key={d.id} className="font-mono">Level {d.level} — {String(d.pilot_definition_hash ?? "").slice(0, 10)}…</li>
            ))}
          </ul>
        )}
      </SectionShell>

      <SectionShell title={`Pilot runs (${runList.length})`} testId="pilot-history-runs" section={runs}>
        {runList.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="pilot-history-runs-empty">No pilot runs recorded.</p>
        ) : (
          runList.map((r: any) => (
            <div key={r.id} className="rounded border p-3 text-xs space-y-1" data-testid="pilot-history-run">
              <div className="flex items-center justify-between">
                <span className="font-semibold font-mono">Level {r.level} — {String(r.id ?? "").slice(0, 8)}…</span>
                <StateBadge state={String(r.state)} />
              </div>
              <div className="text-muted-foreground">Started: {when(r.started_at)}</div>
              <div className="text-muted-foreground">Release SHA: {String(r.release_sha ?? "").slice(0, 12)}…</div>
              {r.cohort_frozen_hash && <div className="text-muted-foreground">Cohort frozen: {String(r.cohort_frozen_hash).slice(0, 12)}…</div>}
              {r.stop_reason && <div className="text-red-600">Stop reason: {r.stop_reason}</div>}
            </div>
          ))
        )}
      </SectionShell>

      <SectionShell title={`Recorded CRO-08A schedule definitions (${scheduleList.length})`} testId="pilot-history-schedules" section={schedules}>
        {scheduleList.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="pilot-history-schedules-empty">No schedule definitions recorded.</p>
        ) : (
          scheduleList.map((s: any) => (
            <div key={s.id} className="rounded border p-2 text-xs flex items-center justify-between">
              <div>
                <div className="font-mono font-semibold">{s.logical_key} v{s.definition_version}</div>
                <div className="text-muted-foreground">{s.purpose}</div>
              </div>
              <span className={`px-1.5 py-0.5 rounded-full text-xs ${s.active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}`}>
                {s.active ? "recorded active" : "recorded inactive"}
              </span>
            </div>
          ))
        )}
      </SectionShell>

      <p className="text-xs text-muted-foreground">
        Read-only record of the retired ceremony. See <code className="font-mono">docs/cro03d-ceremony-runbook.md</code> for how it ran.
        No secrets, credentials, or raw PII are displayed here.
      </p>
    </div>
  );
}
