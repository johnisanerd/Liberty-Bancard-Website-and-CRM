import { useLocation, useSearch } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import OperatorDashboard from "./OperatorDashboard";
import SystemReadiness from "./SystemReadiness";
import SeoHealth from "./SeoHealth";
import IncidentsDashboard from "./IncidentsDashboard";
import { PageHeadingLevel } from "@/components/ui/page-header";
import { useAuth } from "@/hooks/use-auth";
import { systemState, systemUrl, selectionMessage } from "@/lib/crm-destination-state";

const VALID_TABS = ["monitor", "readiness", "seo", "incidents"] as const;
const ADMIN_ONLY_TABS = ["monitor", "incidents"] as const;
type Tab = typeof VALID_TABS[number];

export default function SystemHealthHub() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const search = useSearch();
  const state = systemState(search, isAdmin);
  const tab = state.tab;
  const reason = state.issues[0]?.reason ?? selectionMessage(search);
  const [, navigate] = useLocation();
  const goTab = (v: string) => {
    if ((VALID_TABS as readonly string[]).includes(v) &&
      (isAdmin || !(ADMIN_ONLY_TABS as readonly string[]).includes(v)))
      navigate(systemUrl(search, window.location.hash, v));
  };

  return (
    <PageHeadingLevel level={2}>
    <Tabs value={tab} onValueChange={goTab} className="space-y-4">
      {reason && <p role="status">{reason}</p>}
      <TabsList className="flex-wrap h-auto gap-1">
        {isAdmin && <TabsTrigger value="monitor" data-testid="tab-system-monitor">System Monitor</TabsTrigger>}
        <TabsTrigger value="readiness" data-testid="tab-system-readiness">System Readiness</TabsTrigger>
        <TabsTrigger value="seo" data-testid="tab-system-seo">SEO Health</TabsTrigger>
        {isAdmin && <TabsTrigger value="incidents" data-testid="tab-system-incidents">Incidents &amp; DLQ</TabsTrigger>}
      </TabsList>
      {isAdmin && <TabsContent value="monitor"><OperatorDashboard /></TabsContent>}
      <TabsContent value="readiness"><SystemReadiness /></TabsContent>
      <TabsContent value="seo"><SeoHealth /></TabsContent>
      {isAdmin && <TabsContent value="incidents"><IncidentsDashboard /></TabsContent>}
    </Tabs>
    </PageHeadingLevel>
  );
}
