import { CrmAreaNav } from "@/components/crm/CrmPresentation";
import { useAuth } from "@/hooks/use-auth";
import { resourcesDestinations } from "@/lib/crm-destination-state";

/**
 * Compact role-aware Resources navigation. Entries a role cannot open stay visible but disabled with
 * the reason (no hidden-then-404 surprise); each target keeps its own route guard.
 */
export function ResourcesNav({ current }: { current: string }) {
  const { user } = useAuth();
  const manager = user?.role === "admin" || user?.role === "manager";
  return (
    <CrmAreaNav
      current={current}
      entries={resourcesDestinations.map(d => ({
        label: d.href === "/assets" ? "Collateral (public library)" : d.label, href: d.href, allowed: !d.managerOnly || manager,
        reason: d.managerOnly && !manager ? "Available to managers and administrators." : undefined,
      }))}
    />
  );
}
