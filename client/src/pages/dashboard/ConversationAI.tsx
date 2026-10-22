import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import {
  MessageSquare,
  Bot,
  Zap,
  Plus,
  Pencil,
  Trash2,
  UserCheck,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Users,
  Copy,
  Check,
  Mail,
  Phone,
  AlertCircle,
  ExternalLink,
  Shield,
} from "lucide-react";
import { PageHeader } from "@/components/crm/CrmPresentation";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface BotContext {
  id: number;
  contextId: string;
  name: string;
  systemPrompt: string;
  faqItems: { question: string; answer: string }[];
  active: boolean;
  autoReplyEnabled: boolean;
  autoReplyDelaySeconds: number;
  confidenceThreshold: number;
  channel: string;
  verticalKey?: string | null;
  updatedAt?: string;
}

interface HandoffRule {
  id: number;
  pattern: string;
  type: "explicit" | "angry" | "complex_pricing" | "low_confidence";
  description?: string;
  active: boolean;
  createdAt?: string;
}

interface LiveSession {
  contactId: number;
  contactName: string;
  companyName: string;
  email: string;
  channel: string;
  lastAt: string;
  minutesActive: number;
  messageCount: number;
  lastMessage?: string;
}

// ─── Handoff type styling ───────────────────────────────────────────────────────
const HANDOFF_TYPE_META: Record<string, { label: string; color: string }> = {
  explicit: { label: "Explicit Request", color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  angry: { label: "Angry / Escalation", color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
  complex_pricing: { label: "Complex Pricing", color: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
  low_confidence: { label: "Low Confidence", color: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200" },
};

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ─── Copy Button ───────────────────────────────────────────────────────────────
function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);
  return (
    <Button variant="ghost" size="sm" onClick={copy} className="h-7 px-2 gap-1" data-testid="button-copy-webhook-url">
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
      <span className="text-xs">{label || (copied ? "Copied!" : "Copy")}</span>
    </Button>
  );
}

// ─── Bot Context Editor Dialog ─────────────────────────────────────────────────
function BotContextDialog({
  ctx,
  open,
  onClose,
}: {
  ctx: BotContext;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(ctx.name);
  const [systemPrompt, setSystemPrompt] = useState(ctx.systemPrompt);
  const [active, setActive] = useState(ctx.active);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(ctx.autoReplyEnabled);
  const [autoReplyDelaySeconds, setAutoReplyDelaySeconds] = useState(String(ctx.autoReplyDelaySeconds));
  const [confidenceThreshold, setConfidenceThreshold] = useState(String(ctx.confidenceThreshold));
  const [channel, setChannel] = useState(ctx.channel);
  const [faqItems, setFaqItems] = useState<{ question: string; answer: string }[]>(ctx.faqItems || []);

  const mutation = useMutation({
    mutationFn: (data: Partial<BotContext>) =>
      apiRequest("PUT", `/api/bot-contexts/${ctx.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-contexts"] });
      toast({ title: "Saved", description: `"${name}" updated successfully.` });
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    mutation.mutate({
      name,
      systemPrompt,
      active,
      autoReplyEnabled,
      autoReplyDelaySeconds: Number(autoReplyDelaySeconds),
      confidenceThreshold: Number(confidenceThreshold),
      channel: channel as any,
      faqItems,
    });
  };

  const addFaq = () => setFaqItems(prev => [...prev, { question: "", answer: "" }]);
  const updateFaq = (i: number, field: "question" | "answer", value: string) => {
    setFaqItems(prev => prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));
  };
  const removeFaq = (i: number) => setFaqItems(prev => prev.filter((_, idx) => idx !== i));

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="bot-context-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-blue-500" />
            Edit Bot Context: {ctx.contextId}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Display Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} data-testid="input-bot-name" />
            </div>
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger data-testid="select-bot-channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  <SelectItem value="chat">Chat only</SelectItem>
                  <SelectItem value="sms">SMS only</SelectItem>
                  <SelectItem value="email">Email only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">Bot will respond on this context</p>
              </div>
              <Switch checked={active} onCheckedChange={setActive} data-testid="toggle-bot-active" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Auto-reply</p>
                <p className="text-xs text-muted-foreground">Send auto-reply after delay</p>
              </div>
              <Switch checked={autoReplyEnabled} onCheckedChange={setAutoReplyEnabled} data-testid="toggle-auto-reply" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Auto-reply Delay (seconds)</Label>
              <Input
                type="number"
                min={30}
                max={86400}
                value={autoReplyDelaySeconds}
                onChange={e => setAutoReplyDelaySeconds(e.target.value)}
                disabled={!autoReplyEnabled}
                data-testid="input-auto-reply-delay"
              />
              <p className="text-xs text-muted-foreground">Current: {formatDelay(Number(autoReplyDelaySeconds))}</p>
            </div>
            <div className="space-y-1.5">
              <Label>Confidence Threshold (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={confidenceThreshold}
                onChange={e => setConfidenceThreshold(e.target.value)}
                data-testid="input-confidence-threshold"
              />
              <p className="text-xs text-muted-foreground">Below this → handoff triggered</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>System Prompt</Label>
            <Textarea
              rows={10}
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              className="font-mono text-sm"
              data-testid="textarea-system-prompt"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>FAQ Items ({faqItems.length})</Label>
              <Button variant="outline" size="sm" onClick={addFaq} data-testid="button-add-faq">
                <Plus className="h-3.5 w-3.5 mr-1" /> Add FAQ
              </Button>
            </div>
            {faqItems.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No FAQ items yet. Add common questions the bot should handle directly.</p>
            ) : (
              <div className="space-y-2">
                {faqItems.map((item, i) => (
                  <div key={i} className="flex gap-2 items-start rounded-lg border p-2">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Input
                        placeholder="Question"
                        value={item.question}
                        onChange={e => updateFaq(i, "question", e.target.value)}
                        data-testid={`input-faq-question-${i}`}
                      />
                      <Input
                        placeholder="Answer"
                        value={item.answer}
                        onChange={e => updateFaq(i, "answer", e.target.value)}
                        data-testid={`input-faq-answer-${i}`}
                      />
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => removeFaq(i)} data-testid={`button-remove-faq-${i}`}>
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={mutation.isPending} data-testid="button-save-bot-context">
            {mutation.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bot Contexts Tab ──────────────────────────────────────────────────────────
function BotContextsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingCtx, setEditingCtx] = useState<BotContext | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const { data: contexts = [], isLoading } = useQuery<BotContext[]>({
    queryKey: ["/api/bot-contexts"],
  });

  const seedMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot-contexts/seed", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-contexts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/handoff-rules"] });
      toast({ title: "Reset complete", description: "Bot contexts and handoff rules restored to defaults." });
      setResetDialogOpen(false);
    },
    onError: (err: any) => {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {contexts.length} bot context{contexts.length !== 1 ? "s" : ""} configured.
          Each context defines the AI's behavior, system prompt, and auto-reply settings for a specific channel or vertical.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setResetDialogOpen(true)}
          data-testid="button-reset-defaults"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Reset to Defaults
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {contexts.map(ctx => (
          <Card key={ctx.id} className={`relative transition-opacity ${!ctx.active ? "opacity-60" : ""}`} data-testid={`card-bot-context-${ctx.id}`}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">{ctx.name}</CardTitle>
                  <CardDescription className="font-mono text-xs mt-0.5">{ctx.contextId}</CardDescription>
                </div>
                <div className="flex items-center gap-1.5">
                  {ctx.active ? (
                    <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-xs">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">Inactive</Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setEditingCtx(ctx)}
                    data-testid={`button-edit-bot-context-${ctx.id}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="flex flex-col items-center justify-center rounded bg-muted/60 p-2">
                  <span className="font-semibold">{ctx.channel}</span>
                  <span className="text-muted-foreground">Channel</span>
                </div>
                <div className="flex flex-col items-center justify-center rounded bg-muted/60 p-2">
                  <span className="font-semibold">{ctx.confidenceThreshold}%</span>
                  <span className="text-muted-foreground">Confidence</span>
                </div>
                <div className="flex flex-col items-center justify-center rounded bg-muted/60 p-2">
                  <span className="font-semibold">{ctx.autoReplyEnabled ? formatDelay(ctx.autoReplyDelaySeconds) : "Off"}</span>
                  <span className="text-muted-foreground">Auto-reply</span>
                </div>
              </div>
              {ctx.verticalKey && (
                <Badge variant="secondary" className="text-xs">{ctx.verticalKey}</Badge>
              )}
              <p className="text-xs text-muted-foreground line-clamp-2">
                {ctx.systemPrompt.slice(0, 120)}…
              </p>
              {ctx.faqItems && ctx.faqItems.length > 0 && (
                <p className="text-xs text-muted-foreground">{ctx.faqItems.length} FAQ item{ctx.faqItems.length !== 1 ? "s" : ""}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {editingCtx && (
        <BotContextDialog ctx={editingCtx} open={!!editingCtx} onClose={() => setEditingCtx(null)} />
      )}

      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to Defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              This will DELETE all current bot contexts and handoff rules and re-seed them with the built-in defaults.
              Any customizations will be permanently lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => seedMutation.mutate()}
              data-testid="button-confirm-reset"
            >
              {seedMutation.isPending ? "Resetting…" : "Yes, Reset"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Handoff Rules Tab ──────────────────────────────────────────────────────────
function HandoffRulesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newPattern, setNewPattern] = useState("");
  const [newType, setNewType] = useState<HandoffRule["type"]>("explicit");
  const [newDescription, setNewDescription] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: rules = [], isLoading } = useQuery<HandoffRule[]>({
    queryKey: ["/api/handoff-rules"],
  });

  const addMutation = useMutation({
    mutationFn: (data: { pattern: string; type: string; description: string }) =>
      apiRequest("POST", "/api/handoff-rules", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/handoff-rules"] });
      toast({ title: "Rule added" });
      setNewPattern("");
      setNewDescription("");
    },
    onError: (err: any) => {
      toast({ title: "Add failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiRequest("PATCH", `/api/handoff-rules/${id}`, { active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/handoff-rules"] });
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/handoff-rules/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/handoff-rules"] });
      toast({ title: "Rule deleted" });
      setDeleteId(null);
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const grouped = (["explicit", "angry", "complex_pricing", "low_confidence"] as const).reduce((acc, t) => {
    acc[t] = rules.filter(r => r.type === t);
    return acc;
  }, {} as Record<string, HandoffRule[]>);

  const typeLabels: Record<string, string> = {
    explicit: "Explicit Requests (user asks for a human)",
    angry: "Angry / Frustrated Intent",
    complex_pricing: "Complex Pricing Questions",
    low_confidence: "Low Confidence / Confusion",
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="p-4 bg-muted/40 rounded-lg border">
        <p className="text-sm font-medium mb-1">How Handoff Rules Work</p>
        <p className="text-xs text-muted-foreground">
          Each rule is a regex pattern matched against inbound messages. When a pattern matches, the bot escalates the conversation to a human rep and fires the <code className="bg-muted px-1 rounded text-[11px]">LB-CHAT-HANDOFF</code> tag in GHL. Rules are checked in order: explicit → angry → complex pricing → low confidence.
        </p>
      </div>

      <div className="space-y-6">
        {Object.entries(grouped).map(([type, typeRules]) => (
          <div key={type}>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${HANDOFF_TYPE_META[type]?.color || "bg-muted"}`}>
                {HANDOFF_TYPE_META[type]?.label || type}
              </span>
              <span className="text-muted-foreground font-normal">{typeLabels[type]}</span>
            </h3>
            <div className="space-y-2">
              {typeRules.length === 0 && (
                <p className="text-xs text-muted-foreground italic pl-2">No rules of this type</p>
              )}
              {typeRules.map(rule => (
                <div key={rule.id} className={`flex items-start gap-3 p-3 border rounded-lg ${!rule.active ? "opacity-50" : ""}`} data-testid={`row-handoff-rule-${rule.id}`}>
                  <Switch
                    checked={rule.active}
                    onCheckedChange={v => toggleMutation.mutate({ id: rule.id, active: v })}
                    className="mt-0.5"
                    data-testid={`toggle-handoff-rule-${rule.id}`}
                  />
                  <div className="flex-1 min-w-0">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded block mb-1 font-mono">{rule.pattern}</code>
                    {rule.description && <p className="text-xs text-muted-foreground">{rule.description}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setDeleteId(rule.id)}
                    data-testid={`button-delete-rule-${rule.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Separator />

      <div>
        <h3 className="text-sm font-semibold mb-3">Add New Rule</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
          <div className="sm:col-span-2">
            <Label className="text-xs mb-1 block">Regex Pattern</Label>
            <Input
              placeholder="e.g. talk to (a )?human"
              value={newPattern}
              onChange={e => setNewPattern(e.target.value)}
              className="font-mono text-xs"
              data-testid="input-new-handoff-pattern"
            />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Type</Label>
            <Select value={newType} onValueChange={v => setNewType(v as HandoffRule["type"])}>
              <SelectTrigger data-testid="select-handoff-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(HANDOFF_TYPE_META).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mb-2">
          <Label className="text-xs mb-1 block">Description (optional)</Label>
          <Input
            placeholder="Brief description of what this pattern catches"
            value={newDescription}
            onChange={e => setNewDescription(e.target.value)}
            className="text-xs"
            data-testid="input-new-handoff-description"
          />
        </div>
        <Button
          onClick={() => addMutation.mutate({ pattern: newPattern, type: newType, description: newDescription })}
          disabled={!newPattern.trim() || addMutation.isPending}
          className="gap-1"
          data-testid="button-add-handoff-rule"
        >
          <Plus className="w-3.5 h-3.5" />
          {addMutation.isPending ? "Adding…" : "Add Rule"}
        </Button>
      </div>

      <AlertDialog open={deleteId !== null} onOpenChange={o => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. Re-seed defaults to restore built-in patterns.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Live Conversations Tab ────────────────────────────────────────────────────
function LiveConversationsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [takeoverTarget, setTakeoverTarget] = useState<number | null>(null);

  const { data: sessions = [], isLoading, dataUpdatedAt } = useQuery<LiveSession[]>({
    queryKey: ["/api/bot-conversations/live"],
    refetchInterval: 30000,
  });

  const takeoverMutation = useMutation({
    mutationFn: (contactId: number) => apiRequest("POST", `/api/bot-conversations/${contactId}/takeover`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-conversations/live"] });
      toast({ title: "Taken over", description: "Bot disabled. Contact tagged for human follow-up in GHL." });
      setTakeoverTarget(null);
    },
    onError: (err: any) => {
      toast({ title: "Takeover failed", description: err.message, variant: "destructive" });
    },
  });

  const channelIcon = (ch: string) => {
    if (ch === "email") return <Mail className="w-3.5 h-3.5" />;
    if (ch === "sms") return <Phone className="w-3.5 h-3.5" />;
    return <MessageSquare className="w-3.5 h-3.5" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            Active bot conversations from the last 4 hours. Refreshes every 30s.
          </p>
          {dataUpdatedAt ? (
            <p className="text-xs text-muted-foreground mt-0.5">
              Last updated: {new Date(dataUpdatedAt).toLocaleTimeString()}
            </p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/bot-conversations/live"] })}
          data-testid="button-refresh-live"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Bot className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-muted-foreground font-medium">No active bot conversations</p>
          <p className="text-sm text-muted-foreground mt-1">Bot sessions from the last 4 hours will appear here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map(s => (
            <div key={s.contactId} className="border rounded-lg p-4 flex items-start gap-4" data-testid={`row-live-session-${s.contactId}`}>
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">
                {s.contactName[0] || "?"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm" data-testid={`text-contact-name-${s.contactId}`}>{s.contactName}</span>
                  {s.companyName && <span className="text-xs text-muted-foreground">{s.companyName}</span>}
                  <span className="flex items-center gap-1 text-xs text-muted-foreground border px-1.5 py-0.5 rounded">
                    {channelIcon(s.channel)} {s.channel}
                  </span>
                </div>
                {s.lastMessage && (
                  <p className="text-xs text-muted-foreground mt-1 truncate">{s.lastMessage}</p>
                )}
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    {s.minutesActive < 60 ? `${s.minutesActive}m ago` : `${Math.round(s.minutesActive / 60)}h ago`}
                  </span>
                  <span className="text-xs text-muted-foreground">{s.messageCount} msg{s.messageCount !== 1 ? "s" : ""}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTakeoverTarget(s.contactId)}
                className="shrink-0 gap-1"
                data-testid={`button-takeover-${s.contactId}`}
              >
                <Users className="w-3.5 h-3.5" />
                Take Over
              </Button>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={takeoverTarget !== null} onOpenChange={o => !o && setTakeoverTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take over this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot will be disabled for this contact and a human handoff tag will be applied in GHL. You'll need to follow up manually.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => takeoverTarget && takeoverMutation.mutate(takeoverTarget)}
              disabled={takeoverMutation.isPending}
              data-testid="button-confirm-takeover"
            >
              <UserCheck className="h-4 w-4 mr-1.5" />
              {takeoverMutation.isPending ? "Taking over…" : "Yes, Take Over"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Webhook Guide ─────────────────────────────────────────────────────────────
function WebhookGuide() {
  const baseUrl = typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}`
    : "https://your-app.replit.app";

  const endpoints = [
    {
      event: "InboundMessage",
      path: "/api/webhooks/ghl/message-received",
      description: "Routes SMS and email replies to the bot auto-reply engine",
      icon: <MessageSquare className="w-4 h-4" />,
    },
    {
      event: "ChatWidgetMessage",
      path: "/api/webhooks/ghl/chat-message",
      description: "Handles live chat widget messages for bot qualification",
      icon: <Bot className="w-4 h-4" />,
    },
    {
      event: "ContactUpdated",
      path: "/api/webhooks/ghl/contact-updated",
      description: "Syncs contact data changes back to the SDR pipeline",
      icon: <Users className="w-4 h-4" />,
    },
    {
      event: "AppointmentBooked",
      path: "/api/webhooks/ghl/appointment-booked",
      description: "Triggers booking confirmation workflow and stage transition",
      icon: <CheckCircle2 className="w-4 h-4" />,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="p-4 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">Setup Required</p>
            <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
              You must register these webhook URLs in GHL before the bot can receive inbound messages. Go to{" "}
              <strong>GHL → Settings → Integrations → Webhooks</strong> and add each URL below.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {endpoints.map(ep => (
          <div key={ep.event} className="border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-muted-foreground">{ep.icon}</span>
              <span className="text-sm font-medium">GHL Event: <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{ep.event}</code></span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">{ep.description}</p>
            <div className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
              <code className="text-xs flex-1 break-all font-mono">{baseUrl}{ep.path}</code>
              <CopyButton value={`${baseUrl}${ep.path}`} />
            </div>
          </div>
        ))}
      </div>

      <div className="border rounded-lg p-4">
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          Webhook Security Checklist
        </h4>
        <div className="space-y-2">
          {[
            "Set GHL_WEBHOOK_SECRET env var to a secure random string (32+ chars)",
            "In GHL Webhooks settings, enter the same value as the signing secret",
            "Verify GHL is sending X-GHL-Signature header with each request",
            "Test by sending a test message from a GHL contact and checking the Operator Dashboard → Webhook Events tab",
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <span className="text-muted-foreground">{item}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border rounded-lg p-4">
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <ExternalLink className="w-4 h-4" />
          GHL Navigation Path
        </h4>
        <p className="text-xs text-muted-foreground">
          <strong>Settings</strong> → <strong>Integrations</strong> → <strong>Webhooks</strong> → <strong>Add Webhook</strong>
          {" "}→ Paste the URL → Select the matching event type → Save
        </p>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────
export default function ConversationAI() {
  const { data: stats } = useQuery<BotContext[], Error, { total: number; active: number }>({
    queryKey: ["/api/bot-contexts"],
    select: (data) => ({
      total: data.length,
      active: data.filter(d => d.active).length,
    }),
  });

  const { data: liveCount } = useQuery<LiveSession[], Error, number>({
    queryKey: ["/api/bot-conversations/live"],
    select: (data) => data.length,
    refetchInterval: 30000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Conversation AI"
        subtitle="Manage GHL bot contexts, handoff rules, and monitor live AI conversations."
      />

      {/* KPI Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900">
                <Bot className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.active ?? "—"}</p>
                <p className="text-xs text-muted-foreground">Active Contexts</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900">
                <Zap className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.total ?? "—"}</p>
                <p className="text-xs text-muted-foreground">Total Contexts</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900">
                <MessageSquare className="h-4 w-4 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{liveCount ?? 0}</p>
                <p className="text-xs text-muted-foreground">Live Sessions</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Tabs defaultValue="contexts">
            <div className="border-b px-4 pt-3">
              <TabsList className="h-auto bg-transparent p-0 gap-4">
                <TabsTrigger
                  value="contexts"
                  className="rounded-none border-b-2 border-transparent pb-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
                  data-testid="tab-bot-contexts"
                >
                  <Bot className="h-4 w-4 mr-1.5" />
                  Bot Contexts
                </TabsTrigger>
                <TabsTrigger
                  value="handoff"
                  className="rounded-none border-b-2 border-transparent pb-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
                  data-testid="tab-handoff-rules"
                >
                  <AlertTriangle className="h-4 w-4 mr-1.5" />
                  Handoff Rules
                </TabsTrigger>
                <TabsTrigger
                  value="live"
                  className="rounded-none border-b-2 border-transparent pb-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
                  data-testid="tab-live-conversations"
                >
                  <MessageSquare className="h-4 w-4 mr-1.5" />
                  Live Conversations
                  {liveCount ? (
                    <span className="ml-1.5 bg-green-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
                      {liveCount}
                    </span>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger
                  value="webhooks"
                  className="rounded-none border-b-2 border-transparent pb-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
                  data-testid="tab-webhooks"
                >
                  <Zap className="h-4 w-4 mr-1.5" />
                  Webhooks
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="p-4">
              <TabsContent value="contexts" className="mt-0">
                <BotContextsTab />
              </TabsContent>
              <TabsContent value="handoff" className="mt-0">
                <HandoffRulesTab />
              </TabsContent>
              <TabsContent value="live" className="mt-0">
                <LiveConversationsTab />
              </TabsContent>
              <TabsContent value="webhooks" className="mt-0">
                <WebhookGuide />
              </TabsContent>
            </div>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
