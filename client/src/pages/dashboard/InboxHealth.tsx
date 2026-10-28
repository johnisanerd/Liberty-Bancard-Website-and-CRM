import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2, Mail, Shield, AlertTriangle, Plus, Trash2, RefreshCw, Activity, Server, Gauge, Pause, Play, Settings, TrendingUp, BarChart3 } from "lucide-react";
import { useState } from "react";
import { VERTICALS } from "@shared/schema";

interface SendingIdentity {
  id: number;
  label: string;
  domain: string;
  emailAddress: string;
  mailboxType: string | null;
  provider: string | null;
  ghlLocationId: string | null;
  isActive: boolean | null;
  warmupStatus: string | null;
  warmupStartedAt: string | null;
  dailyLimit: number | null;
  sentToday: number | null;
  bouncesToday: number | null;
  complaintsToday: number | null;
  healthScore: number | null;
  verticalAssignment: string | null;
  lastUsedAt: string | null;
}

interface InboxHealthData {
  identities: (SendingIdentity & {
    effectiveDailyLimit: number;
    last7Days: {
      sent: number;
      bounced: number;
      opened: number;
      replied: number;
      complaints: number;
      bounceRate: number;
      openRate: number;
      replyRate: number;
      complaintRate: number;
    };
  })[];
  totalCapacity: number;
  usedCapacity: number;
  activeCount: number;
  warmingCount: number;
  pausedCount: number;
}

function CapacityOverview({ data }: { data: InboxHealthData }) {
  const utilizationPct = data.totalCapacity > 0 ? Math.round((data.usedCapacity / data.totalCapacity) * 100) : 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="inbox-capacity-overview">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Server className="w-4 h-4 text-blue-600" />
            <span className="text-xs text-muted-foreground">Total Inboxes</span>
          </div>
          <div className="text-2xl font-bold" data-testid="value-total-inboxes">{data.identities.length}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-green-600" />
            <span className="text-xs text-muted-foreground">Active</span>
          </div>
          <div className="text-2xl font-bold" data-testid="value-active-inboxes">{data.activeCount}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw className="w-4 h-4 text-yellow-600" />
            <span className="text-xs text-muted-foreground">Warming</span>
          </div>
          <div className="text-2xl font-bold" data-testid="value-warming-inboxes">{data.warmingCount}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Pause className="w-4 h-4 text-red-600" />
            <span className="text-xs text-muted-foreground">Paused</span>
          </div>
          <div className="text-2xl font-bold" data-testid="value-paused-inboxes">{data.pausedCount}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Gauge className="w-4 h-4 text-purple-600" />
            <span className="text-xs text-muted-foreground">Capacity Used</span>
          </div>
          <div className="text-2xl font-bold" data-testid="value-capacity-used">
            {data.usedCapacity}/{data.totalCapacity}
          </div>
          <div className="text-xs text-muted-foreground">{utilizationPct}%</div>
        </CardContent>
      </Card>
    </div>
  );
}

function getHealthBadge(score: number | null) {
  const s = score ?? 100;
  if (s >= 80) return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">{s.toFixed(0)}</Badge>;
  if (s >= 60) return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">{s.toFixed(0)}</Badge>;
  return <Badge variant="destructive">{s.toFixed(0)}</Badge>;
}

function getWarmupBadge(status: string | null) {
  switch (status) {
    case "warm": return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Warm</Badge>;
    case "warming": return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">Warming</Badge>;
    case "paused": return <Badge variant="destructive">Paused</Badge>;
    case "disabled": return <Badge variant="secondary">Disabled</Badge>;
    default: return <Badge variant="outline">{status || "Unknown"}</Badge>;
  }
}

