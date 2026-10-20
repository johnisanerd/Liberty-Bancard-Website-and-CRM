import { useState, type ReactNode } from "react";
import { SystemContactBusinessLinksPanel } from "./SystemContactBusinessLinksPanel";
import { ContactLinkCoveragePanel } from "./ContactLinkCoveragePanel";

/** Privileged matching, census and review context for the Businesses destination. The business inventory is the
 * primary content of that destination; these readers sit below it, collapsed, and each advanced reader mounts (and
 * starts its requests) only after an admin opens the disclosure. */
export function BusinessAdminContext({ renderReconciliation }: { renderReconciliation: (contactId?: number) => ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="rounded border p-3" data-testid="business-admin-context"
      onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) setOpened(true); }}>
      <summary className="cursor-pointer text-sm font-medium" data-testid="business-admin-context-summary">
        Matching, coverage and review (admin)
      </summary>
      {opened && (
        <div className="mt-3 space-y-4">
          <SystemContactBusinessLinksPanel renderReview={(contactId) => renderReconciliation(contactId)} />
          <section aria-label="Advanced review of conflicting or existing associations" className="rounded border p-3">
            <h3 className="text-sm font-medium">Advanced review of conflicting or existing associations</h3>
            <div className="mt-3">{renderReconciliation()}</div>
          </section>
          <ContactLinkCoveragePanel />
        </div>
      )}
    </details>
  );
}
