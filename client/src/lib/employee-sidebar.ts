/**
 * Final employee sidebar (Stage 3 C5, Section 5). Pure data so order, role filtering, activation
 * status and active-route matching are testable without rendering.
 *
 * Cutover rule: a destination is `activated` only when its authorized route exists and its relevant
 * smoke passed on the candidate. A target with a documented blocker is `legacy` and keeps its working
 * entrance (`legacyHref`) until the blocker clears; routes are never deleted to reach eleven entries.
 */
import { isMerchantOperationsPath } from "@/components/crm/MerchantOperationsNav";

export type SidebarRole = "admin" | "manager" | "agent";
export type SidebarIconKey =
  | "today" | "records" | "pipeline" | "inbox" | "work" | "merchant" | "prospecting"
  | "campaigns" | "reports" | "administration" | "resources";

export interface SidebarEntry {
  id: string;
  label: string;
  icon: SidebarIconKey;
  /** Destination per role; a role with no entry does not see the item. */
  href: Partial<Record<SidebarRole, string>>;
  badgeKey?: "smsUnread" | "overdueTaskCount" | "pendingApplications" | "outreachQueueCount";
  matches: (path: string) => boolean;
  status: "activated" | "legacy";
  /** Required when status is `legacy`: the working entrance and the documented blocker. */
  legacyHref?: Partial<Record<SidebarRole, string>>;
  blocker?: string;
}

const starts = (...prefixes: string[]) => (path: string) =>
  prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`));

export const employeeSidebarEntries: readonly SidebarEntry[] = [
  { id: "today", label: "Today", icon: "today", href: { admin: "/dashboard", manager: "/dashboard", agent: "/dashboard/my-day" },
    matches: p => p === "/dashboard" || p === "/dashboard/my-day" || p === "/dashboard/nba", status: "activated" },
  { id: "records", label: "Records", icon: "records",
    href: { admin: "/dashboard/contacts-leads?tab=people", manager: "/dashboard/contacts-leads?tab=people", agent: "/dashboard/contacts" },
    matches: p => starts("/dashboard/contacts", "/dashboard/contacts-leads", "/dashboard/my-leads", "/dashboard/companies")(p), status: "activated" },
  { id: "pipeline", label: "Pipeline", icon: "pipeline",
    href: { admin: "/dashboard/pipeline", manager: "/dashboard/pipeline", agent: "/dashboard/pipeline" },
    matches: starts("/dashboard/pipeline", "/dashboard/deals"), status: "activated" },
  { id: "inbox", label: "Inbox", icon: "inbox",
    href: { admin: "/dashboard/comms-hub", manager: "/dashboard/comms-hub", agent: "/dashboard/comms-hub" },
    badgeKey: "smsUnread", matches: starts("/dashboard/comms-hub"), status: "activated" },
  { id: "work", label: "Work", icon: "work",
    href: { admin: "/dashboard/tasks-appointments?tab=tasks", manager: "/dashboard/tasks-appointments?tab=tasks", agent: "/dashboard/tasks-appointments?tab=tasks" },
    badgeKey: "overdueTaskCount", matches: starts("/dashboard/tasks-appointments"), status: "activated" },
  { id: "merchant-operations", label: "Merchant Operations", icon: "merchant",
    href: { admin: "/dashboard/portfolio", manager: "/dashboard/portfolio", agent: "/dashboard/portfolio" },
    badgeKey: "pendingApplications", matches: p => isMerchantOperationsPath(p.split("?")[0]) || starts("/dashboard/portfolio")(p), status: "activated" },
  { id: "prospecting", label: "Prospecting", icon: "prospecting",
    // Agents keep the permitted Ready for Outreach path; the Lead Ops hub is admin/manager only.
    href: { admin: "/dashboard/lead-ops?tab=businesses", manager: "/dashboard/lead-ops?tab=businesses", agent: "/dashboard/outreach-queue" },
    badgeKey: "outreachQueueCount",
    matches: starts("/dashboard/lead-ops", "/dashboard/canonical-enrichment", "/dashboard/lead-imports", "/dashboard/outreach-queue", "/dashboard/prospects"),
    status: "activated" },
  { id: "campaigns", label: "Campaigns", icon: "campaigns",
    // Admin/manager only under the current route wrapper; no invented agent access.
    href: { admin: "/dashboard/outbound-center?tab=campaigns", manager: "/dashboard/outbound-center?tab=campaigns" },
    matches: starts("/dashboard/outbound-center", "/dashboard/campaigns", "/dashboard/sequences"), status: "activated" },
  { id: "reports", label: "Reports", icon: "reports",
    href: { admin: "/dashboard/reporting?tab=overview", manager: "/dashboard/reporting?tab=overview", agent: "/dashboard/my-earnings" },
    matches: starts("/dashboard/reporting", "/dashboard/my-earnings", "/dashboard/leaderboard", "/dashboard/financial-hub"), status: "activated" },
  { id: "administration", label: "Administration", icon: "administration",
    // No agent AdminHub; agents keep consent/PCI/security access through their existing standalone routes.
    href: { admin: "/dashboard/admin-hub?tab=users", manager: "/dashboard/admin-hub?tab=agents" },
    matches: starts("/dashboard/admin-hub", "/dashboard/settings", "/dashboard/ghl-integration", "/dashboard/queue-holds",
      "/dashboard/permissions", "/dashboard/consent-audit", "/dashboard/pci-assessment", "/dashboard/system-health", "/dashboard/activation"),
    status: "activated" },
  { id: "resources", label: "Resources", icon: "resources",
    href: { admin: "/dashboard/knowledge-base", manager: "/dashboard/knowledge-base", agent: "/dashboard/knowledge-base" },
    matches: starts("/dashboard/knowledge-base", "/dashboard/knowledge-admin", "/dashboard/training", "/dashboard/playbooks",
      "/dashboard/content-hub", "/assets"), status: "activated" },
];

export const EMPLOYEE_SIDEBAR_ORDER = [
  "Today", "Records", "Pipeline", "Inbox", "Work", "Merchant Operations", "Prospecting", "Campaigns", "Reports", "Administration", "Resources",
] as const;

export interface ResolvedSidebarItem { entry: SidebarEntry; href: string; legacy: boolean }

export function employeeSidebarFor(role: string): ResolvedSidebarItem[] {
  if (role !== "admin" && role !== "manager" && role !== "agent") return [];
  const out: ResolvedSidebarItem[] = [];
  for (const entry of employeeSidebarEntries) {
    const legacy = entry.status === "legacy";
    const href = legacy ? entry.legacyHref?.[role] : entry.href[role];
    if (href) out.push({ entry, href, legacy });
  }
  return out;
}

/** The first matching entry owns the active highlight; an entry is active when it matches the route. */
export function activeSidebarId(role: string, location: string): string | null {
  const path = location.split("#")[0];
  return employeeSidebarFor(role).find(item => item.entry.matches(path))?.entry.id ?? null;
}
