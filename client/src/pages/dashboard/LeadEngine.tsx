import { PageTitle } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Brain, Wand2 } from "lucide-react";
import LeadIntelligence from "./LeadIntelligence";
import LeadGenCleaner from "./LeadGenCleaner";

export default function LeadEngine() {
  return (
    <div className="p-6 space-y-4" data-testid="page-lead-engine">
      <PageTitle className="text-2xl font-bold" data-testid="text-lead-engine-heading">Lead Engine</PageTitle>
      <Tabs defaultValue="intelligence" className="w-full" data-testid="tabs-lead-engine">
        <TabsList data-testid="tabslist-lead-engine">
          <TabsTrigger value="intelligence" data-testid="tab-intelligence">
            <Brain className="w-4 h-4 mr-2" />
            Lead Intelligence
          </TabsTrigger>
          <TabsTrigger value="cleaner" data-testid="tab-cleaner">
            <Wand2 className="w-4 h-4 mr-2" />
            Lead Gen Cleaner
          </TabsTrigger>
        </TabsList>
        <TabsContent value="intelligence">
          <LeadIntelligence />
        </TabsContent>
        <TabsContent value="cleaner">
          <LeadGenCleaner />
        </TabsContent>
      </Tabs>
    </div>
  );
}
