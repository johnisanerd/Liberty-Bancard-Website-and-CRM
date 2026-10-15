import { useLocation, useSearch } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Reporting from "./Reporting";
import GrowthKPI from "./GrowthKPI";
import WinLoss from "./WinLoss";
import OutreachAnalytics from "./OutreachAnalytics";
import OperationsReport from "./OperationsReport";
import FinancialHub from "./FinancialHub";
import { selectValue, safeParams, safeContextKeys, destinationUrl, financialViews,revenueFilterKeys,preserveRevenueFilters } from "@/lib/crm-destination-state";
import { CrmPage, CrmPageHeader } from "@/components/crm/CrmPresentation";

const VALID_TABS = ["overview", "growth", "win-loss", "outreach-analytics", "operations", "financial"] as const;
type Tab = typeof VALID_TABS[number];

export default function ReportingHub() {
  const search = useSearch();
  const state = selectValue(new URLSearchParams(search), "tab", VALID_TABS, "overview");
  const tab = state.value;
  const salesViews = ["overview", "growth", "win-loss"] as const;
  const activeArea = salesViews.includes(tab as typeof salesViews[number])
    ? "sales"
    : tab === "operations" ? "operations"
    : tab === "outreach-analytics" ? "outreach"
    : "financial";
  const [, navigate] = useLocation();
  const goTab = (v: string) => {
    if (!(VALID_TABS as readonly string[]).includes(v)) return;
    const params = safeParams(search, [...safeContextKeys, "financialTab", "revenueView","outreachView",...revenueFilterKeys]);
    preserveRevenueFilters(search,params);
    params.set("tab", v);
    if (v !== "financial") {params.delete("financialTab");params.delete("revenueView");}
    else params.set("financialTab", selectValue(new URLSearchParams(search), "financialTab", financialViews, "revenue").value);
    navigate(destinationUrl("/dashboard/reporting", params, window.location.hash));
  };
  const goArea = (area: "sales" | "operations" | "outreach" | "financial") => {
    if (area === "sales") {
      if (activeArea !== "sales") goTab("overview");
      return;
    }
    goTab(area === "outreach" ? "outreach-analytics" : area);
  };

  return (
    <CrmPage className="space-y-5">
      <CrmPageHeader title="Reports" description="Business performance, outreach, operations and financial views in the same authorized scope." />
      <Tabs value={tab} onValueChange={goTab} className="space-y-4 min-w-0">
        {state.issues.length > 0 && <p className="rounded-md border-l-2 border-destructive bg-muted px-3 py-2 text-sm" role="status">{state.issues[0].reason}</p>}
        <nav aria-label="Report areas" className="grid grid-cols-2 gap-2 border-b pb-3 md:grid-cols-4">
          <button type="button" data-testid="tab-reporting-sales-area" aria-pressed={activeArea === "sales"} onClick={() => goArea("sales")}
            className={`min-h-11 rounded-md border px-3 py-2 text-left text-sm font-semibold ${activeArea === "sales" ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}>
            Sales &amp; Growth
          </button>
          <button type="button" data-testid="tab-reporting-operations" aria-pressed={activeArea === "operations"} onClick={() => goArea("operations")}
            className={`min-h-11 rounded-md border px-3 py-2 text-left text-sm font-semibold ${activeArea === "operations" ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}>
            Operations
          </button>
          <button type="button" data-testid="tab-reporting-outreach" aria-pressed={activeArea === "outreach"} onClick={() => goArea("outreach")}
            className={`min-h-11 rounded-md border px-3 py-2 text-left text-sm font-semibold ${activeArea === "outreach" ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}>
            Outreach
          </button>
          <button type="button" data-testid="tab-reporting-financial" aria-pressed={activeArea === "financial"} onClick={() => goArea("financial")}
            className={`min-h-11 rounded-md border px-3 py-2 text-left text-sm font-semibold ${activeArea === "financial" ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}>
            Financial
          </button>
        </nav>
        {activeArea === "sales" && (
          <TabsList aria-label="Sales and growth views" className="h-auto w-full justify-start gap-1 border-b bg-transparent p-0 pb-3">
            <TabsTrigger value="overview" data-testid="tab-reporting-overview">Overview</TabsTrigger>
            <TabsTrigger value="growth" data-testid="tab-reporting-growth">Growth Metrics</TabsTrigger>
            <TabsTrigger value="win-loss" data-testid="tab-reporting-win-loss">Win/Loss</TabsTrigger>
          </TabsList>
        )}
        <TabsContent value="overview"><Reporting /></TabsContent>
        <TabsContent value="growth"><GrowthKPI /></TabsContent>
        <TabsContent value="win-loss"><WinLoss /></TabsContent>
        <TabsContent value="outreach-analytics"><OutreachAnalytics /></TabsContent>
        <TabsContent value="operations"><OperationsReport /></TabsContent>
        <TabsContent value="financial"><FinancialHub /></TabsContent>
      </Tabs>
    </CrmPage>
  );
}
