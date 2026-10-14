import { useLocation, useSearch } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Onboarding from "./Onboarding";
import OnboardingBoard from "./OnboardingBoard";
import { c4WorkspaceSelection, c4WorkspaceUrl, onboardingViews } from "@/lib/crm-destination-state";
import { CrmPageHeader } from "@/components/crm/CrmPresentation";

export default function OnboardingHub() {
  const search = useSearch();
  const state = c4WorkspaceSelection(search, "tab", onboardingViews, "overview");
  const [, navigate] = useLocation();
  const goTab = (value: string) => {
    if ((onboardingViews as readonly string[]).includes(value))
      navigate(c4WorkspaceUrl("/dashboard/onboarding", search, window.location.hash, "tab", onboardingViews, "overview", value as typeof onboardingViews[number]));
  };

  return (
    <Tabs value={state.value} onValueChange={goTab} className="min-w-0 space-y-4">
      <CrmPageHeader title="Onboarding" description="Track merchant preparation, document collection and next actions." />
      {state.issues.length > 0 && <p className="rounded-md border-l-2 border-destructive bg-muted px-3 py-2 text-sm" role="status">{state.issues[0].reason}</p>}
      <TabsList>
        <TabsTrigger value="overview" data-testid="tab-onboarding-overview">Onboarding</TabsTrigger>
        <TabsTrigger value="board" data-testid="tab-onboarding-board">Board</TabsTrigger>
      </TabsList>
      <TabsContent value="overview"><Onboarding /></TabsContent>
      <TabsContent value="board"><OnboardingBoard /></TabsContent>
    </Tabs>
  );
}
