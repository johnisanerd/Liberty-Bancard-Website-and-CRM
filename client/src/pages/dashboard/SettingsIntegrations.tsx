import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { decodeJsonResponse, isRecord } from "@/lib/decode-json-response";
import { useC4RetainedSelection } from "@/hooks/use-c4-retained-selection";
import { integrationsViews } from "@/lib/crm-destination-state";
import { CheckCircle2, XCircle, Plus, Trash2, Settings, Workflow, Mail, Edit2, Save, X, Loader2, ShieldCheck, Linkedin, Info, Cpu, RefreshCw, AlertTriangle, Activity, ChevronDown, ChevronRight, ExternalLink, Copy, Tag, Clock, MessageSquare, Lock, Server, ArrowRight, ShieldX } from "lucide-react";

interface WorkflowEnvEntry {
  id: string;
  name: string;
  category: string;
  envKey: string;
  description: string;
  triggerType: string;
  value: string | null;
  isSet: boolean;
}

interface SendingIdentity {
  id: number;
  label: string;
  domain: string;
  emailAddress: string;
  mailboxType: string | null;
  isActive: boolean | null;
  warmupStatus: string | null;
  dailyLimit: number | null;
  healthScore: number | null;
  verticalAssignment: string | null;
  sentToday: number | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  sdr_outbound: "SDR Outbound",
  inbound_lead: "Inbound Lead",
  onboarding: "Onboarding",
  nurture: "Nurture",
  scheduling: "Scheduling",
  support: "Support",
};

