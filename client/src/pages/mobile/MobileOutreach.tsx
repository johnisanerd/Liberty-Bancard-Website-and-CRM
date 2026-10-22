import { useQuery } from "@tanstack/react-query";
import {
  TrendingUp, Users, Briefcase, Zap, BarChart3, Globe,
  Loader2, RefreshCw, CheckCircle2, AlertTriangle,
} from "lucide-react";
import { useState } from "react";
import { queryClient } from "@/lib/queryClient";

type OutreachData = {
  contacts?: { total?: number; reachable?: number };
  deals?: { total?: number; open?: number; won?: number };
  prospects?: { total?: number };
  activeCampaigns?: number;
  sourceBreakdown?: Array<{ source: string; count: number }>;
  verticalBreakdown?: Array<{ vertical: string; count: number }>;
  ghlSync?: { lastSyncAt?: string; consecutiveFailures?: number; circuitOpen?: boolean };
  lastOutreachRun?: string | { value?: string };
  workerRunning?: boolean;
};

function StatCard({ icon: Icon, label, value, sub, color = "blue" }: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  const colors: Record<string, string> = {
    blue: "bg-blue-50 dark:bg-blue-950/30 text-blue-600",
    green: "bg-green-50 dark:bg-green-950/30 text-green-600",
    purple: "bg-purple-50 dark:bg-purple-950/30 text-purple-600",
    orange: "bg-orange-50 dark:bg-orange-950/30 text-orange-600",
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-3 ${colors[color]}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function MobileOutreach() {
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading } = useQuery<OutreachData>({
    queryKey: ["/api/outreach/status"],
    staleTime: 1000 * 60 * 5,
  });

  async function refresh() {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["/api/outreach/status"] });
    setTimeout(() => setRefreshing(false), 1000);
  }

  const ghlOk = !data?.ghlSync?.circuitOpen && (data?.ghlSync?.consecutiveFailures ?? 0) < 3;

  function getLastRun(): string {
    const raw = data?.lastOutreachRun;
    if (!raw) return "—";
    const str = typeof raw === "object" ? raw?.value : raw;
    if (!str) return "—";
    try {
      const d = new Date(str);
      if (isNaN(d.getTime())) return String(str);
      const diffH = Math.floor((Date.now() - d.getTime()) / 3_600_000);
      if (diffH < 1) return "< 1h ago";
      if (diffH < 24) return `${diffH}h ago`;
      return `${Math.floor(diffH / 24)}d ago`;
    } catch { return String(str); }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="bg-white dark:bg-gray-900 px-4 pb-3 sticky top-0 z-10 border-b border-gray-100 dark:border-gray-800"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 12px)" }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Outreach</h1>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Last run: {getLastRun()}</p>
          </div>
          <button
            onClick={refresh}
            disabled={refreshing || isLoading}
            className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 active:scale-90 transition-transform"
          >
            <RefreshCw className={`w-4 h-4 text-gray-500 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="p-4 space-y-4">

            {/* GHL Sync Status */}
            <div className={`flex items-center gap-3 p-3 rounded-xl border ${
              ghlOk
                ? "bg-green-50 dark:bg-green-950/20 border-green-100 dark:border-green-900/40"
                : "bg-red-50 dark:bg-red-950/20 border-red-100 dark:border-red-900/40"
            }`}>
              {ghlOk
                ? <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                : <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
              }
              <div>
                <div className={`text-sm font-medium ${ghlOk ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                  GHL Sync: {ghlOk ? "Connected" : data?.ghlSync?.circuitOpen ? "Circuit open" : "Degraded"}
                </div>
                {data?.ghlSync?.lastSyncAt && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Last sync: {(() => {
                      try {
                        const d = new Date(data.ghlSync!.lastSyncAt!);
                        const h = Math.floor((Date.now() - d.getTime()) / 3_600_000);
                        return h < 1 ? "< 1h ago" : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
                      } catch { return "—"; }
                    })()}
                  </div>
                )}
              </div>
              {data?.workerRunning && (
                <span className="ml-auto text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-0.5 rounded-full font-medium flex-shrink-0">
                  Running
                </span>
              )}
            </div>

            {/* Key stats grid */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                icon={Users}
                label="Total Contacts (all unarchived, all record classes)"
                value={data?.contacts?.total ?? "—"}
                sub={data?.contacts?.reachable != null ? `${data.contacts.reachable.toLocaleString()} reachable` : undefined}
                color="blue"
              />
              <StatCard
                icon={Briefcase}
                label="Active Deals"
                value={data?.deals?.open ?? data?.deals?.total ?? "—"}
                sub={data?.deals?.won != null ? `${data.deals.won} won` : undefined}
                color="green"
              />
              <StatCard
                icon={Globe}
                label="Prospects"
                value={data?.prospects?.total ?? "—"}
                sub="in discovery"
                color="purple"
              />
              <StatCard
                icon={Zap}
                label="Active Campaigns"
                value={data?.activeCampaigns ?? "—"}
                color="orange"
              />
            </div>

            {/* Source breakdown */}
            {data?.sourceBreakdown && data.sourceBreakdown.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <BarChart3 className="w-4 h-4 text-gray-500" />
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Lead Sources</span>
                </div>
                <div className="space-y-2.5">
                  {data.sourceBreakdown.slice(0, 8).map((src) => {
                    const total = data.sourceBreakdown!.reduce((s, r) => s + r.count, 0);
                    const pct = total > 0 ? Math.round((src.count / total) * 100) : 0;
                    return (
                      <div key={src.source}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-gray-600 dark:text-gray-400 truncate">{src.source}</span>
                          <span className="text-gray-900 dark:text-white font-medium ml-2 flex-shrink-0">
                            {src.count.toLocaleString()} <span className="text-gray-400">({pct}%)</span>
                          </span>
                        </div>
                        <div className="h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Vertical breakdown */}
            {data?.verticalBreakdown && data.verticalBreakdown.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="w-4 h-4 text-gray-500" />
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">By Vertical</span>
                </div>
                <div className="space-y-1.5">
                  {data.verticalBreakdown.slice(0, 6).map((v) => (
                    <div key={v.vertical} className="flex justify-between text-xs py-0.5">
                      <span className="text-gray-600 dark:text-gray-400 truncate">{v.vertical}</span>
                      <span className="text-gray-900 dark:text-white font-medium ml-2 flex-shrink-0">
                        {v.count.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
