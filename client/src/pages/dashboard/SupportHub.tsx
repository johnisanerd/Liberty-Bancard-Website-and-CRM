import { PageHeadingLevel } from "@/components/ui/page-header";
import { useLocation, useSearch } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Tickets from "./Tickets";
import RFIs from "./RFIs";
import ReviewQueue from "./ReviewQueue";
import { c4WorkspaceSelection, c4WorkspaceUrl, supportViews } from "@/lib/crm-destination-state";

export default function SupportHub() {
  const search = useSearch();
  const state = c4WorkspaceSelection(search, "tab", supportViews, "tickets");
  const [, navigate] = useLocation();
  const goTab = (value: string) => {
    if ((supportViews as readonly string[]).includes(value))
      navigate(c4WorkspaceUrl("/dashboard/support-hub", search, window.location.hash, "tab", supportViews, "tickets", value as typeof supportViews[number]));
  };

  return (
    <PageHeadingLevel level={2}>
    <Tabs value={state.value} onValueChange={goTab} className="min-w-0 space-y-4">
      {state.issues.length > 0 && <p className="rounded-md border-l-2 border-destructive bg-muted px-3 py-2 text-sm" role="status">{state.issues[0].reason}</p>}
      <TabsList>
        <TabsTrigger value="tickets" data-testid="tab-support-tickets">Tickets</TabsTrigger>
        <TabsTrigger value="rfis" data-testid="tab-support-rfis">RFIs</TabsTrigger>
        <TabsTrigger value="review-queue" data-testid="tab-support-review-queue">Review Queue</TabsTrigger>
      </TabsList>
      <TabsContent value="tickets"><Tickets /></TabsContent>
      <TabsContent value="rfis"><RFIs /></TabsContent>
      <TabsContent value="review-queue"><ReviewQueue /></TabsContent>
    </Tabs>
    </PageHeadingLevel>
  );
}
