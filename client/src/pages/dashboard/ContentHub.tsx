import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { hubTabs, hubTabState, typedTabUrl } from "@/lib/crm-destination-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResourcesNav } from "@/components/dashboard/ResourcesNav";
import ContentEditor from "./ContentEditor";
import BlogGenerator from "./BlogGenerator";
import SocialComposer from "./SocialComposer";
import BlazeIntegration from "./BlazeIntegration";

export default function ContentHub() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const search = useSearch();
  const [, navigate] = useLocation();
  const selector = hubTabState<string>(search, hubTabs.content, isAdmin ? hubTabs.content : (["content", "linkedin", "blaze"] as const));
  const tab = selector.value;
  // A user choice is a new history entry; registered context such as contactId is preserved.
  const goTab = (v: string) => navigate(typedTabUrl("/dashboard/content-hub", search, window.location.hash, { tab: v }));

  return (
    <div className="space-y-4">
    <ResourcesNav current="/dashboard/content-hub" />
    {selector.issues.length > 0 && (
      <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="hub-selection-issue">{selector.issues[0].reason}</p>
    )}
    <Tabs value={tab} onValueChange={goTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="content" data-testid="tab-content-engine">Content Engine</TabsTrigger>
        {isAdmin && <TabsTrigger value="blog" data-testid="tab-content-blog">Blog Generator</TabsTrigger>}
        <TabsTrigger value="linkedin" data-testid="tab-content-linkedin">LinkedIn</TabsTrigger>
        <TabsTrigger value="blaze" data-testid="tab-content-blaze">Blaze.ai</TabsTrigger>
      </TabsList>
      <TabsContent value="content"><ContentEditor /></TabsContent>
      {isAdmin && <TabsContent value="blog"><BlogGenerator /></TabsContent>}
      <TabsContent value="linkedin"><SocialComposer /></TabsContent>
      <TabsContent value="blaze"><BlazeIntegration /></TabsContent>
    </Tabs>
    </div>
  );
}
