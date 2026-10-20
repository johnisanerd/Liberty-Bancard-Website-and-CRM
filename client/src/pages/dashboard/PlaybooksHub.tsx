import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResourcesNav } from "@/components/dashboard/ResourcesNav";
import MarketingPlaybook from "./MarketingPlaybook";
import GrowthPlaybook from "./GrowthPlaybook";

export default function PlaybooksHub() {
  const { user } = useAuth();
  const canSeeGrowth = user?.role === "admin" || user?.role === "manager";

  const validTabs = canSeeGrowth ? ["marketing", "growth"] : ["marketing"];
  const search = useSearch();
  const raw = new URLSearchParams(search).get("tab") ?? "";
  const tab = validTabs.includes(raw) ? raw : "marketing";
  const [, navigate] = useLocation();
  const goTab = (v: string) => navigate(`/dashboard/playbooks?tab=${v}`);

  return (
    <div className="space-y-4">
    <ResourcesNav current="/dashboard/playbooks" />
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
