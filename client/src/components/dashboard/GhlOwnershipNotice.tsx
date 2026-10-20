import { Info } from "lucide-react";
import { GHL_OWNERSHIP_STATEMENT } from "@shared/ghl-ownership-guidance";

/** Shared ownership notice for GHL guides, playbooks and workflow-ID screens. */
export function GhlOwnershipNotice({ testId = "notice-ghl-ownership", reference = false }: { testId?: string; reference?: boolean }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 dark:border-blue-800 dark:bg-blue-900/10"
      role="note"
      data-testid={testId}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
      <div className="space-y-1 text-xs leading-relaxed text-blue-800 dark:text-blue-300">
        <p><span className="font-semibold">Current ownership:</span> {GHL_OWNERSHIP_STATEMENT.cadence}</p>
        <p>{GHL_OWNERSHIP_STATEMENT.workflowIds}</p>
        <p>{GHL_OWNERSHIP_STATEMENT.incoming} {GHL_OWNERSHIP_STATEMENT.pause}</p>
        {reference && (
          <p>The GHL-native steps below are a reference design only. They are not instructions to move wait, tag or send cadence into GHL.</p>
        )}
      </div>
    </div>
  );
}
