import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { hubTabs, hubTabState, typedTabUrl } from "@/lib/crm-destination-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResourcesNav } from "@/components/dashboard/ResourcesNav";
import MarketingPlaybook from "./MarketingPlaybook";
import GrowthPlaybook from "./GrowthPlaybook";

export default function PlaybooksHub() {
  const { user } = useAuth();
  const canSeeGrowth = user?.role === "admin" || user?.role === "manager";

  const search = useSearch();
  const [, navigate] = useLocation();
  const selector = hubTabState<string>(search, hubTabs.playbooks, canSeeGrowth ? hubTabs.playbooks : (["marketing"] as const));
  const tab = selector.value;
  // A user choice is a new history entry; registered context such as contactId is preserved.
  const goTab = (v: string) => navigate(typedTabUrl("/dashboard/playbooks", search, window.location.hash, { tab: v }));

  return (
    <div className="space-y-4">
    <ResourcesNav current="/dashboard/playbooks" />
    {selector.issues.length > 0 && (
      <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="hub-selection-issue">{selector.issues[0].reason}</p>
    )}
    <Tabs value={tab} onValueChange={goTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="marketing" data-testid="tab-playbook-marketing">Marketing Playbook</TabsTrigger>
        {canSeeGrowth && <TabsTrigger value="growth" data-testid="tab-playbook-growth">Growth Playbook</TabsTrigger>}
      </TabsList>
      <TabsContent value="marketing"><MarketingPlaybook /></TabsContent>
      {canSeeGrowth && <TabsContent value="growth"><GrowthPlaybook /></TabsContent>}
    </Tabs>
    </div>
  );
}