function EditInboxDialog({ identity, onClose }: { identity: SendingIdentity; onClose: () => void }) {
  const { toast } = useToast();
  const [dailyLimit, setDailyLimit] = useState(String(identity.dailyLimit || 30));
  const [warmupStatus, setWarmupStatus] = useState(identity.warmupStatus || "warming");
  const [label, setLabel] = useState(identity.label);
  const [vertical, setVertical] = useState(identity.verticalAssignment || "");

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      await apiRequest("PUT", `/api/sdr/sending-identities/${identity.id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: "Inbox settings updated" });
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Failed to update inbox", description: err.message, variant: "destructive" });
    },
  });

  return (
    <DialogContent data-testid="edit-inbox-dialog">
      <DialogHeader>
        <DialogTitle>Edit Inbox: {identity.emailAddress}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 pt-4">
        <div>
          <label className="text-sm font-medium">Label</label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="input-edit-label" />
        </div>
        <div>
          <label className="text-sm font-medium">Daily Send Limit</label>
          <Input type="number" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} min="20" max="35" data-testid="input-edit-daily-limit" />
          <p className="text-xs text-muted-foreground mt-1">Max emails per day for this inbox (20-35 for safe deliverability)</p>
        </div>
        <div>
          <label className="text-sm font-medium">Warmup Status</label>
          <Select value={warmupStatus} onValueChange={setWarmupStatus}>
            <SelectTrigger data-testid="select-edit-warmup-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="warming">Warming</SelectItem>
              <SelectItem value="warm">Warm</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Warming: ramps up gradually. Warm: full capacity.</p>
        </div>
        <div>
          <label className="text-sm font-medium">Vertical Assignment (optional)</label>
          <Input value={vertical} onChange={(e) => setVertical(e.target.value)} placeholder="e.g. restaurant, retail" data-testid="input-edit-vertical" />
        </div>
        <Button
          className="w-full"
          disabled={updateMutation.isPending}
          onClick={() => updateMutation.mutate({
            label,
            dailyLimit: parseInt(dailyLimit) || 30,
            warmupStatus,
            verticalAssignment: vertical || null,
          })}
          data-testid="button-save-inbox-settings"
        >
          {updateMutation.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </DialogContent>
  );
}

function IdentityHealthTable({ data }: { data: InboxHealthData }) {
  const { toast } = useToast();
  const [editingIdentity, setEditingIdentity] = useState<SendingIdentity | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const bulkActionMutation = useMutation({
    mutationFn: async ({ action, identityIds }: { action: "pause" | "resume"; identityIds: number[] }) => {
      await apiRequest("POST", "/api/sdr/sending-identities/bulk-action", { action, identityIds });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: `${variables.action === "pause" ? "Paused" : "Resumed"} ${variables.identityIds.length} inbox(es)` });
      setSelectedIds(new Set());
    },
    onError: (err: any) => {
      toast({ title: "Bulk action failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleSelected = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === data.identities.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.identities.map(i => i.id)));
    }
  };

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      await apiRequest("PUT", `/api/sdr/sending-identities/${id}`, { isActive });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
    },
    onError: (err: any) => {
      toast({ title: "Toggle failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/sdr/sending-identities/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: "Inbox removed" });
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("PUT", `/api/sdr/sending-identities/${id}`, { warmupStatus: "warming", isActive: true, warmupStartedAt: new Date().toISOString() });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: "Inbox resumed in warmup mode" });
    },
    onError: (err: any) => {
      toast({ title: "Resume failed", description: err.message, variant: "destructive" });
    },
  });

  if (data.identities.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground" data-testid="empty-identities">
        No sending identities configured yet. Add inboxes to start rotating.
      </div>
    );
  }

  return (
    <>
      <Dialog open={!!editingIdentity} onOpenChange={(open) => { if (!open) setEditingIdentity(null); }}>
        {editingIdentity && <EditInboxDialog identity={editingIdentity} onClose={() => setEditingIdentity(null)} />}
      </Dialog>
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 mb-3 bg-muted rounded-lg" data-testid="bulk-action-bar">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => bulkActionMutation.mutate({ action: "pause", identityIds: Array.from(selectedIds) })}
            disabled={bulkActionMutation.isPending}
            data-testid="button-bulk-pause"
          >
            <Pause className="w-3 h-3 mr-1" />
            Pause Selected
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => bulkActionMutation.mutate({ action: "resume", identityIds: Array.from(selectedIds) })}
            disabled={bulkActionMutation.isPending}
            data-testid="button-bulk-resume"
          >
            <Play className="w-3 h-3 mr-1" />
            Resume Selected
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())} data-testid="button-clear-selection">Clear</Button>
        </div>
      )}
      <div className="overflow-x-auto" data-testid="identity-health-table">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="p-3 w-8">
                <input
                  type="checkbox"
                  checked={selectedIds.size === data.identities.length && data.identities.length > 0}
                  onChange={toggleAll}
                  className="rounded"
                  data-testid="checkbox-select-all"
                />
              </th>
              <th className="text-left p-3 font-medium">Inbox</th>
              <th className="text-left p-3 font-medium">Domain</th>
              <th className="text-center p-3 font-medium">Status</th>
              <th className="text-center p-3 font-medium">Health</th>
              <th className="text-center p-3 font-medium">Sent Today</th>
              <th className="text-center p-3 font-medium">Limit</th>
              <th className="text-center p-3 font-medium">7d Bounce%</th>
              <th className="text-center p-3 font-medium">7d Open%</th>
              <th className="text-center p-3 font-medium">7d Reply%</th>
              <th className="text-center p-3 font-medium">7d Complaint%</th>
              <th className="text-center p-3 font-medium">Active</th>
              <th className="text-center p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.identities.map((identity) => (
              <tr key={identity.id} className="border-b hover:bg-muted/50" data-testid={`identity-row-${identity.id}`}>
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(identity.id)}
                    onChange={() => toggleSelected(identity.id)}
                    className="rounded"
                    data-testid={`checkbox-select-${identity.id}`}
                  />
                </td>
                <td className="p-3">
                  <div className="font-medium">{identity.label}</div>
                  <div className="text-xs text-muted-foreground">{identity.emailAddress}</div>
                </td>
                <td className="p-3 text-muted-foreground">{identity.domain}</td>
                <td className="p-3 text-center">{getWarmupBadge(identity.warmupStatus)}</td>
                <td className="p-3 text-center">{getHealthBadge(identity.healthScore)}</td>
                <td className="p-3 text-center font-medium">{identity.sentToday || 0}</td>
                <td className="p-3 text-center text-muted-foreground">{identity.effectiveDailyLimit}</td>
                <td className="p-3 text-center">
                  <span className={identity.last7Days.bounceRate > 0.05 ? "text-red-600 font-medium" : ""}>
                    {(identity.last7Days.bounceRate * 100).toFixed(1)}%
                  </span>
                </td>
                <td className="p-3 text-center">{(identity.last7Days.openRate * 100).toFixed(1)}%</td>
                <td className="p-3 text-center">{(identity.last7Days.replyRate * 100).toFixed(1)}%</td>
                <td className="p-3 text-center">
                  <span className={identity.last7Days.complaintRate > 0.001 ? "text-red-600 font-medium" : ""}>
                    {(identity.last7Days.complaintRate * 100).toFixed(2)}%
                  </span>
                </td>
                <td className="p-3 text-center">
                  <Switch
                    checked={identity.isActive ?? false}
                    onCheckedChange={(checked) => toggleMutation.mutate({ id: identity.id, isActive: checked })}
                    data-testid={`toggle-active-${identity.id}`}
                  />
                </td>
                <td className="p-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingIdentity(identity)}
                      data-testid={`button-edit-${identity.id}`}
                    >
                      <Settings className="w-3 h-3" />
                    </Button>
                    {identity.warmupStatus === "paused" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resumeMutation.mutate(identity.id)}
                        data-testid={`button-resume-${identity.id}`}
                      >
                        <Play className="w-3 h-3" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm("Remove this inbox?")) deleteMutation.mutate(identity.id);
                      }}
                      data-testid={`button-delete-${identity.id}`}
                    >
                      <Trash2 className="w-3 h-3 text-red-500" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AddIdentityDialog() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const [form, setForm] = useState({
    label: "",
    domain: "",
    emailAddress: "",
    mailboxType: "google_workspace",
    provider: "",
    dailyLimit: 30,
    warmupStatus: "warming",
    verticalAssignment: "",
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/sdr/sending-identities", {
        ...form,
        verticalAssignment: form.verticalAssignment || null,
        provider: form.provider || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: "Inbox added" });
      setOpen(false);
      setForm({ label: "", domain: "", emailAddress: "", mailboxType: "google_workspace", provider: "", dailyLimit: 30, warmupStatus: "warming", verticalAssignment: "" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-add-inbox">
          <Plus className="w-4 h-4 mr-2" />
          Add Inbox
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid="dialog-add-inbox">
        <DialogHeader>
          <DialogTitle>Add Sending Identity</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Label</Label>
            <Input
              placeholder="e.g. Liberty Sales 1"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              data-testid="input-label"
            />
          </div>
          <div>
            <Label>Domain</Label>
            <Input
              placeholder="e.g. libertypayments.co"
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              data-testid="input-domain"
            />
          </div>
          <div>
            <Label>Email Address</Label>
            <Input
              placeholder="e.g. sales1@libertypayments.co"
              value={form.emailAddress}
              onChange={(e) => setForm({ ...form, emailAddress: e.target.value })}
              data-testid="input-email"
            />
          </div>
          <div>
            <Label>Mailbox Type</Label>
            <Select value={form.mailboxType} onValueChange={(v) => setForm({ ...form, mailboxType: v })}>
              <SelectTrigger data-testid="select-mailbox-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google_workspace">Google Workspace</SelectItem>
                <SelectItem value="microsoft_365">Microsoft 365</SelectItem>
                <SelectItem value="smtp">SMTP</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Daily Limit (20-35)</Label>
            <Input
              type="number"
              min="20"
              max="35"
              value={form.dailyLimit}
              onChange={(e) => setForm({ ...form, dailyLimit: Math.max(20, Math.min(35, parseInt(e.target.value) || 30)) })}
              data-testid="input-daily-limit"
            />
          </div>
          <div>
            <Label>Initial Status</Label>
            <Select value={form.warmupStatus} onValueChange={(v) => setForm({ ...form, warmupStatus: v })}>
              <SelectTrigger data-testid="select-warmup-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="warming">Warming (start at 5/day)</SelectItem>
                <SelectItem value="warm">Warm (full capacity)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Vertical Assignment (optional)</Label>
            <Select value={form.verticalAssignment || "none"} onValueChange={(v) => setForm({ ...form, verticalAssignment: v === "none" ? "" : v })}>
              <SelectTrigger data-testid="select-vertical">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Any Vertical</SelectItem>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!form.label || !form.domain || !form.emailAddress || createMutation.isPending}
            className="w-full"
            data-testid="button-submit-inbox"
          >
            {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Add Inbox
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DomainSummary({ data }: { data: InboxHealthData }) {
  const domainMap = new Map<string, { count: number; active: number; capacity: number; sent: number; avgHealth: number }>();

  for (const identity of data.identities) {
    const entry = domainMap.get(identity.domain) || { count: 0, active: 0, capacity: 0, sent: 0, avgHealth: 0 };
    entry.count++;
    if (identity.isActive && (identity.warmupStatus === "warm" || identity.warmupStatus === "warming")) entry.active++;
    entry.capacity += identity.effectiveDailyLimit;
    entry.sent += identity.sentToday || 0;
    entry.avgHealth += identity.healthScore || 0;
    domainMap.set(identity.domain, entry);
  }

  const domains = Array.from(domainMap.entries()).map(([domain, stats]) => ({
    domain,
    ...stats,
    avgHealth: stats.count > 0 ? stats.avgHealth / stats.count : 0,
  }));

  if (domains.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground" data-testid="empty-domains">
        No domains configured. Add sending identities to see domain health.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="domain-summary">
      {domains.map((d) => (
        <Card key={d.domain} data-testid={`domain-card-${d.domain}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="font-medium text-sm">{d.domain}</div>
              {getHealthBadge(d.avgHealth)}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Inboxes: </span>
                <span className="font-medium">{d.active}/{d.count}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Capacity: </span>
                <span className="font-medium">{d.capacity}/day</span>
              </div>
              <div>
                <span className="text-muted-foreground">Sent Today: </span>
                <span className="font-medium">{d.sent}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Avg Health: </span>
                <span className="font-medium">{d.avgHealth.toFixed(0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface SendMonitoringIdentity {
  id: number;
  label: string;
  domain: string;
  emailAddress: string;
  isActive: boolean | null;
  warmupStatus: string | null;
  warmupProgress: number;
  warmupDays: number;
  dailyLimit: number;
  sentToday: number;
  bouncesToday: number;
  complaintsToday: number;
  healthScore: number | null;
  capUtilization: number;
  week: {
    sent: number;
    delivered: number;
    bounced: number;
    replied: number;
    complaints: number;
    opened: number;
    positiveReplies: number;
    bounceRate: number;
    replyRate: number;
    complaintRate: number;
    openRate: number;
  };
}

function WarmupAndCapPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ identities: SendMonitoringIdentity[]; aggregated: any }>({
    queryKey: ["/api/sdr/operator/send-monitoring"],
    refetchInterval: 30000,
  });

  const pauseMutation = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "pause" | "resume" }) => {
      const updates = action === "pause"
        ? { warmupStatus: "paused", isActive: false }
        : { warmupStatus: "warming", isActive: true, warmupStartedAt: new Date().toISOString() };
      await apiRequest("PUT", `/api/sdr/sending-identities/${id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/operator/send-monitoring"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      toast({ title: "Identity status updated" });
    },
    onError: (err: any) => {
      toast({ title: "Status update failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="warmup-cap-panel">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4 text-green-600" />
              <span className="text-xs text-muted-foreground">Total Sent Today</span>
            </div>
            <div className="text-2xl font-bold">{data.aggregated.totalSentToday}</div>
            <div className="text-xs text-muted-foreground">of {data.aggregated.totalDailyLimit} limit</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-purple-600" />
              <span className="text-xs text-muted-foreground">Overall Capacity</span>
            </div>
            <div className="text-2xl font-bold">{data.aggregated.overallCapUtilization}%</div>
            <Progress value={data.aggregated.overallCapUtilization} className="h-2 mt-2" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-blue-600" />
              <span className="text-xs text-muted-foreground">Active</span>
            </div>
            <div className="text-2xl font-bold">{data.aggregated.activeIdentities}</div>
            <div className="text-xs text-muted-foreground">of {data.aggregated.totalIdentities} total</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw className="w-4 h-4 text-yellow-600" />
              <span className="text-xs text-muted-foreground">Warming</span>
            </div>
            <div className="text-2xl font-bold">{data.identities.filter(i => i.warmupStatus === "warming").length}</div>
          </CardContent>
        </Card>
      </div>

      {data.identities.map((identity) => (
        <Card key={identity.id} data-testid={`warmup-identity-${identity.id}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div>
                  <div className="font-medium text-sm">{identity.label}</div>
                  <div className="text-xs text-muted-foreground">{identity.emailAddress}</div>
                </div>
                {getWarmupBadge(identity.warmupStatus)}
              </div>
              <div className="flex items-center gap-2">
                {identity.warmupStatus === "paused" || !identity.isActive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => pauseMutation.mutate({ id: identity.id, action: "resume" })}
                    disabled={pauseMutation.isPending}
                    data-testid={`button-resume-identity-${identity.id}`}
                  >
                    <Play className="w-3 h-3 mr-1" /> Resume
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => pauseMutation.mutate({ id: identity.id, action: "pause" })}
                    disabled={pauseMutation.isPending}
                    data-testid={`button-pause-identity-${identity.id}`}
                  >
                    <Pause className="w-3 h-3 mr-1" /> Pause
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span>Daily Cap: {identity.sentToday} / {identity.dailyLimit}</span>
                  <span>{identity.capUtilization}%</span>
                </div>
                <Progress value={identity.capUtilization} className="h-2" />
              </div>

              {identity.warmupStatus === "warming" && (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span>Warmup: Day {identity.warmupDays} of 14</span>
                    <span>{identity.warmupProgress}%</span>
                  </div>
                  <Progress value={identity.warmupProgress} className="h-2" />
                </div>
              )}

              <div className="grid grid-cols-4 gap-3 text-xs mt-2">
                <div className="text-center">
                  <div className="text-muted-foreground">7d Bounce</div>
                  <div className={`font-medium ${identity.week.bounceRate > 5 ? "text-red-600" : ""}`}>
                    {identity.week.bounceRate}%
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                    <div
                      className={`h-1.5 rounded-full ${identity.week.bounceRate > 5 ? "bg-red-500" : "bg-green-500"}`}
                      style={{ width: `${Math.min(identity.week.bounceRate * 10, 100)}%` }}
                    />
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground">7d Reply</div>
                  <div className="font-medium text-green-600">{identity.week.replyRate}%</div>
                  <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                    <div className="h-1.5 rounded-full bg-green-500" style={{ width: `${Math.min(identity.week.replyRate * 5, 100)}%` }} />
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground">7d Complaint</div>
                  <div className={`font-medium ${identity.week.complaintRate > 0.1 ? "text-red-600" : ""}`}>
                    {identity.week.complaintRate}%
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                    <div
                      className={`h-1.5 rounded-full ${identity.week.complaintRate > 0.1 ? "bg-red-500" : "bg-green-500"}`}
                      style={{ width: `${Math.min(identity.week.complaintRate * 100, 100)}%` }}
                    />
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground">Health</div>
                  <div className="font-medium">{identity.healthScore != null ? Math.round(identity.healthScore) : "—"}</div>
                  <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                    <div
                      className={`h-1.5 rounded-full ${identity.healthScore == null ? "bg-muted-foreground/30" : identity.healthScore >= 80 ? "bg-green-500" : identity.healthScore >= 60 ? "bg-yellow-500" : "bg-red-500"}`}
                      style={{ width: `${identity.healthScore ?? 0}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function InboxHealth() {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useQuery<InboxHealthData>({
    queryKey: ["/api/sdr/inbox-health"],
    refetchInterval: 30000,
  });

  const maintenanceMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/sdr/inbox-maintenance");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      toast({ title: "Daily maintenance completed" });
    },
    onError: (err: any) => {
      toast({ title: "Maintenance failed", description: err.message, variant: "destructive" });
    },
  });

  const healthScoreMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/sdr/inbox-health-scores");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/inbox-health"] });
      toast({ title: "Health scores recalculated" });
    },
    onError: (err: any) => {
      toast({ title: "Health score recalculation failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center py-24" data-testid="page-inbox-health-error">
        <div className="text-center">
          <AlertTriangle className="w-8 h-8 text-destructive mx-auto mb-2" />
          <p className="text-sm text-muted-foreground mb-3">Failed to load inbox health data</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-inbox-health">
            <RefreshCw className="w-4 h-4 mr-1" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  const dashboardData = data || {
    identities: [],
    totalCapacity: 0,
    usedCapacity: 0,
    activeCount: 0,
    warmingCount: 0,
    pausedCount: 0,
  };

  const degradedInboxes = dashboardData.identities.filter(
    (i) => (i.healthScore ?? 100) < 70 && i.isActive
  );

  return (
    <div className="space-y-6" data-testid="page-inbox-health">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight" data-testid="text-inbox-title">
            Inbox Rotation & Deliverability
          </h2>
          <p className="text-muted-foreground">
            Manage sending identities, warmup schedules, and monitor deliverability health
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => healthScoreMutation.mutate()}
            disabled={healthScoreMutation.isPending}
            data-testid="button-recalc-health"
          >
            {healthScoreMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Shield className="w-4 h-4 mr-1" />}
            Recalculate Health
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => maintenanceMutation.mutate()}
            disabled={maintenanceMutation.isPending}
            data-testid="button-run-maintenance"
          >
            {maintenanceMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Run Maintenance
          </Button>
          <AddIdentityDialog />
        </div>
      </div>

      {degradedInboxes.length > 0 && (
        <Card className="border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950" data-testid="alert-degraded-inboxes">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-5 h-5 text-yellow-600" />
              <span className="font-medium text-yellow-800 dark:text-yellow-200">Degraded Inboxes</span>
            </div>
            <div className="text-sm text-yellow-700 dark:text-yellow-300">
              {degradedInboxes.length} inbox(es) have health scores below 70: {degradedInboxes.map(i => i.label).join(", ")}
            </div>
          </CardContent>
        </Card>
      )}

      <CapacityOverview data={dashboardData} />

      <Tabs defaultValue="inboxes" data-testid="tabs-inbox-health">
        <TabsList>
          <TabsTrigger value="inboxes" data-testid="tab-inboxes">
            <Mail className="w-4 h-4 mr-1" />
            Inboxes
          </TabsTrigger>
          <TabsTrigger value="warmup" data-testid="tab-warmup">
            <TrendingUp className="w-4 h-4 mr-1" />
            Warmup & Cap
          </TabsTrigger>
          <TabsTrigger value="domains" data-testid="tab-domains">
            <Server className="w-4 h-4 mr-1" />
            Domains
          </TabsTrigger>
        </TabsList>

        <TabsContent value="inboxes" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="w-5 h-5" />
                Identity Health Dashboard
              </CardTitle>
            </CardHeader>
            <CardContent>
              <IdentityHealthTable data={dashboardData} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="warmup" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5" />
                Warmup Progress & Capacity Utilization
              </CardTitle>
            </CardHeader>
            <CardContent>
              <WarmupAndCapPanel />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="domains" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Server className="w-5 h-5" />
                Domain Overview
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DomainSummary data={dashboardData} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
