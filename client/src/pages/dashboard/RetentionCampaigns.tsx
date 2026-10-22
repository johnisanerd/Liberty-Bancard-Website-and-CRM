import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, Plus, Trash2, Edit, Zap, Settings } from "lucide-react";
import { PageHeader } from "@/components/crm/CrmPresentation";
import type { RetentionCampaignConfig } from "@shared/schema";

const ALERT_TYPE_OPTIONS = [
  { value: "volume_decline", label: "Volume Decline" },
  { value: "chargeback_spike", label: "Chargeback Spike" },
  { value: "no_processing", label: "No Processing" },
  { value: "high_refund_rate", label: "High Refund Rate" },
  { value: "compliance_issue", label: "Compliance Issue" },
  { value: "terminal_offline", label: "Terminal Offline" },
  { value: "funding_hold", label: "Funding Hold" },
];

const PRIORITY_OPTIONS = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
];

const DEFAULT_MESSAGES: Record<string, string> = {
  volume_decline: "Hi {{merchant_name}}, I noticed your processing volume has declined recently. I'd love to connect and see if there's anything we can do to support your business. When would be a good time to chat?",
  chargeback_spike: "Hi {{merchant_name}}, I wanted to reach out regarding some recent chargeback activity on your account. Let's connect to review your options and put a plan in place to protect your business.",
  no_processing: "Hi {{merchant_name}}, we noticed your account hasn't processed recently. Is everything okay? We're here to help and want to make sure you're getting the most out of your processing setup.",
  high_refund_rate: "Hi {{merchant_name}}, I wanted to check in regarding refund activity on your account. There are a few strategies we can discuss to help reduce refunds. Would you have time for a quick call?",
  compliance_issue: "Hi {{merchant_name}}, I need to discuss an important compliance matter regarding your processing account. Please contact me at your earliest convenience.",
  terminal_offline: "Hi {{merchant_name}}, it looks like your terminal may be having connectivity issues. Let me help you get back up and running as quickly as possible.",
  funding_hold: "Hi {{merchant_name}}, I wanted to personally reach out regarding a temporary hold on your funding. I can explain everything and help resolve this quickly.",
};

