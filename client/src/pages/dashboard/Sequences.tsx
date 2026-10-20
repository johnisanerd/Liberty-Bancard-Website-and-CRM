import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {useRetainedLocalIntent} from "@/hooks/use-retained-local-intent";
import {useRetainedCreateIntent} from "@/hooks/use-retained-create-intent";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { DataState } from "@/components/ui/data-state";
import {
  Plus, Trash2, Loader2, Play, Pause, Mail, MessageSquare, Phone,
  CheckSquare, Clock, ChevronDown, ChevronUp, Users, Zap, Send, ArrowDown,
  Target, BarChart3, FlaskConical, Pencil, AlertTriangle, Tag, ShieldCheck,
  Radio, Filter, Link2, Link2Off, HelpCircle, Eye,
} from "lucide-react";
import EmailPreviewModal, { EmailPreviewContent } from "@/components/EmailPreviewModal";
import { isGovernedSequence } from "@/lib/sequence-activation";

interface ABTestConfig {
  splitRatio: number;
  minSampleSize: number;
  winnerCriteria: "open_rate" | "reply_rate";
}

interface SequenceStep {
  id?: number;
  stepOrder: number;
  actionType: string;
  delayDays: number;
  delayHours: number;
  subject?: string;
  body?: string;
  config?: any;
  variantBEnabled?: boolean;
  variantBSubject?: string;
  variantBBody?: string;
  abTestConfig?: ABTestConfig;
}

const STEP_TYPES = [
  { value: "email", label: "Send Email", icon: Mail },
  { value: "sms", label: "Send SMS", icon: MessageSquare },
  { value: "call_reminder", label: "Call Reminder", icon: Phone },
  { value: "task", label: "Create Task", icon: CheckSquare },
  { value: "wait", label: "Wait / Delay", icon: Clock },
];

const TRIGGER_TYPES = [
  { value: "manual", label: "Manual Enrollment" },
  { value: "deal_stage_changed", label: "Deal Stage Changed" },
  { value: "contact_created", label: "New Contact Created" },
  { value: "form_submitted", label: "Form Submitted" },
];

type SequenceBucket =
  | "cold_outreach"
  | "onboarding"
  | "nurture_followup"
  | "vertical_specific"
  | "transactional_operational"
  | "uncategorized"
  | "unknown";

const BUCKET_ORDER: SequenceBucket[] = [
  "cold_outreach",
  "onboarding",
  "nurture_followup",
  "vertical_specific",
  "transactional_operational",
  "uncategorized",
  "unknown",
];

const BUCKET_LABELS: Record<SequenceBucket, string> = {
  cold_outreach: "Cold Outreach",
  onboarding: "Onboarding",
  nurture_followup: "Nurture / Follow-Up",
  vertical_specific: "Vertical-Specific",
  transactional_operational: "Transactional / Operational",
  uncategorized: "Uncategorized",
  unknown: "Grouping unavailable",
};

type WiringStatus = "connected" | "missing" | "invalid_stale" | "not_applicable";

const WIRING_LABELS: Record<WiringStatus, string> = {
  connected: "Connected",
  missing: "Missing GHL Workflow ID",
  invalid_stale: "Invalid / Stale",
  not_applicable: "Not Applicable",
};

