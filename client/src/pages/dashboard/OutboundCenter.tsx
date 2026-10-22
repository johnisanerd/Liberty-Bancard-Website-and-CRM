import { PageHeadingLevel } from "@/components/ui/page-header";
import { PageTitle } from "@/components/ui/page-header";
import { useLocation, useSearch } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CrmAreaNav, CrmPage } from "@/components/crm/CrmPresentation";
import { campaignAreas, campaignAreaForTab, campaignAreaTabs, outboundSelectorState, typedTabUrl } from "@/lib/crm-destination-state";
import { Zap, Megaphone, ListOrdered, LineChart, Users, ShieldCheck } from "lucide-react";
import OutreachCommandPage from "./OutreachCommand";
import CampaignsPage from "./Campaigns";
import SequencesPage from "./Sequences";
import OutreachAnalyticsPage from "./OutreachAnalytics";
import ColdLeadsPage from "./ColdLeads";
import Cr06Governance from "./Cr06Governance";

/**
 * Outbound Command Center — unified tabbed shell
 * Merges: Campaigns, Sequences, OutreachCommand, ColdLeads, OutreachAnalytics
 *
 * Tab "command"   → Outreach Command (read-only pipeline visibility;
 *                    import/enrichment/GHL-sync live in Lead Ops / GHL Integration)
 * Tab "campaigns" → Email campaigns
 * Tab "sequences" → Drip sequences
 * Tab "prospects" → Re-engagement (dormant-contact list; URL param kept as
 *                    "prospects" for legacy bookmark compatibility, see #1963)
 * Tab "analytics" → Outreach analytics
 *
 * URL: /dashboard/outbound-center?tab=command|campaigns|sequences|prospects|analytics
 *
 * Legacy routes that redirect here:
 *   /dashboard/campaigns          → tab=campaigns
 *   /dashboard/sequences          → tab=sequences
 *   /dashboard/outreach-command   → tab=command (already redirected in App.tsx)
 *   /dashboard/cold-leads         → tab=prospects
 *   /dashboard/acquisition-hub    → tab=analytics
 *   /dashboard/outreach-hub       → redirect to here
 */
export default function OutboundCenter() {
  const search = useSearch();
  const [, navigate] = useLocation();

  // Single codec: duplicate or invalid `tab` values fall back to Command and say so.
  const selector = outboundSelectorState(search);
  const tab: string = selector.value;
  const area = campaignAreaForTab(tab);
  const inArea = (value: string) => (campaignAreaTabs[area] as readonly string[]).includes(value);

  // A user choice is a new history entry so Back restores the previous selection.
  const handleTabChange = (value: string) => navigate(typedTabUrl("/dashboard/outbound-center", search, window.location.hash, { tab: value }));
  const AREA_LABEL = { manage: "Manage", audience: "Audience", delivery: "Delivery", results: "Results" } as const;
  const AREA_HREF = {
    manage: "/dashboard/outbound-center?tab=campaigns", audience: "/dashboard/outbound-center?tab=prospects",
    delivery: "/dashboard/outbound-center?tab=command",
    // Shared Results are owned by C4 Reporting; /dashboard/outbound-center?tab=analytics remains a compatibility entrance.
    results: "/dashboard/reporting?tab=outreach-analytics",
  } as const;

  return (
    <CrmPage className="space-y-4" data-testid="page-campaigns">
      <PageTitle className="text-2xl font-semibold" data-testid="text-page-title">Campaigns</PageTitle>
      {selector.issues.length > 0 && (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="outbound-selection-issue">{selector.issues[0].reason}</p>
      )}
      <CrmAreaNav
        current={AREA_HREF[area]}
        entries={campaignAreas.map(a => ({ label: AREA_LABEL[a], href: AREA_HREF[a], allowed: true }))}
      />
      <PageHeadingLevel level={2}>
      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList className="h-auto flex-wrap gap-1" aria-label="Campaign tools">
          <TabsTrigger value="command" className={inArea("command") ? "gap-2" : "hidden"} data-testid="tab-outbound-command">
            <Zap className="w-4 h-4" />
            Command
          </TabsTrigger>
          <TabsTrigger value="campaigns" className={inArea("campaigns") ? "gap-2" : "hidden"} data-testid="tab-outbound-campaigns">
            <Megaphone className="w-4 h-4" />
            Campaigns
          </TabsTrigger>
          <TabsTrigger value="sequences" className={inArea("sequences") ? "gap-2" : "hidden"} data-testid="tab-outbound-sequences">
            <ListOrdered className="w-4 h-4" />
            Sequences
          </TabsTrigger>
          <TabsTrigger value="governance" className={inArea("governance") ? "gap-2" : "hidden"} data-testid="tab-outbound-governance">
            <ShieldCheck className="w-4 h-4" />
            Governance
          </TabsTrigger>
          <TabsTrigger value="prospects" className={inArea("prospects") ? "gap-2" : "hidden"} data-testid="tab-outbound-reengagement">
            <Users className="w-4 h-4" />
            Re-engagement
          </TabsTrigger>
          <TabsTrigger value="analytics" className={inArea("analytics") ? "gap-2" : "hidden"} data-testid="tab-outbound-analytics">
            <LineChart className="w-4 h-4" />
            Analytics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="command" data-testid="tab-content-command">
          <OutreachCommandPage />
        </TabsContent>

        <TabsContent value="campaigns" data-testid="tab-content-campaigns">
          <CampaignsPage />
        </TabsContent>

        <TabsContent value="sequences" data-testid="tab-content-sequences">
          <SequencesPage />
        </TabsContent>

        <TabsContent value="governance" data-testid="tab-content-governance">
          <Cr06Governance />
        </TabsContent>

        <TabsContent value="prospects" data-testid="tab-content-prospects">
          <ColdLeadsPage />
        </TabsContent>

        <TabsContent value="analytics" data-testid="tab-content-analytics">
          <OutreachAnalyticsPage />
        </TabsContent>
      </Tabs>
      </PageHeadingLevel>
    </CrmPage>
  );
}
