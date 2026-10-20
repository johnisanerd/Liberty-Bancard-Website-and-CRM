import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CrmDataState } from "@/components/crm/CrmPresentation";
import type { ReaderState } from "@/lib/reader-state";

/**
 * Shared loading / unavailable / stale presentation for query-backed readers.
 * Renders nothing when the reader is ready, so callers branch on `state` for the
 * empty list and for blocking states (loading, unavailable).
 */
export function ReaderStatus({ state, subject, onRetry }: { state: ReaderState; subject: string; onRetry: () => void }) {
  if (state === "loading") {
    return <div className="flex justify-center py-8" role="status" aria-label={`Loading ${subject}`}><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (state === "unavailable") {
    return <CrmDataState state="unavailable" message={`${subject} could not be loaded. This is not an empty list.`} onRetry={onRetry} />;
  }
  if (state === "stale") {
    return (
      <div role="alert" className="mb-3 flex items-center gap-3 text-sm text-amber-800 dark:text-amber-200" data-crm-state="stale">
        <span>Showing the last loaded {subject.toLowerCase()}; refreshing failed.</span>
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  return null;
}