function ConfigForm({ config, onClose }: { config?: RetentionCampaignConfig; onClose: () => void }) {
  const { toast } = useToast();
  const [alertType, setAlertType] = useState(config?.alertType || "");
  const [campaignName, setCampaignName] = useState(config?.campaignName || "");
  const [suggestedMessage, setSuggestedMessage] = useState(config?.suggestedMessage || "");
  const [taskPriority, setTaskPriority] = useState(config?.taskPriority || "high");
  const [taskDueDays, setTaskDueDays] = useState(String(config?.taskDueDays ?? 1));
  const [enabled, setEnabled] = useState(config?.enabled !== false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = { alertType, campaignName, suggestedMessage, taskPriority, taskDueDays: Number(taskDueDays), enabled };
      if (config) {
        return apiRequest("PATCH", `/api/retention-campaign-configs/${config.id}`, body);
      }
      return apiRequest("POST", "/api/retention-campaign-configs", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/retention-campaign-configs"] });
      toast({ title: config ? "Config updated" : "Config created", description: `Retention campaign for "${alertType}" saved.` });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleAlertTypeChange = (val: string) => {
    setAlertType(val);
    if (!suggestedMessage && DEFAULT_MESSAGES[val]) {
      setSuggestedMessage(DEFAULT_MESSAGES[val]);
    }
    if (!campaignName) {
      setCampaignName(`${ALERT_TYPE_OPTIONS.find(o => o.value === val)?.label} Retention Outreach`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Alert Type</Label>
        <Select value={alertType} onValueChange={handleAlertTypeChange} disabled={!!config}>
          <SelectTrigger data-testid="select-alert-type">
            <SelectValue placeholder="Select alert type..." />
          </SelectTrigger>
          <SelectContent>
            {ALERT_TYPE_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Campaign Name</Label>
        <Input
          value={campaignName}
          onChange={(e) => setCampaignName(e.target.value)}
          placeholder="e.g. Volume Decline Retention Outreach"
          data-testid="input-campaign-name"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Task Priority</Label>
          <Select value={taskPriority} onValueChange={setTaskPriority}>
            <SelectTrigger data-testid="select-task-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Task Due (days)</Label>
          <Input
            type="number"
            value={taskDueDays}
            onChange={(e) => setTaskDueDays(e.target.value)}
            min="1"
            max="30"
            data-testid="input-task-due-days"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Suggested Message Template</Label>
        <Textarea
          value={suggestedMessage}
          onChange={(e) => setSuggestedMessage(e.target.value)}
          placeholder="Message shown to the rep in the task queue... Use {{merchant_name}} for personalization."
          rows={4}
          data-testid="textarea-suggested-message"
        />
        <p className="text-xs text-muted-foreground">Use {"{"}{"{"} merchant_name {"}"}{"}"}  for personalization</p>
      </div>

      <div className="flex items-center gap-3">
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          data-testid="switch-enabled"
        />
        <Label>Enable this campaign trigger</Label>
      </div>

      <div className="flex gap-3 justify-end pt-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={!alertType || !campaignName || saveMutation.isPending}
          data-testid="button-save-config"
        >
          {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {config ? "Update" : "Create"} Config
        </Button>
      </div>
    </div>
  );
}

export default function RetentionCampaigns() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editConfig, setEditConfig] = useState<RetentionCampaignConfig | undefined>();

  const { data: configs = [], isLoading } = useQuery<RetentionCampaignConfig[]>({
    queryKey: ["/api/retention-campaign-configs"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/retention-campaign-configs/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/retention-campaign-configs"] });
      toast({ title: "Deleted", description: "Campaign config removed." });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      await apiRequest("PATCH", `/api/retention-campaign-configs/${id}`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/retention-campaign-configs"] });
    },
  });

  const alertTypeLabel = (val: string) => ALERT_TYPE_OPTIONS.find(o => o.value === val)?.label || val;
  const priorityVariant = (p: string | null): "destructive" | "outline" | "secondary" => {
    if (p === "urgent") return "destructive";
    if (p === "high") return "outline";
    return "secondary";
  };

  return (
    <div className="space-y-6" data-testid="retention-campaigns-page">
      <PageHeader
        title="Retention Campaigns"
        subtitle="Configure automatic outreach tasks when merchant health alerts fire"
        actions={
          <Button data-testid="button-add-config" onClick={() => setDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Config
          </Button>
        }
      />
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditConfig(undefined); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editConfig ? "Edit" : "New"} Retention Campaign Config</DialogTitle>
          </DialogHeader>
          <ConfigForm config={editConfig} onClose={() => { setDialogOpen(false); setEditConfig(undefined); }} />
        </DialogContent>
      </Dialog>

      <Card data-testid="card-how-it-works">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            How It Works
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            When a merchant health alert fires (volume decline, no processing, chargeback spike, etc.), the system automatically creates a task in the assigned rep's queue with a pre-written outreach message. Configure which alert types should trigger retention outreach tasks below.
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : configs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <Settings className="w-12 h-12 text-muted-foreground" />
            <div className="text-center space-y-2">
              <p className="font-semibold">No retention campaign configs yet</p>
              <p className="text-sm text-muted-foreground">Add your first config to automatically trigger outreach when health alerts fire.</p>
            </div>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add First Config
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => (
            <Card key={config.id} data-testid={`card-config-${config.id}`}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm" data-testid={`text-config-name-${config.id}`}>{config.campaignName}</span>
                      <Badge variant="secondary">{alertTypeLabel(config.alertType)}</Badge>
                      <Badge variant={priorityVariant(config.taskPriority)}>
                        {config.taskPriority || "high"} priority
                      </Badge>
                      <Badge variant="outline">Due in {config.taskDueDays || 1}d</Badge>
                      {!config.enabled && <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>}
                    </div>
                    {config.suggestedMessage && (
                      <p className="text-xs text-muted-foreground line-clamp-2" data-testid={`text-config-msg-${config.id}`}>
                        {config.suggestedMessage}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={config.enabled !== false}
                        onCheckedChange={(val) => toggleMutation.mutate({ id: config.id, enabled: val })}
                        data-testid={`switch-config-${config.id}`}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setEditConfig(config); setDialogOpen(true); }}
                      data-testid={`button-edit-${config.id}`}
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={`Delete ${config.campaignName}`}
                          data-testid={`button-delete-${config.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Campaign Config</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete "{config.campaignName}"? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel data-testid={`button-cancel-delete-${config.id}`}>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteMutation.mutate(config.id)}
                            disabled={deleteMutation.isPending}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            data-testid={`button-confirm-delete-${config.id}`}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
