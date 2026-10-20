import { useQuery } from "@tanstack/react-query";
import type { GhlInboundSyncStatus } from "@shared/ghl-inbound-sync";
import { CrmDataState } from "@/components/crm/CrmPresentation";
import { readerState } from "@/lib/reader-state";

const ENDPOINT = "/api/admin/ghl/inbound-contact-sync";

/**
 * Read-only rendering of the stored incoming-sync status for summaries and landing pages.
 * It performs one GET (no polling) and has no mutations and no continuation effect, so
 * discovering the page can never preview, apply, or advance an import. The full
 * GhlInboundSyncCard, with its controls and resumable stepping, stays on GHL Settings.
 */
export function GhlInboundSyncSummary({ enabled }: { enabled: boolean }) {
  const query = useQuery<GhlInboundSyncStatus>({ queryKey: [ENDPOINT, "summary"], queryFn: async () => {
    const res = await fetch(ENDPOINT, { credentials: "include" });
    if (!res.ok) throw new Error(`Incoming sync status unavailable (${res.status})`);
    return res.json();
  }, enabled, retry: false, refetchOnWindowFocus: false, refetchInterval: false });
  if (!enabled) return <CrmDataState state="denied" message="Incoming sync status is visible to administrators." />;
  const state = readerState(query);
  if (state === "loading") return <CrmDataState state="loading" message="Reading stored incoming sync status…" />;
  if (state === "unavailable") return <CrmDataState state="unavailable" message="Incoming sync status could not be read. Nothing is implied about delivery." onRetry={() => void query.refetch()} />;
  const status = query.data!;
  const run = status.run;
  return (
    <section aria-label="Incoming GHL sync status (read only)" className="rounded-md border p-4 text-sm space-y-2" data-testid="section-ghl-inbound-summary">
      {state === "stale" && <p role="alert" className="text-amber-800 dark:text-amber-200">Showing the last read status; refreshing failed.</p>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">Incoming updates</dt><dd className="font-medium">{status.inboundEnabled ? "Enabled" : "Disabled"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Configured</dt><dd className="font-medium">{status.configured ? "Yes" : "No"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Outbound</dt><dd className="font-medium">{status.outboundPaused === null ? "Unknown" : status.outboundPaused ? "Paused" : "Not paused"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Last import run</dt><dd className="font-medium">{run ? `${run.state} · updated ${new Date(run.updatedAt).toLocaleString()}` : "None recorded"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Stored status only. It does not show that GHL events are being delivered or consumed. Controls and imports are on GHL Settings.</p>
    </section>
  );
}