function WiringBadge({ status }: { status: WiringStatus }) {
  if (status === "connected") {
    return (
      <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:bg-green-900/20 text-xs">
        <Link2 className="w-3 h-3 mr-1" /> Connected
      </Badge>
    );
  }
  if (status === "missing") {
    return (
      <Badge variant="outline" className="text-red-700 border-red-300 bg-red-50 dark:bg-red-900/20 text-xs">
        <Link2Off className="w-3 h-3 mr-1" /> Missing GHL ID
      </Badge>
    );
  }
  if (status === "invalid_stale") {
    return (
      <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-900/20 text-xs">
        <AlertTriangle className="w-3 h-3 mr-1" /> Invalid / Stale
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground text-xs">
      <HelpCircle className="w-3 h-3 mr-1" /> N/A
    </Badge>
  );
}

class SavedStepDiffersError extends Error {}

function stepIcon(actionType: string) {
  const found = STEP_TYPES.find(s => s.value === actionType);
  return found ? found.icon : Clock;
}

function stepLabel(actionType: string) {
  const found = STEP_TYPES.find(s => s.value === actionType);
  return found ? found.label : actionType;
}

function supportsABTest(actionType: string) {
  return actionType === "email" || actionType === "sms";
}

export default function Sequences() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const sequenceIntents=useRetainedLocalIntent();
  const createIntents=useRetainedCreateIntent();
  const canAccessOutreachHub = user?.role === "admin" || user?.role === "manager";
  const [showCreate, setShowCreate] = useState(false);
  const [editingSeq, setEditingSeq] = useState<any | null>(null);
  const [editLoadingSteps, setEditLoadingSteps] = useState(false);
  const [originalStepIds, setOriginalStepIds] = useState<number[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedTierId, setExpandedTierId] = useState<number | null>(null);
  const [enrollDialogSeqId, setEnrollDialogSeqId] = useState<number | null>(null);
  const [enrollContactId, setEnrollContactId] = useState("");
  const [enrollDealId, setEnrollDealId] = useState("");
  const [enrollTab, setEnrollTab] = useState<"single" | "vertical">("single");
  const [bulkVertical, setBulkVertical] = useState("");
  const [bulkPreview, setBulkPreview] = useState<any>(null);
  const [bulkPreviewLoading, setBulkPreviewLoading] = useState(false);
  const [bulkConfirmText, setBulkConfirmText] = useState("");
  const [bodyPreviewTab, setBodyPreviewTab] = useState<Record<number, "write" | "preview">>({});
  const [activatingSeq, setActivatingSeq] = useState<any | null>(null);
  const [activateChecks, setActivateChecks] = useState<boolean[]>([false, false, false]);

  useEffect(() => {
    if (activatingSeq !== null) setActivateChecks([false, false, false]);
  }, [activatingSeq]);

  const [form, setForm] = useState({
    name: "",
    description: "",
    triggerType: "manual",
    status: "active",
  });
  const [steps, setSteps] = useState<SequenceStep[]>([]);

  const isEditMode = editingSeq !== null;

  const {
    data: sequencesRaw,
    isLoading,
    isError: sequencesError,
    error: sequencesErrorObj,
    refetch: refetchSequences,
  } = useQuery<any[]>({
    queryKey: ["/api/sequences"],
  });
  const sequences = Array.isArray(sequencesRaw) ? sequencesRaw : [];

  // Admin-only endpoint: a denied or failed read means the grouping is unknown,
  // not that every sequence is uncategorized.
  const { data: groupingMetaRaw, isError: groupingMetaError, error: groupingMetaErrorObj } = useQuery<any[]>({
    queryKey: ["/api/sequences/grouping-meta"],
  });
  const groupingMetaDenied = groupingMetaError && /^(401|403):/.test(String((groupingMetaErrorObj as Error)?.message ?? ""));
  const groupingMetaById = new Map<number, { bucket: SequenceBucket; wiring: { status: WiringStatus; workflowId: string | null } }>(
    (Array.isArray(groupingMetaRaw) ? groupingMetaRaw : []).map((m: any) => [m.id, { bucket: m.bucket, wiring: m.wiring }])
  );

  const [bucketFilter, setBucketFilter] = useState<"all" | SequenceBucket>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">("all");
  const [wiringFilter, setWiringFilter] = useState<"all" | "missing">("all");

  const { data: allEnrollmentsRaw, isError: enrollmentReadError, isLoading: enrollmentReadLoading } = useQuery<any[]>({
    queryKey: ["/api/sequence-enrollments/owned"],
  });
  const allEnrollments = Array.isArray(allEnrollmentsRaw) ? allEnrollmentsRaw : [];

  const { data: contactsRes } = useQuery<{ data: any[]; total: number }>({
    queryKey: ["/api/contacts"],
  });
  const contacts = Array.isArray(contactsRes?.data) ? contactsRes.data : [];

  // A sequence row may be committed before every step is. The create command (ID + normalized fields) is retained, so a
  // lost response, double click, close or reload replays the same command and recovers the committed ID instead of
  // creating a duplicate; the recovered ID lets a retry read persisted steps back and save only the missing ones.
  const createIntent = createIntents.intent;
  const partialCreate = createIntent?.sequenceId ? { id: createIntent.sequenceId, name: createIntent.fields.name } : null;
  const createFieldsLocked = !!createIntent;

  const stepSignature = (row: any) => JSON.stringify([
    row.actionType, row.delayDays, row.delayHours, row.subject || null, row.body || null, row.config ?? null,
    row.variantBSubject || null, row.variantBBody || null,
  ]);
  const stepPayload = (s: SequenceStep, order: number) => ({
    stepOrder: order,
    actionType: s.actionType,
    delayDays: s.delayDays,
    delayHours: s.delayHours,
    subject: s.subject || null,
    body: s.body || null,
    config: s.config ?? null,
    variantBSubject: s.variantBEnabled ? (s.variantBSubject || null) : null,
    variantBBody: s.variantBEnabled ? (s.variantBBody || null) : null,
    abTestConfig: s.variantBEnabled
      ? (s.abTestConfig || { splitRatio: 50, minSampleSize: 100, winnerCriteria: "open_rate" })
      : null,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      // Server owns the initial paused status and step count. Retained fields win over the (locked) form.
      const intent = createIntents.begin({ name: form.name, description: form.description, triggerType: form.triggerType });
      let seq: { id: number; name: string } | null = intent.sequenceId ? { id: intent.sequenceId, name: intent.fields.name } : null;
      if (!seq) {
        const seqRes = await apiRequest("POST", "/api/sequences", {
          ...intent.fields, commandId: intent.commandId, expectedActorId: intent.actorId, expectedAccountVersion: intent.accountVersion,
        });
        const created = await seqRes.json();
        seq = { id: created.id, name: created.name ?? intent.fields.name };
        createIntents.recordCreated(seq.id);
      }
      const persistedRes = await apiRequest("GET", `/api/sequences/${seq.id}/steps`);
      const persisted: any[] = await persistedRes.json();
      // Steps already saved are authoritative: a differing editor copy is never silently skipped.
      for (const row of persisted) {
        const local = steps[row.stepOrder - 1];
        const expected = local ? stepSignature(stepPayload(local, row.stepOrder)) : null;
        if (expected !== stepSignature(row)) {
          throw new SavedStepDiffersError(`Step ${row.stepOrder} was already saved and differs from the editor. Restore the saved values, or close this dialog and edit the saved sequence; nothing further was saved.`);
        }
      }
      const persistedOrders = new Set(persisted.map((row) => row.stepOrder));
      for (let i = 0; i < steps.length; i++) {
        if (persistedOrders.has(i + 1)) continue;
        await apiRequest("POST", `/api/sequences/${seq.id}/steps`, stepPayload(steps[i], i + 1));
      }
      return seq;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
      createIntents.clear();
      setShowCreate(false);
      setForm({ name: "", description: "", triggerType: "manual", status: "active" });
      setSteps([]);
      toast({ title: "Drip sequence created", description: "It starts paused. Activation is a separate step." });
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
      toast({
        title: partialCreate ? "Sequence created but not all steps were saved" : "Sequence create not confirmed",
        description: `${err.message} Retry: the same request is recognized, so no duplicate sequence is created.`,
        variant: "destructive",
      });
    },
  });

  // Confirm a retained create with no editor open (after close or reload): replaying the same command returns the
  // committed sequence or creates it once; never a second one.
  const confirmCreateMutation = useMutation({
    mutationFn: async () => {
      const intent = createIntent;
      if (!intent) throw new Error("No retained create request.");
      if (intent.sequenceId) return { id: intent.sequenceId };
      const res = await apiRequest("POST", "/api/sequences", {
        ...intent.fields, commandId: intent.commandId, expectedActorId: intent.actorId, expectedAccountVersion: intent.accountVersion,
      });
      const created = await res.json();
      createIntents.recordCreated(created.id);
      return created;
    },
    onSuccess: async (created: any) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
      toast({ title: created?.replayed ? "Sequence already created" : "Sequence created paused",
        description: `Sequence ${created.id} exists and is paused. Open it to add or check its steps.` });
    },
    onError: (err: Error) => toast({ title: "Create still not confirmed", description: err.message, variant: "destructive" }),
  });
  const openSavedSequence = () => {
    const saved = sequencesRaw?.find((row: any) => row.id === createIntent?.sequenceId);
    if (!saved) { toast({ title: "Saved sequence not in the list yet", description: "Reload the list, then try again.", variant: "destructive" }); return; }
    createIntents.clear();
    void openEditDialog(saved);
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const sequence=sequencesRaw?.find((row:any)=>row.id===id);
      if(!sequence?.version) throw new Error("Sequence snapshot unavailable. Reload before retiring.");
      await apiRequest("DELETE", `/api/sequences/${id}`,sequenceIntents.payload(`retire:${id}`,{expectedVersion:sequence.version}));
      sequenceIntents.accepted(`retire:${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
      toast({ title: "Sequence retired",description:"History and receipts retained. Restore returns it to paused, never active." });
    },
    onError:(error:Error)=>toast({title:"Retirement not applied",description:error.message,variant:"destructive"}),
  });
  const restoreMutation=useMutation({
    mutationFn:async(id:number)=>{
      const sequence=sequencesRaw?.find((row:any)=>row.id===id);
      if(!sequence?.version) throw new Error("Sequence snapshot unavailable. Reload before restoring.");
      await apiRequest("POST",`/api/sequences/${id}/restore`,sequenceIntents.payload(`restore:${id}`,{expectedVersion:sequence.version}));
      sequenceIntents.accepted(`restore:${id}`);
    },
    onSuccess:()=>{void queryClient.invalidateQueries({queryKey:["/api/sequences"]});toast({title:"Sequence restored to paused",description:"No enrollment or send was resumed."});},
    onError:(error:Error)=>toast({title:"Restore not applied",description:error.message,variant:"destructive"}),
  });

  const toggleMutation = useMutation({
    mutationFn: async (id: number) => {
      const sequence=sequencesRaw?.find((row:any)=>row.id===id);
      if(!sequence?.version) throw new Error("Sequence snapshot unavailable. Reload before changing its state.");
      const res = await apiRequest("PUT", `/api/sequences/${id}/toggle-status`,sequenceIntents.payload(`toggle:${id}`,{expectedVersion:sequence.version}));
      sequenceIntents.accepted(`toggle:${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
      setActivatingSeq(null);
      setActivateChecks([false, false, false]);
      toast({ title: "Sequence updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  // Wave 6 sequences (carrying sequenceFamily or eligibleConsentTiers) begin
  // enrolling contacts immediately on activation, so activating one requires
  // a guided acknowledgement checklist rather than a single click. Pausing,
  // and toggling legacy sequences with no Wave 6 metadata, still fire the
  // mutation directly. See client/src/lib/sequence-activation.ts.
  const handleToggleClick = (seq: any) => {
    if (seq.status !== "active" && isGovernedSequence(seq)) {
      setActivatingSeq(seq);
    } else {
      toggleMutation.mutate(seq.id);
    }
  };

  const handleConfirmActivate = () => {
    if (!activatingSeq) return;
    toggleMutation.mutate(activatingSeq.id);
  };

  const enrollMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/sequence-enrollments", {
        sequenceId: enrollDialogSeqId,
        contactId: enrollContactId ? Number(enrollContactId) : null,
        dealId: enrollDealId ? Number(enrollDealId) : null,
        status: "active",
        currentStep: 0,
        nextActionAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequence-enrollments"] });
      setEnrollDialogSeqId(null);
      setEnrollContactId("");
      setEnrollDealId("");
      toast({ title: "Contact enrolled in sequence" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to enroll", description: err.message, variant: "destructive" });
    },
  });

  const {
    data: verticalsData,
    isPending: verticalsIsPending,
    isError: verticalsIsError,
  } = useQuery<Array<{ vertical: string; count: number }>>({
    queryKey: ["/api/contacts/verticals"],
    enabled: enrollTab === "vertical" && enrollDialogSeqId !== null,
  });
  const verticalsList = Array.isArray(verticalsData) ? verticalsData : [];

  async function handleVerticalPreview() {
    if (!bulkVertical || !enrollDialogSeqId) return;
    setBulkPreviewLoading(true);
    setBulkPreview(null);
    try {
      const res = await apiRequest("POST", `/api/sequences/${enrollDialogSeqId}/enroll-vertical/preview`, { vertical: bulkVertical });
      const data = await res.json();
      setBulkPreview(data);
    } catch (err: any) {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    } finally {
      setBulkPreviewLoading(false);
    }
  }

  const bulkEnrollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/sequences/${enrollDialogSeqId}/enroll-vertical`, {
        vertical: bulkVertical,
        confirmed: true,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequence-enrollments"] });
      setEnrollDialogSeqId(null);
      setBulkVertical("");
      setBulkPreview(null);
      setBulkConfirmText("");
      toast({
        title: `Bulk enrollment queued`,
        description: `Queued: ${data.queued} | Skipped already enrolled: ${data.skippedBreakdown?.alreadyEnrolled ?? 0} | Skipped ineligible/DNC/opt-out: ${data.skippedBreakdown?.ineligible ?? 0} | Skipped missing contact info: ${data.skippedBreakdown?.missingInfo ?? 0}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Bulk enrollment failed", description: err.message, variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editingSeq) return;
      if (editHydrationError) throw new Error("Existing steps did not load. Reload them before saving.");
      const editorSteps=steps.map((s,index)=>({
        ...(s.id?{id:s.id}:{}),stepOrder:index+1,actionType:s.actionType,delayDays:s.delayDays,delayHours:s.delayHours,
        subject:s.subject || null,body:s.body || null,config:s.config || null,
        variantBSubject:s.variantBEnabled?(s.variantBSubject || null):null,
        variantBBody:s.variantBEnabled?(s.variantBBody || null):null,
        abTestConfig:s.variantBEnabled?(s.abTestConfig || {splitRatio:50,minSampleSize:100,winnerCriteria:"open_rate"}):null,
      }));
      await apiRequest("PUT", `/api/sequences/${editingSeq.id}`,sequenceIntents.payload(`edit:${editingSeq.id}`,{
        expectedVersion:editingSeq.version,
        name: form.name,
        description: form.description,
        triggerType: form.triggerType,
        steps:editorSteps,
      }));
      sequenceIntents.accepted(`edit:${editingSeq.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sequences"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sequences", editingSeq?.id, "steps"] });
      setEditingSeq(null);
      setOriginalStepIds([]);
      setForm({ name: "", description: "", triggerType: "manual", status: "active" });
      setSteps([]);
      toast({ title: "Sequence updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update sequence", description: err.message, variant: "destructive" });
    },
  });

  const [editHydrationError, setEditHydrationError] = useState<string | null>(null);

  // Each hydration owns a generation and an AbortController. A late response from an earlier open, another sequence
  // or another account can never write into the current editor.
  const hydrationGeneration = useRef(0);
  const hydrationAbort = useRef<AbortController | null>(null);
  const invalidateHydration = () => {
    hydrationGeneration.current++;
    hydrationAbort.current?.abort();
    hydrationAbort.current = null;
  };
  const hydrateEditSteps = async (seq: any) => {
    invalidateHydration();
    const generation = hydrationGeneration.current;
    const controller = new AbortController();
    hydrationAbort.current = controller;
    const current = () => generation === hydrationGeneration.current && !controller.signal.aborted;
    setEditLoadingSteps(true);
    setEditHydrationError(null);
    try {
      const res = await apiRequest("GET", `/api/sequences/${seq.id}/steps`, undefined, undefined, controller.signal);
      const existingSteps: any[] = await res.json();
      if (!current()) return;
      setOriginalStepIds(existingSteps.map((s: any) => s.id));
      setSteps(existingSteps.map((s: any) => ({
        id: s.id,
        stepOrder: s.stepOrder,
        actionType: s.actionType,
        delayDays: s.delayDays,
        delayHours: s.delayHours,
        subject: s.subject || "",
        body: s.body || "",
        // Advanced step configuration is retained so a later save cannot clear it.
        config: s.config ?? null,
        variantBEnabled: !!(s.variantBBody || s.variantBSubject),
        variantBSubject: s.variantBSubject || "",
        variantBBody: s.variantBBody || "",
        abTestConfig: s.abTestConfig || { splitRatio: 50, minSampleSize: 100, winnerCriteria: "open_rate" },
      })));
    } catch (err) {
      if (!current()) return;
      // A failed read must not become an empty step list that a save would persist.
      setSteps([]);
      setOriginalStepIds([]);
      setEditHydrationError(err instanceof Error ? err.message : "Existing steps could not be loaded.");
    } finally {
      if (current()) setEditLoadingSteps(false);
    }
  };

  const openEditDialog = async (seq: any) => {
    setEditingSeq(seq);
    setForm({
      name: seq.name,
      description: seq.description || "",
      triggerType: seq.triggerType || "manual",
      status: seq.status,
    });
    await hydrateEditSteps(seq);
  };

  const closeDialog = () => {
    invalidateHydration();
    setEditLoadingSteps(false);
    setEditHydrationError(null);
    const keepCreateDraft = !isEditMode && !!createIntent;
    setShowCreate(false);
    setEditingSeq(null);
    setOriginalStepIds([]);
    // A retained (unconfirmed or partial) create keeps its draft; confirm or discard it from the banner.
    if (!keepCreateDraft) {
      setForm({ name: "", description: "", triggerType: "manual", status: "active" });
      setSteps([]);
    }
  };

  // Another account (or a changed account version) never sees or edits the previous account's drafts, partial IDs or
  // in-flight editor reads.
  const actorIdentity = `${user?.id ?? ""}:${user?.accountVersion ?? ""}`;
  const previousActor = useRef(actorIdentity);
  useEffect(() => {
    if (previousActor.current === actorIdentity) return;
    previousActor.current = actorIdentity;
    invalidateHydration();
    setEditLoadingSteps(false);
    setEditHydrationError(null);
    setShowCreate(false);
    setEditingSeq(null);
    setOriginalStepIds([]);
    setForm({ name: "", description: "", triggerType: "manual", status: "active" });
    setSteps([]);
  }, [actorIdentity]);
  useEffect(() => () => invalidateHydration(), []);

  const openCreateDialog = () => {
    if (createIntent) {
      setForm({ ...form, ...createIntent.fields, status: "active" });
    }
    setShowCreate(true);
  };

  const addStep = () => {
    setSteps([...steps, {
      stepOrder: steps.length + 1,
      actionType: "email",
      delayDays: steps.length === 0 ? 0 : 2,
      delayHours: 0,
      subject: "",
      body: "",
      variantBEnabled: false,
      variantBSubject: "",
      variantBBody: "",
      abTestConfig: { splitRatio: 50, minSampleSize: 100, winnerCriteria: "open_rate" },
    }]);
  };

  const updateStep = (index: number, updates: Partial<SequenceStep>) => {
    const updated = [...steps];
    updated[index] = { ...updated[index], ...updates };
    setSteps(updated);
  };

  const removeStep = (index: number) => {
    setSteps(steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, stepOrder: i + 1 })));
  };

  const totalEnrollments = allEnrollments?.length || 0;
  const activeEnrollments = enrollmentReadError ? "Unavailable" : enrollmentReadLoading ? "Loading" : allEnrollments.filter(e => e.status === "active").length;
  const completedEnrollments = enrollmentReadError ? "Unavailable" : enrollmentReadLoading ? "Loading" : allEnrollments.filter(e => e.status === "completed").length;

  if (isLoading) {
    return (
      <div className="space-y-6" data-testid="sequences-loading">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (sequencesError) {
    return (
      <div className="space-y-6" data-testid="sequences-page">
        <div>
          <h2 className="text-xl font-bold" data-testid="text-page-heading">Drip Sequences</h2>
          <p className="text-sm text-muted-foreground">Build multi-step follow-up sequences and drip marketing campaigns</p>
        </div>
        <DataState
          query={{ isLoading: false, isError: true, error: sequencesErrorObj, refetch: refetchSequences }}
          errorTitle="Failed to load drip sequences"
          testId="sequences"
        >
          <></>
        </DataState>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="sequences-page">
      <div className="flex flex-col sm:flex-row justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold" data-testid="text-page-heading">Drip Sequences</h2>
          <p className="text-sm text-muted-foreground">Build multi-step follow-up sequences and drip marketing campaigns</p>
        </div>
        <Button onClick={openCreateDialog} className="gap-2" data-testid="button-create-sequence">
          <Plus className="w-4 h-4" /> Create Sequence
        </Button>
      </div>

      {createIntent && !showCreate && !isEditMode && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-900/20" data-testid="sequence-create-retained">
          <p className="font-medium">
            {createIntent.sequenceId
              ? `Sequence "${createIntent.fields.name}" was created paused, but its steps were not confirmed saved.`
              : `Creating "${createIntent.fields.name}" was not confirmed.`}
          </p>
          <p className="mt-1 text-muted-foreground">
            {createIntent.sequenceId
              ? "Open the saved sequence to check or add its steps. Nothing was activated or sent."
              : "Confirming replays the same request: the sequence is created once, or the one already created is returned."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {createIntent.sequenceId
              ? <Button size="sm" onClick={openSavedSequence} data-testid="button-open-saved-sequence">Open saved sequence</Button>
              : <Button size="sm" onClick={() => confirmCreateMutation.mutate()} disabled={confirmCreateMutation.isPending} data-testid="button-confirm-create">
                  {confirmCreateMutation.isPending ? "Confirming…" : "Confirm create"}
                </Button>}
            <Button size="sm" variant="outline" onClick={() => { createIntents.clear(); setForm({ name: "", description: "", triggerType: "manual", status: "active" }); setSteps([]); }} data-testid="button-discard-create">Dismiss</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="kpi-total-sequences">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10"><Zap className="w-5 h-5 text-primary" /></div>
              <div>
                <p className="text-2xl font-bold">{sequences?.length || 0}</p>
                <p className="text-xs text-muted-foreground">Total Sequences</p>
              </div>
            </div>
          </CardContent>
        </Card>
        {/* #545 — Total emails sent across all sequences */}
        <Card data-testid="kpi-total-emails-sent">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-indigo-500/10"><Mail className="w-5 h-5 text-indigo-600" /></div>
              <div>
                <p className="text-2xl font-bold">
                  {(sequences || []).reduce((sum: number, s: any) => sum + (s.totalSent ?? 0), 0).toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Emails Sent</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-active-enrollments">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-green-500/10"><Users className="w-5 h-5 text-green-600" /></div>
              <div>
                <p className="text-2xl font-bold">{activeEnrollments}</p>
                <p className="text-xs text-muted-foreground">Active Enrollments</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-completed">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-blue-500/10"><Target className="w-5 h-5 text-blue-600" /></div>
              <div>
                <p className="text-2xl font-bold">{completedEnrollments}</p>
                <p className="text-xs text-muted-foreground">Completed</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-conversion">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-orange-500/10"><BarChart3 className="w-5 h-5 text-orange-600" /></div>
              <div>
                <p className="text-2xl font-bold">
                  {enrollmentReadError ? "Unavailable" : enrollmentReadLoading ? "Loading" : `${totalEnrollments > 0 ? Math.round((Number(completedEnrollments) / totalEnrollments) * 100) : 0}%`}
                </p>
                <p className="text-xs text-muted-foreground">Completion Rate</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {(!sequences || sequences.length === 0) ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Zap className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-2">No drip sequences yet</p>
            <p className="text-sm text-muted-foreground mb-4">Create automated multi-step campaigns to nurture leads and follow up with contacts</p>
            <Button onClick={openCreateDialog} data-testid="button-empty-create">
              <Plus className="w-4 h-4 mr-2" /> Create Your First Sequence
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {groupingMetaError && (
            <p role="status" className="text-sm text-muted-foreground" data-testid="grouping-meta-unavailable">
              {groupingMetaDenied
                ? "Grouping and wiring metadata is administrator-only for your role; groups and wiring are unknown, not uncategorized."
                : "Grouping and wiring metadata could not be loaded; groups and wiring are unknown, not uncategorized."}
            </p>
          )}
          <Card data-testid="card-sequence-filters">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-3 text-sm font-medium text-muted-foreground">
                <Filter className="w-4 h-4" /> Filter &amp; Group Sequences
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Group</Label>
                  <Select value={bucketFilter} onValueChange={(v) => setBucketFilter(v as any)}>
                    <SelectTrigger data-testid="select-bucket-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Groups</SelectItem>
                      {BUCKET_ORDER.map(b => (
                        <SelectItem key={b} value={b}>{BUCKET_LABELS[b]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
                    <SelectTrigger data-testid="select-status-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">GHL Wiring</Label>
                  <Select value={wiringFilter} onValueChange={(v) => setWiringFilter(v as any)}>
                    <SelectTrigger data-testid="select-wiring-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Wiring States</SelectItem>
                      <SelectItem value="missing">Missing GHL Workflow ID</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {(() => {
            const enriched = sequences.map((seq: any) => {
              const meta = groupingMetaById.get(seq.id);
              const bucket: SequenceBucket = meta?.bucket || (groupingMetaError ? "unknown" : "uncategorized");
              const wiring = meta?.wiring || { status: (groupingMetaError ? "not_applicable" : "missing") as WiringStatus, workflowId: null };
              return { seq, bucket, wiring };
            });
            const filtered = enriched.filter(({ seq, bucket, wiring }) => {
              if (bucketFilter !== "all" && bucket !== bucketFilter) return false;
              if (statusFilter !== "all" && seq.status !== statusFilter) return false;
              if (wiringFilter === "missing" && wiring.status !== "missing" && wiring.status !== "invalid_stale") return false;
              return true;
            });
            if (filtered.length === 0) {
              return (
                <Card>
                  <CardContent className="py-10 text-center text-sm text-muted-foreground" data-testid="text-no-filtered-sequences">
                    No sequences match the selected filters.
                  </CardContent>
                </Card>
              );
            }
            const groups = new Map<SequenceBucket, typeof filtered>();
            for (const item of filtered) {
              const arr = groups.get(item.bucket) || [];
              arr.push(item);
              groups.set(item.bucket, arr);
            }
            const bucketsToRender = bucketFilter === "all" ? BUCKET_ORDER : [bucketFilter];
            return (
              <div className="space-y-6">
                {bucketsToRender.map(bucket => {
                  const items = groups.get(bucket);
                  if (!items || items.length === 0) return null;
                  return (
                    <div key={bucket} data-testid={`group-${bucket}`}>
                      {bucketFilter === "all" && (
                        <div className="flex items-center gap-2 mb-2">
                          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide" data-testid={`heading-group-${bucket}`}>
                            {BUCKET_LABELS[bucket]}
                          </h3>
                          <Badge variant="secondary" className="text-xs">{items.length}</Badge>
                        </div>
                      )}
                      <div className="space-y-3">
                        {items.map(({ seq, wiring }) => {
            const seqEnrollments = allEnrollments?.filter(e => e.sequenceId === seq.id) || [];
            const isExpanded = expandedId === seq.id;
            const hasSmsSteps = seq.channelsAllowed?.includes("sms");
            return (
              <Card key={seq.id} data-testid={`card-sequence-${seq.id}`}>
                {(enrollmentReadError || enrollmentReadLoading) && <p role="status" className="px-4 pt-3 text-sm">Enrollment counts {enrollmentReadError ? "unavailable" : "loading"}; no zero-result assertion.</p>}
                <CardContent className="pt-4 pb-4">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold truncate" data-testid={`text-seq-name-${seq.id}`}>{seq.name}</h3>
                        <Badge variant={seq.status === "active" ? "default" : "secondary"} data-testid={`badge-seq-status-${seq.id}`}>
                          {seq.retiredAt?"retired (history retained)":seq.status}
                        </Badge>
                        {seq.status === "paused" && (
                          <Badge variant="outline" className="text-yellow-600 border-yellow-400 bg-yellow-50 dark:bg-yellow-900/20" data-testid={`badge-paused-${seq.id}`}>
                            <Pause className="w-3 h-3 mr-1" /> Paused
                          </Badge>
                        )}
                        <Badge variant="outline" data-testid={`badge-seq-trigger-${seq.id}`}>
                          {TRIGGER_TYPES.find(t => t.value === seq.triggerType)?.label || seq.triggerType}
                        </Badge>
                        {seq.sequenceFamily && (
                          <Badge variant="outline" className="font-mono text-xs text-blue-700 border-blue-300 bg-blue-50 dark:bg-blue-900/20" data-testid={`badge-family-${seq.id}`}>
                            <Tag className="w-3 h-3 mr-1" />{seq.sequenceFamily}
                          </Badge>
                        )}
                        <WiringBadge status={wiring.status} />
                      {/* #986 — Enrolled contacts count badge */}
                      {seqEnrollments.length > 0 && (
                        <Badge variant="outline" className="text-xs border-blue-300 text-blue-700 bg-blue-50 dark:bg-blue-900/20" data-testid={`badge-enrolled-${seq.id}`}>
                          <Users className="w-3 h-3 mr-1" />{seqEnrollments.length} enrolled
                        </Badge>
                      )}
                      </div>
                      {seq.description && (
                        <p className="text-sm text-muted-foreground mt-1 truncate">{seq.description}</p>
                      )}
                      {/* #905 — Avg sequence length + step count sub-line */}
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span data-testid={`text-step-count-${seq.id}`}>{seq.totalSteps || 0}-step sequence</span>
                        {/* #1443 — Avg step delay computed from sequence steps */}
                        {(seq as any).avgDelayDays != null && (
                          <span data-testid={`text-avg-delay-${seq.id}`}>~{(seq as any).avgDelayDays}d avg delay</span>
                        )}
                        <span>{enrollmentReadError ? "Unavailable" : enrollmentReadLoading ? "Loading" : seqEnrollments.filter((e: any) => e.status === "active").length} active</span>
                        <span>{enrollmentReadError ? "Unavailable" : enrollmentReadLoading ? "Loading" : seqEnrollments.filter((e: any) => e.status === "completed").length} completed</span>
                      </div>
                      {/* #547 — Per-card completion percent bar */}
                      {seqEnrollments.length > 0 && (() => {
                        const completed = seqEnrollments.filter((e: any) => e.status === "completed").length;
                        const pct = Math.round((completed / seqEnrollments.length) * 100);
                        return (
                          <div className="mt-2 flex items-center gap-2" data-testid={`completion-bar-${seq.id}`}>
                            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} data-testid={`completion-fill-${seq.id}`} />
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0">{pct}% complete</span>
                          </div>
                        );
                      })()}
                      {(seq.eligibleConsentTiers?.length > 0 || seq.channelsAllowed?.length > 0 || seq.offerRoutes?.length > 0) && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {seq.channelsAllowed?.length > 0 && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`channels-${seq.id}`}>
                              <Radio className="w-3 h-3" />
                              {seq.channelsAllowed.map((ch: string) => (
                                <span key={ch} className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 bg-muted text-muted-foreground">
                                  {ch === "email" && <Mail className="w-3 h-3" />}
                                  {ch === "sms" && <MessageSquare className="w-3 h-3" />}
                                  {ch === "task" && <CheckSquare className="w-3 h-3" />}
                                  {ch === "voice_ai" && <Phone className="w-3 h-3" />}
                                  {!["email","sms","task","voice_ai"].includes(ch) && ch}
                                </span>
                              ))}
                            </div>
                          )}
                          {seq.eligibleConsentTiers?.length > 0 && (
                            <div className="flex items-center gap-1 flex-wrap" data-testid={`consent-tiers-${seq.id}`}>
                              <ShieldCheck className="w-3 h-3 text-muted-foreground" />
                              {seq.eligibleConsentTiers.map((tier: string) => (
                                <Badge key={tier} variant="outline" className="text-xs px-1 py-0">
                                  {tier === "cold_no_consent" ? "cold" : tier === "warm_no_pewc" ? "warm" : tier === "pewc_full_automation" ? "PEWC" : tier}
                                </Badge>
                              ))}
                            </div>
                          )}
                          {seq.offerRoutes?.length > 0 && (
                            <div className="flex items-center gap-1 flex-wrap" data-testid={`offer-routes-${seq.id}`}>
                              {seq.offerRoutes.map((route: string) => (
                                <Badge key={route} variant="secondary" className="text-xs px-1 py-0">
                                  {route}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {seq.sequenceFamily && (!seq.totalSteps || seq.totalSteps === 0) && (
                        <div className="flex items-center gap-1 mt-2 text-xs text-red-600" data-testid={`warn-no-steps-${seq.id}`}>
                          <AlertTriangle className="w-3 h-3" />
                          No steps defined — sequence cannot execute until steps are added
                        </div>
                      )}
                      {hasSmsSteps && seq.status !== "active" && (
                        <div className="flex items-center gap-1 mt-2 text-xs text-amber-600" data-testid={`warn-sms-paused-${seq.id}`}>
                          <AlertTriangle className="w-3 h-3" />
                          SMS steps present — activate sequence and ensure PEWC flag is enabled before enrolling contacts
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Edit sequence"
                        onClick={() => openEditDialog(seq)}
                        data-testid={`button-edit-${seq.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={seq.status === "active" ? "Pause sequence" : "Activate sequence"}
                        onClick={() => handleToggleClick(seq)}
                        disabled={!!seq.retiredAt || toggleMutation.isPending || (seq.status !== "active" && seq.status !== "paused" && seq.status !== "draft")}
                        title={seq.status === "active" ? "Pause this sequence" : "Activate this sequence"}
                        data-testid={`button-toggle-${seq.id}`}
                      >
                        {seq.status === "active" ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={isExpanded ? "Collapse sequence" : "Expand sequence"}
                        onClick={() => setExpandedId(isExpanded ? null : seq.id)}
                        data-testid={`button-expand-${seq.id}`}
                      >
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={seq.retiredAt?"Restore sequence to paused":"Retire sequence while retaining history"}
                        onClick={() => seq.retiredAt?restoreMutation.mutate(seq.id):deleteMutation.mutate(seq.id)}
                        data-testid={`button-delete-${seq.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-2">
                    <button
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setExpandedTierId(expandedTierId === seq.id ? null : seq.id)}
                      data-testid={`button-tier-breakdown-${seq.id}`}
                    >
                      {expandedTierId === seq.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      Tier Breakdown
                    </button>
                    {expandedTierId === seq.id && (
                      <TierBreakdown seqId={seq.id} eligibleTiers={seq.eligibleConsentTiers || []} />
                    )}
                  </div>

                  {isExpanded && (
                    <SequenceStepsView sequenceId={seq.id} enrollments={seqEnrollments} />
                  )}
                </CardContent>
              </Card>
            );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </>
      )}

      <Dialog open={showCreate || isEditMode} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-create-sequence">
          <DialogHeader>
            <DialogTitle>{isEditMode ? `Edit: ${editingSeq?.name}` : "Create Drip Sequence"}</DialogTitle>
          </DialogHeader>
          {isEditMode && editLoadingSteps && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading steps…</span>
            </div>
          )}
          {isEditMode && !editLoadingSteps && editHydrationError && (
            <div role="alert" className="rounded-md border border-destructive p-4 text-sm" data-testid="sequence-hydration-error">
              <p className="font-medium">Existing steps could not be loaded.</p>
              <p className="text-muted-foreground">{editHydrationError} Saving is blocked so the sequence is not overwritten with an empty step list.</p>
              <Button className="mt-3" variant="outline" onClick={() => editingSeq && hydrateEditSteps(editingSeq)} data-testid="button-retry-hydration">Reload steps</Button>
            </div>
          )}
          {!isEditMode && createIntent && !partialCreate && (
            <div role="status" className="rounded-md border p-4 text-sm" data-testid="sequence-create-unconfirmed">
              A previous create of "{createIntent.fields.name}" was not confirmed. The sequence fields are locked; Create Sequence replays the same request, so it is created once.
            </div>
          )}
          {!isEditMode && partialCreate && (
            <div role="status" className="rounded-md border p-4 text-sm" data-testid="sequence-partial-create">
              Sequence "{partialCreate.name}" (ID {partialCreate.id}) was created paused, but some steps were not confirmed saved.
              Create Sequence will read its steps back and save only the missing ones; it will not create a second sequence.
              Saved steps are checked against the editor; a differing saved step stops the save and is named.
            </div>
          )}
          {(!isEditMode || (!editLoadingSteps && !editHydrationError)) && <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Sequence Name</Label>
                <Input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  disabled={!isEditMode && createFieldsLocked}
                  placeholder="e.g., New Lead Follow-up"
                  data-testid="input-seq-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Trigger</Label>
                <Select value={form.triggerType} onValueChange={v => setForm({ ...form, triggerType: v })} disabled={!isEditMode && createFieldsLocked}>
                  <SelectTrigger data-testid="select-seq-trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRIGGER_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                disabled={!isEditMode && createFieldsLocked}
                placeholder="Describe the purpose of this drip sequence..."
                data-testid="input-seq-description"
              />
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-base font-semibold">Campaign Steps</Label>
                <Button variant="outline" size="sm" onClick={addStep} data-testid="button-add-step">
                  <Plus className="w-4 h-4 mr-1" /> Add Step
                </Button>
              </div>

              {steps.length === 0 && (
                <div className="border border-dashed rounded-md p-6 text-center text-muted-foreground">
                  <p className="text-sm">No steps yet. Add your first step to build the drip campaign.</p>
                </div>
              )}

              <div className="space-y-2">
                {steps.map((step, index) => (
                  <div key={index}>
                    {index > 0 && (
                      <div className="flex items-center justify-center py-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <ArrowDown className="w-3 h-3" />
                          <span>Wait {step.delayDays}d {step.delayHours}h</span>
                        </div>
                      </div>
                    )}
                    <Card className="border-l-2 border-l-primary" data-testid={`step-card-${index}`}>
                      <CardContent className="pt-3 pb-3">
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs">Step {index + 1}</Badge>
                            <Select
                              value={step.actionType}
                              onValueChange={v => updateStep(index, { actionType: v, variantBEnabled: false })}
                            >
                              <SelectTrigger className="w-40" data-testid={`select-step-type-${index}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {STEP_TYPES.map(st => (
                                  <SelectItem key={st.value} value={st.value}>
                                    {st.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={step.id ? "Saved steps cannot be removed" : "Remove step"}
                            disabled={!!step.id}
                            title={step.id ? "Saved steps cannot be removed: step history is retained. Edit the step or retire the sequence." : undefined}
                            onClick={() => removeStep(index)}
                            data-testid={`button-remove-step-${index}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>

                        {index > 0 && (
                          <div className="flex items-center gap-3 mb-3">
                            <div className="space-y-1 flex-1">
                              <Label className="text-xs">Delay (days)</Label>
                              <Input
                                type="number"
                                min={0}
                                value={step.delayDays}
                                onChange={e => updateStep(index, { delayDays: Number(e.target.value) })}
                                data-testid={`input-delay-days-${index}`}
                              />
                            </div>
                            <div className="space-y-1 flex-1">
                              <Label className="text-xs">Delay (hours)</Label>
                              <Input
                                type="number"
                                min={0}
                                value={step.delayHours}
                                onChange={e => updateStep(index, { delayHours: Number(e.target.value) })}
                                data-testid={`input-delay-hours-${index}`}
                              />
                            </div>
                          </div>
                        )}

                        {(step.actionType === "email" || step.actionType === "call_reminder") && (
                          <div className="space-y-2">
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">Variant A (Primary)</Label>
                              <Input
                                placeholder="Subject line"
                                value={step.subject || ""}
                                onChange={e => updateStep(index, { subject: e.target.value })}
                                data-testid={`input-step-subject-${index}`}
                              />
                            </div>
                            {step.actionType === "email" && (
                              <div className="space-y-1">
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setBodyPreviewTab(prev => ({ ...prev, [index]: "write" }))}
                                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${(bodyPreviewTab[index] ?? "write") === "write" ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-transparent hover:border-border"}`}
                                    data-testid={`tab-write-${index}`}
                                  >
                                    Write
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setBodyPreviewTab(prev => ({ ...prev, [index]: "preview" }))}
                                    className={`text-xs px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${(bodyPreviewTab[index] ?? "write") === "preview" ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-transparent hover:border-border"}`}
                                    data-testid={`tab-preview-${index}`}
                                  >
                                    <Eye className="w-3 h-3" /> Preview
                                  </button>
                                </div>
                                {(bodyPreviewTab[index] ?? "write") === "write" ? (
                                  <Textarea
                                    placeholder="Email body... Use {{firstName}}, {{companyName}} for personalization"
                                    value={step.body || ""}
                                    onChange={e => updateStep(index, { body: e.target.value })}
                                    className="min-h-[80px]"
                                    data-testid={`input-step-body-${index}`}
                                  />
                                ) : (
                                  <div className="rounded border p-2 bg-muted/20 min-h-[80px]">
                                    <EmailPreviewContent
                                      subject={step.subject}
                                      body={step.body || ""}
                                      contentType="html"
                                      showComplianceNotice={false}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {step.actionType === "sms" && (
                          <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground block">Variant A (Primary)</Label>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => setBodyPreviewTab(prev => ({ ...prev, [index]: "write" }))}
                                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${(bodyPreviewTab[index] ?? "write") === "write" ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-transparent hover:border-border"}`}
                                  data-testid={`tab-write-${index}`}
                                >
                                  Write
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setBodyPreviewTab(prev => ({ ...prev, [index]: "preview" }))}
                                  className={`text-xs px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${(bodyPreviewTab[index] ?? "write") === "preview" ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-transparent hover:border-border"}`}
                                  data-testid={`tab-preview-${index}`}
                                >
                                  <Eye className="w-3 h-3" /> Preview
                                </button>
                              </div>
                              {(bodyPreviewTab[index] ?? "write") === "write" ? (
                                <Textarea
                                  placeholder="SMS message... Use {{firstName}} for personalization"
                                  value={step.body || ""}
                                  onChange={e => updateStep(index, { body: e.target.value })}
                                  className="min-h-[60px]"
                                  data-testid={`input-step-sms-${index}`}
                                />
                              ) : (
                                <div className="rounded border p-2 bg-muted/20 min-h-[60px]">
                                  <EmailPreviewContent
                                    body={step.body || ""}
                                    contentType="text"
                                    showComplianceNotice={false}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {step.actionType === "task" && (
                          <Input
                            placeholder="Task title"
                            value={step.subject || ""}
                            onChange={e => updateStep(index, { subject: e.target.value })}
                            data-testid={`input-step-task-${index}`}
                          />
                        )}

                        {step.actionType === "wait" && (
                          <p className="text-sm text-muted-foreground">
                            This step pauses the sequence for the configured delay before proceeding.
                          </p>
                        )}

                        {supportsABTest(step.actionType) && (
                          <div className="mt-3 border-t pt-3">
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <div className="flex items-center gap-2">
                                <FlaskConical className="w-4 h-4 text-purple-500" />
                                <span className="text-sm font-medium">A/B Test</span>
                                <Badge variant="outline" className="text-xs">Beta</Badge>
                              </div>
                              <Switch
                                checked={!!step.variantBEnabled}
                                onCheckedChange={v => updateStep(index, { variantBEnabled: v })}
                                data-testid={`switch-ab-test-${index}`}
                              />
                            </div>

                            {step.variantBEnabled && (
                              <div className="space-y-3 mt-2 pl-1">
                                <div className="p-3 rounded-md bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800 space-y-2">
                                  <Label className="text-xs font-semibold text-purple-700 dark:text-purple-300 block">Variant B</Label>
                                  {step.actionType === "email" && (
                                    <>
                                      <Input
                                        placeholder="Variant B subject line"
                                        value={step.variantBSubject || ""}
                                        onChange={e => updateStep(index, { variantBSubject: e.target.value })}
                                        data-testid={`input-variant-b-subject-${index}`}
                                      />
                                      <Textarea
                                        placeholder="Variant B email body..."
                                        value={step.variantBBody || ""}
                                        onChange={e => updateStep(index, { variantBBody: e.target.value })}
                                        className="min-h-[80px]"
                                        data-testid={`input-variant-b-body-${index}`}
                                      />
                                    </>
                                  )}
                                  {step.actionType === "sms" && (
                                    <Textarea
                                      placeholder="Variant B SMS message..."
                                      value={step.variantBBody || ""}
                                      onChange={e => updateStep(index, { variantBBody: e.target.value })}
                                      className="min-h-[60px]"
                                      data-testid={`input-variant-b-sms-${index}`}
                                    />
                                  )}
                                </div>

                                <div className="grid grid-cols-3 gap-2">
                                  <div className="space-y-1">
                                    <Label className="text-xs">Traffic Split (A%)</Label>
                                    <Input
                                      type="number"
                                      min={10}
                                      max={90}
                                      value={step.abTestConfig?.splitRatio ?? 50}
                                      onChange={e => updateStep(index, {
                                        abTestConfig: { ...step.abTestConfig!, splitRatio: Number(e.target.value) }
                                      })}
                                      data-testid={`input-ab-split-${index}`}
                                    />
                                    <p className="text-xs text-muted-foreground">B gets {100 - (step.abTestConfig?.splitRatio ?? 50)}%</p>
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Min Sample</Label>
                                    <Input
                                      type="number"
                                      min={10}
                                      value={step.abTestConfig?.minSampleSize ?? 100}
                                      onChange={e => updateStep(index, {
                                        abTestConfig: { ...step.abTestConfig!, minSampleSize: Number(e.target.value) }
                                      })}
                                      data-testid={`input-ab-sample-${index}`}
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Winner By</Label>
                                    <Select
                                      value={step.abTestConfig?.winnerCriteria ?? "open_rate"}
                                      onValueChange={v => updateStep(index, {
                                        abTestConfig: { ...step.abTestConfig!, winnerCriteria: v as "open_rate" | "reply_rate" }
                                      })}
                                    >
                                      <SelectTrigger data-testid={`select-ab-criteria-${index}`}>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="open_rate">Open Rate</SelectItem>
                                        <SelectItem value="reply_rate">Reply Rate</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={closeDialog} data-testid="button-cancel-create">
                Cancel
              </Button>
              {isEditMode ? (
                <Button
                  onClick={() => editMutation.mutate()}
                  disabled={!form.name || steps.length === 0 || editMutation.isPending || editLoadingSteps}
                  data-testid="button-save-sequence"
                >
                  {editMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving...</>
                  ) : (
                    <><Pencil className="w-4 h-4 mr-2" /> Save Changes</>
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={!form.name || steps.length === 0 || createMutation.isPending}
                  data-testid="button-save-sequence"
                >
                  {createMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Creating...</>
                  ) : (
                    <><Send className="w-4 h-4 mr-2" /> Create Sequence</>
                  )}
                </Button>
              )}
            </div>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={enrollDialogSeqId !== null} onOpenChange={(open) => {
        if (!open) {
          setEnrollDialogSeqId(null);
          setEnrollTab("single");
          setBulkVertical("");
          setBulkPreview(null);
          setBulkConfirmText("");
        }
      }}>
        <DialogContent data-testid="dialog-enroll" className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Enroll Contact in Sequence</DialogTitle>
          </DialogHeader>
          <Tabs value={enrollTab} onValueChange={(v) => { setEnrollTab(v as "single" | "vertical"); setBulkVertical(""); setBulkPreview(null); setBulkConfirmText(""); }}>
            <TabsList className="flex-wrap h-auto gap-1 mb-4" data-testid="enroll-tab-list">
              <TabsTrigger value="single" data-testid="tab-single-contact">Single Contact</TabsTrigger>
              <TabsTrigger value="vertical" data-testid="tab-by-vertical">By Vertical</TabsTrigger>
            </TabsList>

            <TabsContent value="single">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select Contact</Label>
                  <Select value={enrollContactId} onValueChange={setEnrollContactId}>
                    <SelectTrigger data-testid="select-enroll-contact">
                      <SelectValue placeholder="Choose a contact..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(contacts || []).map((c: any) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.firstName} {c.lastName} - {c.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Deal ID (optional)</Label>
                  <Input
                    value={enrollDealId}
                    onChange={e => setEnrollDealId(e.target.value)}
                    placeholder="Optional deal ID"
                    data-testid="input-enroll-deal"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setEnrollDialogSeqId(null)} data-testid="button-cancel-enroll">
                    Cancel
                  </Button>
                  <Button
                    onClick={() => enrollMutation.mutate()}
                    disabled={!enrollContactId || enrollMutation.isPending}
                    data-testid="button-confirm-enroll"
                  >
                    {enrollMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Users className="w-4 h-4 mr-2" />}
                    Enroll
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="vertical">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select Vertical</Label>
                  <Select value={bulkVertical} onValueChange={(v) => { setBulkVertical(v); setBulkPreview(null); setBulkConfirmText(""); }} data-testid="select-bulk-vertical">
                    <SelectTrigger data-testid="trigger-bulk-vertical">
                      <SelectValue placeholder="Choose a vertical..." />
                    </SelectTrigger>
                    <SelectContent>
                      {verticalsIsPending && (
                        <SelectItem value="_loading" disabled>Loading verticals…</SelectItem>
                      )}
                      {!verticalsIsPending && verticalsIsError && (
                        <SelectItem value="_error" disabled>Could not load verticals — try again</SelectItem>
                      )}
                      {!verticalsIsPending && !verticalsIsError && verticalsList.length === 0 && (
                        <SelectItem value="_empty" disabled>No verticals yet</SelectItem>
                      )}
                      {!verticalsIsPending && !verticalsIsError && verticalsList.map((v) => (
                        <SelectItem key={v.vertical} value={v.vertical}>
                          {v.vertical}
                          <Badge variant="secondary" className="ml-2 text-xs">{v.count}</Badge>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Enrichment guidance — shown only on successful empty result, never on error */}
                  {!verticalsIsPending && !verticalsIsError && verticalsList.length === 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      No contacts have been classified into verticals yet. Enrich your contacts first.{" "}
                      {canAccessOutreachHub ? (
                        <a href="/dashboard/outreach-hub?tab=command" className="underline hover:text-foreground">
                          Open Outreach Command Center
                        </a>
                      ) : (
                        "Ask an admin to run enrichment from the Outreach Command Center."
                      )}
                    </p>
                  )}
                </div>

                {bulkVertical && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleVerticalPreview}
                    disabled={bulkPreviewLoading}
                    data-testid="button-preview-vertical"
                  >
                    {bulkPreviewLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
                    Preview Eligibility
                  </Button>
                )}

                {bulkPreview && (
                  <div className="border rounded-md p-3 space-y-2 text-sm bg-muted/30" data-testid="bulk-preview-results">
                    <div className="flex gap-4 flex-wrap">
                      <span>Total matching: <strong data-testid="preview-total">{bulkPreview.totalMatching}</strong></span>
                      <span className="text-green-700 dark:text-green-400">Eligible: <strong data-testid="preview-eligible">{bulkPreview.eligible}</strong></span>
                      <span className="text-amber-700 dark:text-amber-400">Already enrolled: <strong>{bulkPreview.alreadyEnrolled}</strong></span>
                      <span className="text-red-700 dark:text-red-400">Ineligible: <strong>{bulkPreview.notEligible}</strong></span>
                    </div>
                    {bulkPreview.previewContacts?.length > 0 && (
                      <div>
                        <p className="text-muted-foreground text-xs mb-1">First {bulkPreview.previewContacts.length} eligible contact(s):</p>
                        <ul className="space-y-0.5" data-testid="preview-contact-list">
                          {bulkPreview.previewContacts.map((c: any) => (
                            <li key={c.id} className="text-xs text-muted-foreground">
                              {c.firstName} {c.lastName} — {c.email}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Object.keys(bulkPreview.skippedBreakdown ?? {}).length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Skip reasons:</p>
                        <ul className="text-xs text-muted-foreground space-y-0.5">
                          {Object.entries(bulkPreview.skippedBreakdown).map(([reason, cnt]: [string, any]) => (
                            <li key={reason}>{reason}: {cnt}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {bulkPreview && bulkPreview.eligible >= 100 && (
                  <div className="space-y-1">
                    <Label className="text-sm">Type <strong>ENROLL</strong> to confirm ({bulkPreview.eligible} eligible contacts)</Label>
                    <Input
                      value={bulkConfirmText}
                      onChange={e => setBulkConfirmText(e.target.value)}
                      placeholder="ENROLL"
                      data-testid="input-bulk-confirm"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setEnrollDialogSeqId(null)} data-testid="button-cancel-bulk-enroll">
                    Cancel
                  </Button>
                  <Button
                    onClick={() => bulkEnrollMutation.mutate()}
                    disabled={
                      !bulkVertical ||
                      !bulkPreview ||
                      bulkPreview.eligible === 0 ||
                      bulkEnrollMutation.isPending ||
                      (bulkPreview.eligible >= 100 && bulkConfirmText !== "ENROLL")
                    }
                    data-testid="button-queue-vertical-enroll"
                  >
                    {bulkEnrollMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Users className="w-4 h-4 mr-2" />}
                    Queue Eligible Contacts
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog open={activatingSeq !== null} onOpenChange={(open) => { if (!open) { setActivatingSeq(null); setActivateChecks([false, false, false]); } }}>
        <DialogContent data-testid="dialog-activate-confirm">
          <DialogHeader>
            <DialogTitle>Activate "{activatingSeq?.name}"</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2 text-sm rounded-md border p-3">
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Family</span>
                <span data-testid="activate-family">
                  {activatingSeq?.sequenceFamily || <span className="text-muted-foreground italic">—</span>}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Consent Tiers</span>
                <div className="flex flex-wrap gap-1" data-testid="activate-consent-tiers">
                  {activatingSeq?.eligibleConsentTiers?.length > 0
                    ? activatingSeq.eligibleConsentTiers.map((tier: string) => (
                        <Badge key={tier} variant="outline" className="text-xs">
                          {tier === "cold_no_consent" ? "cold" : tier === "warm_no_pewc" ? "warm" : tier === "pewc_full_automation" ? "PEWC" : tier}
                        </Badge>
                      ))
                    : <span className="text-muted-foreground italic">none</span>
                  }
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Channels</span>
                <div className="flex flex-wrap gap-1" data-testid="activate-channels">
                  {activatingSeq?.channelsAllowed?.length > 0
                    ? activatingSeq.channelsAllowed.map((ch: string) => (
                        <Badge key={ch} variant="secondary" className="text-xs">
                          {ch}
                        </Badge>
                      ))
                    : <span className="text-muted-foreground italic">none</span>
                  }
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground w-28 shrink-0">Steps</span>
                <span data-testid="activate-steps">
                  {activatingSeq?.totalSteps != null ? activatingSeq.totalSteps : "unknown"}
                </span>
              </div>
            </div>

            <div className="space-y-3" data-testid="activate-checklist">
              {[
                "I have reviewed all step copy and delay timing.",
                "The eligible consent tiers above are correct for this campaign.",
                "I understand this sequence will begin enrolling contacts immediately.",
              ].map((label, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Checkbox
                    id={`activate-ack-${i}`}
                    checked={activateChecks[i]}
                    onCheckedChange={(checked) =>
                      setActivateChecks((prev) => prev.map((v, j) => (j === i ? !!checked : v)))
                    }
                    data-testid={`checkbox-activate-ack-${i}`}
                  />
                  <Label htmlFor={`activate-ack-${i}`} className="text-sm leading-snug cursor-pointer">
                    {label}
                  </Label>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                data-testid="button-cancel-activate"
                onClick={() => {
                  setActivatingSeq(null);
                  setActivateChecks([false, false, false]);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={!activateChecks.every(Boolean) || toggleMutation.isPending}
                data-testid="button-confirm-activate"
                onClick={handleConfirmActivate}
              >
                {toggleMutation.isPending ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Activating…</> : "Confirm"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}

function TierBreakdown({ seqId, eligibleTiers }: { seqId: number; eligibleTiers: string[] }) {
  const { data, isLoading, isError, refetch } = useQuery<{ consentTier: string; count: number }[]>({
    queryKey: ["/api/sequences", seqId, "enrollments", "by-tier"],
    queryFn: async ({ signal }) => {
      const res = await apiRequest("GET", `/api/sequences/${seqId}/enrollments/by-tier`, undefined, undefined, signal);
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="mt-2 space-y-1.5" data-testid={`tier-breakdown-loading-${seqId}`}>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  if (isError) {
    return (
      <div role="alert" className="mt-2 border rounded-md px-3 py-2 text-xs" data-testid={`tier-breakdown-error-${seqId}`}>
        Tier breakdown unavailable. This is not a zero count.
        <Button size="sm" variant="outline" className="ml-2" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const serverRows = data || [];
  const serverTiers = new Set(serverRows.map((r) => r.consentTier));
  const zeroRows = eligibleTiers
    .filter((t) => !serverTiers.has(t))
    .map((t) => ({ consentTier: t, count: 0 }));
  const allRows = [...serverRows, ...zeroRows];

  if (allRows.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid={`tier-breakdown-empty-${seqId}`}>
        No active enrollment records
      </p>
    );
  }

  return (
    <div className="mt-2 border rounded-md px-3 py-2 text-xs" data-testid={`tier-breakdown-${seqId}`}>
      <p className="text-muted-foreground mb-1.5 font-medium">Active enrollment records by tier</p>
      {allRows.map(({ consentTier, count }) => (
        <div
          key={consentTier}
          className={`flex justify-between py-0.5${count === 0 ? " text-muted-foreground" : ""}`}
          data-testid={`row-tier-${seqId}-${consentTier}`}
        >
          <span>{consentTier}</span>
          <span>{count}</span>
        </div>
      ))}
    </div>
  );
}

function SequenceStepsView({ sequenceId, enrollments }: { sequenceId: number; enrollments: any[] }) {
  const { data: steps, isLoading, isError: stepsError, refetch: refetchSteps } = useQuery<any[]>({
    queryKey: ["/api/sequences", sequenceId, "steps"],
    queryFn: async ({ signal }) => {
      const res = await apiRequest("GET", `/api/sequences/${sequenceId}/steps`, undefined, undefined, signal);
      return res.json();
    },
  });

  const { data: contactsRes2 } = useQuery<{ data: any[]; total: number }>({
    queryKey: ["/api/contacts"],
  });
  const contacts = contactsRes2?.data;

  const contactMap = new Map((contacts || []).map((c: any) => [c.id, c]));

  const [previewStep, setPreviewStep] = useState<any | null>(null);

  if (isLoading) return <Skeleton className="h-20 mt-4" />;

  return (
    <div className="mt-4 space-y-4">
      {previewStep && (
        <EmailPreviewModal
          open={!!previewStep}
          onOpenChange={(open) => { if (!open) setPreviewStep(null); }}
          subject={previewStep.subject || ""}
          body={previewStep.body || ""}
          contentType={previewStep.actionType === "sms" ? "text" : "html"}
        />
      )}

      <div>
        <h4 className="text-sm font-semibold mb-2">Steps Timeline</h4>
        {stepsError ? (
          <div role="alert" className="text-sm" data-testid={`steps-error-${sequenceId}`}>
            Steps could not be loaded. This is not an empty sequence.
            <Button size="sm" variant="outline" className="ml-2" onClick={() => refetchSteps()}>Retry</Button>
          </div>
        ) : (!steps || steps.length === 0) ? (
          <p className="text-sm text-muted-foreground">No steps configured</p>
        ) : (
          <div className="space-y-1">
            {steps.map((step: any, i: number) => {
              const StepIcon = stepIcon(step.actionType);
              const hasABTest = !!(step.abTestConfig && (step.variantBSubject || step.variantBBody));
              const abResults = step.abTestResults as any;
              const canPreview = true;
              return (
                <div key={step.id} className="space-y-1" data-testid={`view-step-${step.id}`}>
                  <div className="flex items-center gap-3 py-1.5">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Badge variant="outline" className="text-xs shrink-0">{i + 1}</Badge>
                      <StepIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium">{stepLabel(step.actionType)}</span>
                      {step.subject && <span className="text-xs text-muted-foreground truncate">- {step.subject}</span>}
                      {hasABTest && (
                        <Badge variant="outline" className="text-xs shrink-0 border-purple-400 text-purple-600 dark:text-purple-400">
                          <FlaskConical className="w-3 h-3 mr-1" /> A/B
                        </Badge>
                      )}
                      {step.actionType === "call_reminder" && (
                        <Badge variant="outline" className="text-xs shrink-0 border-amber-400 text-amber-600 dark:text-amber-400" title="Voice execution requires ORCHESTRATOR_ENABLED=true">
                          <AlertTriangle className="w-3 h-3 mr-1" /> Needs Orchestrator
                        </Badge>
                      )}
                      {/* #902 — Per-step email sent count badge */}
                      {(() => {
                        const abRes = step.abTestResults as any;
                        const sentCount = step.sentCount != null
                          ? step.sentCount
                          : abRes
                          ? (abRes.variantASent || 0) + (abRes.variantBSent || 0)
                          : null;
                        if (!sentCount) return null;
                        return (
                          <Badge variant="secondary" className="text-xs shrink-0" data-testid={`badge-step-sent-${step.id}`}>
                            <Send className="w-3 h-3 mr-1" />{sentCount} sent
                          </Badge>
                        );
                      })()}
                    </div>
                    {(step.delayDays > 0 || step.delayHours > 0) && (
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {step.delayDays > 0 && `${step.delayDays}d`} {step.delayHours > 0 && `${step.delayHours}h`} delay
                      </Badge>
                    )}
                    {hasABTest && abResults?.winnerSelected && (
                      <Badge variant="default" className="text-xs shrink-0 bg-green-600">
                        Winner: {abResults.winnerSelected}
                      </Badge>
                    )}
                    {canPreview && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Preview step content"
                        onClick={() => setPreviewStep(step)}
                        className="h-6 w-6 shrink-0"
                        data-testid={`button-preview-step-${step.id}`}
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                  {hasABTest && abResults && (
                    <div className="ml-8 grid grid-cols-2 gap-2 text-xs text-muted-foreground pb-1">
                      <div className="rounded border p-2">
                        <p className="font-semibold mb-0.5">Variant A</p>
                        <p>Sent: {abResults.variantASent ?? 0}</p>
                        <p>Opens: {abResults.aOpens ?? 0}</p>
                        <p>Replies: {abResults.aReplies ?? 0}</p>
                      </div>
                      <div className="rounded border p-2">
                        <p className="font-semibold mb-0.5">Variant B</p>
                        <p>Sent: {abResults.variantBSent ?? 0}</p>
                        <p>Opens: {abResults.bOpens ?? 0}</p>
                        <p>Replies: {abResults.bReplies ?? 0}</p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {enrollments.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Enrollments ({enrollments.length})</h4>
          <div className="space-y-1">
            {enrollments.slice(0, 10).map((e: any) => {
              const contact = contactMap.get(e.contactId);
              return (
                <div key={e.id} className="flex items-center justify-between py-1 text-sm" data-testid={`enrollment-${e.id}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {/* #546 — Link to contact profile from enrollment */}
                    <a
                      href={`/dashboard/contacts/${e.contactId}`}
                      className="font-medium truncate hover:underline text-primary"
                      data-testid={`link-enrollment-contact-${e.id}`}
                      onClick={ev => { ev.stopPropagation(); }}
                    >
                      {contact ? `${contact.firstName} ${contact.lastName}` : `Contact #${e.contactId}`}
                    </a>
                    <Badge variant={e.status === "active" ? "default" : e.status === "completed" ? "secondary" : "outline"} className="text-xs">
                      {e.status}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    Step {e.currentStep || 0}/{steps?.length || "?"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
