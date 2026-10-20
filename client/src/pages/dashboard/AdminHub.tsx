import { lazy, Suspense, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "wouter";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CrmAreaNav, CrmPage, CrmPageHeader } from "@/components/crm/CrmPresentation";
import { GhlInboundSyncSummary } from "@/components/dashboard/GhlInboundSyncSummary";
import {
  adminAreas, adminAreaForTab, adminAreaTabs, adminSelectorState, typedTabUrl, type adminTabs,
} from "@/lib/crm-destination-state";

// Every Administration child is lazy: only the selected, authorized child is fetched and mounted.
const UserManagement = lazy(() => import("./UserManagement"));
const Permissions = lazy(() => import("./Permissions"));
const AuditLogs = lazy(() => import("./AuditLogs"));
const ConsentAudit = lazy(() => import("./ConsentAudit"));
const PciAssessment = lazy(() => import("./PciAssessment"));
const AgentManagement = lazy(() => import("./AgentManagement"));
const InformationFlow = lazy(() => import("./InformationFlow"));
const PreDeployGateResult = lazy(() => import("./PreDeployGateResult"));
const AutomationRegistry = lazy(() => import("./AutomationRegistry"));
const SettingsIntegrations = lazy(() => import("./SettingsIntegrations"));

type AdminTab = typeof adminTabs[number];
const AREA_LABEL = {
  "users-access": "Users & Access",
  "integrations": "Integrations",
  "operational-controls": "Operational Controls",
  "data-audit": "Data & Audit",
  "release-readiness": "Release Readiness",
} as const;
const TAB_LABEL: Record<AdminTab, string> = {
  "users": "User Management", "permissions": "Permissions", "audit-log": "Audit Log", "consent": "Consent Audit",
  "pci": "PCI Assessment", "agents": "Agent Management", "integrations": "Integrations", "ghl": "GHL Integration",
  "info-flow": "Information Flow", "gate-result": "Deploy Gate", "automations": "Automations",
};
const areaHref = (area: typeof adminAreas[number], tab: AdminTab) => `/dashboard/admin-hub?area=${area}&tab=${tab}`;
const PATH = "/dashboard/admin-hub";

/** Existing destinations discovered from each area. Links only: nothing here mounts or triggers a control. */
const AREA_LINKS: Record<typeof adminAreas[number], Array<{ label: string; href: string; adminOnly?: boolean }>> = {
  "users-access": [{ label: "Account security", href: "/dashboard/security" }],
  "integrations": [{ label: "GHL Integration", href: "/dashboard/ghl-integration" }],
  "operational-controls": [
    { label: "Workflows", href: "/dashboard/workflows" }, { label: "Automation", href: "/dashboard/automation" },
    { label: "Round Robin", href: "/dashboard/round-robin" }, { label: "Deliverability", href: "/dashboard/deliverability-hub" },
    { label: "Queue Holds", href: "/dashboard/queue-holds", adminOnly: true },
  ],
  "data-audit": [
    { label: "Data Requests", href: "/dashboard/data-requests" }, { label: "Data Health", href: "/dashboard/data-health" },
    { label: "Blocked Contacts", href: "/dashboard/blocked-contacts" }, { label: "System Audit", href: "/dashboard/system-audit" },
  ],
  "release-readiness": [
    { label: "System Readiness", href: "/dashboard/system-health?tab=readiness" },
    { label: "Go-Live Controls", href: "/dashboard/activation" },
  ],
};

function Child({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="py-12 text-center text-muted-foreground animate-pulse" role="status">Loading…</div>}>{children}</Suspense>;
}

export default function AdminHub() {
  const { user } = useAuth();
  const search = useSearch();
  const [, navigate] = useLocation();
  // "ghl" tab used to mount a second copy of GhlIntegrationHub; it now just
  // links out to the single canonical /dashboard/ghl-integration route so the
  // integration only has one mount point in the app.
  const selector = adminSelectorState(search, user?.role ?? undefined);
  const { tab, area, permitted } = selector;
  const isAdmin = user?.role === "admin";
  const can = (t: AdminTab) => permitted.includes(t);
  const goTab = (v: string) => navigate(typedTabUrl(PATH, search, window.location.hash, { area: adminAreaForTab(v as AdminTab), tab: v }));

  const entries = adminAreas.map(a => {
    const first = adminAreaTabs[a].find(can);
    return {
      label: AREA_LABEL[a],
      href: first ? areaHref(a, first) : areaHref(a, adminAreaTabs[a][0]),
      allowed: !!first,
      reason: first ? undefined : "Requires an administrator.",
    };
  });
  const current = entries[adminAreas.indexOf(area)].href;
  const relatedLinks = AREA_LINKS[area].filter(l => (!l.adminOnly || isAdmin) && (isAdmin || user?.role === "manager" || l.href === "/dashboard/security"));
  const areaChildren = adminAreaTabs[area].filter(can);

  return (
    <CrmPage className="space-y-4" data-testid="page-administration">
      <CrmPageHeader headingLevel={1} title="Administration"
        description="Users, integrations, operational controls, audit data and release readiness." />
      {selector.issues.length > 0 && (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="admin-selection-issue">{selector.issues[0].reason}</p>
      )}
      <CrmAreaNav entries={entries} current={current} />
      <Tabs value={tab} onValueChange={goTab} className="space-y-4">
        <TabsList className="flex-wrap h-auto gap-1" aria-label={`${AREA_LABEL[area]} tools`}>
          {areaChildren.map(t => (
            <TabsTrigger key={t} value={t} data-testid={`tab-admin-${t}`}>{TAB_LABEL[t]}</TabsTrigger>
          ))}
        </TabsList>
        {relatedLinks.length > 0 && (
          <nav aria-label={`${AREA_LABEL[area]} related destinations`} className="flex flex-wrap items-center gap-2 text-sm" data-testid="admin-related-links">
            <span className="text-muted-foreground">Related:</span>
            {relatedLinks.map(l => <Link key={l.href} href={l.href} className="underline underline-offset-2">{l.label}</Link>)}
          </nav>
        )}
        {isAdmin && <TabsContent value="users"><Child><UserManagement /></Child></TabsContent>}
        {isAdmin && <TabsContent value="permissions"><Child><Permissions /></Child></TabsContent>}
        {isAdmin && <TabsContent value="audit-log"><Child><AuditLogs /></Child></TabsContent>}
        <TabsContent value="consent"><Child><ConsentAudit /></Child></TabsContent>
        <TabsContent value="pci"><Child><PciAssessment /></Child></TabsContent>
        {can("agents") && <TabsContent value="agents"><Child><AgentManagement /></Child></TabsContent>}
        {can("integrations") && (
          <TabsContent value="integrations"><Child><SettingsIntegrations /></Child></TabsContent>
        )}
        {can("ghl") && (
          <TabsContent value="ghl">
            <div className="flex flex-col items-start gap-3 py-4 text-sm text-muted-foreground">
              <p>GHL Integration settings now live on their own page.</p>
              {isAdmin && <GhlInboundSyncSummary enabled />}
              <Link href="/dashboard/ghl-integration">
                <Button variant="outline" className="gap-2" data-testid="link-admin-ghl-integration">
                  Open GHL Integration <ExternalLink className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </TabsContent>
        )}
        {isAdmin && <TabsContent value="info-flow"><Child><InformationFlow /></Child></TabsContent>}
        {isAdmin && <TabsContent value="gate-result"><Child><PreDeployGateResult /></Child></TabsContent>}
        {isAdmin && <TabsContent value="automations"><Child><AutomationRegistry /></Child></TabsContent>}
      </Tabs>
    </CrmPage>
  );
}