const CATEGORY_COLORS: Record<string, string> = {
  sdr_outbound: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  inbound_lead: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  onboarding: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  nurture: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  scheduling: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  support: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

const isSeedReceipt = (v: unknown): v is { created: boolean; message?: string } =>
  isRecord(v) && typeof v.created === "boolean" && (v.message === undefined || typeof v.message === "string");

/** Admin-only writes: the workflow-ID, sending-identity, seed and auto-run endpoints reject managers. */
const ADMIN_ONLY_REASON = "Only administrators can change this. Managers can view it.";

function WorkflowEnvRow({ entry, onSaved, canEdit }: { entry: WorkflowEnvEntry; onSaved: () => void; canEdit: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState(entry.value || "");

  const saveMutation = useMutation({
    mutationFn: async (value: string | null) => {
      await apiRequest("PUT", `/api/ghl/workflow-env-ids/${entry.envKey}`, { value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ghl/workflow-env-ids"] });
      toast({ title: "Workflow ID saved" });
      setEditing(false);
      onSaved();
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <TableRow data-testid={`row-workflow-env-${entry.envKey}`}>
      <TableCell className="max-w-[200px]">
        <div className="font-medium text-sm">{entry.name}</div>
        <div className="text-xs text-muted-foreground font-mono mt-0.5">{entry.envKey}</div>
      </TableCell>
      <TableCell>
        <Badge className={CATEGORY_COLORS[entry.category] || "bg-gray-100 text-gray-700"}>
          {CATEGORY_LABELS[entry.category] || entry.category}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground max-w-[250px]">{entry.description}</TableCell>
      <TableCell>
        {entry.isSet
          ? <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 gap-1"><CheckCircle2 className="w-3 h-3" />Set</Badge>
          : <Badge variant="outline" className="text-muted-foreground gap-1"><XCircle className="w-3 h-3" />Missing</Badge>
        }
      </TableCell>
      <TableCell className="min-w-[260px]">
        {editing ? (
          <div className="flex gap-2 items-center">
            <Input
              className="h-7 text-xs font-mono"
              placeholder="Paste GHL Workflow ID..."
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              data-testid={`input-workflow-id-${entry.envKey}`}
            />
            <Button
              size="sm"
              className="h-7 px-2"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate(inputVal || null)}
              data-testid={`button-save-workflow-${entry.envKey}`}
            >
              {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setEditing(false); setInputVal(entry.value || ""); }}>
              <X className="w-3 h-3" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground truncate max-w-[180px]">
              {entry.value ? entry.value : <span className="italic">Not set</span>}
            </span>
            {canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 ml-auto"
                aria-label={`Edit ${entry.name} workflow ID`}
                onClick={() => { setEditing(true); setInputVal(entry.value || ""); }}
                data-testid={`button-edit-workflow-${entry.envKey}`}
              >
                <Edit2 className="w-3 h-3" />
              </Button>
            ) : (
              <span className="ml-auto text-xs text-muted-foreground" data-testid={`text-readonly-workflow-${entry.envKey}`}>Read only</span>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function AddIdentityDialog({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [domain, setDomain] = useState("");
  const [mailboxType, setMailboxType] = useState("google_workspace");
  const [dailyLimit, setDailyLimit] = useState("30");
  const [warmupStatus, setWarmupStatus] = useState("warming");
  const [vertical, setVertical] = useState("");

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      await apiRequest("POST", "/api/sdr/sending-identities", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: "Sending identity added" });
      setOpen(false);
      setLabel(""); setEmailAddress(""); setDomain(""); setMailboxType("google_workspace");
      setDailyLimit("30"); setWarmupStatus("warming"); setVertical("");
      onCreated();
    },
    onError: (err: any) => {
      toast({ title: "Failed to add identity", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!label || !emailAddress || !domain) {
      toast({ title: "Label, email, and domain are required", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      label,
      emailAddress,
      domain,
      mailboxType,
      isActive: true,
      warmupStatus,
      warmupStartedAt: warmupStatus === "warming" ? new Date().toISOString() : null,
      dailyLimit: parseInt(dailyLimit) || 30,
      verticalAssignment: vertical || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-add-identity">
          <Plus className="w-4 h-4 mr-1" />Add Identity
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="dialog-add-identity">
        <DialogHeader>
          <DialogTitle>Add Sending Identity</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <Label className="text-sm">Label</Label>
            <Input placeholder="e.g. Scott - Liberty Bancard" value={label} onChange={(e) => setLabel(e.target.value)} data-testid="input-identity-label" />
          </div>
          <div>
            <Label className="text-sm">Email Address</Label>
            <Input placeholder="e.g. Scott@mail.libertybancard.com" value={emailAddress} onChange={(e) => { setEmailAddress(e.target.value); if (!domain && e.target.value.includes("@")) setDomain(e.target.value.split("@")[1]); }} data-testid="input-identity-email" />
          </div>
          <div>
            <Label className="text-sm">Domain</Label>
            <Input placeholder="e.g. mail.libertybancard.com" value={domain} onChange={(e) => setDomain(e.target.value)} data-testid="input-identity-domain" />
          </div>
          <div>
            <Label className="text-sm">Mailbox Type</Label>
            <Select value={mailboxType} onValueChange={setMailboxType}>
              <SelectTrigger data-testid="select-identity-mailbox-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="google_workspace">Google Workspace</SelectItem>
                <SelectItem value="microsoft_365">Microsoft 365</SelectItem>
                <SelectItem value="smtp">SMTP</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-sm">Daily Limit</Label>
              <Input type="number" min="20" max="35" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} data-testid="input-identity-daily-limit" />
              <p className="text-xs text-muted-foreground mt-1">20–35 for safe deliverability</p>
            </div>
            <div>
              <Label className="text-sm">Warmup Status</Label>
              <Select value={warmupStatus} onValueChange={setWarmupStatus}>
                <SelectTrigger data-testid="select-identity-warmup-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="warming">Warming</SelectItem>
                  <SelectItem value="warm">Warm</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-sm">Vertical Assignment (optional)</Label>
            <Input placeholder="e.g. restaurant, retail" value={vertical} onChange={(e) => setVertical(e.target.value)} data-testid="input-identity-vertical" />
          </div>
          <Button className="w-full" disabled={createMutation.isPending} onClick={handleSubmit} data-testid="button-submit-add-identity">
            {createMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Adding...</> : "Add Sending Identity"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SendingIdentitiesTab() {
  const { user } = useAuth();
  // The sending-identity endpoints are administrator-only. Managers get a read-only
  // explanation and no request is made.
  if (user?.role !== "admin") {
    return (
      <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground" role="status" data-testid="text-sending-identities-readonly">
        Sending identities are managed by administrators. {ADMIN_ONLY_REASON}
      </div>
    );
  }
  return <SendingIdentitiesAdminTab />;
}

function SendingIdentitiesAdminTab() {
  const { toast } = useToast();

  const { data: identities = [], isLoading, refetch } = useQuery<SendingIdentity[]>({
    queryKey: ["/api/sdr/sending-identities"],
  });

  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/seed-scott-identity", {});
      return decodeJsonResponse(res, isSeedReceipt, "Seed");
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: data.created ? "Scott's identity seeded" : "Scott's identity already exists", description: data.message });
    },
    onError: (err: any) => {
      toast({ title: "Seed failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/sdr/sending-identities/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sdr/sending-identities"] });
      toast({ title: "Identity removed" });
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const scottExists = identities.some(i => i.emailAddress === "Scott@mail.libertybancard.com");

  function warmupBadge(status: string | null) {
    switch (status) {
      case "warm": return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">Warm</Badge>;
      case "warming": return <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300">Warming</Badge>;
      case "paused": return <Badge variant="destructive">Paused</Badge>;
      default: return <Badge variant="outline">{status || "Unknown"}</Badge>;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            All registered sending identities used for SDR outreach. The orchestrator picks the best available warm inbox.
          </p>
        </div>
        <div className="flex gap-2">
          {!scottExists && (
            <Button
              size="sm"
              variant="outline"
              disabled={seedMutation.isPending}
              onClick={() => seedMutation.mutate()}
              data-testid="button-seed-scott"
            >
              {seedMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-1" />}
              Seed Scott's Identity
            </Button>
          )}
          <AddIdentityDialog onCreated={() => refetch()} />
        </div>
      </div>

      {scottExists && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-200" data-testid="banner-scott-exists">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span><strong>Scott@mail.libertybancard.com</strong> is active as the primary sending identity.</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : identities.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Mail className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No sending identities registered yet.</p>
          <p className="text-xs mt-1">Seed Scott's identity or add one manually to get started.</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Identity</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Daily Limit</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Sent Today</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {identities.map((identity) => (
                <TableRow key={identity.id} data-testid={`row-identity-${identity.id}`}>
                  <TableCell>
                    <div className="font-medium text-sm">{identity.label}</div>
                    <div className="text-xs text-muted-foreground">{identity.emailAddress}</div>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{identity.domain}</TableCell>
                  <TableCell>{warmupBadge(identity.warmupStatus)}</TableCell>
                  <TableCell className="text-sm">{identity.dailyLimit ?? 30}</TableCell>
                  <TableCell>
                    <span className={`text-sm font-medium ${(identity.healthScore ?? 100) >= 80 ? "text-green-600" : (identity.healthScore ?? 100) >= 60 ? "text-yellow-600" : "text-red-600"}`}>
                      {(identity.healthScore ?? 100).toFixed(0)}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{identity.sentToday ?? 0}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{identity.verticalAssignment || <span className="italic">All</span>}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => deleteMutation.mutate(identity.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-identity-${identity.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function GhlWorkflowSetupGuide() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: `Copied ${label}`, description: "Paste it into GHL." });
    });
  }

  const emailSubject = "We received your request, {{contact.first_name}}!";
  const emailBody = `Hi {{contact.first_name}},

Thanks for reaching out to Liberty Bancard! We've received your information and our team is reviewing it now.

Here's what happens next:
1. Our team will analyze your processing statement (usually within a few hours)
2. We'll prepare a personalized savings estimate for {{contact.company_name}}
3. A team member will follow up with your results and recommendations

Want to skip the wait? Book a call directly:
{{contact.bookingLink}}

Questions? Just reply to this email.

— Liberty Bancard Team

Eligibility, underwriting, card brand rules, and applicable laws apply.`;

  const smsBody = `Hi {{contact.first_name}}, thanks for connecting with Liberty Bancard! We'll review your info and follow up soon. Book a call: {{contact.bookingLink}} — Liberty Bancard`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-left hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
          data-testid="button-toggle-workflow-setup-guide"
        >
          {open ? <ChevronDown className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />}
          <span className="text-sm font-semibold text-blue-800 dark:text-blue-300 flex-1">
            GHL Workflow Setup Guide — Step-by-step instructions to build the "Instant Lead Confirmation" workflow in GoHighLevel
          </span>
          <ExternalLink className="w-3.5 h-3.5 text-blue-500 shrink-0" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 space-y-5">
          <p className="text-xs text-blue-700 dark:text-blue-300">
            GoHighLevel does not expose a workflow creation API, so a supported inbound/scheduling handoff workflow has to be built in the GHL UI. Only slots whose own row says they are needed use an ID; every other ID is reference-only. Replit owns sequence cadence, incoming GHL sync is controlled separately, and the global outbound pause still applies.
          </p>

          {/* Step 1 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
              <p className="text-sm font-semibold text-foreground">Open Automation → Workflows → + New Workflow → Start from Scratch</p>
            </div>
            <p className="text-xs text-muted-foreground ml-7">Name it: <strong>LB — Inbound Lead Instant Confirmation</strong></p>
          </div>

          {/* Step 2 — Trigger */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
              <p className="text-sm font-semibold text-foreground">Add Trigger: <Tag className="w-3.5 h-3.5 inline mx-0.5" /> Contact Tag Added</p>
            </div>
            <div className="ml-7 space-y-1.5">
              <p className="text-xs text-muted-foreground">In the trigger settings, set the tag filter to:</p>
              <div className="flex items-center gap-2">
                <code className="text-xs bg-white dark:bg-gray-800 border rounded px-2 py-1 font-mono font-bold text-blue-700 dark:text-blue-300">LB-INBOUND</code>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => copyToClipboard("LB-INBOUND", "tag")} data-testid="button-copy-tag-lb-inbound">
                  <Copy className="w-3 h-3 mr-1" />Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">This tag is added automatically by the platform on every form submission (estimate, statement upload, get-started, callback).</p>
            </div>
          </div>

          {/* Step 3 — Send Email */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">3</span>
              <p className="text-sm font-semibold text-foreground">Add Action: <Mail className="w-3.5 h-3.5 inline mx-0.5" /> Send Email (Step 1 — Instant confirmation)</p>
            </div>
            <div className="ml-7 space-y-2">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Subject line:</p>
                <div className="flex items-start gap-2">
                  <code className="text-xs bg-white dark:bg-gray-800 border rounded px-2 py-1 font-mono flex-1 break-all">{emailSubject}</code>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs shrink-0" onClick={() => copyToClipboard(emailSubject, "subject")} data-testid="button-copy-email-subject">
                    <Copy className="w-3 h-3 mr-1" />Copy
                  </Button>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Email body (paste into GHL email editor):</p>
                <div className="flex items-start gap-2">
                  <pre className="text-xs bg-white dark:bg-gray-800 border rounded px-2 py-1 font-mono flex-1 whitespace-pre-wrap break-all leading-relaxed">{emailBody}</pre>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs shrink-0 self-start" onClick={() => copyToClipboard(emailBody, "email body")} data-testid="button-copy-email-body">
                    <Copy className="w-3 h-3 mr-1" />Copy
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">{"{{contact.bookingLink}}"}</code> merge tag maps to the <strong>bookingLink</strong> custom field that the platform writes on every contact sync. If it's blank in a test, create a GHL custom field named <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">bookingLink</code> under Contacts → Custom Fields.
              </p>
            </div>
          </div>

          {/* Step 4 — Wait + SMS */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">4</span>
              <p className="text-sm font-semibold text-foreground">(Optional) Add Wait → <Clock className="w-3.5 h-3.5 inline mx-0.5" /> 5 Minutes → <MessageSquare className="w-3.5 h-3.5 inline mx-0.5" /> Send SMS</p>
            </div>
            <div className="ml-7 space-y-2">
              <p className="text-xs text-muted-foreground">Add an <strong>If/Else</strong> condition: <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">consentSms = true</code> → branch YES sends the SMS below.</p>
              <div className="flex items-start gap-2">
                <code className="text-xs bg-white dark:bg-gray-800 border rounded px-2 py-1 font-mono flex-1 break-all">{smsBody}</code>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs shrink-0 self-start" onClick={() => copyToClipboard(smsBody, "SMS body")} data-testid="button-copy-sms-body">
                  <Copy className="w-3 h-3 mr-1" />Copy
                </Button>
              </div>
            </div>
          </div>

          {/* Step 5 — 24h follow-up */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">5</span>
              <p className="text-sm font-semibold text-foreground">(Optional) Add Wait → <Clock className="w-3.5 h-3.5 inline mx-0.5" /> 24 Hours → If/Else: no appointment booked → Send follow-up nudge</p>
            </div>
            <div className="ml-7">
              <p className="text-xs text-muted-foreground">Condition: <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">Appointment is not set</code> (or check the deal stage via a custom field). Send a second email with subject <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">Still want to see how much you could save, {"{{contact.first_name}}"}?</code> and the booking link.</p>
            </div>
          </div>

          {/* Step 6 — Publish and copy ID */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-green-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">6</span>
              <p className="text-sm font-semibold text-foreground">Publish the workflow → Copy the Workflow ID → Paste it below</p>
            </div>
            <div className="ml-7 space-y-1">
              <p className="text-xs text-muted-foreground">After publishing, open the workflow. The Workflow ID is in the URL: <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">app.gohighlevel.com/…/automation/workflows/<strong>WORKFLOW_ID_HERE</strong></code></p>
              <p className="text-xs text-muted-foreground">Paste that ID into the <strong>Inbound Lead — Instant Confirmation</strong> row in the table below. The platform will start enrolling leads immediately — no code change or restart needed.</p>
            </div>
          </div>

          <div className="flex items-start gap-2 p-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              <strong>Prerequisite:</strong> The <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">bookingLink</code> custom field must exist in GHL (Contacts → Settings → Custom Fields). The platform writes this value on every contact upsert. Without it the merge tag will render blank in the email.
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Architecture classification for GHL workflow slots
const REQUIRED_CATEGORIES = new Set(["inbound_lead"]);
const OPTIONAL_CATEGORIES = new Set(["scheduling", "support"]);
// sdr_outbound, onboarding, nurture, and anything else → Replit-owned

function getArchRole(category: string): "required" | "optional" | "replit_owned" {
  if (REQUIRED_CATEGORIES.has(category)) return "required";
  if (OPTIONAL_CATEGORIES.has(category)) return "optional";
  return "replit_owned";
}

function GhlWorkflowEnvTab() {
  const { user } = useAuth();
  const isAdminUser = user?.role === "admin";
  const { data: registry = [], isLoading, refetch } = useQuery<WorkflowEnvEntry[]>({
    queryKey: ["/api/ghl/workflow-env-ids"],
  });

  const [optionalOpen, setOptionalOpen] = useState(false);
  const [replitOwnedOpen, setReplitOwnedOpen] = useState(false);

  const requiredEntries = registry.filter(e => getArchRole(e.category) === "required");
  const optionalEntries = registry.filter(e => getArchRole(e.category) === "optional");
  const replitOwnedEntries = registry.filter(e => getArchRole(e.category) === "replit_owned");

  const requiredConfigured = requiredEntries.filter(e => e.isSet).length;
  const optionalConfigured = optionalEntries.filter(e => e.isSet).length;

  return (
    <div className="space-y-5">

      {/* Architecture Summary Card */}
      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10 p-4 space-y-3" data-testid="card-ghl-architecture-summary">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">
            Architecture: Replit owns orchestration — GHL is the transport and webhook layer
          </p>
        </div>
        <p className="text-xs text-blue-800 dark:text-blue-300 leading-relaxed">
          Replit controls all sequence cadences, enrollment, suppression, sender-policy gating, and attribution.
          GHL is used only for email/SMS delivery, the conversation inbox, contact sync, and inbound webhook events.
          Outbound sequence logic is <strong>never</strong> delegated to GHL native workflows.
        </p>
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-blue-700 dark:text-blue-300 font-medium">
          <span className="bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded">Replit CRM</span>
          <ArrowRight className="w-3 h-3 shrink-0" />
          <span className="bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded">Replit Sequence Engine</span>
          <ArrowRight className="w-3 h-3 shrink-0" />
          <span className="bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded">Replit Send Gate</span>
          <ArrowRight className="w-3 h-3 shrink-0" />
          <span className="bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded">GHL Transport</span>
          <ArrowRight className="w-3 h-3 shrink-0" />
          <span className="bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded">GHL Reply/Bounce Webhook</span>
          <ArrowRight className="w-3 h-3 shrink-0" />
          <span className="bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded">Replit CRM/Audit</span>
        </div>
      </div>

      {/* Operator Readiness Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="panel-operator-readiness">
        {/* Required */}
        <div className={`rounded-lg border p-3 space-y-1 ${requiredConfigured === requiredEntries.length && requiredEntries.length > 0 ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/10" : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/10"}`}>
          <div className="flex items-center gap-1.5">
            {requiredConfigured === requiredEntries.length && requiredEntries.length > 0
              ? <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
              : <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />}
            <p className="text-xs font-semibold text-foreground">Required Handoffs</p>
          </div>
          <p className="text-xs text-muted-foreground">Inbound webhook handoffs GHL fires when a lead arrives. Must be configured for instant lead confirmation.</p>
          <p className="text-xs font-medium">{requiredConfigured}/{requiredEntries.length} configured</p>
        </div>
        {/* Optional */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/10 p-3 space-y-1">
          <div className="flex items-center gap-1.5">
            <Info className="w-4 h-4 text-slate-500 shrink-0" />
            <p className="text-xs font-semibold text-foreground">Optional Handoffs</p>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300">Scheduling and support workflows that Replit can optionally hand off to GHL for native execution.</p>
          <p className="text-xs font-medium text-foreground">{optionalConfigured}/{optionalEntries.length} configured</p>
        </div>
        {/* Replit-Owned */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/10 p-3 space-y-1">
          <div className="flex items-center gap-1.5">
            <Lock className="w-4 h-4 text-slate-400 shrink-0" />
            <p className="text-xs font-semibold text-foreground">Replit-Owned</p>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300">All outbound sequence slots. Replit's sequence engine handles enrollment, timing, and suppression — GHL is not involved.</p>
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300">{replitOwnedEntries.length} slots intentionally unused</p>
        </div>
      </div>

      <GhlWorkflowSetupGuide />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-4">

          {/* Required Handoffs */}
          {requiredEntries.length > 0 && (
            <div data-testid="section-required-handoffs">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
                <span className="text-sm font-semibold text-foreground">Required — Inbound Webhook Handoffs</span>
                <span className="text-xs text-muted-foreground">{requiredConfigured}/{requiredEntries.length} set</span>
              </div>
              <div className="rounded-md border overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workflow</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="hidden md:table-cell">Description</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>GHL Workflow ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {requiredEntries.map((entry) => (
                      <WorkflowEnvRow key={entry.envKey} entry={entry} canEdit={isAdminUser} onSaved={() => refetch()} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Optional Handoffs — collapsible */}
          {optionalEntries.length > 0 && (
            <Collapsible open={optionalOpen} onOpenChange={setOptionalOpen} data-testid="section-optional-handoffs">
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/20 text-left hover:bg-slate-100 dark:hover:bg-slate-800/30 transition-colors">
                  {optionalOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                  <Info className="w-4 h-4 text-slate-500 shrink-0" />
                  <span className="text-sm font-medium flex-1">Optional — Scheduling &amp; Support Handoffs</span>
                  <span className="text-xs text-slate-600 dark:text-slate-300">{optionalConfigured}/{optionalEntries.length} configured</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 rounded-md border overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workflow</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="hidden md:table-cell">Description</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>GHL Workflow ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {optionalEntries.map((entry) => (
                        <WorkflowEnvRow key={entry.envKey} entry={entry} canEdit={isAdminUser} onSaved={() => refetch()} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Replit-Owned Slots — collapsed, read-only */}
          {replitOwnedEntries.length > 0 && (
            <Collapsible open={replitOwnedOpen} onOpenChange={setReplitOwnedOpen} data-testid="section-replit-owned-slots">
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/10 text-left hover:bg-slate-100 dark:hover:bg-slate-800/20 transition-colors">
                  {replitOwnedOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                  <Lock className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="text-sm font-medium text-muted-foreground flex-1">
                    Intentionally Disabled — Replit-Owned Outbound Slots ({replitOwnedEntries.length})
                  </span>
                  <span className="text-xs text-muted-foreground italic">Not used — Replit schedules locally</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 p-3 rounded-md border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/30 dark:bg-slate-900/5">
                  <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5">
                    <Lock className="w-3 h-3 shrink-0" />
                    These slots are shown for reference only. Replit's sequence engine owns all enrollment, timing, and suppression for these categories — no GHL native workflow ID is needed or used.
                  </p>
                  <div className="space-y-1.5">
                    {replitOwnedEntries.map((entry) => (
                      <div key={entry.envKey} className="flex items-center gap-3 px-3 py-2 rounded-md bg-slate-100/60 dark:bg-slate-800/20 opacity-60" data-testid={`row-replit-owned-${entry.envKey}`}>
                        <Lock className="w-3 h-3 text-slate-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-medium text-foreground">{entry.name}</span>
                          <span className="text-xs text-muted-foreground font-mono ml-2">{entry.envKey}</span>
                        </div>
                        <Badge variant="outline" className="text-xs text-muted-foreground border-slate-300 dark:border-slate-600 shrink-0">
                          Not used — Replit controls this
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

        </div>
      )}
    </div>
  );
}

type ProcessorHealthState =
  | "disabled"
  | "missing_contract"
  | "missing_credentials"
  | "configured_unverified"
  | "sandbox_verified"
  | "production_authorized"
  | "expired_or_drifted"
  | "held";

interface AdapterStatus {
  name: string;
  enabled: boolean;
  configured: boolean;
  healthState?: ProcessorHealthState;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  callCount: number;
  errorCount: number;
  errorRate: number;
}

function ProcessorHealthStateBadge({ state }: { state?: ProcessorHealthState }) {
  if (!state) return null;
  const configs: Record<ProcessorHealthState, { label: string; className: string }> = {
    disabled:              { label: "Disabled",             className: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" },
    missing_contract:      { label: "Missing Contract",     className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
    missing_credentials:   { label: "No Credentials",      className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
    configured_unverified: { label: "Unverified",          className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
    sandbox_verified:      { label: "Sandbox Verified",    className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
    production_authorized: { label: "Production Ready",    className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" },
    expired_or_drifted:    { label: "Expired / Drifted",   className: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
    held:                  { label: "Held",                className: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" },
  };
  const cfg = configs[state] ?? configs.configured_unverified;
  return <Badge className={`text-xs ${cfg.className}`}>{cfg.label}</Badge>;
}

interface ProcessorAdaptersResponse {
  adapters: AdapterStatus[];
}

function ProcessorAdaptersTab() {
  const { toast } = useToast();

  const { data, isLoading, refetch } = useQuery<ProcessorAdaptersResponse>({
    queryKey: ["/api/admin/processor-adapters"],
  });

  const pingMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/processor-adapters/ping", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/processor-adapters"] });
      toast({ title: "Ping complete", description: "Adapter connectivity check finished." });
      refetch();
    },
    onError: (err: any) => {
      toast({ title: "Ping failed", description: err.message, variant: "destructive" });
    },
  });

  const adapters = data?.adapters ?? [];

  function formatTimeAgo(dateStr: string | null): string {
    if (!dateStr) return "Never";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  return (
    <div className="space-y-4" data-testid="section-processor-adapters">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground flex-1">
          All registered processor adapters and their live connectivity status. Add new processors by creating an adapter file and registering it — no changes to the boarding flow required.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={pingMutation.isPending}
          onClick={() => pingMutation.mutate()}
          data-testid="button-ping-adapters"
        >
          {pingMutation.isPending
            ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            : <RefreshCw className="w-4 h-4 mr-1.5" />
          }
          Ping All
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-md border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Adapter</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Readiness State</TableHead>
                <TableHead>Last Success</TableHead>
                <TableHead>Last Error</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Error Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {adapters.map((adapter) => (
                <TableRow key={adapter.name} data-testid={`row-adapter-${adapter.name.replace(/\s+/g, "-").toLowerCase()}`}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{adapter.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {adapter.enabled
                      ? <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 gap-1"><Activity className="w-3 h-3" />Enabled</Badge>
                      : <Badge variant="outline" className="text-muted-foreground gap-1"><XCircle className="w-3 h-3" />Disabled</Badge>
                    }
                  </TableCell>
                  <TableCell>
                    {adapter.healthState ? (
                      <ProcessorHealthStateBadge state={adapter.healthState} />
                    ) : adapter.configured ? (
                      <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 gap-1"><CheckCircle2 className="w-3 h-3" />Configured</Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-600 border-amber-300 gap-1"><AlertTriangle className="w-3 h-3" />Not set</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatTimeAgo(adapter.lastSuccessAt)}</TableCell>
                  <TableCell>
                    {adapter.lastError ? (
                      <span className="text-xs text-red-600 dark:text-red-400 truncate max-w-[200px] block" title={adapter.lastError}>
                        {adapter.lastError.slice(0, 60)}{adapter.lastError.length > 60 ? "…" : ""}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">None</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{adapter.callCount}</TableCell>
                  <TableCell>
                    <span className={`text-sm font-medium ${adapter.errorRate === 0 ? "text-green-600" : adapter.errorRate < 10 ? "text-yellow-600" : "text-red-600"}`}>
                      {adapter.errorRate}%
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="rounded-md border p-4 space-y-3 bg-card">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Cpu className="w-4 h-4" />Adding a New Processor</h3>
        <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
          <li>Create <code className="font-mono bg-muted px-1 rounded text-xs">server/services/processors/yourprocessor.adapter.ts</code> implementing <code className="font-mono bg-muted px-1 rounded text-xs">IProcessorAdapter</code>.</li>
          <li>Register the adapter in <code className="font-mono bg-muted px-1 rounded text-xs">server/services/processors/registry.ts</code> with its env var flag.</li>
          <li>Set <code className="font-mono bg-muted px-1 rounded text-xs">ENABLED_PROCESSORS=nmi,yourprocessor</code> in your environment secrets.</li>
          <li>The boarding flow picks up the adapter automatically via <code className="font-mono bg-muted px-1 rounded text-xs">getDefaultProcessor()</code> — no further changes needed.</li>
        </ol>
      </div>
    </div>
  );
}

function ProxycurlTab() {
  const { data: status, isLoading } = useQuery<{ configured: boolean }>({
    queryKey: ["/api/proxycurl/status"],
  });

  const configured = status?.configured ?? false;

  return (
    <div className="space-y-4" data-testid="section-proxycurl">
      <p className="text-sm text-muted-foreground">
        Proxycurl powers LinkedIn profile enrichment. When configured, the "Enrich from LinkedIn" button
        on contact records will fetch name, title, company, location, and more directly from LinkedIn profiles.
      </p>

      <div className={`flex items-start gap-3 p-4 rounded-lg border ${configured ? "bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800" : "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800"}`} data-testid="banner-proxycurl-status">
        {configured ? (
          <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
        ) : (
          <Info className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        )}
        <div className="space-y-1">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Checking configuration…</p>
          ) : configured ? (
            <>
              <p className="text-sm font-medium text-green-800 dark:text-green-200">Proxycurl API key is configured</p>
              <p className="text-xs text-green-700 dark:text-green-300">LinkedIn enrichment is active. Open any contact with a LinkedIn URL and click "Enrich from LinkedIn".</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Proxycurl API key is not set</p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Set the <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">PROXYCURL_API_KEY</code> environment variable to enable LinkedIn enrichment.
                Get your API key at{" "}
                <a href="https://nubela.co/proxycurl" target="_blank" rel="noopener noreferrer" className="underline font-medium">nubela.co/proxycurl</a>.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="rounded-md border p-4 space-y-3 bg-card">
        <h3 className="text-sm font-semibold">Setup Instructions</h3>
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>Sign up at <a href="https://nubela.co/proxycurl" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">nubela.co/proxycurl</a> and obtain an API key.</li>
          <li>In your Replit project, open the Secrets panel and add a new secret named <code className="font-mono bg-muted px-1 rounded text-xs">PROXYCURL_API_KEY</code> with your key as the value.</li>
          <li>Restart the application for the change to take effect.</li>
          <li>Open any contact record that has a LinkedIn URL and click <strong>Enrich from LinkedIn</strong>.</li>
        </ol>
      </div>
    </div>
  );
}

function ZeroBounceSafetyTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const canToggleAutoRun = user?.role === "admin";
  const { data: usage, isLoading } = useQuery<{ usedToday: number }>({
    queryKey: ["/api/admin/settings/zerobounce-usage"],
  });
  const safetyQuery = useQuery<{
    enabled: boolean;
    circuitState: string;
    autoRunEnabled: boolean;
    nextAutomaticRunAt: string;
    authorizedPurposes: string[];
    authorizedCallers: string[];
  }>({ queryKey: ["/api/admin/settings/zerobounce-safety"] });

  const autoRunMutation = useMutation({
    mutationFn: (enabled: boolean) => apiRequest("PUT", "/api/admin/settings/zerobounce-auto-run", { enabled }),
    onSuccess: () => {
      toast({ title: "ZeroBounce automatic lane updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/settings/zerobounce-safety"] });
    },
    onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      {/* MI-09 safety controls are independent from the legacy/manual batch lane. */}
      <div className="rounded-md border border-violet-200 dark:border-violet-800 p-4 bg-violet-50/50 dark:bg-violet-900/10 space-y-3" data-testid="panel-zerobounce-safety">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">ZeroBounce safety controls</h3>
            <p className="text-xs text-muted-foreground">MI-09 automatic validation is off by default and does not enable legacy bulk validation.</p>
          </div>
          <Badge variant={safetyQuery.data?.enabled && safetyQuery.data?.circuitState === "closed" ? "default" : "destructive"}>
            {safetyQuery.data?.enabled ? "enabled" : "disabled"} · {safetyQuery.data?.circuitState ?? "unavailable"}
          </Badge>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="rounded border p-2"><div className="text-muted-foreground">Validations today</div><div className="font-mono">{isLoading ? "…" : (usage?.usedToday ?? 0).toLocaleString()}</div></div>
          <div className="rounded border p-2"><div className="text-muted-foreground">MI-09 auto-run</div><div className="font-mono">{safetyQuery.data?.autoRunEnabled ? "ON" : "OFF"}</div></div>
          <div className="rounded border p-2"><div className="text-muted-foreground">Next scheduled</div><div className="font-mono">{safetyQuery.data?.nextAutomaticRunAt ? new Date(safetyQuery.data.nextAutomaticRunAt).toLocaleString() : "—"}</div></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={safetyQuery.data?.autoRunEnabled ? "destructive" : "default"}
            disabled={autoRunMutation.isPending || !safetyQuery.data || !canToggleAutoRun}
            onClick={() => autoRunMutation.mutate(!safetyQuery.data?.autoRunEnabled)}
            data-testid="button-toggle-zerobounce-auto-run"
          >
            {safetyQuery.data?.autoRunEnabled ? "Disable MI-09 auto-run" : "Enable MI-09 auto-run"}
          </Button>
          {!canToggleAutoRun && <span className="self-center text-xs text-muted-foreground">{ADMIN_ONLY_REASON}</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          Purposes: {(safetyQuery.data?.authorizedPurposes ?? []).join(", ") || "none"} · Callers: {(safetyQuery.data?.authorizedCallers ?? []).join(", ") || "none"}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Daily validation count is reported for visibility; the application does not impose a local credit ceiling.</p>
    </div>
  );
}

export default function SettingsIntegrations() {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  // Mounted standalone (/dashboard/settings/integrations) or inside Administration (admin-hub?tab=integrations).
  const selectorPath = pathname.startsWith("/dashboard/settings/integrations") ? "/dashboard/settings/integrations" : "/dashboard/admin-hub";
  const view = useC4RetainedSelection(selectorPath, "integrationsView", integrationsViews, "ghl-workflows");
  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" data-testid="page-settings-integrations">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6" />
          Settings — Integrations
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Manage reference GHL workflow IDs, SDR sending identities, and API integrations.
        </p>
      </div>

      {view.issues.length > 0 && (
        <p role="status" className="mb-2 text-sm text-muted-foreground" data-testid="text-integrations-selection-issue">{view.issues[0].reason}</p>
      )}
      <Tabs value={view.value} onValueChange={(v) => view.setValue(v as typeof integrationsViews[number])} data-testid="tabs-integrations">
        <TabsList>
          <TabsTrigger value="ghl-workflows" data-testid="tab-ghl-workflows">
            <Workflow className="w-4 h-4 mr-1.5" />GHL Workflow IDs
          </TabsTrigger>
          <TabsTrigger value="sending-identities" data-testid="tab-sending-identities">
            <Mail className="w-4 h-4 mr-1.5" />Sending Identities
          </TabsTrigger>
          <TabsTrigger value="processor-adapters" data-testid="tab-processor-adapters">
            <Cpu className="w-4 h-4 mr-1.5" />Processor Adapters
          </TabsTrigger>
          <TabsTrigger value="linkedin" data-testid="tab-linkedin-enrichment">
            <Linkedin className="w-4 h-4 mr-1.5" />LinkedIn Enrichment
          </TabsTrigger>
          <TabsTrigger value="zerobounce" data-testid="tab-zerobounce">
            <ShieldX className="w-4 h-4 mr-1.5" />ZeroBounce
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ghl-workflows" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Workflow className="w-4 h-4" />
                GHL Transport &amp; Webhook Handoffs
              </CardTitle>
              <CardDescription>
                Replit controls all sequence cadences, routing, enrollment, suppression, sender policy, and attribution.
                GHL is used as the transport layer (email/SMS delivery), conversation inbox, contact sync, and inbound webhook events only.
                Only configure slots in the <strong>Required</strong> and <strong>Optional</strong> categories below — outbound sequence slots are intentionally unused.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GhlWorkflowEnvTab />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sending-identities" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sending Identities</CardTitle>
              <CardDescription>
                Email inboxes used for SDR outreach. The orchestrator automatically selects the healthiest warm inbox.
                Scott@mail.libertybancard.com is the primary sending identity.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SendingIdentitiesTab />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="processor-adapters" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Cpu className="w-4 h-4" />
                Processor Adapters
              </CardTitle>
              <CardDescription>
                Universal processor abstraction layer. Each adapter implements the same interface so new processors can be added without changing the boarding flow.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProcessorAdaptersTab />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="linkedin" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Linkedin className="w-4 h-4 text-blue-600" />
                LinkedIn Enrichment (Proxycurl)
              </CardTitle>
              <CardDescription>
                Automatically enrich contact records with LinkedIn profile data including job title, company, and location.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProxycurlTab />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="zerobounce" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldX className="w-4 h-4 text-violet-600" />
                ZeroBounce
              </CardTitle>
              <CardDescription>
                Review provider safety controls and validation usage.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ZeroBounceSafetyTab />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
