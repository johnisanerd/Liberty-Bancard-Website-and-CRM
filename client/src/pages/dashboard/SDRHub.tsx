import { useLocation, useSearch } from "wouter";
import { hubTabs, hubTabState, typedTabUrl } from "@/lib/crm-destination-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SdrDashboard from "./SdrDashboard";
import ConversationAI from "./ConversationAI";

export default function SDRHub() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const selector = hubTabState<string>(search, hubTabs.sdr, hubTabs.sdr);
  const tab = selector.value;
  // A user choice is a new history entry; registered context such as contactId is preserved.
  const goTab = (v: string) => navigate(typedTabUrl("/dashboard/sdr-hub", search, window.location.hash, { tab: v }));

  return (
    <>
    {selector.issues.length > 0 && (
      <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="hub-selection-issue">{selector.issues[0].reason}</p>
    )}
    <Tabs value={tab} onValueChange={goTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="sdr" data-testid="tab-sdr-dashboard">AI SDR</TabsTrigger>
        <TabsTrigger value="chatbot" data-testid="tab-sdr-chatbot">Chat Bot Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="sdr"><SdrDashboard /></TabsContent>
      <TabsContent value="chatbot"><ConversationAI /></TabsContent>
    </Tabs>
    </>
  );
}
