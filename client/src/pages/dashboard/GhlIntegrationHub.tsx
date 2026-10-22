import { PageHeadingLevel } from "@/components/ui/page-header";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { hubTabs, hubTabState, typedTabUrl } from "@/lib/crm-destination-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import GhlSettings from "./GhlSettings";
import GhlWorkflowManager from "./GhlWorkflowManager";
import GhlSequenceGuide from "./GhlSequenceGuide";

export default function GhlIntegrationHub() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const search = useSearch();
  const [, navigate] = useLocation();
  const selector = hubTabState<string>(search, hubTabs.ghlIntegration, isAdmin ? hubTabs.ghlIntegration : (["sequence-guide"] as const));
  const tab = selector.value;
  // A user choice is a new history entry; registered context such as contactId is preserved.
  const goTab = (v: string) => navigate(typedTabUrl("/dashboard/ghl-integration", search, window.location.hash, { tab: v }));

  return (
    <>
    {selector.issues.length > 0 && (
      <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="hub-selection-issue">{selector.issues[0].reason}</p>
    )}
    <PageHeadingLevel level={2}>
    <Tabs value={tab} onValueChange={goTab} className="space-y-4">
      <TabsList>
        {isAdmin && <TabsTrigger value="settings" data-testid="tab-ghl-settings">Settings</TabsTrigger>}
        {isAdmin && <TabsTrigger value="workflow-ids" data-testid="tab-ghl-workflow-ids">Workflow IDs</TabsTrigger>}
        <TabsTrigger value="sequence-guide" data-testid="tab-ghl-sequence-guide">Sequence Guide</TabsTrigger>
      </TabsList>
      {isAdmin && <TabsContent value="settings"><GhlSettings /></TabsContent>}
      {isAdmin && <TabsContent value="workflow-ids"><GhlWorkflowManager /></TabsContent>}
      <TabsContent value="sequence-guide"><GhlSequenceGuide /></TabsContent>
    </Tabs>
    </PageHeadingLevel>
    </>
  );
}
