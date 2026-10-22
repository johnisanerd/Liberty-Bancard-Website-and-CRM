import { useLocation, useSearch } from "wouter";
import { hubTabs, hubTabState, typedTabUrl } from "@/lib/crm-destination-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import EmailHealth from "./EmailHealth";
import InboxHealth from "./InboxHealth";

export default function DeliverabilityHub() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const selector = hubTabState<string>(search, hubTabs.deliverability, hubTabs.deliverability);
  const tab = selector.value;
  // A user choice is a new history entry; registered context such as contactId is preserved.
  const goTab = (v: string) => navigate(typedTabUrl("/dashboard/deliverability-hub", search, window.location.hash, { tab: v }));

  return (
    <>
    {selector.issues.length > 0 && (
      <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="hub-selection-issue">{selector.issues[0].reason}</p>
    )}
    <Tabs value={tab} onValueChange={goTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="email-health" data-testid="tab-deliverability-email">Email Health</TabsTrigger>
        <TabsTrigger value="inbox-health" data-testid="tab-deliverability-inbox">Inbox Health</TabsTrigger>
      </TabsList>
      <TabsContent value="email-health"><EmailHealth /></TabsContent>
      <TabsContent value="inbox-health"><InboxHealth /></TabsContent>
    </Tabs>
    </>
  );
}
