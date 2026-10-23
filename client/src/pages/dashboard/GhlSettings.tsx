import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Settings, CheckCircle2, XCircle, Key, MapPin, Calendar, Activity, Mail, Clock, Zap, ArrowRightLeft, Send, Database, AlertTriangle, RefreshCw, Shield, ShieldAlert, ShieldCheck, GitBranch } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getApiErrorMessage } from "@/lib/ghlTruth";
import { useToast } from "@/hooks/use-toast";
import type { GhlActivityLog, MessageTemplate, SlaConfig } from "@shared/schema";
import { GhlSyncControlCard } from "@/components/dashboard/GhlSyncControlCard";
import { GhlInboundSyncCard } from "@/components/dashboard/GhlInboundSyncCard";
import { GhlCommandAction } from "@/components/dashboard/GhlCommandAction";
import { InboundAcknowledgementCard } from "@/components/dashboard/InboundAcknowledgementCard";
import { MessageTemplateEditor, ReceiptWordingPreview } from "@/components/dashboard/MessageTemplateEditor";

interface PipelineStagesResult {
  matchingPolicy: "explicit_ids_only";
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
  localStages: Array<{ id: number; pipeline: string; stageName: string }>;
}

interface SemanticStageMapping {
  localPipelineId: string;
  localStageId: number;
  ghlPipelineId: string;
  ghlStageId: string;
}

interface StageMapResult {
  version: 2;
  mappings: SemanticStageMapping[];
  legacyStageMap?: Record<string, string>;
  legacyDeprecated?: boolean;
}

interface GhlStatus {
  configured: boolean;
  hasApiKey: boolean;
  hasPrivateToken: boolean;
  hasLocationId: boolean;
  hasCalendarId: boolean;
}

interface HealthCheckResult {
  connected: boolean;
  latencyMs: number;
  locationName?: string;
  error?: string;
}

interface AdminHealthResult {
  status: "ok" | "expired" | "unconfigured" | "slow" | string;
  failureCount: number;
  lastSync: string | null;
  latencyMs?: number;
  locationName?: string;
  error?: string;
  checkedAt?: string;
  cached?: boolean;
}

interface SyncStatus {
  configured: boolean;
  totalContacts: number;
  syncedToGhl: number;
  unsyncedToGhl: number;
  lastSyncTo: any;
  lastSyncFrom: any;
  hotLeadSync?: { timestamp: string; synced: number; failed: number; total: number };
  hotLeadEnrollment?: { timestamp: string; enrolled: number; skipped: number; blocked: number; total: number };
}

interface EntitySyncStatus {
  entityType: string;
  lastSyncAt: string | null;
  lastSyncDirection: string | null;
  syncedCount: number;
  errorCount: number;
  lastError: string | null;
  localCount: number;
  ghlCount: number;
}

interface SyncDashboard {
  configured: boolean;
  totalContacts: number;
  syncedToGhl: number;
  unsyncedToGhl: number;
  totalDeals: number;
  entitySyncStatuses: EntitySyncStatus[];
  entityStatuses: Record<string, {
    lastSyncAt: string | null;
    lastSyncDirection: string | null;
    syncedCount: number;
    errorCount: number;
    lastError: string | null;
    localCount?: number;
    ghlSyncedCount?: number;
  }>;
  // Wave 7: Sync Authority Guard fields
  circuitState?: {
    open: boolean;
    consecutiveFailures: number;
    threshold: number;
    lastTripAt: string | null;
  };
  failedSyncsLast24h?: number;
  missingGhlContactId?: number;
  fieldWriteErrors422?: number;
  recent422Errors?: Array<{ contactId: number | null; operation: string | null; httpStatus: number | null; createdAt: string | null }>;
  webhookEventsLast24h?: number;
  permissionCheckCallsLast24h?: number;
  optOutEventsLast24h?: number;
  hasPermissionFieldGap?: boolean;
}

interface CircuitStatus {
  circuitOpen: boolean;
  consecutiveFailures: number;
  threshold: number;
  lastTripAt: string | null;
  lastTripReason: string | null;
  lastResetAt: string | null;
  ghlWebhookSecretConfigured: boolean;
}

interface BackfillStatus {
  totalContacts: number;
  missingGhlId: number;
}

function StatusIndicator({ configured }: { configured: boolean | null }) {
  if (configured === true) return <CheckCircle2 className="w-5 h-5 text-green-500" />;
  if (configured === false) return <XCircle className="w-5 h-5 text-red-500" />;
  return <AlertTriangle className="w-5 h-5 text-muted-foreground" />;
}

