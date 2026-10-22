import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle, XCircle, Save, RefreshCw, Workflow, Search, Copy, Download, ChevronDown, ChevronRight, Bot, FileText, Phone, Mic, Mail, MessageSquare, Settings2, Map, Play, Pause, Loader2, AlertTriangle, Zap, ExternalLink, Info } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { jsPDF } from "jspdf";
import {
  SEQUENCE_PROMPTS,
  CONVERSATION_AI_SYSTEM_PROMPT,
  CATEGORY_LABELS,
  type SequencePrompt,
  type SequenceStep,
} from "@/lib/ghl-workflow-prompts";

const ALL_SEQUENCES = [
  // Core Sales & Education
  { name: "1. Switch & Save — Statement Audit", category: "sales" },
  { name: "2. Payment Stack 101 — Education", category: "education" },
  { name: "3. Fast Approval — Application Completion", category: "onboarding" },
  { name: "4. Trust Builder — Authority Sequence", category: "sales" },
  { name: "5. Chargeback Defense", category: "risk" },
  { name: "6. Funding Speed & Reliability", category: "sales" },
  { name: "8. Liberty Smart Terminal — Product Showcase", category: "hardware" },
  { name: "9. Surcharge & Cash Discount — Compliance", category: "sales" },
  { name: "10. Retail Merchants — SDR Outbound + Drip", category: "sdr_outbound" },
  { name: "11. Auto Merchants — SDR Outbound + Drip", category: "sdr_outbound" },
  { name: "12. Medical & Med Spa — SDR Outbound + Drip", category: "sdr_outbound" },
  { name: "13. Recurring Billing — Subscription Merchants", category: "sales" },
  { name: "15. Omnichannel — Online + In-Person", category: "sales" },
  { name: "16. Security & PCI Compliance — Made Easy", category: "education" },
  { name: "17. Contract Escape — Switch Help", category: "sales" },
  { name: "18. Objection Crusher — Overcome Hesitation", category: "sales" },
  { name: "19. Reactivation — Cold Lead Revival", category: "reactivation" },
  { name: "20. Free Analysis Follow-Up", category: "sales" },
  { name: "Post-Call Review Follow-Up", category: "sales" },
  { name: "Proposal Follow-Up", category: "sales" },
  { name: "No-Show Reschedule", category: "sales" },
  { name: "Long-Term Nurture", category: "nurture" },
  // SDR Cold Outbound by Vertical
  { name: "SDR: Cold Outbound — Auto Repair", category: "sdr_cold_outbound" },
  { name: "SDR: Cold Outbound — Med Spa", category: "sdr_cold_outbound" },
  { name: "SDR: Cold Outbound — Dental", category: "sdr_cold_outbound" },
  { name: "SDR: Cold Outbound — Construction", category: "sdr_cold_outbound" },
  // SDR Reply & Pipeline Handling
  { name: "SDR: Reply Engaged", category: "sdr_reply_engaged" },
  { name: "SDR: Statement Chase", category: "sdr_statement_chase" },
  { name: "SDR: Proposal Follow-Up", category: "sdr_proposal_followup" },
  { name: "SDR: No-Show Recovery", category: "sdr_noshow_recovery" },
  // Vertical Playbooks — Retail
  { name: "V-Retail: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Retail: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Retail: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Auto
  { name: "V-Auto: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Auto: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Auto: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Medical
  { name: "V-Medical: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Medical: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Medical: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Med Spa
  { name: "V-Med Spa: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Med Spa: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Med Spa: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Dental
  { name: "V-Dental: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Dental: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Dental: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Auto Repair
  { name: "V-Auto Repair: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Auto Repair: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Auto Repair: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Salon
  { name: "V-Salon: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Salon: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Salon: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Gym
  { name: "V-Gym: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Gym: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Gym: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Hotel
  { name: "V-Hotel: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Hotel: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Hotel: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Landscaping
  { name: "V-Landscaping: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Landscaping: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Landscaping: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Construction
  { name: "V-Construction: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Construction: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Construction: Account Management Ops", category: "operations" },
  // Vertical Playbooks — Legal
  { name: "V-Legal: SDR Outbound Prospecting", category: "sdr" },
  { name: "V-Legal: Inbound Lead Nurture", category: "inbound" },
  { name: "V-Legal: Account Management Ops", category: "operations" },
];

interface WorkflowMapping {
  id: number;
  sequenceName: string;
  ghlWorkflowId: string | null;
  category: string | null;
  description: string | null;
  updatedAt: string | null;
}

const CATEGORY_COLORS: Record<string, string> = {
  sales: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  education: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  onboarding: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  risk: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  hardware: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  sdr_outbound: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  sdr_cold_outbound: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
  sdr_reply_engaged: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  sdr_statement_chase: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  sdr_proposal_followup: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  sdr_noshow_recovery: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  reactivation: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
  nurture: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  sdr: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  inbound: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  operations: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
};

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  call: "Call",
  voicemail_drop: "Voicemail Drop",
  task: "Internal Task",
  ai_conversation: "Conversation AI",
};

const CHANNEL_COLORS: Record<string, string> = {
  email: "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800",
  sms: "bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800",
  call: "bg-orange-50 border-orange-200 dark:bg-orange-900/20 dark:border-orange-800",
  voicemail_drop: "bg-purple-50 border-purple-200 dark:bg-purple-900/20 dark:border-purple-800",
  task: "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800",
  ai_conversation: "bg-purple-50 border-purple-200 dark:bg-purple-900/20 dark:border-purple-800",
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast({ title: "Copied", description: `${label} copied to clipboard.` });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Error", description: "Could not copy to clipboard.", variant: "destructive" });
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="h-7 px-2 text-xs shrink-0"
      data-testid={`button-copy-${label.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}
    >
      {copied ? <CheckCircle className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
      <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  email: <Mail className="w-3.5 h-3.5" />,
  sms: <MessageSquare className="w-3.5 h-3.5" />,
  call: <Phone className="w-3.5 h-3.5" />,
  voicemail_drop: <Mic className="w-3.5 h-3.5" />,
  task: <FileText className="w-3.5 h-3.5" />,
  ai_conversation: <Bot className="w-3.5 h-3.5" />,
};

function StepCard({ step, sequenceId }: { step: SequenceStep; sequenceId: string }) {
  const [expanded, setExpanded] = useState(false);
  const channelColor = CHANNEL_COLORS[step.channel] || "";

  const isCall = step.channel === "call";
  const isVoicemail = step.channel === "voicemail_drop";

  const primaryCopyText = isCall
    ? (step.callScript || "")
    : isVoicemail
    ? (step.voicemailScript || "")
    : step.subject
    ? `Subject: ${step.subject}\n\n${step.body}`
    : step.body;

  const previewText = isCall
    ? (step.callScript?.slice(0, 80) + "…")
    : isVoicemail
    ? (step.voicemailScript?.slice(0, 80) + "…")
    : step.subject
    ? step.subject
    : step.body.slice(0, 80) + "…";

  return (
    <div className={`border rounded-lg overflow-hidden ${channelColor}`} data-testid={`card-step-${sequenceId}-${step.stepNumber}`}>
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(e => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setExpanded(v => !v); }}
        data-testid={`button-expand-step-${sequenceId}-${step.stepNumber}`}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-xs font-bold shrink-0 w-6 h-6 rounded-full bg-foreground/10 flex items-center justify-center">
            {step.stepNumber}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                isCall ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
                : isVoicemail ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                : "bg-foreground/10 text-foreground/60"
              }`}>
                {CHANNEL_ICONS[step.channel]}
                {CHANNEL_LABELS[step.channel] || step.channel}
              </span>
              <span className="text-xs text-muted-foreground">— {step.delayDescription}</span>
              {step.callMode && (
                <span className="text-xs text-orange-600 dark:text-orange-400 font-medium">Mode: {step.callMode}</span>
              )}
            </div>
            <p className="text-sm text-foreground/80 truncate mt-0.5">{previewText}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <CopyButton text={primaryCopyText} label={`Step ${step.stepNumber} of ${sequenceId}`} />
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {isCall && (
            <>
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Call Script (30–45 sec)</p>
                <div className="flex items-start gap-2">
                  <pre className="text-sm whitespace-pre-wrap font-sans flex-1 leading-relaxed text-foreground/90 bg-orange-50 dark:bg-orange-900/10 rounded p-2 border border-orange-200 dark:border-orange-800">{step.callScript}</pre>
                  <CopyButton text={step.callScript || ""} label={`Call script step ${step.stepNumber} ${sequenceId}`} />
                </div>
              </div>
              {step.callMode && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mode:</span>
                  <span className="text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 px-2 py-0.5 rounded font-medium">{step.callMode}</span>
                </div>
              )}
              {step.ghlNote && (
                <div className="flex items-start gap-2 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded p-2">
                  <Settings2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-800 dark:text-blue-300"><span className="font-semibold">GHL Setup: </span>{step.ghlNote}</p>
                </div>
              )}
            </>
          )}
          {isVoicemail && (
            <>
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Voicemail Script (15–20 sec)</p>
                <div className="flex items-start gap-2">
                  <pre className="text-sm whitespace-pre-wrap font-sans flex-1 leading-relaxed text-foreground/90 bg-purple-50 dark:bg-purple-900/10 rounded p-2 border border-purple-200 dark:border-purple-800">{step.voicemailScript}</pre>
                  <CopyButton text={step.voicemailScript || ""} label={`Voicemail script step ${step.stepNumber} ${sequenceId}`} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground italic">Record this as an audio file and upload to GHL Voicemail Drops library.</p>
              {step.ghlNote && (
                <div className="flex items-start gap-2 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded p-2">
                  <Settings2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-800 dark:text-blue-300"><span className="font-semibold">GHL Setup: </span>{step.ghlNote}</p>
                </div>
              )}
            </>
          )}
          {!isCall && !isVoicemail && (
            <>
              {step.subject && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Subject Line</p>
                  <div className="flex items-start gap-2">
                    <p className="text-sm font-medium flex-1">{step.subject}</p>
                    <CopyButton text={step.subject} label={`Subject step ${step.stepNumber} ${sequenceId}`} />
                  </div>
                </div>
              )}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                  {step.channel === "email" ? "Email Body" : step.channel === "sms" ? "SMS Message" : "Task / Notes"}
                </p>
                <div className="flex items-start gap-2">
                  <pre className="text-sm whitespace-pre-wrap font-sans flex-1 leading-relaxed text-foreground/90">{step.body}</pre>
                  <CopyButton text={step.body} label={`Body step ${step.stepNumber} ${sequenceId}`} />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PRIMARY_CADENCE_SEQUENCES = [
  "1. Switch & Save — Statement Audit",
  "20. Free Analysis Follow-Up",
  "SDR: Reply Engaged",
  "SDR: Statement Chase",
  "SDR: Proposal Follow-Up",
  "SDR: No-Show Recovery",
];

const COLD_OUTBOUND_CADENCE_SEQUENCES = [
  "SDR: Cold Outbound — Auto Repair",
  "SDR: Cold Outbound — Med Spa",
  "SDR: Cold Outbound — Dental",
  "SDR: Cold Outbound — Construction",
];

type CadenceGroup = "primary" | "cold_outbound";

type StepConfig = {
  callMode?: string;
  scriptType?: string;
  voicemailScript?: string;
  opening?: string;
  close?: string;
  ghlNote?: string;
  [key: string]: unknown;
};

type DbStep = {
  id: number;
  stepOrder: number;
  actionType: string;
  delayDays: number;
  delayHours: number;
  subject?: string | null;
  config?: StepConfig | string | null;
};

type SequenceStepsResponse = {
  sequence: { id: number; name: string; description: string };
  steps: DbStep[];
};

function delayLabel(step: DbStep, prevStep: DbStep | null): string {
  if (step.stepOrder === 1) return "Day 0";
  const days = step.delayDays ?? 0;
  const hours = step.delayHours ?? 0;
  if (days === 0 && hours === 0) return "+immediate";
  if (days === 0) return `+${hours}h`;
  if (hours === 0) return `Day +${days}`;
  return `Day +${days} +${hours}h`;
}

function CadenceTimeline() {
  const [group, setGroup] = useState<CadenceGroup>("primary");
  const [selected, setSelected] = useState(PRIMARY_CADENCE_SEQUENCES[0]);

  const activeList = group === "primary" ? PRIMARY_CADENCE_SEQUENCES : COLD_OUTBOUND_CADENCE_SEQUENCES;

  const handleGroupChange = (g: CadenceGroup) => {
    setGroup(g);
    setSelected(g === "primary" ? PRIMARY_CADENCE_SEQUENCES[0] : COLD_OUTBOUND_CADENCE_SEQUENCES[0]);
  };

  const { data, isLoading, error } = useQuery<SequenceStepsResponse>({
    queryKey: ["/api/sequences", selected, "steps"],
    queryFn: async () => {
      const r = await fetch(`/api/sequences/by-name/${encodeURIComponent(selected)}/steps`, { credentials: "include" });
      if (!r.ok) throw new Error(`Failed to load sequence steps: ${r.status}`);
      return r.json() as Promise<SequenceStepsResponse>;
    },
    enabled: !!selected,
  });

  const steps = data?.steps ?? [];

  const cumulativeDays = (stepList: DbStep[]) => {
    let total = 0;
    return stepList.map((s, i) => {
      if (i > 0) {
        total += (s.delayDays ?? 0) + (s.delayHours ?? 0) / 24;
      }
      return Math.round(total * 10) / 10;
    });
  };
  const cumulative = cumulativeDays(steps);

  return (
    <div className="space-y-6" data-testid="cadence-timeline-panel">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Map className="w-5 h-5 text-primary" />
          Cadence Timeline Visualizer
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Horizontal step-by-step timeline for each sales cadence sequence, pulled live from the database.
        </p>
      </div>

      <div className="flex items-center gap-3" data-testid="cadence-group-toggle">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">View:</span>
        <Button
          size="sm"
          variant={group === "primary" ? "default" : "outline"}
          onClick={() => handleGroupChange("primary")}
          className="text-xs"
          data-testid="button-group-primary"
        >
          Inbound / Primary Sequences
        </Button>
        <Button
          size="sm"
          variant={group === "cold_outbound" ? "default" : "outline"}
          onClick={() => handleGroupChange("cold_outbound")}
          className="text-xs"
          data-testid="button-group-cold-outbound"
        >
          Cold Outbound SDR
        </Button>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="cadence-sequence-selector">
        {activeList.map(name => (
          <Button
            key={name}
            size="sm"
            variant={selected === name ? "default" : "outline"}
            onClick={() => setSelected(name)}
            className="text-xs"
            data-testid={`button-cadence-${name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`}
          >
            {name}
          </Button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading sequence steps…
        </div>
      )}

      {error && (
        <div className="text-sm text-red-500 py-4" data-testid="cadence-error">
          Failed to load sequence steps. Make sure the sequence name matches a seeded sequence.
        </div>
      )}

      {!isLoading && data && (
        <Card data-testid={`card-cadence-${selected.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{data.sequence.name}</CardTitle>
            {data.sequence.description && (
              <p className="text-xs text-muted-foreground">{data.sequence.description}</p>
            )}
          </CardHeader>
          <CardContent>
            {steps.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No steps seeded yet.</p>
            ) : (
              <div className="overflow-x-auto pb-3">
                <div className="flex items-start gap-0 min-w-max">
                  {steps.map((step, i) => {
                    const style = CHANNEL_CHIP_STYLES[step.actionType] || CHANNEL_CHIP_STYLES.email;
                    const isCall = step.actionType === "call";
                    const isVm = step.actionType === "voicemail_drop";
                    const rawConfig = step.config;
                    const config: StepConfig | null = rawConfig == null
                      ? null
                      : typeof rawConfig === "string"
                        ? (JSON.parse(rawConfig) as StepConfig)
                        : rawConfig;
                    const vmScript = typeof config?.voicemailScript === "string" ? config.voicemailScript : null;
                    const label = CHANNEL_LABELS[step.actionType] || step.actionType;

                    return (
                      <div key={step.id} className="flex items-center" data-testid={`timeline-step-${i + 1}`}>
                        <div className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg border text-center min-w-[88px] max-w-[96px] ${style.bg}`}>
                          <span className="flex items-center gap-1 text-current">{style.icon}</span>
                          <span className="text-[10px] font-semibold leading-tight">{label}</span>
                          <span className="text-[9px] opacity-60 leading-tight font-mono">
                            {i === 0 ? "Day 0" : delayLabel(step, steps[i - 1])}
                          </span>
                          {step.subject && (
                            <span className="text-[9px] opacity-70 leading-tight truncate w-full text-center px-1">
                              {step.subject.length > 22 ? step.subject.slice(0, 22) + "…" : step.subject}
                            </span>
                          )}
                          {(isCall || isVm) && vmScript && (
                            <span className="text-[9px] opacity-60 leading-tight italic truncate w-full text-center px-1" title={vmScript}>
                              {vmScript.slice(0, 22)}…
                            </span>
                          )}
                          <span className="text-[9px] font-bold opacity-50">#{i + 1}</span>
                        </div>
                        {i < steps.length - 1 && (
                          <div className="w-5 h-px bg-border shrink-0" />
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 flex flex-wrap gap-2 text-[10px]">
                  {Object.entries(CHANNEL_LABELS).map(([k, v]) => {
                    const style = CHANNEL_CHIP_STYLES[k];
                    if (!style) return null;
                    return (
                      <span key={k} className={`flex items-center gap-1 px-2 py-0.5 rounded-full border ${style.bg}`}>
                        {style.icon} {v}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {steps.length > 0 && (
              <div className="mt-4 border-t pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Sequence Summary</p>
                <div className="flex flex-wrap gap-4 text-xs text-foreground/80">
                  <span><span className="font-semibold">{steps.length}</span> steps total</span>
                  <span><span className="font-semibold">{steps.filter(s => s.actionType === "email").length}</span> emails</span>
                  <span><span className="font-semibold">{steps.filter(s => s.actionType === "sms").length}</span> SMS</span>
                  <span><span className="font-semibold">{steps.filter(s => s.actionType === "call").length}</span> calls</span>
                  <span><span className="font-semibold">{steps.filter(s => s.actionType === "voicemail_drop").length}</span> voicemail drops</span>
                  <span>~<span className="font-semibold">{Math.round(cumulative[cumulative.length - 1])}</span> day span</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="mt-2" data-testid="card-cadence-branch-logic">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">GHL Branch Logic for Call + Voicemail Steps</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 text-xs text-foreground/80">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span><span className="font-semibold">Call Answered</span> → Remove from sequence → enroll in "Inbound Nurture" workflow</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
              <span><span className="font-semibold">Voicemail Left</span> → Drop voicemail audio → send follow-up SMS (5 min delay via GHL if/then)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-slate-400 shrink-0" />
              <span><span className="font-semibold">No Answer</span> → Continue sequence to next step</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span><span className="font-semibold">DNC / STOP reply</span> → Remove from all sequences immediately</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const COLD_OUTBOUND_IDS = ["cold-outbound-auto-repair", "cold-outbound-dental", "cold-outbound-medspa", "cold-outbound-construction"];

const GROUP_BY_CATEGORY: Record<string, "inbound" | "cold_sdr" | "sales" | "ops"> = {
  inbound: "inbound",
  sales: "sales",
  onboarding: "sales",
  reactivation: "sales",
  nurture: "sales",
  sdr: "cold_sdr",
  sdr_cold_outbound: "cold_sdr",
  sdr_reply_engaged: "cold_sdr",
  sdr_statement_chase: "cold_sdr",
  sdr_proposal_followup: "cold_sdr",
  sdr_noshow_recovery: "cold_sdr",
  operations: "ops",
  education: "ops",
};

const GROUP_LABELS: Record<string, string> = {
  all: "All",
  inbound: "Inbound",
  cold_sdr: "Cold SDR",
  sales: "Sales",
  ops: "Ops",
};

const GROUP_CADENCE_MODELS: Record<string, string> = {
  inbound: "Immediate response cadence: SMS + Call + Voicemail within 15 minutes of form submission. Designed for urgent lead capture before competitors engage.",
  cold_sdr: "Multi-touch cold outbound: Email/SMS days 1–7, Call + Voicemail on days 8–10. SDR-specific variants (Reply Engaged, Statement Chase, Proposal Follow-Up, No-Show Recovery) run 2–7 days.",
  sales: "Consultative follow-up: Email/SMS touchpoints days 1–5, Call + Voicemail on days 6–10. Reactivation sequences run to day 14. Nurture sequences run monthly (no voicemail).",
  ops: "Relationship management: Call check-ins on day 14 and quarterly thereafter. No voicemail drop — these are operational, not sales, calls.",
};

const NO_VOICEMAIL_CATEGORIES = new Set(["operations", "education", "nurture"]);

const CHANNEL_CHIP_STYLES: Record<string, { bg: string; icon: React.ReactNode }> = {
  email: { bg: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300", icon: <Mail className="w-3 h-3" /> },
  sms: { bg: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300", icon: <MessageSquare className="w-3 h-3" /> },
  call: { bg: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300", icon: <Phone className="w-3 h-3" /> },
  voicemail_drop: { bg: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300", icon: <Mic className="w-3 h-3" /> },
  task: { bg: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300", icon: <FileText className="w-3 h-3" /> },
  ai_conversation: { bg: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300", icon: <Bot className="w-3 h-3" /> },
};

type DbSequence = {
  id: number;
  name: string;
  status: string;
};

type SequenceListEntry = {
  id: string;
  name: string;
  category: string;
  groupLabel: string;
  cadenceModel: string;
  nodeOrder: string[];
  branches: Array<{ type: string; action: string }>;
  exitConditions: string[];
  hasVoicemail: boolean;
  trigger: string;
};

const DB_NAME_BY_PROMPT_ID: Record<string, string> = {
  "cold-outbound-auto-repair": "SDR: Cold Outbound — Auto Repair",
  "cold-outbound-medspa": "SDR: Cold Outbound — Med Spa",
  "cold-outbound-dental": "SDR: Cold Outbound — Dental",
  "cold-outbound-construction": "SDR: Cold Outbound — Construction",
};

const GHL_TAG_BY_PROMPT_ID: Record<string, string> = {
  "cold-outbound-auto-repair": "LB-COLD-AUTO-REPAIR",
  "cold-outbound-medspa": "LB-COLD-MEDSPA",
  "cold-outbound-dental": "LB-COLD-DENTAL",
  "cold-outbound-construction": "LB-COLD-CONSTRUCTION",
};

function CadenceBlueprints() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdminOrManager = user?.role === "admin" || user?.role === "manager";
  const [groupFilter, setGroupFilter] = useState<"all" | "inbound" | "cold_sdr" | "sales" | "ops">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: dbSequences = [], isLoading: dbLoading } = useQuery<DbSequence[]>({
    queryKey: ["/api/sequences"],
  });

  const { data: blueprintApiData } = useQuery<{ sequences: SequenceListEntry[] }>({
    queryKey: ["/api/sequences/list"],
  });

  const getBlueprintEntry = (seqId: string): SequenceListEntry | undefined =>
    blueprintApiData?.sequences.find(s => s.id === seqId);

  const toggleMutation = useMutation({
    mutationFn: async ({ id, newStatus }: { id: number; newStatus: string }) => {
      return apiRequest("PUT", `/api/sequences/${id}`, { status: newStatus });
    },
    onSuccess: (_, { newStatus }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
      toast({
        title: newStatus === "active" ? "Sequence activated" : "Sequence paused",
        description: newStatus === "active"
          ? "This sequence will now auto-enroll matching contacts."
          : "This sequence is paused. No new contacts will be enrolled.",
      });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update sequence status.", variant: "destructive" });
    },
  });

  const syncDocMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/training/sync-main-ghl-doc", {}),
    onSuccess: () => {
      toast({
        title: "Google Doc Synced",
        description: "GHL Workflow Node Blueprints have been appended to the Liberty Bancard GHL doc.",
      });
    },
    onError: () => {
      toast({ title: "Sync Failed", description: "Could not sync blueprints to Google Doc.", variant: "destructive" });
    },
  });

  const getDbSeq = (promptId: string): DbSequence | undefined =>
    dbSequences.find(s => s.name === DB_NAME_BY_PROMPT_ID[promptId]);

  const isTogglingId = (id: number) =>
    toggleMutation.isPending && (toggleMutation.variables as { id: number })?.id === id;

  const filteredSequences = SEQUENCE_PROMPTS.filter(seq => {
    const group = GROUP_BY_CATEGORY[seq.category] || "sales";
    const matchGroup = groupFilter === "all" || group === groupFilter;
    const q = searchQuery.toLowerCase();
    const matchSearch = !q || seq.name.toLowerCase().includes(q) || seq.category.toLowerCase().includes(q);
    return matchGroup && matchSearch;
  });

  const getBranchLogic = (seq: SequencePrompt) => {
    const hasVoicemail = seq.steps.some(s => s.channel === "voicemail_drop");
    const isOps = NO_VOICEMAIL_CATEGORIES.has(seq.category);
    const isSdrReply = seq.category === "sdr_reply_engaged";
    const isSdrStatement = seq.category === "sdr_statement_chase";
    const isSdrProposal = seq.category === "sdr_proposal_followup";
    const isSdrNoShow = seq.category === "sdr_noshow_recovery";

    if (isOps) return [
      { color: "bg-green-500", label: "Call Answered", desc: "Log account health check → update CRM notes" },
      { color: "bg-slate-400", label: "No Answer", desc: "Continue ops cadence — no voicemail (account context)" },
    ];
    if (isSdrReply) return [
      { color: "bg-green-500", label: "Appointment Booked", desc: "Stop sequence → move to appointment confirmation workflow" },
      { color: "bg-blue-500", label: "Statement Sent", desc: "Stop sequence → enroll in Statement Chase" },
      { color: "bg-slate-400", label: "No Response", desc: "Continue sequence" },
    ];
    if (isSdrStatement) return [
      { color: "bg-green-500", label: "Statement Received", desc: "Stop sequence → trigger statement review workflow" },
      { color: "bg-purple-500", label: "Voicemail", desc: "Drop voicemail audio → follow-up SMS in 5 min" },
      { color: "bg-slate-400", label: "No Response", desc: "Escalate with call + voicemail on day 5" },
    ];
    if (isSdrProposal) return [
      { color: "bg-green-500", label: "Deal Closed", desc: "Stop sequence → move to Onboarding workflow" },
      { color: "bg-amber-500", label: "Objection Raised", desc: "Enroll in Objection Crusher sequence" },
      { color: "bg-purple-500", label: "Voicemail", desc: "Drop voicemail audio → follow-up SMS in 5 min" },
      { color: "bg-slate-400", label: "No Response", desc: "Continue sequence" },
    ];
    if (isSdrNoShow) return [
      { color: "bg-green-500", label: "Appointment Rescheduled", desc: "Stop sequence → update calendar" },
      { color: "bg-purple-500", label: "Voicemail", desc: "Drop voicemail audio → reschedule link SMS in 5 min" },
      { color: "bg-slate-400", label: "No Response", desc: "Exit after day 5 with final DNC check" },
    ];

    const branches = [
      { color: "bg-green-500", label: "Call Answered", desc: "Remove from sequence → update deal stage → enroll in Inbound Nurture workflow" },
      ...(hasVoicemail ? [{ color: "bg-purple-500", label: "Voicemail", desc: "Drop voicemail audio → send follow-up SMS in 5 min" }] : []),
      { color: "bg-slate-400", label: "No Answer", desc: "Continue sequence to next step" },
    ];
    return branches;
  };

  const getExitConditions = (seq: SequencePrompt) => {
    if (NO_VOICEMAIL_CATEGORIES.has(seq.category)) return [
      "Contact opts out or DNC tag added → stop immediately",
      "Churn detected → move to Reactivation sequence",
    ];
    if (seq.category === "sdr_cold_outbound") return [
      "Reply received → enroll in SDR Reply Engaged sequence",
      "Appointment booked → stop",
      "Statement received → enroll in Statement Chase sequence",
      "DNC / STOP reply → stop immediately",
      "No engagement after day 12 → exit sequence",
    ];
    if (seq.category === "onboarding") return [
      "Application submitted → stop sequence",
      "Merchant goes live (LB-LIVE tag) → stop",
      "DNC / STOP → stop immediately",
    ];
    if (seq.category === "reactivation" || seq.category === "nurture") return [
      "Contact re-engages (replies or books) → move to Inbound Nurture or Sales sequence",
      "DNC / STOP → stop immediately",
    ];
    return [
      "Contact replies to any email or SMS → stop sequence",
      "Appointment booked (LB-BOOKING-READY tag added) → stop",
      "DNC / STOP reply received → stop immediately",
    ];
  };

  const getChecklist = (seq: SequencePrompt) => {
    const hasVoicemail = seq.steps.some(s => s.channel === "voicemail_drop");
    const isColdOutbound = COLD_OUTBOUND_IDS.includes(seq.id);
    const tag = GHL_TAG_BY_PROMPT_ID[seq.id];
    const triggerLine = tag
      ? `Create workflow in GHL with trigger: Contact Tag Added = ${tag}`
      : `Create workflow in GHL — trigger: ${seq.triggerConditions.split(/[.,]/)[0].trim()}`;
    return [
      triggerLine,
      "Add each step as a GHL action in order (see AI Workflow Prompts tab for scripts)",
      "Configure If/Then branches on all Call steps",
      "Add exit conditions for reply detection and booking/DNC tags",
      ...(hasVoicemail ? ["Upload voicemail audio files to GHL Voicemail Drops library"] : []),
      "Test with a dummy contact in GHL before going live",
      ...(isColdOutbound ? ["Click Activate on the card above to enable contact enrollment"] : []),
    ];
  };

  const groupCounts = {
    all: SEQUENCE_PROMPTS.length,
    inbound: SEQUENCE_PROMPTS.filter(s => GROUP_BY_CATEGORY[s.category] === "inbound").length,
    cold_sdr: SEQUENCE_PROMPTS.filter(s => GROUP_BY_CATEGORY[s.category] === "cold_sdr").length,
    sales: SEQUENCE_PROMPTS.filter(s => GROUP_BY_CATEGORY[s.category] === "sales").length,
    ops: SEQUENCE_PROMPTS.filter(s => GROUP_BY_CATEGORY[s.category] === "ops").length,
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Map className="w-5 h-5 text-primary" />
          GHL Cadence Blueprints
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Build-ready workflow blueprint for every sequence — trigger, node order, if/then branches, and exit conditions. Use the AI Workflow Prompts tab for copy-paste scripts.
        </p>
        {isAdminOrManager && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 gap-2 text-xs"
            onClick={() => syncDocMutation.mutate()}
            disabled={syncDocMutation.isPending}
            data-testid="button-sync-ghl-doc"
          >
            {syncDocMutation.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            Sync Blueprints to Google Doc
          </Button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap" data-testid="blueprint-group-filters">
        {(["all", "inbound", "cold_sdr", "sales", "ops"] as const).map(g => (
          <Button
            key={g}
            variant={groupFilter === g ? "default" : "outline"}
            size="sm"
            onClick={() => setGroupFilter(g)}
            data-testid={`button-filter-group-${g}`}
          >
            {GROUP_LABELS[g]} ({groupCounts[g]})
          </Button>
        ))}
      </div>

      {groupFilter !== "all" && GROUP_CADENCE_MODELS[groupFilter] && (
        <Card className="border-blue-200 bg-blue-50/40 dark:bg-blue-900/10 dark:border-blue-800">
          <CardContent className="p-4">
            <p className="text-xs font-semibold text-blue-800 dark:text-blue-300 uppercase tracking-wide mb-1">
              {GROUP_LABELS[groupFilter]} Cadence Model
            </p>
            <p className="text-sm text-foreground/80">{GROUP_CADENCE_MODELS[groupFilter]}</p>
          </CardContent>
        </Card>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search blueprints..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-blueprints"
        />
      </div>

      {filteredSequences.length === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm">No sequences match your filter.</div>
      )}

      {filteredSequences.map(seq => {
        const dbSeq = getDbSeq(seq.id);
        const isActive = dbSeq?.status === "active";
        const isPaused = COLD_OUTBOUND_IDS.includes(seq.id) && !isActive;
        const isToggling = dbSeq ? isTogglingId(dbSeq.id) : false;
        const apiBp = getBlueprintEntry(seq.id);
        const apiBranches = apiBp?.branches.map(b => ({
          color: b.type === "Call Answered" || b.type === "Appointment Booked" || b.type === "Statement Received" || b.type === "Deal Closed" ? "bg-green-500"
            : b.type === "Voicemail" ? "bg-purple-500"
            : b.type === "No Answer" || b.type === "No Response" ? "bg-slate-400"
            : "bg-blue-500",
          label: b.type,
          desc: b.action,
        }));
        const branches = apiBranches || getBranchLogic(seq);
        const exitConditions = apiBp?.exitConditions || getExitConditions(seq);
        const checklist = getChecklist(seq);
        const hasVoicemail = seq.steps.some(s => s.channel === "voicemail_drop");

        return (
          <Card key={seq.id} className="overflow-hidden" data-testid={`card-blueprint-${seq.id}`}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[seq.category] || "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>
                      {CATEGORY_LABELS[seq.category] || seq.category}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 font-medium">
                      {GROUP_LABELS[GROUP_BY_CATEGORY[seq.category] || "sales"]}
                    </span>
                    {!hasVoicemail && (
                      <span className="text-xs text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                        <Mic className="w-3 h-3" /> No voicemail
                      </span>
                    )}
                    {!dbLoading && dbSeq && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold flex items-center gap-1 ${isActive ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"}`}
                        data-testid={`badge-status-${seq.id}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-green-500" : "bg-slate-400"}`} />
                        {isActive ? "Active" : "Paused"}
                      </span>
                    )}
                  </div>
                  <CardTitle className="text-base">{seq.name}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">{seq.triggerConditions}</p>
                </div>

                {dbSeq && (
                  <Button
                    size="sm"
                    variant={isActive ? "outline" : "default"}
                    className={isActive ? "text-slate-600 border-slate-300" : "bg-green-600 hover:bg-green-700 text-white"}
                    disabled={isToggling}
                    onClick={() => toggleMutation.mutate({ id: dbSeq.id, newStatus: isActive ? "paused" : "active" })}
                    data-testid={`button-toggle-${seq.id}`}
                  >
                    {isToggling ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    ) : isActive ? (
                      <Pause className="w-3.5 h-3.5 mr-1.5" />
                    ) : (
                      <Play className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {isToggling ? "Saving..." : isActive ? "Pause" : "Activate"}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {isPaused && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-800 px-4 py-3 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                  <span className="shrink-0 mt-0.5">⚠</span>
                  <span>This sequence is <strong>paused</strong>. No contacts will be enrolled until you click Activate. Build and test the GHL workflow first, then activate.</span>
                </div>
              )}

              {apiBp?.cadenceModel && (
                <div className="rounded-lg bg-muted/40 border border-border px-3 py-2 text-xs text-foreground/80">
                  <span className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">Cadence Model: </span>
                  {apiBp.cadenceModel}
                </div>
              )}

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Node Order — Cadence Timeline</p>
                <div className="overflow-x-auto pb-2">
                  <div className="flex gap-2 min-w-max">
                    {seq.steps.map(step => {
                      const style = CHANNEL_CHIP_STYLES[step.channel] || CHANNEL_CHIP_STYLES.email;
                      return (
                        <div
                          key={step.stepNumber}
                          className={`flex flex-col items-center gap-1 px-2.5 py-2 rounded-lg border text-center min-w-[72px] ${style.bg}`}
                          data-testid={`chip-step-${seq.id}-${step.stepNumber}`}
                        >
                          <span className="flex items-center gap-1">{style.icon}</span>
                          <span className="text-[10px] font-semibold leading-tight">{CHANNEL_LABELS[step.channel]}</span>
                          <span className="text-[10px] opacity-70 leading-tight">{step.delayDescription}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">If/Then Branch Logic</p>
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5 text-xs text-foreground/80">
                  {branches.map((b, i) => (
                    <div key={i} className="flex items-start gap-2" data-testid={`branch-${seq.id}-${i}`}>
                      <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${b.color}`} />
                      <span><span className="font-semibold">{b.label}</span> → {b.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Exit Conditions</p>
                <ul className="text-xs text-foreground/80 space-y-1 list-none">
                  {exitConditions.map((cond, i) => (
                    <li key={i} className="flex items-start gap-2" data-testid={`exit-${seq.id}-${i}`}>
                      <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />
                      <span>{cond}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">GHL Build Checklist</p>
                <ul className="text-xs text-foreground/80 space-y-1.5">
                  {checklist.map((item, i) => (
                    <li key={i} className="flex items-start gap-2" data-testid={`checklist-${seq.id}-${i}`}>
                      <span className="w-4 h-4 rounded shrink-0 mt-0.5 flex items-center justify-center border border-border">
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function SequenceCard({ sequence }: { sequence: SequencePrompt }) {
  const [expanded, setExpanded] = useState(false);
  const [aiPromptExpanded, setAiPromptExpanded] = useState(false);
  const [builderSetupExpanded, setBuilderSetupExpanded] = useState(false);
  const categoryLabel = CATEGORY_LABELS[sequence.category] || sequence.category;
  const categoryColor = CATEGORY_COLORS[sequence.category] || "bg-gray-100 text-gray-700";

  const { data: blueprintApiData } = useQuery<{ sequences: SequenceListEntry[] }>({
    queryKey: ["/api/sequences/list"],
  });
  const blueprint = blueprintApiData?.sequences.find(s => s.id === sequence.id);

  const aiPromptBlock = sequence.usesConversationAI
    ? `\n\nCONVERSATION AI SYSTEM PROMPT (paste into GHL AI Agent Settings):\n${"─".repeat(60)}\n${CONVERSATION_AI_SYSTEM_PROMPT}\n${"─".repeat(60)}\n`
    : "";

  const fullSequenceText = [
    `SEQUENCE: ${sequence.name}`,
    `CATEGORY: ${categoryLabel}`,
    ``,
    `TRIGGER CONDITIONS:`,
    sequence.triggerConditions,
    ``,
    sequence.usesConversationAI
      ? `USES CONVERSATION AI: Yes\n${aiPromptBlock}`
      : `USES CONVERSATION AI: No`,
    ``,
    ...sequence.steps.flatMap(step => {
      const lines = [
        `─────────────────────────────────`,
        `STEP ${step.stepNumber} — ${CHANNEL_LABELS[step.channel] || step.channel}`,
        `Timing: ${step.delayDescription}`,
      ];
      if (step.channel === "call") {
        if (step.callMode) lines.push(`Call Mode: ${step.callMode}`);
        lines.push(``, `CALL SCRIPT (30–45 sec):`, step.callScript || "");
        if (step.ghlNote) lines.push(``, `GHL SETUP: ${step.ghlNote}`);
      } else if (step.channel === "voicemail_drop") {
        lines.push(``, `VOICEMAIL SCRIPT (15–20 sec):`, step.voicemailScript || "");
        if (step.ghlNote) lines.push(``, `GHL SETUP: ${step.ghlNote}`);
        lines.push(`NOTE: Record as audio file and upload to GHL Voicemail Drops library.`);
      } else {
        if (step.subject) lines.push(`Subject: ${step.subject}`, ``);
        lines.push(step.body);
        if (step.ghlNote) lines.push(``, `GHL SETUP: ${step.ghlNote}`);
      }
      lines.push(``);
      return lines;
    }),
  ].filter(l => l !== undefined).join("\n");

  return (
    <Card className="overflow-hidden" data-testid={`card-sequence-prompt-${sequence.id}`}>
      <div className="flex items-start justify-between gap-4 p-4">
        <div
          className="flex-1 min-w-0 cursor-pointer"
          onClick={() => setExpanded(e => !e)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setExpanded(v => !v); }}
          data-testid={`button-expand-sequence-${sequence.id}`}
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryColor}`}>
              {categoryLabel}
            </span>
            {sequence.usesConversationAI && (
              <span className="flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 font-medium">
                <Bot className="w-3 h-3" /> Conversation AI
              </span>
            )}
            <span className="text-xs text-muted-foreground">{sequence.steps.length} steps</span>
          </div>
          <h3 className="font-semibold text-foreground text-sm">{sequence.name}</h3>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{sequence.triggerConditions}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <CopyButton text={fullSequenceText} label={`sequence ${sequence.id}`} />
          <div
            className="cursor-pointer p-1"
            onClick={() => setExpanded(e => !e)}
            role="button"
            tabIndex={-1}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border/60 pt-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Trigger Conditions</p>
            <p className="text-sm text-foreground/80">{sequence.triggerConditions}</p>
          </div>
          {sequence.usesConversationAI && (
            <div className="rounded-lg border border-purple-200 dark:border-purple-800 overflow-hidden">
              <div className="flex items-center justify-between gap-2 p-3 bg-purple-50 dark:bg-purple-900/20">
                <div
                  className="flex items-center gap-2 text-purple-800 dark:text-purple-300 text-sm font-medium flex-1 cursor-pointer"
                  onClick={() => setAiPromptExpanded(v => !v)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setAiPromptExpanded(v => !v); }}
                  data-testid={`button-expand-ai-prompt-${sequence.id}`}
                >
                  <Bot className="w-4 h-4 shrink-0" />
                  <span>Conversation AI System Prompt (paste into GHL AI Agent Settings)</span>
                  {aiPromptExpanded ? <ChevronDown className="w-4 h-4 ml-1" /> : <ChevronRight className="w-4 h-4 ml-1" />}
                </div>
                <CopyButton text={CONVERSATION_AI_SYSTEM_PROMPT} label={`ai-prompt-${sequence.id}`} />
              </div>
              {aiPromptExpanded && (
                <div className="p-3 bg-background border-t border-purple-200 dark:border-purple-800">
                  <pre className="text-xs whitespace-pre-wrap font-sans text-foreground/80 leading-relaxed max-h-80 overflow-y-auto" data-testid={`text-ai-prompt-${sequence.id}`}>
                    {CONVERSATION_AI_SYSTEM_PROMPT}
                  </pre>
                </div>
              )}
            </div>
          )}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Steps</p>
            {sequence.steps.map(step => (
              <StepCard key={step.stepNumber} step={step} sequenceId={sequence.id} />
            ))}
          </div>

          {blueprint && (
            <div className="rounded-lg border border-blue-200 dark:border-blue-800 overflow-hidden" data-testid={`card-builder-setup-${sequence.id}`}>
              <div
                className="flex items-center justify-between gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                onClick={() => setBuilderSetupExpanded(v => !v)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setBuilderSetupExpanded(v => !v); }}
                data-testid={`button-expand-builder-setup-${sequence.id}`}
                aria-expanded={builderSetupExpanded}
              >
                <div className="flex items-center gap-2 text-blue-800 dark:text-blue-300 text-sm font-medium">
                  <Settings2 className="w-4 h-4 shrink-0" />
                  <span>GHL Workflow Builder Setup</span>
                  {builderSetupExpanded ? <ChevronDown className="w-4 h-4 ml-1" /> : <ChevronRight className="w-4 h-4 ml-1" />}
                </div>
              </div>
              {builderSetupExpanded && (
                <div className="p-3 bg-background border-t border-blue-200 dark:border-blue-800 space-y-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Trigger</p>
                    <p className="text-xs text-foreground/80">{blueprint.trigger}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Cadence Model</p>
                    <p className="text-xs text-foreground/80">{blueprint.cadenceModel}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Node Order</p>
                    <div className="flex flex-wrap gap-1">
                      {blueprint.nodeOrder.map((node, i) => (
                        <span key={i} className="text-[10px] bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700 px-1.5 py-0.5 rounded">
                          {i + 1}. {node}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">If/Then Branches</p>
                    <div className="space-y-1">
                      {blueprint.branches.map((b, i) => (
                        <div key={i} className="text-xs text-foreground/80">
                          <span className="font-semibold text-foreground/90">{b.type}</span> → {b.action}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Exit Conditions</p>
                    <ul className="space-y-0.5">
                      {blueprint.exitConditions.map((cond, i) => (
                        <li key={i} className="text-xs text-foreground/80 flex items-start gap-1.5">
                          <CheckCircle className="w-3 h-3 text-green-500 shrink-0 mt-0.5" />
                          {cond}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function PromptsDocument() {
  const { toast } = useToast();
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const categories = Array.from(new Set(SEQUENCE_PROMPTS.map(s => s.category)));

  const filtered = SEQUENCE_PROMPTS.filter(seq => {
    const matchCategory = filterCategory === "all" || seq.category === filterCategory;
    const q = searchQuery.toLowerCase();
    const matchSearch = !q || seq.name.toLowerCase().includes(q) || seq.category.toLowerCase().includes(q) || seq.triggerConditions.toLowerCase().includes(q);
    return matchCategory && matchSearch;
  });

  const handleDownload = () => {
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    const maxLineWidth = pageWidth - margin * 2;
    const lineHeight = 11;
    let y = margin;

    const addText = (text: string, fontSize = 8, bold = false) => {
      doc.setFontSize(fontSize);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      const splitLines = doc.splitTextToSize(text, maxLineWidth);
      for (const line of splitLines) {
        if (y + lineHeight > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
        doc.text(line, margin, y);
        y += lineHeight;
      }
    };

    const addBlankLine = () => { y += lineHeight * 0.5; };

    addText("LIBERTY BANCARD — GHL AI WORKFLOW PROMPTS", 13, true);
    addText(`Generated: ${new Date().toLocaleDateString()}`, 8);
    addBlankLine();
    addText("=".repeat(90), 7);
    addText("CONVERSATION AI SYSTEM PROMPT", 11, true);
    addText("Paste into GHL → Automation → [Workflow] → Conversation AI → AI Agent → System Prompt", 8);
    addText("=".repeat(90), 7);
    addBlankLine();
    addText(CONVERSATION_AI_SYSTEM_PROMPT, 7);
    addBlankLine();
    addText("=".repeat(90), 7);
    addText("SEQUENCE PROMPTS", 11, true);
    addText("=".repeat(90), 7);
    addBlankLine();

    for (const seq of SEQUENCE_PROMPTS) {
      addText("─".repeat(90), 7);
      addText(`SEQUENCE: ${seq.name}`, 10, true);
      addText(`Category: ${CATEGORY_LABELS[seq.category] || seq.category}`, 8);
      addText(`Conversation AI: ${seq.usesConversationAI ? "Yes — apply system prompt to AI Agent step" : "No"}`, 8);
      addBlankLine();
      addText("TRIGGER CONDITIONS:", 8, true);
      addText(seq.triggerConditions, 7);
      addBlankLine();

      if (seq.usesConversationAI) {
        addText("CONVERSATION AI SYSTEM PROMPT (paste into GHL AI Agent Settings):", 8, true);
        addText(CONVERSATION_AI_SYSTEM_PROMPT, 7);
        addBlankLine();
      }

      for (const step of seq.steps) {
        addText(`STEP ${step.stepNumber} — ${CHANNEL_LABELS[step.channel] || step.channel}`, 9, true);
        addText(`Timing: ${step.delayDescription}`, 8);
        if (step.channel === "call") {
          if (step.callMode) addText(`Call Mode: ${step.callMode}`, 8);
          addBlankLine();
          addText("CALL SCRIPT (30–45 sec):", 8, true);
          addText(step.callScript || "", 7);
          if (step.ghlNote) { addBlankLine(); addText(`GHL SETUP: ${step.ghlNote}`, 7); }
        } else if (step.channel === "voicemail_drop") {
          addBlankLine();
          addText("VOICEMAIL SCRIPT (15–20 sec):", 8, true);
          addText(step.voicemailScript || "", 7);
          if (step.ghlNote) { addBlankLine(); addText(`GHL SETUP: ${step.ghlNote}`, 7); }
          addText("NOTE: Record as audio file and upload to GHL Voicemail Drops library.", 7);
        } else {
          if (step.subject) addText(`Subject: ${step.subject}`, 8);
          addBlankLine();
          addText(step.body, 7);
          if (step.ghlNote) { addBlankLine(); addText(`GHL SETUP: ${step.ghlNote}`, 7); }
        }
        addBlankLine();
      }
      addBlankLine();
    }

    doc.save("liberty-bancard-ghl-workflow-prompts.pdf");
    toast({ title: "Downloaded", description: "Prompts document saved as PDF." });
  };

  const handleCopyAll = async () => {
    const lines: string[] = [
      "LIBERTY BANCARD — GHL AI WORKFLOW PROMPTS",
      "=".repeat(80),
      "",
      "CONVERSATION AI SYSTEM PROMPT",
      "=".repeat(80),
      CONVERSATION_AI_SYSTEM_PROMPT,
      "",
    ];
    for (const seq of SEQUENCE_PROMPTS) {
      lines.push(`${"─".repeat(60)}`);
      lines.push(`SEQUENCE: ${seq.name}`);
      lines.push(`TRIGGER: ${seq.triggerConditions}`);
      lines.push(`CONVERSATION AI: ${seq.usesConversationAI ? "Yes" : "No"}`);
      lines.push("");
      for (const step of seq.steps) {
        lines.push(`STEP ${step.stepNumber} [${CHANNEL_LABELS[step.channel]}] — ${step.delayDescription}`);
        if (step.channel === "call") {
          if (step.callMode) lines.push(`Call Mode: ${step.callMode}`);
          lines.push(`CALL SCRIPT: ${step.callScript || ""}`);
          if (step.ghlNote) lines.push(`GHL SETUP: ${step.ghlNote}`);
        } else if (step.channel === "voicemail_drop") {
          lines.push(`VOICEMAIL SCRIPT: ${step.voicemailScript || ""}`);
          if (step.ghlNote) lines.push(`GHL SETUP: ${step.ghlNote}`);
          lines.push(`NOTE: Record as audio file and upload to GHL Voicemail Drops library.`);
        } else {
          if (step.subject) lines.push(`Subject: ${step.subject}`);
          lines.push(step.body);
          if (step.ghlNote) lines.push(`GHL SETUP: ${step.ghlNote}`);
        }
        lines.push("");
      }
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast({ title: "Copied", description: "All prompts copied to clipboard." });
    } catch {
      toast({ title: "Error", description: "Could not copy to clipboard.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            GHL AI Workflow Prompts Document
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Copy-paste-ready prompts for all sequences. Expand a sequence to view and copy individual steps.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCopyAll} data-testid="button-copy-all-prompts">
            <Copy className="w-4 h-4 mr-1" /> Copy All
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload} data-testid="button-download-prompts">
            <Download className="w-4 h-4 mr-1" /> Download PDF
          </Button>
        </div>
      </div>

      <Card className="border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-900/10">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2 text-purple-800 dark:text-purple-300">
              <Bot className="w-4 h-4" />
              Conversation AI System Prompt
            </CardTitle>
            <CopyButton text={CONVERSATION_AI_SYSTEM_PROMPT} label="Conversation AI system prompt" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Paste into GHL → Automation → [Workflow] → Conversation AI → AI Agent → System Prompt
          </p>
        </CardHeader>
        <CardContent>
          <pre className="text-xs whitespace-pre-wrap font-sans text-foreground/80 max-h-64 overflow-y-auto leading-relaxed border border-border rounded-md p-3 bg-background" data-testid="text-conversation-ai-prompt">
            {CONVERSATION_AI_SYSTEM_PROMPT}
          </pre>
        </CardContent>
      </Card>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search sequences..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-prompts"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          <Button
            variant={filterCategory === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterCategory("all")}
            data-testid="button-filter-all"
          >
            All ({SEQUENCE_PROMPTS.length})
          </Button>
          {categories.map(cat => (
            <Button
              key={cat}
              variant={filterCategory === cat ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterCategory(cat)}
              data-testid={`button-filter-${cat}`}
            >
              {CATEGORY_LABELS[cat] || cat} ({SEQUENCE_PROMPTS.filter(s => s.category === cat).length})
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">No sequences match your search.</div>
        ) : (
          filtered.map(seq => <SequenceCard key={seq.id} sequence={seq} />)
        )}
      </div>
    </div>
  );
}

const GHL_SETUP_STEPS = [
  {
    step: 1,
    title: "Fix your GHL token",
    detail: "In GHL → Settings → Private Integrations, regenerate your token. Then set the env var GHL_PRIVATE_INTEGRATION_TOKEN in Replit Secrets and restart the app.",
    link: "https://app.gohighlevel.com/settings/private-integrations",
    linkLabel: "GHL Private Integrations",
    critical: true,
  },
  {
    step: 2,
    title: "Build workflows in GHL",
    detail: "In GHL → Automation → Workflows, create one workflow per sequence. Copy the full email/SMS/call/voicemail content from the AI Workflow Prompts tab. Set the trigger to \"Contact Tag Added\" using the sequence's LB-* tag (e.g. LB-SEQ-COLD-AUTO). GHL then handles all delivery — email, SMS, voicemail drops, and AI calls.",
    link: "https://app.gohighlevel.com/automation/workflows",
    linkLabel: "GHL Automation",
    critical: true,
  },
  {
    step: 3,
    title: "Copy each workflow ID from GHL (optional, reference only)",
    detail: "Open a GHL workflow → click the three-dot menu → Settings. The Workflow ID is a long alphanumeric string (e.g. abc1234def5678...). Copy it.",
    critical: false,
  },
  {
    step: 4,
    title: "Paste the workflow ID into the fields below",
    detail: "Find the matching sequence below, paste the GHL Workflow ID, and click Save. The ID is stored as a reference only. Replit keeps running cadence and execution; saving an ID does not enroll contacts in GHL or start anything.",
    critical: false,
  },
  {
    step: 5,
    title: "Activate sequences in Replit",
    detail: "Go to Dashboard → Sequences and unpause the sequences you want running. For full SDR automation, start with: SDR Cold Outbound (by vertical), SDR Reply Engaged, SDR Statement Chase, and SDR No-Show Recovery.",
    critical: false,
  },
];

function GhlSetupGuide({ configuredCount, totalCount }: { configuredCount: number; totalCount: number }) {
  const [open, setOpen] = useState(configuredCount === 0);
  const allDone = configuredCount === totalCount;

  return (
    <Card className={`border-2 ${allDone ? "border-green-400 dark:border-green-700" : "border-amber-400 dark:border-amber-700"}`} data-testid="card-ghl-setup-guide">
      <div
        className={`flex items-center justify-between p-4 cursor-pointer rounded-t-lg transition-colors ${allDone ? "bg-green-50 dark:bg-green-900/20" : "bg-amber-50 dark:bg-amber-900/20"}`}
        onClick={() => setOpen(v => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setOpen(v => !v); }}
        data-testid="button-toggle-setup-guide"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          {allDone
            ? <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
            : <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          }
          <div>
            <p className={`font-semibold text-sm ${allDone ? "text-green-800 dark:text-green-300" : "text-amber-800 dark:text-amber-300"}`}>
              {allDone
                ? "Reference IDs recorded for all sequences"
                : `Reference IDs: ${configuredCount} of ${totalCount} recorded (optional — not a launch requirement)`}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {allDone
                ? "Sequence IDs are reference-only; IDs for supported handoff workflows are used when Replit enrolls those contacts and are skipped when missing. Replit owns cadence and sending; incoming GHL sync is controlled separately and the global outbound pause still applies."
                : "Missing sequence IDs do not change sequence execution. A missing ID for a supported handoff workflow skips that enrollment. Replit owns cadence. Click to see steps."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${allDone ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}>
            {configuredCount}/{totalCount} connected
          </span>
          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <CardContent className="pt-0 pb-5 px-4 border-t border-border/50">
          <div className="mt-4 mb-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-start gap-2">
            <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-800 dark:text-blue-300">
              <span className="font-semibold">Architecture: Replit owns cadence.</span>{" "}
              Replit manages contacts, decides eligibility and timing, and runs sequence delivery under the global outbound pause. Pasted sequence workflow IDs are reference-only records and are not required to launch sequences; IDs for supported handoff workflows (form confirmation, scheduling, merchant application, proposal follow-up, affiliate welcome) are used when Replit enrolls those contacts.
            </p>
          </div>

          <div className="space-y-3 mt-4">
            {GHL_SETUP_STEPS.map(s => (
              <div key={s.step} className="flex gap-3" data-testid={`setup-step-${s.step}`}>
                <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${s.critical ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}>
                  {s.step}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-foreground">{s.title}</p>
                    {s.critical && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 font-semibold uppercase tracking-wide">Required first</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{s.detail}</p>
                  {s.link && (
                    <a
                      href={s.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                      data-testid={`link-setup-step-${s.step}`}
                    >
                      <ExternalLink className="w-3 h-3" />
                      {s.linkLabel}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 pt-4 border-t border-border/50">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Reference designs (not required to run sequences)</p>
            <div className="flex flex-wrap gap-1.5">
              {["SDR: Cold Outbound — Auto Repair", "SDR: Cold Outbound — Med Spa", "SDR: Cold Outbound — Dental", "SDR: Cold Outbound — Construction", "SDR: Reply Engaged", "SDR: Statement Chase", "SDR: Proposal Follow-Up", "SDR: No-Show Recovery", "1. Switch & Save — Statement Audit"].map(name => (
                <span key={name} className="text-xs bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full">{name}</span>
              ))}
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-border/50">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Who owns what</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/10 p-3">
                <p className="text-xs font-semibold text-blue-800 dark:text-blue-300 flex items-center gap-1.5 mb-1.5">
                  <Zap className="w-3.5 h-3.5" /> Replit manages
                </p>
                <ul className="space-y-0.5 text-xs text-blue-700 dark:text-blue-400">
                  <li>• Contact & lead database</li>
                  <li>• Sequence enrollment, timing and sending</li>
                  <li>• Lead scoring & intent detection</li>
                  <li>• Deal pipeline & CRM</li>
                  <li>• Starts only the supported handoff workflows (see notice above)</li>
                </ul>
              </div>
              <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10 p-3">
                <p className="text-xs font-semibold text-green-800 dark:text-green-300 flex items-center gap-1.5 mb-1.5">
                  <Workflow className="w-3.5 h-3.5" /> GHL provides
                </p>
                <ul className="space-y-0.5 text-xs text-green-700 dark:text-green-400">
                  <li>• Incoming contact, conversation and appointment sync</li>
                  <li>• Handoff workflows you built and saved an ID for</li>
                  <li>• Calendars and the GHL inbox</li>
                  <li>• Nothing here overrides the global outbound pause</li>
</ul>
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default function GhlWorkflowManager() {
  const { toast } = useToast();
  const [editingIds, setEditingIds] = useState<Record<string, string>>({});
  const [savingSequences, setSavingSequences] = useState<Set<string>>(new Set());
  const [testingSequences, setTestingSequences] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, { valid: boolean; active?: boolean; warning?: string; error?: string; name?: string }>>({});
  const [searchQuery, setSearchQuery] = useState("");

  const { data: mappings = [], isLoading } = useQuery<WorkflowMapping[]>({
    queryKey: ["/api/ghl/workflow-mappings"],
  });

  const mappingByName = Object.fromEntries(mappings.map(m => [m.sequenceName, m]));

  const saveMutation = useMutation({
    mutationFn: async ({ sequenceName, ghlWorkflowId, category }: { sequenceName: string; ghlWorkflowId: string; category: string }) => {
      return apiRequest("PUT", `/api/ghl/workflow-mappings/${encodeURIComponent(sequenceName)}`, { ghlWorkflowId: ghlWorkflowId || null, category });
    },
    onSuccess: (_, { sequenceName }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ghl/workflow-mappings"] });
      setSavingSequences(prev => { const next = new Set(prev); next.delete(sequenceName); return next; });
      setEditingIds(prev => { const next = { ...prev }; delete next[sequenceName]; return next; });
      toast({ title: "Saved", description: "Workflow ID updated successfully." });
    },
    onError: (_, { sequenceName }) => {
      setSavingSequences(prev => { const next = new Set(prev); next.delete(sequenceName); return next; });
      toast({ title: "Error", description: "Failed to save workflow ID.", variant: "destructive" });
    },
  });

  const handleSave = (sequenceName: string, category: string) => {
    const ghlWorkflowId = editingIds[sequenceName] ?? (mappingByName[sequenceName]?.ghlWorkflowId || "");
    setSavingSequences(prev => new Set(prev).add(sequenceName));
    saveMutation.mutate({ sequenceName, ghlWorkflowId, category });
  };

  const handleTest = async (sequenceName: string) => {
    const workflowId = getWorkflowId(sequenceName);
    if (!workflowId || workflowId.trim().length < 8) {
      toast({ title: "No workflow ID", description: "Enter a GHL workflow ID before testing.", variant: "destructive" });
      return;
    }
    setTestingSequences(prev => new Set(prev).add(sequenceName));
    try {
      const res = await apiRequest("POST", `/api/admin/ghl-workflows/${encodeURIComponent(workflowId)}/test`, {});
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [sequenceName]: data }));
      if (data.valid && data.active !== false) {
        toast({ title: "Workflow found & active ✓", description: `GHL confirmed: "${data.name || workflowId}"` });
      } else if (data.valid && data.active === false) {
        toast({ title: "Workflow found — not active", description: data.warning || "Workflow exists but is not published/active. Contacts may not be enrolled.", variant: "destructive" });
      } else {
        toast({ title: "Workflow not found", description: data.error || "GHL returned invalid for this ID.", variant: "destructive" });
      }
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [sequenceName]: { valid: false, error: err.message } }));
      toast({ title: "Test failed", description: err.message, variant: "destructive" });
    } finally {
      setTestingSequences(prev => { const next = new Set(prev); next.delete(sequenceName); return next; });
    }
  };

  const getWorkflowId = (sequenceName: string) => {
    if (sequenceName in editingIds) return editingIds[sequenceName];
    return mappingByName[sequenceName]?.ghlWorkflowId || "";
  };

  const isEdited = (sequenceName: string) => sequenceName in editingIds;
  const hasId = (sequenceName: string) => {
    const id = mappingByName[sequenceName]?.ghlWorkflowId;
    return !!id && id.trim() !== "";
  };

  const configuredCount = ALL_SEQUENCES.filter(s => hasId(s.name)).length;

  const filteredSequences = ALL_SEQUENCES.filter(s =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Workflow className="w-6 h-6 text-primary" />
            GHL Workflow Reference &amp; Sequence Blueprints
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Replit controls all sequences, cadences, enrollment, and suppression. GHL is the transport and conversation layer.
          </p>
        </div>
      </div>

      {/* Architecture statement */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10" data-testid="banner-ghl-arch-statement">
        <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <p className="text-xs text-blue-800 dark:text-blue-300 leading-relaxed">
          <span className="font-semibold">Architecture note:</span> Replit owns all sequence cadences, routing logic, enrollment gates, suppression, sender policy, and audit.
          GHL is used only for email/SMS delivery, the conversation inbox, contact sync, and inbound webhook events.
          The workflow IDs below are <span className="font-semibold">reference only</span> — outbound sequence execution happens inside Replit's sequence engine, not GHL native workflows.
          Only the <span className="font-semibold">Inbound Confirmation</span> slot in Settings → Integrations → GHL Workflow IDs needs to be configured.
        </p>
      </div>

      <Tabs defaultValue="id-manager">
        <TabsList data-testid="tabs-ghl-workflows">
          <TabsTrigger value="id-manager" data-testid="tab-id-manager">
            <Workflow className="w-4 h-4 mr-1.5" />
            Workflow ID Manager
          </TabsTrigger>
          <TabsTrigger value="prompts" data-testid="tab-prompts">
            <FileText className="w-4 h-4 mr-1.5" />
            AI Workflow Prompts
          </TabsTrigger>
          <TabsTrigger value="blueprints" data-testid="tab-blueprints">
            <Map className="w-4 h-4 mr-1.5" />
            Cadence Blueprints
          </TabsTrigger>
          <TabsTrigger value="cadence" data-testid="tab-cadence">
            <Play className="w-4 h-4 mr-1.5" />
            Cadence Timeline
          </TabsTrigger>
        </TabsList>

        <TabsContent value="id-manager" className="space-y-4 mt-4">
          <GhlSetupGuide configuredCount={configuredCount} totalCount={ALL_SEQUENCES.length} />

          <div className="flex items-center justify-between flex-wrap gap-3">
            <Card className="flex-1" data-testid="card-ghl-workflow-summary">
              <CardContent className="p-4">
                <div className="flex items-center gap-6 flex-wrap">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    <span className="text-sm"><span className="font-semibold">{configuredCount}</span> of <span className="font-semibold">{ALL_SEQUENCES.length}</span> sequences connected to GHL</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <XCircle className="w-4 h-4 text-amber-400" />
                    <span className="text-sm"><span className="font-semibold">{ALL_SEQUENCES.length - configuredCount}</span> need a GHL workflow ID</span>
                  </div>
                </div>
                <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{ width: `${Math.round((configuredCount / ALL_SEQUENCES.length) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Replit's sequence engine schedules and sends all outbound messages. These workflow IDs are for reference only —
                  only the inbound confirmation slot in Settings → Integrations needs to be active.
                </p>
              </CardContent>
            </Card>
            <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/ghl/workflow-mappings"] })} data-testid="button-refresh-mappings">
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search sequences by name or category..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-sequences"
            />
          </div>

          <div className="space-y-3">
            {isLoading ? (
              <div className="text-center py-12 text-muted-foreground">Loading workflow mappings...</div>
            ) : (
              filteredSequences.map(seq => {
                const currentId = getWorkflowId(seq.name);
                const edited = isEdited(seq.name);
                const configured = hasId(seq.name);
                const isSaving = savingSequences.has(seq.name);
                const categoryColor = CATEGORY_COLORS[seq.category] || "bg-gray-100 text-gray-700";

                return (
                  <Card key={seq.name} className={`transition-all ${edited ? "ring-2 ring-primary/30" : ""}`} data-testid={`card-sequence-${seq.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-medium text-sm text-foreground truncate">{seq.name}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryColor}`}>{seq.category}</span>
                            {configured && !edited && (
                              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                <CheckCircle className="w-3 h-3" /> Connected
                              </span>
                            )}
                            {!configured && (
                              <span className="flex items-center gap-1 text-xs text-red-500">
                                <XCircle className="w-3 h-3" /> No ID set
                              </span>
                            )}
                            {edited && (
                              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Unsaved</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            <Input
                              placeholder="Paste GHL workflow ID here (e.g. abc123def456...)"
                              value={currentId}
                              onChange={e => setEditingIds(prev => ({ ...prev, [seq.name]: e.target.value }))}
                              className="font-mono text-xs h-8 flex-1"
                              data-testid={`input-workflow-id-${seq.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`}
                            />
                            <Button
                              size="sm"
                              variant={edited ? "default" : "outline"}
                              disabled={isSaving || (!edited && configured)}
                              onClick={() => handleSave(seq.name, seq.category)}
                              className="shrink-0 h-8"
                              data-testid={`button-save-${seq.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`}
                            >
                              {isSaving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                              <span className="ml-1 text-xs">{isSaving ? "Saving..." : "Save"}</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={testingSequences.has(seq.name) || !currentId || currentId.trim().length < 8}
                              onClick={() => handleTest(seq.name)}
                              className={`shrink-0 h-8 ${testResults[seq.name] ? (testResults[seq.name].valid ? "text-green-600" : "text-destructive") : ""}`}
                              title="Ping GHL to verify this workflow ID is valid"
                              data-testid={`button-test-${seq.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`}
                            >
                              {testingSequences.has(seq.name)
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : testResults[seq.name]
                                  ? (testResults[seq.name].valid ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />)
                                  : <Zap className="w-3 h-3" />}
                              <span className="ml-1 text-xs">{testingSequences.has(seq.name) ? "..." : "Test"}</span>
                            </Button>
                          </div>
                          {testResults[seq.name] && !testResults[seq.name].valid && (
                            <p className="text-xs text-destructive mt-1" data-testid={`text-test-error-${seq.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`}>
                              {testResults[seq.name].error}
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </TabsContent>

        <TabsContent value="prompts" className="mt-4">
          <PromptsDocument />
        </TabsContent>

        <TabsContent value="blueprints" className="mt-4">
          <CadenceBlueprints />
        </TabsContent>

        <TabsContent value="cadence" className="mt-4">
          <CadenceTimeline />
        </TabsContent>
      </Tabs>
    </div>
  );
}
