import { PageTitle } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Repeat, Send } from "lucide-react";
import Sequences from "./Sequences";
import Campaigns from "./Campaigns";

export default function Outreach() {
  return (
    <div className="p-6 space-y-4" data-testid="page-outreach">
      <PageTitle className="text-2xl font-bold" data-testid="text-outreach-heading">Outreach</PageTitle>
      <Tabs defaultValue="sequences" className="w-full" data-testid="tabs-outreach">
        <TabsList data-testid="tabslist-outreach">
          <TabsTrigger value="sequences" data-testid="tab-sequences">
            <Repeat className="w-4 h-4 mr-2" />
            Drip Sequences
          </TabsTrigger>
          <TabsTrigger value="campaigns" data-testid="tab-campaigns">
            <Send className="w-4 h-4 mr-2" />
            Campaigns
          </TabsTrigger>
        </TabsList>
        <TabsContent value="sequences">
          <Sequences />
        </TabsContent>
        <TabsContent value="campaigns">
          <Campaigns />
        </TabsContent>
      </Tabs>
    </div>
  );
}