export default function GhlSettings() {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEditTemplates = user?.role === "admin" || user?.role === "manager";
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [draftStageMappings, setDraftStageMappings] = useState<SemanticStageMapping[]>([]);
  const [selectedLocalPipeline, setSelectedLocalPipeline] = useState("");
  const [draftExternalPipelineIds, setDraftExternalPipelineIds] = useState<Record<string, string>>({});
  const [outboundControlsOpen, setOutboundControlsOpen] = useState(false);

  const { data: status, isLoading: statusLoading } = useQuery<GhlStatus>({
    queryKey: ["/api/ghl/status"],
  });

  const { data: adminHealth } = useQuery<AdminHealthResult>({
    queryKey: ["/api/admin/ghl-health"],
    refetchInterval: 60_000,
    retry: false,
    staleTime: 25_000,
  });

  const { data: healthResult } = useQuery<HealthCheckResult>({
    queryKey: ["/api/ghl/health-check"],
    refetchInterval: 60000,
  });

  const { data: syncStatus, isError: syncStatusError } = useQuery<SyncStatus>({
    queryKey: ["/api/ghl/sync-status"],
    refetchInterval: 15000,
  });

  const { data: syncDashboard, isError: syncDashboardError } = useQuery<SyncDashboard>({
    queryKey: ["/api/ghl/sync-dashboard"],
    refetchInterval: 30000,
  });

  const { data: activity, isLoading: activityLoading } = useQuery<GhlActivityLog[]>({
    queryKey: ["/api/ghl/activity"],
  });

  const { data: templates, isLoading: templatesLoading } = useQuery<MessageTemplate[]>({
    queryKey: ["/api/message-templates"],
  });

  const { data: slaConfigs, isLoading: slaLoading } = useQuery<SlaConfig[]>({
    queryKey: ["/api/sla-configs"],
  });

  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ghl/test-connection");
      return res.json() as Promise<HealthCheckResult>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ghl/health-check"] });
      if (data.connected) {
        toast({ title: "GHL Connected", description: `Location: ${data.locationName} (${data.latencyMs}ms)` });
      } else {
        toast({ title: "Connection Failed", description: data.error || "Could not reach GHL", variant: "destructive" });
      }
    },
    onError: (error: unknown) => toast({
      title: "Connection test failed",
      description: getApiErrorMessage(error, "The GHL health probe could not be completed."),
      variant: "destructive",
    }),
  });

  const syncToGhlMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ghl/sync-all-to-ghl"),
    onSuccess: () => {
      toast({ title: "Sync Started", description: "Pushing contacts to GHL" });
      queryClient.invalidateQueries({ queryKey: ["/api/ghl/sync-status"] });
    },
    onError: (error: unknown) => toast({
      title: "GHL sync request failed",
      description: getApiErrorMessage(error, "Could not start the contact sync."),
      variant: "destructive",
    }),
  });

  const syncHotLeadsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ghl/sync-hot-leads", { limit: 100 }),
    onSuccess: () => {
      toast({ title: "Hot Lead Sync Started", description: "Syncing up to 100 hot lead contacts to GHL" });
      queryClient.invalidateQueries({ queryKey: ["/api/ghl/sync-status"] });
    },
    onError: (error: unknown) => toast({
      title: "Hot lead sync request failed",
      description: getApiErrorMessage(error, "Could not start the hot lead sync."),
      variant: "destructive",
    }),
  });

  const { data: backfillStatus } = useQuery<BackfillStatus>({
    queryKey: ["/api/admin/backfill-ghl-contacts/status"],
    refetchInterval: 0,
  });

  const { data: circuitStatus } = useQuery<CircuitStatus>({
    queryKey: ["/api/ghl/circuit-status"],
    refetchInterval: 30000,
    retry: false,
  });

  // ── Stage Mapping ──────────────────────────────────────────────────────────
  const { data: pipelineStages, isLoading: stagesLoading, isError: stagesError, refetch: refetchStages } = useQuery<PipelineStagesResult>({
    queryKey: ["/api/admin/ghl/pipeline-stages"],
    retry: false,
  });

  const { data: savedStageMap, isError: stageMapError } = useQuery<StageMapResult>({
    queryKey: ["/api/admin/ghl/stage-map"],
    retry: false,
  });

  useEffect(() => {
    if (savedStageMap?.version === 2 && Array.isArray(savedStageMap.mappings)) {
      setDraftStageMappings(savedStageMap.mappings);
      setDraftExternalPipelineIds(Object.fromEntries(
        savedStageMap.mappings.map((mapping) => [`${mapping.localPipelineId}:${mapping.localStageId}`, mapping.ghlPipelineId]),
      ));
    }
  }, [savedStageMap]);

  useEffect(() => {
    if (!selectedLocalPipeline && pipelineStages?.localStages?.length) {
      setSelectedLocalPipeline(pipelineStages.localStages[0].pipeline);
    }
  }, [pipelineStages?.localStages, selectedLocalPipeline]);

  const saveStageMapMutation = useMutation({
    mutationFn: async (mappings: SemanticStageMapping[]) => {
      const res = await apiRequest("POST", "/api/admin/ghl/stage-map", { version: 2, mappings });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ghl/stage-map"] });
      toast({ title: "Semantic stage map saved", description: "The server validated the explicit pipeline and stage ID mappings." });
    },
    onError: (error: unknown) => toast({
      title: "Could not save semantic stage map",
      description: getApiErrorMessage(error, "The server rejected the stage mapping."),
      variant: "destructive",
    }),
  });

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="ghlsettings-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const localPipelineOptions = Array.from(new Set((pipelineStages?.localStages ?? []).map((stage) => stage.pipeline)));
  const visibleLocalStages = (pipelineStages?.localStages ?? []).filter((stage) => stage.pipeline === selectedLocalPipeline);
  const stageMapChanged = JSON.stringify(draftStageMappings) !== JSON.stringify(savedStageMap?.mappings ?? []);

  return (
    <div className="space-y-6" data-testid="ghlsettings-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3">
            <Settings className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-xl font-semibold" data-testid="text-ghlsettings-title">GHL Integration Settings</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">Bring GHL contact information into this database without changing GHL records or enabling outbound messages</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => testConnectionMutation.mutate()}
            disabled={testConnectionMutation.isPending}
            className="gap-2"
            data-testid="button-test-connection"
          >
            {testConnectionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Test Connection
          </Button>
        </div>
      </div>

      {adminHealth && (() => {
        const healthState = adminHealth.status === "ok" ? "connected" :
          adminHealth.status === "unconfigured" ? "unconfigured" :
          adminHealth.status === "expired" || adminHealth.status === "slow" ? "disconnected" : "unknown";
        return (
          <div
            data-testid="card-ghl-admin-health"
            className={`flex items-start gap-4 p-4 rounded-lg border text-sm ${
              healthState === "connected"
                ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800 text-green-900 dark:text-green-100"
                : healthState === "unknown"
                ? "bg-muted border-border text-foreground"
                : "bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100"
            }`}
          >
            {healthState === "connected"
              ? <CheckCircle2 className="w-5 h-5 shrink-0 text-green-600 dark:text-green-400 mt-0.5" />
              : healthState === "unknown"
              ? <AlertTriangle className="w-5 h-5 shrink-0 text-muted-foreground mt-0.5" />
              : healthState === "unconfigured"
              ? <AlertTriangle className="w-5 h-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
              : <XCircle className="w-5 h-5 shrink-0 text-red-600 dark:text-red-400 mt-0.5" />}
            <div className="flex-1 min-w-0">
              <p className="font-semibold">
                {healthState === "connected" ? "GHL API connected (health probe)" :
                 healthState === "unconfigured" ? "GHL is not configured" :
                 healthState === "disconnected" ? `GHL API probe failed (${adminHealth.status})` :
                 "GHL connection status unknown"}
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 mt-1 text-xs opacity-80">
                <span>Last successful sync: {adminHealth.lastSync ? new Date(adminHealth.lastSync).toLocaleString() : "No recorded success"}</span>
                <span>Historical failures (24h): {adminHealth.failureCount ?? "Unknown"}</span>
                {adminHealth.latencyMs != null && <span>Latency: {adminHealth.latencyMs}ms</span>}
                {adminHealth.locationName && <span>Location: {adminHealth.locationName}</span>}
                <span>Probe checked: {adminHealth.checkedAt ? new Date(adminHealth.checkedAt).toLocaleString() : "Unknown"}</span>
                {adminHealth.cached && <span>Cached probe response</span>}
              </div>
              {adminHealth.error && (
                <p className="text-xs mt-1 opacity-80">{adminHealth.error}</p>
              )}
            </div>
          </div>
        );
      })()}

      {healthResult && (
        <Alert variant={healthResult.connected ? "default" : "destructive"} data-testid="alert-health-result">
          {healthResult.connected ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          <AlertDescription>
            {healthResult.connected
              ? `Connected to GHL. Location: ${healthResult.locationName}. Latency: ${healthResult.latencyMs}ms.`
              : `Connection failed: ${healthResult.error}`}
          </AlertDescription>
        </Alert>
      )}

      <GhlInboundSyncCard canControl={user?.role === "admin"} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-ghl-connection">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Connection Status</CardTitle>
            <Activity className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {(() => {
              const connected = healthResult?.connected ?? (
                adminHealth
                  ? adminHealth.status === "ok"
                  : null
              );
              return (
            <div className="flex items-center gap-2">
              <StatusIndicator configured={connected} />
              <span className="text-lg font-semibold" data-testid="text-ghl-connection-status">
                {connected === true ? "Connected" : connected === false ? "Not connected" : "Unknown"}
              </span>
            </div>
              );
            })()}
            {healthResult?.locationName && (
              <p className="text-xs text-muted-foreground mt-1" data-testid="text-ghl-location-name">{healthResult.locationName}</p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-ghl-apikey">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">API Token</CardTitle>
            <Key className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {(() => {
              const tokenConfigured = status
                ? Boolean(status.hasApiKey || status.hasPrivateToken)
                : null;
              return (
            <div className="flex items-center gap-2">
              <StatusIndicator configured={tokenConfigured} />
              <span className="text-lg font-semibold" data-testid="text-ghl-apikey-status">
                {tokenConfigured === null ? "Unknown" : tokenConfigured ? "Configured" : "Not set"}
              </span>
            </div>
              );
            })()}
          </CardContent>
        </Card>

        <Card data-testid="card-ghl-locationid">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Location ID</CardTitle>
            <MapPin className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <StatusIndicator configured={status ? status.hasLocationId : null} />
              <span className="text-lg font-semibold" data-testid="text-ghl-locationid-status">
                {status ? (status.hasLocationId ? "Configured" : "Not set") : "Unknown"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-ghl-calendarid">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Calendar ID</CardTitle>
            <Calendar className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <StatusIndicator configured={status ? status.hasCalendarId : null} />
              <span className="text-lg font-semibold" data-testid="text-ghl-calendarid-status">
                {status ? (status.hasCalendarId ? "Configured" : "Not set") : "Unknown"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {syncStatus && (
        <Card data-testid="card-ghl-sync-status">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base">Sync Status</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Total Contacts</p>
                <p className="text-lg font-semibold" data-testid="text-sync-total">{syncStatus.totalContacts}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Synced to GHL</p>
                <p className="text-lg font-semibold text-green-600" data-testid="text-sync-synced">{syncStatus.syncedToGhl}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Unsynced</p>
                <p className="text-lg font-semibold text-amber-600" data-testid="text-sync-unsynced">{syncStatus.unsyncedToGhl}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Sync</p>
                <p className="text-sm font-medium" data-testid="text-sync-last">
                  {syncStatus.lastSyncTo?.timestamp
                    ? new Date(syncStatus.lastSyncTo.timestamp).toLocaleString()
                    : "Never"}
                </p>
              </div>
            </div>
            {syncStatus.hotLeadSync && (
              <div className="mt-3 pt-3 border-t text-sm" data-testid="text-hot-lead-sync-result">
                <p className="text-muted-foreground">Last Hot Lead Sync: {new Date(syncStatus.hotLeadSync.timestamp).toLocaleString()}</p>
                <p>{syncStatus.hotLeadSync.synced} synced, {syncStatus.hotLeadSync.failed} failed of {syncStatus.hotLeadSync.total} total</p>
              </div>
            )}
            {syncStatus.hotLeadEnrollment && (
              <div className="mt-2 text-sm" data-testid="text-hot-lead-enrollment-result">
                <p className="text-muted-foreground">Last Hot Lead Enrollment: {new Date(syncStatus.hotLeadEnrollment.timestamp).toLocaleString()}</p>
                <p>{syncStatus.hotLeadEnrollment.enrolled} enrolled, {syncStatus.hotLeadEnrollment.skipped} skipped, {syncStatus.hotLeadEnrollment.blocked} blocked</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {syncStatusError && (
        <Alert variant="destructive" data-testid="alert-ghl-sync-status-unavailable">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Sync status is unavailable; current contact counts and last successful sync are unknown.</AlertDescription>
        </Alert>
      )}

      {syncDashboard && (
        <Card data-testid="card-sync-dashboard">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base">Sync Health Dashboard</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
              <div>
                <p className="text-muted-foreground">Total Contacts</p>
                <p className="text-lg font-semibold" data-testid="text-dashboard-contacts">{syncDashboard.totalContacts}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Synced Contacts</p>
                <p className="text-lg font-semibold text-green-600" data-testid="text-dashboard-synced">{syncDashboard.syncedToGhl}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Unsynced</p>
                <p className="text-lg font-semibold text-amber-600" data-testid="text-dashboard-unsynced">{syncDashboard.unsyncedToGhl}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Total Deals</p>
                <p className="text-lg font-semibold" data-testid="text-dashboard-deals">{syncDashboard.totalDeals}</p>
              </div>
            </div>

            {Object.keys(syncDashboard.entityStatuses || {}).length > 0 && (
              <Table data-testid="table-entity-sync-status">
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity Type</TableHead>
                    <TableHead>Last Sync</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>Synced</TableHead>
                    <TableHead>Errors</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(syncDashboard.entityStatuses).map(([entityType, status]) => (
                    <TableRow key={entityType} data-testid={`row-sync-entity-${entityType}`}>
                      <TableCell className="text-sm font-medium capitalize">{entityType}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {status.lastSyncDirection || "-"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-green-600" data-testid={`text-sync-count-${entityType}`}>
                        {status.syncedCount || 0}
                        {status.localCount != null && (
                          <span className="text-muted-foreground ml-1">/ {status.localCount} local</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {status.errorCount != null && status.errorCount > 0 ? (
                          <span className="text-red-600 flex items-center gap-1" data-testid={`text-error-count-${entityType}`}>
                            <AlertTriangle className="w-3 h-3" />
                            {status.errorCount}
                          </span>
                        ) : status.errorCount === 0 ? (
                          <span className="text-muted-foreground">0</span>
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {status.lastError ? (
                          <Badge variant="destructive" className="text-xs" data-testid={`badge-sync-error-${entityType}`}>
                            Error
                          </Badge>
                        ) : status.lastSyncAt && status.errorCount === 0 ? (
                          <Badge variant="outline" className="text-xs">
                            No recorded error
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Unknown</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {Object.keys(syncDashboard.entityStatuses || {}).length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-no-entity-sync">
                No entity sync data yet. Sync operations will appear here once performed.
              </p>
            )}

            {/* Wave 7: Sync Authority Guard Metrics */}
            {(syncDashboard.circuitState || syncDashboard.failedSyncsLast24h !== undefined) && (
              <div className="mt-4 pt-4 border-t space-y-3" data-testid="section-sync-authority-guard">
                <p className="text-sm font-semibold flex items-center gap-2">
                  <Shield className="w-4 h-4 text-muted-foreground" />
                  Sync Authority Guard (Wave 7)
                </p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-muted-foreground">Circuit State</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      {syncDashboard.circuitState?.open
                        ? <ShieldAlert className="w-4 h-4 text-red-500" />
                        : syncDashboard.circuitState?.open === false
                          ? <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                          : <AlertTriangle className="w-4 h-4 text-muted-foreground" />}
                      <span className={`font-semibold ${syncDashboard.circuitState?.open ? "text-red-600" : "text-muted-foreground"}`}
                        data-testid="text-circuit-state">
                        {syncDashboard.circuitState?.open === true ? "OPEN" : syncDashboard.circuitState?.open === false ? "Closed" : "Unknown"}
                      </span>
                      {syncDashboard.circuitState && (
                        <span className="text-muted-foreground text-xs">
                          ({syncDashboard.circuitState.consecutiveFailures}/{syncDashboard.circuitState.threshold})
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Failed Syncs (24h)</p>
                    <p className={`font-semibold ${syncDashboard.failedSyncsLast24h == null ? "text-muted-foreground" : syncDashboard.failedSyncsLast24h > 0 ? "text-red-600" : "text-muted-foreground"}`}
                      data-testid="text-failed-syncs-24h">
                      {syncDashboard.failedSyncsLast24h ?? "Unknown"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Missing GHL IDs</p>
                    <p className={`font-semibold ${syncDashboard.missingGhlContactId == null ? "text-muted-foreground" : syncDashboard.missingGhlContactId > 0 ? "text-amber-600" : "text-muted-foreground"}`}
                      data-testid="text-missing-ghl-ids">
                      {syncDashboard.missingGhlContactId ?? "Unknown"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Opt-Out Events (24h)</p>
                    <p className="font-semibold" data-testid="text-optout-events">
                      {syncDashboard.optOutEventsLast24h ?? "Unknown"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Webhook Events (24h)</p>
                    <p className="font-semibold" data-testid="text-webhook-events">
                      {syncDashboard.webhookEventsLast24h ?? "Unknown"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Permission Checks (24h)</p>
                    <p className="font-semibold" data-testid="text-perm-checks">
                      {syncDashboard.permissionCheckCallsLast24h ?? "Unknown"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Field Write Errors (422)</p>
                    <p className={`font-semibold ${syncDashboard.fieldWriteErrors422 == null ? "text-muted-foreground" : syncDashboard.fieldWriteErrors422 > 0 ? "text-amber-600" : "text-muted-foreground"}`}
                      data-testid="text-field-write-errors">
                      {syncDashboard.fieldWriteErrors422 ?? "Unknown"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">GHL Webhook Secret</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      {circuitStatus?.ghlWebhookSecretConfigured === true
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                        : circuitStatus?.ghlWebhookSecretConfigured === false
                          ? <XCircle className="w-3.5 h-3.5 text-red-500" />
                          : <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground" />}
                      <span className={`text-xs font-medium ${circuitStatus?.ghlWebhookSecretConfigured === true ? "text-green-600" : circuitStatus?.ghlWebhookSecretConfigured === false ? "text-red-600" : "text-muted-foreground"}`}
                        data-testid="text-webhook-secret-status">
                        {circuitStatus?.ghlWebhookSecretConfigured === true ? "Set" : circuitStatus?.ghlWebhookSecretConfigured === false ? "Not set" : "Unknown"}
                      </span>
                    </div>
                  </div>
                </div>

                {syncDashboard.hasPermissionFieldGap && (
                  <Alert variant="default" className="border-amber-300 bg-amber-50 dark:bg-amber-950/30" data-testid="alert-permission-field-gap">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription className="text-amber-800 dark:text-amber-200 text-xs">
                      <strong>Permission field gap detected:</strong> GHL returned 422 errors when writing lb_* custom fields. This means GHL workflows may not see the contactability gate fields. Go to GHL → Settings → Custom Fields and create the required lb_* fields, then run a force-sync below.
                    </AlertDescription>
                  </Alert>
                )}

                {syncDashboard.circuitState?.lastTripAt && (
                  <div className="text-xs text-muted-foreground">
                    <p>Last circuit trip: {new Date(syncDashboard.circuitState.lastTripAt).toLocaleString()}</p>
                    {circuitStatus?.lastTripReason && (
                      <p className="text-amber-700 dark:text-amber-400 mt-0.5" data-testid="text-circuit-trip-reason">Reason: {circuitStatus.lastTripReason}</p>
                    )}
                  </div>
                )}

                {/* Recent 422 error rows (last 10) */}
                {(syncDashboard.recent422Errors?.length ?? 0) > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">Recent 422 Field-Write Errors (last 10):</p>
                    <div className="overflow-x-auto rounded border border-amber-200 dark:border-amber-800">
                      <table className="text-xs w-full" data-testid="table-recent-422-errors">
                        <thead className="bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300">
                          <tr>
                            <th className="px-2 py-1 text-left">Contact ID</th>
                            <th className="px-2 py-1 text-left">Operation</th>
                            <th className="px-2 py-1 text-left">Status</th>
                            <th className="px-2 py-1 text-left">Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {syncDashboard.recent422Errors!.map((row, i) => (
                            <tr key={i} className="border-t border-amber-100 dark:border-amber-900">
                              <td className="px-2 py-1">{row.contactId ?? "—"}</td>
                              <td className="px-2 py-1">{row.operation ?? "—"}</td>
                              <td className="px-2 py-1">{row.httpStatus ?? 422}</td>
                              <td className="px-2 py-1">{row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {syncDashboardError && (
        <Alert variant="destructive" data-testid="alert-ghl-sync-dashboard-unavailable">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Historical entity counts, sync error counters, and recent write errors are unavailable.</AlertDescription>
        </Alert>
      )}

      {/* Provider-write controls are distinct and not needed by the one-way import. */}
      {user?.role === "admin" && <details
        className="rounded-lg border p-4"
        onToggle={event => setOutboundControlsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-medium">Optional writes back to GHL — not needed for incoming contact sync</summary>
        {outboundControlsOpen && <div className="mt-4 space-y-4">
        <Alert><AlertDescription>Leave these provider-write controls disabled for one-way GHL → database synchronization. Native-trigger review applies only to writes back to GHL.</AlertDescription></Alert>
        <GhlSyncControlCard canControl />
        <Card data-testid="card-force-permission-sync">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">Force Contact Permission Sync</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <GhlCommandAction
            title="Force contact permission sync"
            description="Queue a server-authorized permission-field projection for one contact. HTTP 202 means queued, not completed; the actual field-write result is shown after polling."
            endpoint="/api/ghl/sync-contact"
            contactIdRequired
            testId="ghl-permission-command"
            statusEndpointToInvalidate="/api/ghl/sync-dashboard"
          />
        </CardContent>
       </Card>
       </div>}
       </details>}

      <Card data-testid="card-ghl-instructions">
        <CardHeader>
          <CardTitle className="text-base">Configuration Instructions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground" data-testid="text-ghl-instructions">
            To enable the GoHighLevel integration, set the following environment secrets in your Replit project:
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <Key className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">Private integration token or legacy API key</span>
              <span className="text-muted-foreground">- configure GHL_PRIVATE_INTEGRATION_TOKEN (preferred) or GHL_API_KEY</span>
            </li>
            <li className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-muted-foreground" />
              <code className="bg-muted px-2 py-0.5 rounded text-xs">GHL_LOCATION_ID</code>
              <span className="text-muted-foreground">- Your GHL location identifier</span>
            </li>
            <li className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-muted-foreground" />
              <code className="bg-muted px-2 py-0.5 rounded text-xs">GHL_CALENDAR_ID</code>
              <span className="text-muted-foreground">- Your GHL calendar identifier</span>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card data-testid="card-ghl-activity">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">Recent GHL Activity</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {activityLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : !activity || activity.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-ghl-activity-empty">
              No recent GHL activity
            </p>
          ) : (
            <Table data-testid="table-ghl-activity">
              <TableHeader>
                <TableRow>
                  <TableHead>Direction</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.map((entry) => (
                  <TableRow key={entry.id} data-testid={`row-ghl-activity-${entry.id}`}>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {entry.direction}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{entry.channel}</TableCell>
                    <TableCell className="text-sm">{entry.subject || "-"}</TableCell>
                    <TableCell>
                      <Badge variant={entry.status === "sent" ? "default" : "secondary"} className="text-xs">
                        {entry.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-message-templates">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">Message Templates</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {templatesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : !templates || templates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-templates-empty">
              No message templates configured
            </p>
          ) : (
            <Table data-testid="table-message-templates">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Wording</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.id} data-testid={`row-template-${t.id}`}>
                    <TableCell className="text-sm font-medium">{t.name}</TableCell>
                    <TableCell className="text-sm">{t.category}</TableCell>
                    <TableCell className="text-sm">{t.channel}</TableCell>
                    <TableCell>
                      <Badge variant={t.isActive ? "default" : "secondary"} className="text-xs">
                        {t.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {canEditTemplates ? (
                        <Button variant="outline" size="sm" className="min-h-11" onClick={() => setEditingTemplateId(t.id)} data-testid={`button-edit-template-${t.id}`}>
                          Edit and preview
                        </Button>
                      ) : <span className="text-xs text-muted-foreground">Admin or manager</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <ReceiptWordingPreview canView={canEditTemplates} />
        </CardContent>
      </Card>
      <MessageTemplateEditor
        templateId={editingTemplateId}
        canEdit={canEditTemplates}
        canActivate={user?.role === "admin"}
        onClose={() => setEditingTemplateId(null)}
      />

      <InboundAcknowledgementCard canControl={user?.role === "admin"} />

      <Card data-testid="card-ghl-backfill">
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base">GHL Contact ID Backfill</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Looks up existing GHL contacts by email for local contacts missing a GHL Contact ID. The operation runs as a durable, bounded server command. Starting the command only queues work.
          </p>
          {backfillStatus && (
            <div className="flex gap-6 text-sm">
              <span data-testid="text-backfill-total">Total contacts: <strong>{backfillStatus.totalContacts}</strong></span>
              <span data-testid="text-backfill-missing">
                Missing GHL ID:{" "}
                <strong className={backfillStatus.missingGhlId > 0 ? "text-amber-600" : "text-muted-foreground"}>
                  {backfillStatus.missingGhlId}
                </strong>
              </span>
            </div>
          )}
          {user?.role === "admin" && <GhlCommandAction
            title="Backfill missing GHL contact IDs"
            description="Queues a durable backfill command. Progress, bounded steps, terminal failures, and actual errors are polled from the server-provided command status URL."
            endpoint="/api/admin/backfill-ghl-contacts"
            testId="ghl-backfill-command"
            statusEndpointToInvalidate="/api/admin/backfill-ghl-contacts/status"
          />}
        </CardContent>
      </Card>

      {/* ── Semantic GHL Pipeline Stage Mapping ─────────────────────────────── */}
      <Card data-testid="card-ghl-stage-map">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base">Pipeline Stage Mapping</CardTitle>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchStages()}
                disabled={stagesLoading}
                className="gap-2"
                data-testid="button-refresh-stages"
              >
                {stagesLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Refresh discovery
              </Button>
              {user?.role === "admin" && (
                <Button
                  size="sm"
                  onClick={() => saveStageMapMutation.mutate(draftStageMappings)}
                  disabled={saveStageMapMutation.isPending || !stageMapChanged}
                  className="gap-2"
                  data-testid="button-save-stage-map"
                >
                  {saveStageMapMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Save explicit ID mappings
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Map existing local pipeline/stage IDs to existing GHL pipeline/stage IDs. Displayed names are labels only and never select a match automatically. This screen does not create or mutate remote GHL stages.
          </p>

          {stageMapError && (
            <Alert variant="destructive">
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription>Version 2 semantic stage mappings are unavailable. Legacy title mappings will not be used as authority.</AlertDescription>
            </Alert>
          )}
          {stagesError && (
            <Alert variant="destructive" data-testid="alert-stage-discovery-unavailable">
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription>
                Local semantic stage IDs and read-only GHL pipeline/stage identities are unavailable. No title-based mapping is substituted.
              </AlertDescription>
            </Alert>
          )}
          {savedStageMap?.legacyDeprecated && Object.keys(savedStageMap.legacyStageMap ?? {}).length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100" data-testid="text-legacy-stage-map">
              Deprecated legacy title-keyed map is read-only ({Object.keys(savedStageMap.legacyStageMap ?? {}).length} entr{Object.keys(savedStageMap.legacyStageMap ?? {}).length === 1 ? "y" : "ies"}). It is not used to choose or save semantic mappings.
            </div>
          )}
          {((pipelineStages?.pipelines?.length ?? 0) > 0 || localPipelineOptions.length > 0) && (
            <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" data-testid="text-pipeline-id">
              {localPipelineOptions.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Local pipeline</div>
                  <Select value={selectedLocalPipeline} onValueChange={setSelectedLocalPipeline}>
                    <SelectTrigger aria-label="Select local pipeline"><SelectValue placeholder="Choose local pipeline" /></SelectTrigger>
                    <SelectContent>
                      {localPipelineOptions.map((pipelineId) => (
                        <SelectItem key={pipelineId} value={pipelineId}>{pipelineId}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Local pipeline identity: Unknown</div>
              )}
              <div className="text-xs text-muted-foreground">
                <div>Existing GHL pipelines discovered: {pipelineStages?.pipelines?.length ?? "Unknown"}</div>
                <div>Mapping policy: {pipelineStages?.matchingPolicy ?? "Unknown"}</div>
              </div>
            </div>
          )}

          {stagesLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading local and existing GHL pipeline identities…
            </div>
          )}
          {!stagesLoading && pipelineStages && visibleLocalStages.length === 0 && (
            <div className="text-sm text-muted-foreground py-4 text-center">No local stages were returned for this pipeline.</div>
          )}
          {!stagesLoading && visibleLocalStages.length > 0 && (
            <div className="space-y-3" data-testid="table-stage-map">
              {visibleLocalStages.map((localStage) => {
                const current = draftStageMappings.find((mapping) =>
                  mapping.localPipelineId === localStage.pipeline && mapping.localStageId === localStage.id
                );
                const mappingKey = `${localStage.pipeline}:${localStage.id}`;
                const externalPipelineId = draftExternalPipelineIds[mappingKey] ?? current?.ghlPipelineId ?? pipelineStages?.pipelines?.[0]?.id ?? "";
                const selectedExternalPipeline = pipelineStages?.pipelines?.find((pipeline) => pipeline.id === externalPipelineId);
                const selectedGhlStage = selectedExternalPipeline?.stages.find((stage) => stage.id === current?.ghlStageId);
                return (
                  <div key={`${localStage.pipeline}-${localStage.id}`} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{localStage.stageName}</div>
                      <div className="break-all font-mono text-xs text-muted-foreground">
                        Local pipeline ID: {localStage.pipeline} · Local stage ID: {localStage.id}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="mb-2">
                        <Select
                          value={externalPipelineId || "__unavailable"}
                          disabled={user?.role !== "admin" || !(pipelineStages?.pipelines?.length ?? 0)}
                          onValueChange={(ghlPipelineId) => {
                            setDraftExternalPipelineIds((previous) => ({ ...previous, [mappingKey]: ghlPipelineId }));
                            setDraftStageMappings((previous) => previous.filter((mapping) =>
                              !(mapping.localPipelineId === localStage.pipeline && mapping.localStageId === localStage.id)
                            ));
                          }}
                        >
                          <SelectTrigger aria-label={`Choose GHL pipeline for ${localStage.stageName}`} data-testid={`select-ghl-pipeline-${localStage.id}`}>
                            <SelectValue placeholder="Choose an existing GHL pipeline" />
                          </SelectTrigger>
                          <SelectContent>
                            {pipelineStages?.pipelines?.length
                              ? pipelineStages.pipelines.map((pipeline) => (
                                  <SelectItem key={pipeline.id} value={pipeline.id}>{pipeline.name} — {pipeline.id}</SelectItem>
                                ))
                              : <SelectItem value="__unavailable" disabled>GHL pipeline IDs unavailable</SelectItem>}
                          </SelectContent>
                        </Select>
                      </div>
                      <Select
                        value={current?.ghlPipelineId === externalPipelineId ? current.ghlStageId : "__unmapped"}
                        disabled={user?.role !== "admin" || !selectedExternalPipeline}
                        onValueChange={(ghlStageId) => {
                          setDraftStageMappings((previous) => {
                            const withoutCurrent = previous.filter((mapping) =>
                              !(mapping.localPipelineId === localStage.pipeline && mapping.localStageId === localStage.id)
                            );
                            if (ghlStageId === "__unmapped") return withoutCurrent;
                            return [...withoutCurrent, {
                              localPipelineId: localStage.pipeline,
                              localStageId: localStage.id,
                              ghlPipelineId: externalPipelineId,
                              ghlStageId,
                            }];
                          });
                        }}
                      >
                        <SelectTrigger aria-label={`Map ${localStage.stageName} by GHL stage ID`} data-testid={`select-ghl-stage-${localStage.id}`}>
                          <SelectValue placeholder="Select an existing GHL stage" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unmapped">Not explicitly mapped</SelectItem>
                          {(selectedExternalPipeline?.stages ?? []).map((ghlStage) => (
                            <SelectItem key={ghlStage.id} value={ghlStage.id}>
                              {ghlStage.name} — {ghlStage.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="mt-1 break-all text-xs text-muted-foreground">
                        GHL pipeline ID: {(current?.ghlPipelineId ?? externalPipelineId) || "Unknown"} · GHL stage ID: {current?.ghlStageId ?? "Not explicitly mapped"}
                        {selectedGhlStage ? ` (${selectedGhlStage.name})` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-sla-configs">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">SLA Configurations</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {slaLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : !slaConfigs || slaConfigs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-sla-empty">
              No SLA configurations defined
            </p>
          ) : (
            <Table data-testid="table-sla-configs">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Entity Type</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Max Duration</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slaConfigs.map((sla) => (
                  <TableRow key={sla.id} data-testid={`row-sla-${sla.id}`}>
                    <TableCell className="text-sm font-medium">{sla.name}</TableCell>
                    <TableCell className="text-sm">{sla.entityType}</TableCell>
                    <TableCell className="text-sm">{sla.stage || "-"}</TableCell>
                    <TableCell className="text-sm">
                      {sla.maxDurationMinutes >= 60
                        ? `${Math.floor(sla.maxDurationMinutes / 60)}h ${sla.maxDurationMinutes % 60}m`
                        : `${sla.maxDurationMinutes}m`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={sla.isActive ? "default" : "secondary"} className="text-xs">
                        {sla.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
