/**
 * Communication Arbitration Log
 *
 * Shows recent suppression events so ops can see when automation was held back
 * and tune the suppression windows without a code change.
 *
 * Route: /dashboard/settings/arbitration
 * Access: admin, manager
 */

import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Shield, Clock, RefreshCw, User, Bot, AlertCircle, CheckCircle2, Settings2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArbitrationWindows {
  humanTouchWindowHours: number;
  autoSendWindowMinutes: number;
  replyPendingWindowHours: number;
}

interface SuppressionEvent {
  id: number;
  contactId: number | null;
  details: {
    channel?: string;
    signal?: string;
    reason?: string;
    resumeAfter?: string;
  } | null;
  createdAt: string;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
  } | null;
}

interface SuppressionResponse {
  items: SuppressionEvent[];
  total: number;
  days: number;
  since: string;
}

// ─── Signal badge ─────────────────────────────────────────────────────────────

const SIGNAL_META: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  human_touch:       { label: "Human Touch",        variant: "default" },
  recent_auto_send:  { label: "Recent Auto-Send",   variant: "secondary" },
  reply_pending:     { label: "Unanswered Reply",   variant: "destructive" },
  appointment_proximity: { label: "Appointment",   variant: "outline" },
};

function SignalBadge({ signal }: { signal?: string }) {
  if (!signal) return null;
  const meta = SIGNAL_META[signal] ?? { label: signal, variant: "outline" as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function ChannelBadge({ channel }: { channel?: string }) {
  if (!channel) return null;
  return (
    <Badge variant="outline" className="uppercase text-xs font-mono">
      {channel}
    </Badge>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ArbitrationLog() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(7);
  const [editingWindows, setEditingWindows] = useState(false);
  const [windowDraft, setWindowDraft] = useState<Partial<ArbitrationWindows>>({});

  // Suppression events
  const { data: suppressions, isLoading: suppLoading, refetch: refetchSupp } = useQuery<SuppressionResponse>({
    queryKey: ["/api/admin/arbitration-suppressions", days],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/arbitration-suppressions?days=${days}&limit=200`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  // Window settings
  const { data: windows, isLoading: winLoading } = useQuery<ArbitrationWindows>({
    queryKey: ["/api/admin/arbitration-windows"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/arbitration-windows");
      return res.json();
    },
  });

  // Update windows mutation
  const updateWindowsMutation = useMutation({
    mutationFn: async (patch: Partial<ArbitrationWindows>) => {
      const res = await apiRequest("PATCH", "/api/admin/arbitration-windows", patch);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/arbitration-windows"] });
      toast({ title: "Suppression windows updated", description: "Changes take effect immediately." });
      setEditingWindows(false);
      setWindowDraft({});
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err?.message ?? "Could not save", variant: "destructive" });
    },
  });

  function startEdit() {
    if (windows) setWindowDraft({ ...windows });
    setEditingWindows(true);
  }

  function cancelEdit() {
    setEditingWindows(false);
    setWindowDraft({});
  }

  function saveWindows() {
    const patch: Partial<ArbitrationWindows> = {};
    if (windowDraft.humanTouchWindowHours !== undefined)
      patch.humanTouchWindowHours = Number(windowDraft.humanTouchWindowHours);
    if (windowDraft.autoSendWindowMinutes !== undefined)
      patch.autoSendWindowMinutes = Number(windowDraft.autoSendWindowMinutes);
    if (windowDraft.replyPendingWindowHours !== undefined)
      patch.replyPendingWindowHours = Number(windowDraft.replyPendingWindowHours);
    updateWindowsMutation.mutate(patch);
  }

  const items = suppressions?.items ?? [];

  // Group by signal for summary
  const signalCounts: Record<string, number> = {};
  for (const item of items) {
    const sig = item.details?.signal ?? "unknown";
    signalCounts[sig] = (signalCounts[sig] ?? 0) + 1;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="h-5 w-5 text-primary" />
            <PageTitle className="text-2xl font-semibold tracking-tight">Communication Arbitration</PageTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            Tracks when automation was suppressed because a rep recently touched a prospect,
            a recent automated send was too soon, or an inbound reply is waiting for a human response.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetchSupp()}>
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Suppression Windows Config */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Settings2 className="h-4 w-4" /> Suppression Windows
              </CardTitle>
              <CardDescription>
                How long after a triggering event automation is held back. Changes take effect immediately.
              </CardDescription>
            </div>
            {!editingWindows && (
              <Button variant="outline" size="sm" onClick={startEdit} disabled={winLoading}>
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {winLoading ? (
            <p className="text-sm text-muted-foreground">Loading settings…</p>
          ) : editingWindows ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="humanWindow">Human touch window (hours)</Label>
                  <Input
                    id="humanWindow"
                    type="number"
                    min={0}
                    max={72}
                    value={windowDraft.humanTouchWindowHours ?? ""}
                    onChange={e => setWindowDraft(d => ({ ...d, humanTouchWindowHours: e.target.valueAsNumber }))}
                  />
                  <p className="text-xs text-muted-foreground">Suppress auto-sends for this many hours after any rep activity.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="autoWindow">Auto-send cooldown (minutes)</Label>
                  <Input
                    id="autoWindow"
                    type="number"
                    min={0}
                    max={1440}
                    value={windowDraft.autoSendWindowMinutes ?? ""}
                    onChange={e => setWindowDraft(d => ({ ...d, autoSendWindowMinutes: e.target.valueAsNumber }))}
                  />
                  <p className="text-xs text-muted-foreground">Minimum gap between automated sends on the same channel.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="replyWindow">Unanswered-reply window (hours)</Label>
                  <Input
                    id="replyWindow"
                    type="number"
                    min={0}
                    max={168}
                    value={windowDraft.replyPendingWindowHours ?? ""}
                    onChange={e => setWindowDraft(d => ({ ...d, replyPendingWindowHours: e.target.valueAsNumber }))}
                  />
                  <p className="text-xs text-muted-foreground">Block automation while a prospect reply awaits a human response.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveWindows} disabled={updateWindowsMutation.isPending}>
                  {updateWindowsMutation.isPending ? "Saving…" : "Save changes"}
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEdit}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Human touch:</span>
                <span className="font-medium">{windows?.humanTouchWindowHours ?? 4}h</span>
              </div>
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Auto-send cooldown:</span>
                <span className="font-medium">{windows?.autoSendWindowMinutes ?? 60}min</span>
              </div>
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Unanswered reply:</span>
                <span className="font-medium">{windows?.replyPendingWindowHours ?? 24}h</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary cards */}
      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Total suppressed ({days}d)</p>
            <p className="text-2xl font-bold">{items.length}</p>
          </Card>
          {Object.entries(signalCounts).map(([signal, count]) => {
            const meta = SIGNAL_META[signal] ?? { label: signal };
            return (
              <Card key={signal} className="p-4">
                <p className="text-xs text-muted-foreground mb-1">{meta.label}</p>
                <p className="text-2xl font-bold">{count}</p>
              </Card>
            );
          })}
        </div>
      )}

      {/* Suppression log */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" /> Suppression Events
              </CardTitle>
              <CardDescription>Most recent first. Use this to tune windows.</CardDescription>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Label htmlFor="dayFilter" className="text-muted-foreground whitespace-nowrap">Show last</Label>
              <select
                id="dayFilter"
                className="border rounded px-2 py-1 text-sm bg-background"
                value={days}
                onChange={e => setDays(Number(e.target.value))}
              >
                <option value={1}>1 day</option>
                <option value={3}>3 days</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {suppLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          ) : items.length === 0 ? (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>
                No suppression events in the last {days} day{days !== 1 ? "s" : ""}.
                Automation is flowing freely to all eligible contacts.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Contact</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Channel</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Signal</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Reason</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Resume After</th>
                    <th className="py-2 font-medium text-muted-foreground">Suppressed At</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="py-2 pr-4">
                        {item.contact ? (
                          <div>
                            <span className="font-medium">
                              {item.contact.firstName} {item.contact.lastName}
                            </span>
                            <div className="text-xs text-muted-foreground">{item.contact.email}</div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">ID {item.contactId ?? "—"}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <ChannelBadge channel={item.details?.channel} />
                      </td>
                      <td className="py-2 pr-4">
                        <SignalBadge signal={item.details?.signal} />
                      </td>
                      <td className="py-2 pr-4 max-w-xs">
                        <span className="text-xs text-muted-foreground line-clamp-2">
                          {item.details?.reason ?? "—"}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                        {item.details?.resumeAfter
                          ? new Date(item.details.resumeAfter).toLocaleString()
                          : "—"}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(item.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
