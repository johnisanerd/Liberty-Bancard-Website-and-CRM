import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { formatDistanceToNow } from "date-fns";
import { useSearch, useLocation } from "wouter";
import { useMutation, type InfiniteData } from "@tanstack/react-query";
import { useCrmInfiniteQuery } from "@/hooks/use-crm-infinite-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { apiRequest, queryClient, protectedContextToken, protectedScope } from "@/lib/queryClient";
import { requireDealTransitionObservation, DealTransitionObservationError } from "@/lib/deal-transition-observation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Calendar, Sparkles, Loader2, Download, ChevronDown, ChevronUp, Archive, Settings, ArrowUp, ArrowDown, Pencil, Trash2, RotateCcw, MoreVertical, TrendingUp, TrendingDown, UserRound, AlertTriangle, Activity, ArrowUpDown, FileText, Copy, ExternalLink, Send, CheckCircle2, History, User, Bot, Monitor, ShieldCheck, ShieldAlert, ShieldX, Clock, RefreshCw, ListChecks, Eye, StickyNote, Users } from "lucide-react";
import TerminalEconomicsCard from "@/components/TerminalEconomicsCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {useAuthorizedSelectedRecord} from "@/hooks/use-authorized-selected-record";
import { exportToCSV } from "@/lib/export-csv";
import { getDealCardIdentity as dealCardIdentityFn } from "@/lib/deal-identity";
import type { Deal, Contact, PipelineStage, Agent, AgentMerchant, CoBrandedProposal } from "@shared/schema";
import { SALES_STAGES, OFFER_PATHS, VERTICALS } from "@shared/schema";
import Comments from "@/components/Comments";
import SavedFilterBar from "@/components/SavedFilterBar";
import DashboardErrorState from "@/components/DashboardErrorState";
import { useConfirmationFailedBatch, type ConfirmationFailedStatus } from "@/hooks/use-confirmation-failed-batch";
import { CrmPage, CrmPageHeader, CrmDataState } from "@/components/crm/CrmPresentation";
import { AuthorizedContactPicker, type ContactChoice } from "@/components/crm/AuthorizedContactPicker";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const STAGE_COLORS: Record<string, string> = {
  "New Lead": "bg-blue-500",
  "Enriched": "bg-teal-500",
  "Statement Received": "bg-indigo-500",
  "Review In Progress": "bg-violet-500",
  "Call Booked": "bg-cyan-500",
  "Proposal Sent": "bg-amber-500",
  "Negotiation / Follow-Up": "bg-orange-500",
  "Verbal Commit": "bg-purple-500",
  "Promise to Submit": "bg-rose-500",   // #513
  "Nurture / Not Now": "bg-slate-500",
  "Closed Won": "bg-green-600",
  "Closed Lost": "bg-red-500",
};

const PRESET_COLORS = [
  "#3b82f6", "#6366f1", "#8b5cf6", "#06b6d4", "#f59e0b",
  "#f97316", "#64748b", "#16a34a", "#ef4444", "#ec4899",
  "#14b8a6", "#84cc16",
];

interface MidSummary {
  dealId: number;
  mid: string;
  totalVolume: number;
  txCount: number;
  chargebackCount: number;
  trendPct: number;
  sparkline: number[];
  latestDate: string | null;
  fetchedAt: string | null;
}

type BulkStageOutcome = "confirmed" | "blocked" | "unknown" | "unattempted";
interface BulkStageResult {
  id: number;
  outcome: BulkStageOutcome;
  reason?: string | null;
  currentStage?: string | null;
}
interface BulkStageResponse {
  advanced: number;
  blocked: number;
  blockedDealIds: number[];
  results: BulkStageResult[];
  confirmedDealIds: number[];
  unresolvedDealIds: number[];
}

function fmtCompactCurrency(n: unknown): string {
  const val = typeof n === "number" ? n : Number(n);
  if (n === null || n === undefined || n === "" || !isFinite(val)) return "Value unknown";
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(val >= 10_000_000 ? 0 : 1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(val >= 10_000 ? 0 : 1)}k`;
  return `$${val.toFixed(0)}`;
}

function VolumeSparkline({ values }: { values: number[] }) {
  if (!values || values.length < 2) return null;
  const w = 80;
  const h = 20;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-primary" data-testid="svg-deal-sparkline">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function DealMidBadge({ summary }: { summary: MidSummary | undefined }) {
  if (!summary) return null;
  const hasData = summary.sparkline.length > 0 && summary.totalVolume > 0;
  if (!hasData) {
    return (
      <Badge
        variant="outline"
        className="text-xs no-default-hover-elevate no-default-active-elevate"
        data-testid={`badge-no-volume-${summary.dealId}`}
        title={`MID ${summary.mid} — no recent processing activity`}
      >
        <Activity className="w-3 h-3 mr-1 opacity-60" /> No activity
      </Badge>
    );
  }
  const trendUp = summary.trendPct >= 0;
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5" data-testid={`mid-summary-${summary.dealId}`}>
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tabular-nums" data-testid={`text-deal-volume-${summary.dealId}`}>
            30d: {fmtCompactCurrency(summary.totalVolume)}
          </span>
          {summary.chargebackCount > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[10px] border-red-300 text-red-600 dark:text-red-400 no-default-hover-elevate no-default-active-elevate"
              data-testid={`badge-chargebacks-${summary.dealId}`}
              title={`${summary.chargebackCount} chargeback${summary.chargebackCount === 1 ? "" : "s"} in last 30 days`}
            >
              <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
              {summary.chargebackCount} CB
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-0.5 text-[10px]">
          {trendUp ? (
            <TrendingUp className="w-2.5 h-2.5 text-green-600 dark:text-green-400" />
          ) : (
            <TrendingDown className="w-2.5 h-2.5 text-red-600 dark:text-red-400" />
          )}
          <span
            className={trendUp ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}
            data-testid={`text-deal-trend-${summary.dealId}`}
          >
            {trendUp ? "+" : ""}{summary.trendPct.toFixed(0)}%
          </span>
        </div>
      </div>
      <VolumeSparkline values={summary.sparkline} />
    </div>
  );
}

// #474 — Quick inline note editor on deal card
function QuickNoteEditor({ deal }: { deal: Deal }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [noteText, setNoteText] = useState(deal.notes || "");
  const [, queryClientInstance] = [null, null]; // placeholder
  const saveNote = async (text: string) => {
    try {
      const res = await apiRequest("PUT", `/api/deals/${deal.id}`, { notes: text });
      if (!res.ok) throw new Error("Failed");
    } catch (err: any) {
      toast({ title: "Note save failed", description: err.message, variant: "destructive" });
    }
  };

  if (editing) {
    return (
      <div onClick={e => e.stopPropagation()}>
        <textarea
          className="w-full text-xs border rounded p-1 resize-none bg-background"
          value={noteText}
          autoFocus
          rows={2}
          placeholder="Add note…"
          data-testid={`textarea-quick-note-${deal.id}`}
          onChange={e => setNoteText(e.target.value)}
          onBlur={() => {
            if (noteText !== (deal.notes || "")) saveNote(noteText);
            setEditing(false);
          }}
          onKeyDown={e => {
            if (e.key === "Escape") { setNoteText(deal.notes || ""); setEditing(false); }
          }}
        />
      </div>
    );
  }

  return (
    <button
      className="text-muted-foreground/40 hover:text-muted-foreground text-xs flex items-center gap-1 mt-0.5"
      onClick={e => { e.stopPropagation(); setNoteText(deal.notes || ""); setEditing(true); }}
      data-testid={`button-quick-note-${deal.id}`}
      title="Add/edit note"
    >
      <StickyNote className="h-3 w-3" />
      {deal.notes ? "Edit note" : "Add note"}
    </button>
  );
}

// #427 — Self-contained notes expand dialog for deal cards
function NotesExpandButton({ deal, identity }: { deal: Deal; identity: { primary: string; secondary: string | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="text-[10px] text-primary/70 hover:text-primary underline-offset-2 hover:underline mt-0.5"
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        data-testid={`button-view-full-notes-${deal.id}`}
      >
        View full notes
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid={`dialog-full-notes-${deal.id}`}>
          <DialogHeader>
            <DialogTitle>Deal Notes</DialogTitle>
            <p className="text-xs text-muted-foreground">{identity.primary} · {deal.stage}</p>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm whitespace-pre-wrap" data-testid={`text-full-notes-${deal.id}`}>{deal.notes}</p>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} data-testid={`button-close-notes-${deal.id}`}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Deal Quick-Edit Sheet ──────────────────────────────────────────────────
function DealQuickEditSheet({
  deal,
  open,
  onClose,
}: {
  deal: Deal | null;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const contextKey=JSON.stringify([protectedScope(user),open,deal?.id,deal?.contactId]);
  const currentContext=useRef(contextKey);currentContext.current=contextKey;
  const focusReturnDealId=useRef<number|null>(null);
  useEffect(()=>{
    if(open && deal)focusReturnDealId.current=deal.id;
  },[open,deal?.id]);
  const hydratedContext=useRef<string|null>(null);
  const [confirmedDealKey,setConfirmedDealKey]=useState<string|null>(null);
  const contactRead=useQuery<Record<string,any>>({
    queryKey:["/api/contacts",deal?.contactId],
    enabled:open&&!!deal?.contactId,
    queryFn:async({signal})=>{
      const row=await (await apiRequest("GET",`/api/contacts/${deal!.contactId}`,undefined,undefined,signal)).json();
      if(!row || row.id!==deal?.contactId)throw new Error("Exact linked contact response unavailable");
      for(const key of ["firstName","lastName","email","phone"]){
        if(!Object.hasOwn(row,key) || row[key]!==null && typeof row[key]!=="string"){
          throw new Error("Exact linked contact response is malformed");
        }
      }
      return row;
    },
    retry:false,
    staleTime:0,
  });
  const [contactFields, setContactFields] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    companyName: "",
    vertical: "",
    monthlyVolume: "",
    currentProvider: "",
    leadSource: "",       // schema column is leadSource (not source)
    preferredChannel: "",
  });
  const [dealFields, setDealFields] = useState({
    name: "",
    offerPath: "",
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [contactId, setContactId] = useState<number | null>(null);

  // Reset edits on the exact protected context; no prior entity placeholders.
  useEffect(() => {
    hydratedContext.current=null;
    setConfirmedDealKey(null);setSaving(false);
    setContactFields(previous=>Object.fromEntries(Object.keys(previous).map(key=>[key,""])) as typeof previous);
    setContactId(open&&deal ? deal.contactId : null);
    setErrors({});
    setDealFields({
      name: (deal as any)?.name ?? "",
      offerPath: (deal as any)?.offerPath ?? "",
    });
  }, [contextKey]);
  useEffect(()=>{
        const c=contactRead.data;
        if(!open || contactRead.isError || !c || c.id!==deal?.contactId || hydratedContext.current===contextKey)return;
        hydratedContext.current=contextKey;
        setContactFields({
          firstName: c.firstName ?? "",
          lastName: c.lastName ?? "",
          email: c.email ?? "",
          phone: c.phone ?? "",
          companyName: c.companyName ?? "",
          vertical: c.vertical ?? "",
          monthlyVolume: c.monthlyVolume ?? "",
          currentProvider: c.currentProvider ?? "",
          leadSource: c.leadSource ?? "",   // correct column name
          preferredChannel: c.preferredChannel ?? "",
        });
  },[contactRead.data,contactRead.isError,contextKey]);

  const validate = () => {
    const errs: Record<string, string> = {};
    // firstName/lastName/companyName: at least one identifier required
    if (contactId && !contactFields.firstName.trim() && !contactFields.lastName.trim() && !contactFields.companyName.trim()) {
      errs.name = "At least first name, last name, or company name is required.";
    }
    // email and phone are NOT NULL in the schema — cannot be cleared to null
    if (contactId && !contactFields.email.trim()) errs.email = "Email is required.";
    if (contactId && !contactFields.phone.trim()) errs.phone = "Phone is required.";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!deal || (deal.contactId && (contactRead.isError || !contactRead.data)) || !validate()) return;
    const submittedContext=contextKey;
    const dealKey=JSON.stringify([submittedContext,dealFields]);
    let dealConfirmed=confirmedDealKey===dealKey;
    setSaving(true);
    try {
      // Save deal fields.
      // name and offerPath are both nullable columns — send null to clear.
      const dealPayload: Record<string, unknown> = {
        name: dealFields.name.trim() || null,
        offerPath: dealFields.offerPath || null,
      };
      if(!dealConfirmed){
        const dr = await apiRequest("PUT", `/api/deals/${deal.id}`, dealPayload);
        const receipt=await dr.json();
        if(receipt?.id!==deal.id)throw new Error("Deal confirmation unavailable. Read back before retrying.");
        dealConfirmed=true;
        void queryClient.invalidateQueries({queryKey:["/api/deals"]});
        if(currentContext.current!==submittedContext)return;
        setConfirmedDealKey(dealKey);
      }
      if(currentContext.current!==submittedContext)return;
      // Save contact fields.
      // NOT NULL columns (firstName, lastName, email, phone): only include when non-empty
      //   (omitting preserves the existing DB value; validation above already ensured they're set).
      //   Never send null — that would violate the DB constraint.
      // Nullable columns: send null to explicitly clear.
      if (contactId) {
        const contactPayload: Record<string, unknown> = {
          // NOT NULL — only update when non-empty (validation guarantees this for email/phone)
          firstName: contactFields.firstName.trim() || undefined,
          lastName: contactFields.lastName.trim() || undefined,
          email: contactFields.email.trim() || undefined,
          phone: contactFields.phone.trim() || undefined,
          // Nullable — send null to clear
          companyName: contactFields.companyName.trim() || null,
          vertical: contactFields.vertical || null,
          monthlyVolume: contactFields.monthlyVolume.trim() || null,
          currentProvider: contactFields.currentProvider.trim() || null,
          leadSource: contactFields.leadSource.trim() || null,
          preferredChannel: contactFields.preferredChannel || null,
        };
        const cr = await apiRequest("PUT", `/api/contacts/${contactId}`, contactPayload);
        const receipt=await cr.json();
        if(receipt?.id!==contactId)throw new Error("Contact save confirmation unavailable");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      if(currentContext.current!==submittedContext)return;
      toast({ title: "Lead updated", description: "Deal and requested contact changes confirmed." });
      onClose();
    } catch (err: any) {
      if(currentContext.current!==submittedContext)return;
      const message=dealConfirmed
        ? `Deal changes confirmed. Contact changes are not confirmed. ${err?.message} Retry only the remaining contact save; do not undo the committed deal.`
        : `Deal changes are not confirmed. ${err?.message}`;
      setErrors(previous=>({...previous,save:message}));
      toast({ title: "Save not fully confirmed", description:message, variant: "destructive" });
    } finally {
      if(currentContext.current===submittedContext)setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto" data-testid="sheet-deal-quick-edit"
        onCloseAutoFocus={(event)=>{
          // The menu item unmounts when it opens this controlled Sheet. Return
          // to the same record's live action button, never a stale menu node.
          const caller=document.querySelector<HTMLButtonElement>(
            `[data-testid="button-deal-actions-${focusReturnDealId.current}"]`);
          if(caller?.isConnected){event.preventDefault();caller.focus();}
        }}>
        <SheetHeader>
          <SheetTitle>Edit Lead</SheetTitle>
        </SheetHeader>
        {deal?.contactId && contactRead.isLoading && <CrmDataState state="loading" message="Loading the exact authorized linked contact."/>}
        {deal?.contactId && contactRead.isError && <CrmDataState state="unavailable" message="Linked contact could not be loaded. Editing is unavailable; no empty record is assumed." onRetry={()=>void contactRead.refetch()}/>}
        {(!deal?.contactId || contactRead.data && !contactRead.isError) && <div className="mt-6 space-y-5">
          {errors.save && <p role="alert" className="text-sm text-destructive">{errors.save}</p>}
          {/* Contact name */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>First Name</Label>
              <Input
                value={contactFields.firstName}
                onChange={(e) => setContactFields((p) => ({ ...p, firstName: e.target.value }))}
                data-testid="input-qe-first-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Last Name</Label>
              <Input
                value={contactFields.lastName}
                onChange={(e) => setContactFields((p) => ({ ...p, lastName: e.target.value }))}
                data-testid="input-qe-last-name"
              />
            </div>
          </div>
          {errors.name && <p className="text-xs text-destructive" data-testid="error-qe-name">{errors.name}</p>}

          <div className="space-y-1.5">
            <Label>Company Name</Label>
            <Input
              value={contactFields.companyName}
              onChange={(e) => setContactFields((p) => ({ ...p, companyName: e.target.value }))}
              data-testid="input-qe-company"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Email <span className="text-destructive">*</span></Label>
            <Input
              type="email"
              value={contactFields.email}
              onChange={(e) => setContactFields((p) => ({ ...p, email: e.target.value }))}
              data-testid="input-qe-email"
            />
            {errors.email && <p className="text-xs text-destructive" data-testid="error-qe-email">{errors.email}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Phone <span className="text-destructive">*</span></Label>
            <Input
              value={contactFields.phone}
              onChange={(e) => setContactFields((p) => ({ ...p, phone: e.target.value }))}
              data-testid="input-qe-phone"
            />
            {errors.phone && <p className="text-xs text-destructive" data-testid="error-qe-phone">{errors.phone}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Vertical</Label>
            <Select
              value={contactFields.vertical || "_none"}
              onValueChange={(v) => setContactFields((p) => ({ ...p, vertical: v === "_none" ? "" : v }))}
            >
              <SelectTrigger data-testid="select-qe-vertical">
                <SelectValue placeholder="Select vertical" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">None</SelectItem>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Monthly Volume</Label>
            <Input
              value={contactFields.monthlyVolume}
              onChange={(e) => setContactFields((p) => ({ ...p, monthlyVolume: e.target.value }))}
              placeholder="e.g. 50000"
              data-testid="input-qe-monthly-volume"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Current Processor</Label>
            <Input
              value={contactFields.currentProvider}
              onChange={(e) => setContactFields((p) => ({ ...p, currentProvider: e.target.value }))}
              data-testid="input-qe-current-provider"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Lead Source</Label>
            <Input
              value={contactFields.leadSource}
              onChange={(e) => setContactFields((p) => ({ ...p, leadSource: e.target.value }))}
              data-testid="input-qe-source"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Preferred Contact Method</Label>
            <Select
              value={contactFields.preferredChannel || "_none"}
              onValueChange={(v) => setContactFields((p) => ({ ...p, preferredChannel: v === "_none" ? "" : v }))}
            >
              <SelectTrigger data-testid="select-qe-preferred-channel">
                <SelectValue placeholder="Select method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">None</SelectItem>
                {["email", "phone", "sms", "in-person"].map((ch) => (
                  <SelectItem key={ch} value={ch}>{ch.charAt(0).toUpperCase() + ch.slice(1)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="border-t pt-4 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Deal Fields</p>
            <div className="space-y-1.5">
              <Label>Deal Name</Label>
              <Input
                value={dealFields.name}
                onChange={(e) => setDealFields((p) => ({ ...p, name: e.target.value }))}
                data-testid="input-qe-deal-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Offer Path</Label>
              <Select
                value={dealFields.offerPath || "_none"}
                onValueChange={(v) => setDealFields((p) => ({ ...p, offerPath: v === "_none" ? "" : v }))}
              >
                <SelectTrigger data-testid="select-qe-offer-path">
                  <SelectValue placeholder="Select offer path" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">None</SelectItem>
                  {OFFER_PATHS.map((op) => (
                    <SelectItem key={op} value={op}>{op}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} data-testid="button-qe-cancel">Cancel</Button>
            <Button onClick={handleSave} disabled={saving} data-testid="button-qe-save">
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save Changes"}
            </Button>
          </div>
        </div>}
      </SheetContent>
    </Sheet>
  );
}

function SortableDealCard({
  deal,
  isDealArchived,
  selectedDealIds,
  toggleDealSelection,
  openDealDetail,
  archiveDealMutation,
  restoreDealMutation,
  getDealCardIdentity,
  getContactVertical,
  getContactEmployeeCount,
  getContactLeadSource,
  midSummary,
  proposals,
  proposalsFailed,
  onRetryProposals,
  proposalsRetrying,
  confirmationFailed,
  onQuickEdit,
}: {
  deal: Deal;
  isDealArchived: boolean;
  selectedDealIds: Set<number>;
  toggleDealSelection: (id: number) => void;
  openDealDetail: (deal: Deal) => void;
  archiveDealMutation: any;
  restoreDealMutation: any;
  getDealCardIdentity: (deal: { id: number }, contactId: number | null) => { primary: string; secondary: string | null };
  getContactVertical: (id: number | null) => string | null;
  getContactEmployeeCount: (id: number | null, embedded?: number | null) => number | null;
  getContactLeadSource: (id: number | null) => string | null;
  midSummary?: MidSummary;
  proposals?: CoBrandedProposal[];
  proposalsFailed?: boolean;
  onRetryProposals?: (dealId: number) => void;
  proposalsRetrying?: boolean;
  confirmationFailed?: ConfirmationFailedStatus | null;
  onQuickEdit?: (deal: Deal) => void;
}) {
  const { data: checklistSummary } = useQuery<{ total: number; completed: number }>({
    queryKey: ["/api/deals", deal.id, "checklist-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/deals/${deal.id}/checklist-summary`, { credentials: "include" });
      if (!res.ok) return { total: 0, completed: 0 };
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // cache 5 min — many cards render at once
    enabled: true,
  });
  const [, navigateTo] = useLocation();
  // alias used by URL filter sync
  const navigatePipeline = navigateTo;
  const identity = getDealCardIdentity(deal, deal.contactId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.id,
    data: { stage: deal.stage },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <Card
        className={`cursor-pointer hover-elevate ${isDealArchived ? "opacity-50" : ""}`}
        onClick={() => openDealDetail(deal)}
        data-testid={`card-deal-${deal.id}`}
      >
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Checkbox
              aria-label={`Select deal ${deal.id}`}
              checked={selectedDealIds.has(deal.id)}
              onCheckedChange={() => toggleDealSelection(deal.id)}
              onClick={(e) => e.stopPropagation()}
              data-testid={`checkbox-deal-${deal.id}`}
            />
            <div
              {...listeners}
              className="flex-1 cursor-grab active:cursor-grabbing touch-none"
              onClick={(e) => e.stopPropagation()}
              title="Drag to move"
            >
              <div className={`font-medium text-sm ${isDealArchived ? "line-through" : ""}`} data-testid={`text-deal-contact-${deal.id}`}>
                {identity.primary}
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="shrink-0" aria-label="Deal actions" onClick={(e) => e.stopPropagation()} data-testid={`button-deal-actions-${deal.id}`}>
                  <MoreVertical className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onQuickEdit?.(deal);
                  }}
                  data-testid={`menu-quick-edit-deal-${deal.id}`}
                >
                  <Pencil className="w-4 h-4 mr-2" /> Edit Lead
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    const v = getContactVertical(deal.contactId);
                    navigateTo(`/dashboard/chat${v ? `?vertical=${encodeURIComponent(v)}` : ""}`);
                  }}
                  data-testid={`menu-ai-advisor-deal-${deal.id}`}
                >
                  <Bot className="w-4 h-4 mr-2" /> Ask AI Advisor
                </DropdownMenuItem>
                {isDealArchived ? (
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); restoreDealMutation.mutate(deal.id); }}
                    data-testid={`menu-restore-deal-${deal.id}`}
                  >
                    <RotateCcw className="w-4 h-4 mr-2" /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); archiveDealMutation.mutate(deal.id); }}
                    data-testid={`menu-archive-deal-${deal.id}`}
                  >
                    <Archive className="w-4 h-4 mr-2" /> Archive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button variant="outline" className="w-full" aria-label={`Open deal ${deal.id}: ${identity.primary}`} data-testid={`button-open-deal-${deal.id}`}
            onClick={event=>{event.stopPropagation();openDealDetail(deal);}}>
            Open deal
          </Button>
          {isDealArchived && (
            <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-archived-deal-${deal.id}`}>
              <Archive className="w-3 h-3 mr-1" /> Archived
            </Badge>
          )}
          {/* #400 — Submitted stage stale badge (7+ days) */}
          {!isDealArchived && deal.stage === "Submitted" && deal.createdAt && (() => {
            const daysInStage = Math.floor((Date.now() - new Date(deal.createdAt).getTime()) / 86400000);
            return daysInStage >= 7 ? (
              <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate border-orange-300 bg-orange-50 text-orange-700" data-testid={`badge-submitted-stale-${deal.id}`}>
                ⏳ {daysInStage}d
              </Badge>
            ) : null;
          })()}
          {/* #1019 — Profitability tier badge (High/Medium/Low based on volume) */}
          {!isDealArchived && (() => {
            const volStr = String((deal as any).estimatedProcessingVolume ?? "");
            const vol = parseFloat(volStr.replace(/[^0-9.]/g, "")) || 0;
            if (vol <= 0) return null;
            const tier = vol >= 100000 ? { label: "High Value", cls: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" }
              : vol >= 25000 ? { label: "Mid Value", cls: "border-blue-200 bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" }
              : { label: "Small Deal", cls: "border-slate-200 bg-slate-50 text-slate-600 dark:bg-slate-900/30 dark:text-slate-400" };
            return (
              <Badge variant="outline" className={`text-[10px] no-default-hover-elevate no-default-active-elevate ${tier.cls}`} data-testid={`badge-profit-tier-${deal.id}`}>
                {tier.label}
              </Badge>
            );
          })()}
          {/* #966 — Quick Win badge: small volume deal ($0–$50k) in a late stage (Submitted or beyond) */}
          {!isDealArchived && (() => {
            const lateStages = ["Submitted", "Under Review", "Approved", "Go-Live Scheduled"];
            if (!lateStages.includes(deal.stage ?? "")) return null;
            const volStr = String((deal as any).estimatedProcessingVolume ?? "");
            const vol = parseFloat(volStr.replace(/[^0-9.]/g, "")) || 0;
            if (vol <= 0 || vol > 50000) return null;
            return (
              <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate border-green-300 bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300" data-testid={`badge-quick-win-${deal.id}`} title="Quick Win — small deal, late stage">
                ⚡ Quick Win
              </Badge>
            );
          })()}
          {/* #874 — General stage age badge for non-closed stages stuck 14+ days (uses updatedAt as proxy) */}
          {!isDealArchived && deal.stage !== "Submitted" && deal.stage !== "Closed Won" && deal.stage !== "Closed Lost" && deal.updatedAt && (() => {
            const daysStuck = Math.floor((Date.now() - new Date(deal.updatedAt).getTime()) / 86400000);
            if (daysStuck < 14) return null;
            return (
              <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate border-yellow-300 bg-yellow-50 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300" data-testid={`badge-stage-age-${deal.id}`} title={`${daysStuck} days since last update`}>
                🕐 {daysStuck}d stale
              </Badge>
            );
          })()}
          {/* #399 — Future follow-up date when set (not overdue) */}
          {!isDealArchived && deal.nextFollowUp && new Date(deal.nextFollowUp) >= new Date() && (
            <Badge
              variant="outline"
              className="text-xs no-default-hover-elevate no-default-active-elevate border-blue-200 bg-blue-50 text-blue-700"
              data-testid={`badge-followup-${deal.id}`}
              title={`Follow-up: ${new Date(deal.nextFollowUp).toLocaleString()}`}
            >
              <Clock className="w-3 h-3 mr-1" /> {new Date(deal.nextFollowUp).toLocaleDateString()}
            </Badge>
          )}
          {/* #213 — Overdue follow-up indicator */}
          {!isDealArchived && deal.nextFollowUp && new Date(deal.nextFollowUp) < new Date() && (
            <Badge
              variant="outline"
              className="text-xs no-default-hover-elevate no-default-active-elevate border-red-300 bg-red-50 text-red-700"
              data-testid={`badge-overdue-followup-${deal.id}`}
              title={`Follow-up was due ${new Date(deal.nextFollowUp).toLocaleDateString()}`}
            >
              <Clock className="w-3 h-3 mr-1" /> Overdue
            </Badge>
          )}
          {identity.secondary && (
            <div className="text-xs text-muted-foreground" data-testid={`text-deal-company-${deal.id}`}>
              {identity.secondary}
            </div>
          )}
          {/* #565 — Owner chip */}
          {deal.owner && (
            <div className="text-xs text-muted-foreground/70 truncate" data-testid={`text-deal-owner-${deal.id}`}>
              👤 {deal.owner}
            </div>
          )}
          {/* #509 — Vertical badge on deal card */}
          {(deal as any).vertical && (
            <div className="text-xs text-muted-foreground/70" data-testid={`text-deal-vertical-${deal.id}`}>
              🏷 {(deal as any).vertical}
            </div>
          )}
          {/* Post-enrichment Next Action chip — set by the enrichment automation worker */}
          {!isDealArchived && (deal as any).nextAction && (
            <div
              className={`text-[10px] rounded px-2 py-0.5 border font-medium truncate max-w-full ${
                (deal as any).nextAction.startsWith("Manual")
                  ? "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-700"
                  : (deal as any).nextAction.includes("blocked")
                  ? "bg-red-50 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-700"
                  : "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-700"
              }`}
              data-testid={`badge-next-action-${deal.id}`}
              title={(deal as any).nextAction}
            >
              ⚡ {(deal as any).nextAction}
            </div>
          )}
          {/* Lead import source batch — prefer embedded JOIN field, fall back to contacts map */}
          {(() => {
            const src = (deal as any).contactLeadSource || getContactLeadSource(deal.contactId);
            if (!src) return null;
            const label = src === "google_ads" ? "Google Ads"
              : src === "sunbiz" ? "Sunbiz"
              : src === "imported_list" ? "Imported List"
              : src === "referral" ? "Referral"
              : src === "outbound" ? "Outbound"
              : src.replace(/_/g, " ");
            return (
              <div className="text-[10px] text-muted-foreground/60 truncate" data-testid={`text-deal-source-${deal.id}`}>
                📋 {label}
              </div>
            );
          })()}
          {/* #1146 — Company size badge: uses embedded contactEmployeeCount from deal JOIN, fallback to map */}
          {!isDealArchived && (() => {
            const empCount = getContactEmployeeCount(deal.contactId, (deal as any).contactEmployeeCount);
            if (!empCount || empCount <= 0) return null;
            const tier = empCount < 10 ? "< 10"
              : empCount <= 50 ? "10–50"
              : empCount <= 200 ? "51–200"
              : "200+";
            return (
              <Badge
                variant="outline"
                className="text-[10px] no-default-hover-elevate no-default-active-elevate border-slate-200 bg-slate-50 text-slate-600 dark:bg-slate-900/20 dark:border-slate-700 dark:text-slate-400"
                data-testid={`badge-company-size-${deal.id}`}
                title={`${empCount} employees`}
              >
                👥 {tier} emp.
              </Badge>
            );
          })()}
          {/* #477 — High-value merchant badge (>$100K monthly volume) */}
          {Number((deal as any).totalVolume) >= 100000 && (
            <Badge
              variant="outline"
              className="text-[10px] no-default-hover-elevate no-default-active-elevate border-yellow-400 bg-yellow-50 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-600"
              data-testid={`badge-high-value-${deal.id}`}
              title={`Monthly volume $${Number((deal as any).totalVolume).toLocaleString()}`}
            >
              💎 High Value
            </Badge>
          )}
          {/* #562 / #427 — Notes preview with tooltip + "View all" dialog button */}
          {deal.notes && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-xs text-muted-foreground/70 truncate mt-0.5 cursor-help" data-testid={`text-deal-notes-preview-${deal.id}`}>
                    📝 {deal.notes.slice(0, 50)}{deal.notes.length > 50 ? "…" : ""}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs" side="bottom">
                  <p className="text-xs">{deal.notes}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {/* #427 — Full notes expand button (only when notes are long) */}
          {deal.notes && deal.notes.length > 50 && (
            <NotesExpandButton deal={deal} identity={identity} />
          )}
          {/* #606 — Past expected go-live date warning */}
          {(() => {
            const egl = (deal as any).expectedGoLiveDate;
            const bs = (deal as any).boardingStatus;
            if (!egl || bs === "live" || bs === "approved") return null;
            const diffDays = Math.floor((Date.now() - new Date(egl).getTime()) / 86400000);
            if (diffDays <= 0) return null;
            return (
              <Badge
                variant="outline"
                className="text-[10px] no-default-hover-elevate no-default-active-elevate border-red-300 bg-red-50 text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300"
                data-testid={`badge-past-golive-${deal.id}`}
                title={`Expected go-live: ${new Date(egl).toLocaleDateString()} — ${diffDays}d overdue`}
              >
                ⚠️ {diffDays}d past go-live
              </Badge>
            );
          })()}
          {deal.offerPath && (
            <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-offer-${deal.id}`}>
              {deal.offerPath}
            </Badge>
          )}
          {(deal as any).boardingStatus && (deal as any).boardingStatus !== "not_submitted" && (deal as any).boardingStatus !== "not submitted" && (() => {
            const bs = (deal as any).boardingStatus as string;
            const statusMap: Record<string, { label: string; className: string }> = {
              pending_review: { label: "Pending Review", className: "bg-amber-50 text-amber-800 border-amber-300" },
              submitted:  { label: "Boarding Submitted", className: "bg-blue-50 text-blue-800 border-blue-200" },
              under_review: { label: "Under Review", className: "bg-amber-50 text-amber-800 border-amber-200" },
              approved:   { label: "Board Approved", className: "bg-green-50 text-green-800 border-green-200" },
              declined:   { label: "Board Declined", className: "bg-red-50 text-red-800 border-red-200" },
              live:       { label: "Live / Active", className: "bg-emerald-50 text-emerald-800 border-emerald-200" },
            };
            const s = statusMap[bs] ?? { label: bs.replace(/_/g, " "), className: "bg-muted text-muted-foreground" };
            // #394 — Stuck badge: submitted or under_review for 14+ days
            const boardingSubmittedAt = (deal as any).boardingSubmittedAt;
            const stuckDays = boardingSubmittedAt && (bs === "submitted" || bs === "under_review")
              ? Math.floor((Date.now() - new Date(boardingSubmittedAt).getTime()) / 86400000)
              : 0;
            return (
              <>
                <Badge variant="outline" className={`text-xs no-default-hover-elevate no-default-active-elevate ${s.className}`} data-testid={`badge-boarding-${deal.id}`}>
                  {s.label}
                </Badge>
                {stuckDays >= 14 && (
                  <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate bg-yellow-50 text-yellow-800 border-yellow-300" data-testid={`badge-boarding-stuck-${deal.id}`} title={`Submitted ${stuckDays}d ago — may need follow-up`}>
                    ⏳ Stuck {stuckDays}d
                  </Badge>
                )}
              </>
            );
          })()}
          {proposals && proposals.length > 0 ? (() => {
            const accepted = proposals.some(p => p && p.status === "accepted");
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const oneDayAgo   = Date.now() - 24 * 60 * 60 * 1000;
            // Find the most recently viewed proposal within the last 7 days
            const recentlyViewedProposal = proposals
              .filter(p => p && ((p as any).viewCount > 0 || p.status === "viewed") && p.viewedAt && new Date(p.viewedAt).getTime() >= sevenDaysAgo)
              .sort((a, b) => new Date(b.viewedAt!).getTime() - new Date(a.viewedAt!).getTime())[0];
            if (accepted) {
              return (
                <Badge variant="outline" className="text-xs bg-green-100 text-green-800 border-green-200 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-proposal-accepted-${deal.id}`}>
                  Proposal Accepted
                </Badge>
              );
            }
            if (recentlyViewedProposal) {
              const viewedAgo  = formatDistanceToNow(new Date(recentlyViewedProposal.viewedAt!), { addSuffix: true });
              const viewCount  = (recentlyViewedProposal as any).viewCount || 1;
              // Views within the last 24 h get a pulsing engagement-alert badge so reps
              // can act immediately (call / follow-up) while the prospect is still engaged.
              const isAlert    = new Date(recentlyViewedProposal.viewedAt!).getTime() >= oneDayAgo;
              return (
                <Badge
                  variant="outline"
                  className={`text-xs no-default-hover-elevate no-default-active-elevate ${
                    isAlert
                      ? "bg-orange-50 text-orange-700 border-orange-400 animate-pulse"
                      : "bg-amber-50 text-amber-800 border-amber-300"
                  }`}
                  data-testid={isAlert ? `badge-proposal-alert-${deal.id}` : `badge-proposal-viewed-${deal.id}`}
                  title={`Proposal viewed ${viewCount} time${viewCount !== 1 ? "s" : ""} — last opened ${viewedAgo}`}
                >
                  <span className="mr-1">{isAlert ? "🔔" : "👁"}</span>
                  {isAlert ? `Viewed ${viewedAgo}!` : `Viewed ${viewedAgo}`}
                </Badge>
              );
            }
            return null;
          })() : proposalsFailed ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Badge variant="outline" className="text-xs bg-muted text-foreground border-dashed no-default-hover-elevate no-default-active-elevate" data-testid={`badge-proposal-unavailable-${deal.id}`} title="Could not load proposal status for this deal">
                Details unavailable
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Retry loading proposal status"
                disabled={proposalsRetrying}
                data-testid={`button-retry-proposals-${deal.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryProposals?.(deal.id);
                }}
              >
                {proposalsRetrying
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RefreshCw className="h-3 w-3" />}
              </Button>
            </div>
          ) : null}
          {/* deal.proposalStatus fallback badge — only shown when no co-branded proposals
              are loaded for this deal, to avoid conflicting with the live-proposal badge above */}
          {deal.proposalStatus && deal.proposalStatus !== "none" && !proposals?.length && (
            <Badge 
              variant="outline" 
              className={`text-xs no-default-hover-elevate no-default-active-elevate ${
                deal.proposalStatus === "accepted" ? "border-green-500 text-green-700 bg-green-50/50" : 
                deal.proposalStatus === "viewed" ? "border-blue-500 text-blue-700 bg-blue-50/50" :
                deal.proposalStatus === "resent" ? "border-orange-500 text-orange-700 bg-orange-50/50" :
                "border-amber-500 text-amber-700 bg-amber-50/50"
              }`}
              data-testid={`badge-proposal-status-${deal.id}`}
            >
              <FileText className="w-3 h-3 mr-1" />
              {deal.proposalStatus === "resent" ? "Proposal Re-sent" : 
               deal.proposalStatus === "sent" ? (() => {
                 // #303 — show days since proposal was sent
                 const sentAt = (deal as any).proposalEmailSentAt;
                 if (sentAt) {
                   const days = Math.floor((Date.now() - new Date(sentAt).getTime()) / 86400000);
                   return days > 0 ? `Proposal Sent · ${days}d, No Reply` : "Proposal Not Opened";
                 }
                 return "Proposal Not Opened";
               })() :
               `Proposal ${deal.proposalStatus.charAt(0).toUpperCase() + deal.proposalStatus.slice(1)}`}
            </Badge>
          )}
          {deal.mid && <DealMidBadge summary={midSummary} />}
          {confirmationFailed && deal.contactId && (
            <Badge
              variant="destructive"
              className="text-xs gap-1 cursor-pointer no-default-hover-elevate no-default-active-elevate"
              data-testid={`badge-confirmation-failed-deal-${deal.id}`}
              title="Confirmation failed — click to view contact details"
              onClick={(e) => {
                e.stopPropagation();
                navigateTo(`/dashboard/contacts/${deal.contactId}#confirmation-status`);
              }}
            >
              <AlertTriangle className="h-3 w-3" />
              Confirm Failed
            </Badge>
          )}
          {checklistSummary && checklistSummary.total > 0 && (
            <Badge
              variant="outline"
              className="text-xs gap-1 no-default-hover-elevate no-default-active-elevate"
              data-testid={`badge-checklist-${deal.id}`}
              title={`Onboarding checklist: ${checklistSummary.completed} of ${checklistSummary.total} items complete`}
            >
              <ListChecks className="w-3 h-3" />
              {checklistSummary.completed}/{checklistSummary.total} ✓
            </Badge>
          )}
          {/* #249 — Monthly volume estimate when no live MID data */}
          {!deal.mid && (deal as any).totalVolume && (deal as any).totalVolume > 0 && (
            <Badge
              variant="outline"
              className="text-xs no-default-hover-elevate no-default-active-elevate text-blue-700 border-blue-200 bg-blue-50"
              data-testid={`badge-est-volume-${deal.id}`}
              title="Estimated monthly volume"
            >
              {`~$${Number((deal as any).totalVolume).toLocaleString()}/mo est.`}
            </Badge>
          )}
          <div className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`text-deal-date-${deal.id}`}>
            <Calendar className="w-3 h-3 inline-block" />
            {(() => {
              if (!deal.createdAt) return "N/A";
              const d = new Date(deal.createdAt);
              if (isNaN(d.getTime())) return "Unknown date";
              const daysOld = Math.floor((Date.now() - d.getTime()) / 86400000);
              return <>{d.toLocaleDateString()} <span className="text-muted-foreground/60" data-testid={`text-deal-age-${deal.id}`}>({daysOld}d old)</span></>;
            })()}
          </div>
          {/* #376 — Last modified display */}
          {(deal as any).updatedAt && (() => {
            const upd = new Date((deal as any).updatedAt);
            const updDays = Math.floor((Date.now() - upd.getTime()) / 86400000);
            if (updDays < 1) return null; // same-day updates not shown
            return (
              <div className="text-[10px] text-muted-foreground/50" data-testid={`text-deal-updated-${deal.id}`}>
                Updated {updDays}d ago
              </div>
            );
          })()}
          {/* #474 — Quick inline note editor */}
          <QuickNoteEditor deal={deal} />
        </CardContent>
      </Card>
    </div>
  );
}

function DroppableColumn({
  stage,
  colorClass,
  stageDeals,
  selectedDealIds,
  toggleDealSelection,
  openDealDetail,
  archiveDealMutation,
  restoreDealMutation,
  getDealCardIdentity,
  getContactVertical,
  getContactEmployeeCount,
  getContactLeadSource,
  setCreateOpen,
  midSummaries,
  proposalsByDeal,
  proposalsFailedByDeal,
  onRetryProposals,
  proposalsRetryingByDeal,
  confirmationFailedMap,
  onQuickEdit,
}: {
  stage: string;
  colorClass: string;
  stageDeals: Deal[];
  selectedDealIds: Set<number>;
  toggleDealSelection: (id: number) => void;
  openDealDetail: (deal: Deal) => void;
  archiveDealMutation: any;
  restoreDealMutation: any;
  getDealCardIdentity: (deal: { id: number }, contactId: number | null) => { primary: string; secondary: string | null };
  getContactVertical: (id: number | null) => string | null;
  getContactEmployeeCount: (id: number | null, embedded?: number | null) => number | null;
  getContactLeadSource: (id: number | null) => string | null;
  setCreateOpen: (open: boolean) => void;
  midSummaries: Record<string, MidSummary>;
  proposalsByDeal: Record<string, CoBrandedProposal[]>;
  proposalsFailedByDeal?: Record<string, boolean>;
  onRetryProposals?: (dealId: number) => void;
  proposalsRetryingByDeal?: Record<string, boolean>;
  confirmationFailedMap?: Map<number, ConfirmationFailedStatus>;
  onQuickEdit?: (deal: Deal) => void;
}) {
  return (
    <div className="w-[270px] max-w-[300px] flex-shrink-0" data-testid={`stage-column-${stage.replace(/\s+/g, "-").toLowerCase()}`}>{/* #233 — kanban column max-width cap */}
      <div className="bg-primary text-primary-foreground px-3 py-2 rounded-md mb-3 flex items-center justify-between gap-2">
        <span aria-hidden="true" className={`${colorClass} h-2 w-2 rounded-full shrink-0`}/>
        <span className="text-sm font-semibold truncate">{stage}</span>
        <div className="flex items-center gap-1">
          {/* #367 — Stage estimated revenue total · #469 — avg deal value tooltip */}
          {(() => {
            const vols = stageDeals.map(d => Number((d as any).totalVolume) || 0).filter(v => v > 0);
            if (vols.length === 0) return null;
            const totalVol = vols.reduce((s, v) => s + v, 0);
            const avgVol = Math.round(totalVol / vols.length);
            return (
              <span
                className="text-[10px] opacity-80 font-normal"
                data-testid={`text-stage-revenue-${stage.replace(/\s+/g, "-").toLowerCase()}`}
                title={`Total: $${totalVol.toLocaleString()} · Avg: $${avgVol.toLocaleString()}/mo`}
              >
                ~${totalVol.toLocaleString()}
              </span>
            );
          })()}
          <Badge variant="secondary" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-count-${stage.replace(/\s+/g, "-").toLowerCase()}`}>
            {stageDeals.length}
          </Badge>
        </div>
      </div>
      <SortableContext items={stageDeals.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-3 min-h-[200px]" data-droppable-stage={stage}>
          {stageDeals.map((deal) => {
            const isDealArchived = !!(deal as any).archivedAt;
            return (
              <SortableDealCard
                key={deal.id}
                deal={deal}
                isDealArchived={isDealArchived}
                selectedDealIds={selectedDealIds}
                toggleDealSelection={toggleDealSelection}
                openDealDetail={openDealDetail}
                archiveDealMutation={archiveDealMutation}
                restoreDealMutation={restoreDealMutation}
                getDealCardIdentity={getDealCardIdentity}
                getContactVertical={getContactVertical}
                getContactEmployeeCount={getContactEmployeeCount}
                getContactLeadSource={getContactLeadSource}
                midSummary={midSummaries[String(deal.id)]}
                proposals={proposalsByDeal[String(deal.id)]}
                proposalsFailed={proposalsFailedByDeal?.[String(deal.id)]}
                onRetryProposals={onRetryProposals}
                proposalsRetrying={proposalsRetryingByDeal?.[String(deal.id)]}
                confirmationFailed={deal.contactId != null ? confirmationFailedMap?.get(deal.contactId) : undefined}
                onQuickEdit={onQuickEdit}
              />
            );
          })}
          {stageDeals.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-8 gap-2" data-testid={`empty-state-${stage.replace(/\s+/g, "-").toLowerCase()}`}>
              <TrendingUp className="w-6 h-6 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">No deals in this stage</p>
              <Button variant="ghost" size="sm" className="text-xs h-7 px-2" onClick={() => setCreateOpen(true)} data-testid={`button-add-deal-${stage.replace(/\s+/g, "-").toLowerCase()}`}>
                <Plus className="w-3 h-3 mr-1" />
                Add Deal
              </Button>
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// #1281 — Deal competitors section (inline component, uses existing /api/deal-competitors endpoints)
function DealCompetitorsSection({ dealId }: { dealId: number }) {
  const { data: competitors = [], refetch } = useQuery<Array<{ id: number; name: string; notes: string | null }>>({
    queryKey: ["/api/deal-competitors/deal", dealId],
    queryFn: () => fetch(`/api/deal-competitors/deal/${dealId}`).then(r => r.json()),
  });
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const { toast } = useToast();

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      const res = await apiRequest("POST", "/api/deal-competitors", { dealId, name: newName.trim(), notes: "" });
      if (!res.ok) throw new Error("Failed to add");
      setNewName("");
      setAdding(false);
      refetch();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="border-t pt-4" data-testid="deal-competitors-section">
      <p className="text-sm font-medium mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1"><Users className="h-4 w-4" /> Competitors</span>
        <button onClick={() => setAdding(v => !v)} className="text-xs text-primary hover:underline">
          {adding ? "Cancel" : "+ Add"}
        </button>
      </p>
      {adding && (
        <div className="flex gap-2 mb-2">
          <input
            className="flex-1 text-xs border rounded px-2 py-1 bg-background"
            placeholder="Competitor name…"
            value={newName}
            autoFocus
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") { setAdding(false); setNewName(""); } }}
            data-testid="input-new-competitor"
          />
          <Button size="sm" className="h-7 text-xs" onClick={handleAdd}>Add</Button>
        </div>
      )}
      {competitors.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">No competitors tracked yet.</p>
      )}
      <ul className="space-y-1">
        {competitors.map(c => (
          <li key={c.id} className="text-xs flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
            <span className="font-medium">{c.name}</span>
            {c.notes && <span className="text-muted-foreground">— {c.notes}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DealChangeHistory({ dealId }: { dealId: number }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { data: logs, isLoading, isError, refetch } = useQuery<Array<{
    id: number; action: string; beforeState: Record<string, unknown> | null;
    afterState: Record<string, unknown> | null; actorType: string | null;
    actorId: string | null; userId: string | null; createdAt: string;
  }>>({
    queryKey: ["/api/audit-logs/entity", "deal", dealId],
    queryFn: async ({signal}) => {
      const res = await fetch(`/api/audit-logs/entity/deal/${dealId}?limit=50`, { credentials: "include",signal });
      if (!res.ok) throw new Error("Deal change history unavailable");
      const data=await res.json();
      if(!Array.isArray(data))throw new Error("Invalid deal change history response");
      return data;
    },
    enabled: !!dealId,
    staleTime: 30000,
  });

  const HIDDEN = new Set(["updatedAt","createdAt","archivedAt","scoreBreakdown","dealBlueprint","savingsProposal","boardingLog","linkedinEnrichmentLog"]);
  function fmtVal(v: unknown): string {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
    return String(v);
  }
  function getDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
    if (!after) return [];
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
    const changes: Array<{ field: string; from: string; to: string }> = [];
    for (const k of keys) {
      if (HIDDEN.has(k)) continue;
      const a = fmtVal(before?.[k] ?? null), b = fmtVal(after[k] ?? null);
      if (a !== b) changes.push({ field: k.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()), from: a, to: b });
    }
    return changes;
  }

  if (isLoading) return <div className="py-4 text-sm text-muted-foreground">Loading history...</div>;
  if (isError) return <CrmDataState state="unavailable" message="Immutable deal history could not be loaded; this is not an empty history." onRetry={()=>void refetch()}/>;
  if (!logs || logs.length === 0) return <div className="py-4 text-sm text-muted-foreground italic">No change history recorded yet.</div>;

  return (
    <div className="space-y-2 max-h-80 overflow-y-auto pr-1" data-testid="deal-change-history">
      {logs.map((entry) => {
        const isCreate = entry.action.endsWith("_created") || entry.beforeState === null;
        const diff = getDiff(entry.beforeState, entry.afterState);
        const isExpanded = expandedId === entry.id;
        return (
          <div key={entry.id} className="border rounded-md p-3 text-xs space-y-1" data-testid={`deal-history-entry-${entry.id}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-medium">
                {entry.actorType === "ai" ? <Bot className="h-3 w-3 text-purple-500" /> : entry.actorType === "system" ? null : <User className="h-3 w-3" />}
                <span>{entry.action.replace(/_/g, " ").replace(/^./, s => s.toUpperCase())}</span>
              </div>
              <span className="text-muted-foreground shrink-0">
                {new Date(entry.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="text-muted-foreground">
              {entry.actorType === "ai" ? `AI${entry.actorId ? `: ${entry.actorId}` : ""}` : entry.actorType === "system" ? "System" : entry.userId ? `User ${entry.userId.slice(0,8)}` : "Unknown"}
            </div>
            {isCreate && <div className="italic text-muted-foreground">Record created</div>}
            {!isCreate && diff.length > 0 && (
              <>
                <button className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setExpandedId(isExpanded ? null : entry.id)} data-testid={`deal-history-toggle-${entry.id}`}>
                  {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {diff.length} field{diff.length !== 1 ? "s" : ""} changed
                </button>
                {isExpanded && (
                  <div className="rounded border p-2 bg-muted/30 space-y-1" data-testid={`deal-history-diff-${entry.id}`}>
                    {diff.map((d, i) => (
                      <div key={i} className="grid grid-cols-[auto_1fr] gap-x-2">
                        <span className="font-medium text-muted-foreground whitespace-nowrap">{d.field}:</span>
                        <span className="break-all">
                          {d.from !== "—" && <span className="line-through text-red-500 mr-1">{d.from}</span>}
                          <span className="text-green-700 dark:text-green-400">{d.to}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Pipeline() {
  useAuth();
  return <PipelineWorkspace key={protectedContextToken()} />;
}

function PipelineWorkspace() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isManagerOrAdmin = user?.role === "admin" || user?.role === "manager";
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const selectedDealRef = useRef(selectedDeal);
  selectedDealRef.current = selectedDeal;
  const [quickEditDeal, setQuickEditDeal] = useState<Deal | null>(null);
  // #1445 — Underwriting checklist tasks for the currently open deal
  const { data: uwTasks = [], isError: uwTasksError, isLoading: uwTasksLoading, refetch: refetchUwTasks } = useQuery<any[]>({
    queryKey: ["/api/deals", selectedDeal?.id, "underwriting-tasks"],
    queryFn: async ({ signal }) => {
      if (!selectedDeal?.id) return [];
      const res = await fetch(`/api/deals/${selectedDeal.id}/underwriting-tasks`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Underwriting work unavailable");
      const tasks: unknown = await res.json();
      if (!Array.isArray(tasks)) throw new Error("Invalid underwriting work response");
      return tasks;
    },
    enabled: !!selectedDeal?.id && !!selectedDeal?.stage?.toLowerCase().includes("underwriting"),
    staleTime: 0,
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const search = useSearch();
  const [, navigatePipeline] = useLocation();
  const selectedRecord=useAuthorizedSelectedRecord<Deal>("/api/deals",search);
  const dealIdParam=selectedRecord.id;
  const [configOpen, setConfigOpen] = useState(false);
  const [configPipeline, setConfigPipeline] = useState("sales");
  const [addStageName, setAddStageName] = useState("");
  const [addStageColor, setAddStageColor] = useState("#6366f1");
  const [editingStage, setEditingStage] = useState<PipelineStage | null>(null);
  const [editStageName, setEditStageName] = useState("");
  const [editStageColor, setEditStageColor] = useState("");
  const [deleteConfirmStage, setDeleteConfirmStage] = useState<PipelineStage | null>(null);

  const [newDeal, setNewDeal] = useState({
    contactId: "",
    pipeline: "sales",
    stage: "New Lead",
    offerPath: "",
    notes: "",
    vertical: "",
  });

  // Terminal economics state
  const [terminalEcon, setTerminalEcon] = useState<{
    available: boolean;
    terminalModel?: string;
    terminalCost?: number;
    msrp?: number;
    estimatedMonthlyGrossProfit?: number;
    paybackMonths?: number | null;
    tier?: "green" | "yellow" | "red";
    greenThreshold?: number;
    yellowThreshold?: number;
    leaseComparison?: { competitorMonthlyLease: number; savingsVsLease3Year: number };
  } | null>(null);
  const [terminalEconLoading, setTerminalEconLoading] = useState(false);
  const [approvalActionPending, setApprovalActionPending] = useState(false);
  const [approvalReason, setApprovalReason] = useState("");

  const loadTerminalEconomics = async (dealId: number) => {
    setTerminalEconLoading(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/terminal-economics`, { credentials: "include" });
      if (res.ok) setTerminalEcon(await res.json());
      else setTerminalEcon(null);
    } catch { setTerminalEcon(null); }
    finally { setTerminalEconLoading(false); }
  };

  const handleTerminalApprove = async () => {
    if (!selectedDeal) return;
    setApprovalActionPending(true);
    try {
      const res = await apiRequest("POST", `/api/deals/${selectedDeal.id}/terminal-economics/approve`, {});
      if (res.ok) {
        toast({ title: "Terminal approved" });
        queryClient.invalidateQueries({ queryKey: ["/api/deals", { pipeline: "sales" }] });
        loadTerminalEconomics(selectedDeal.id);
      } else {
        const data = await res.json();
        toast({ title: data.message || "Approval failed", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    finally { setApprovalActionPending(false); }
  };

  const handleTerminalReject = async () => {
    if (!selectedDeal) return;
    setApprovalActionPending(true);
    try {
      const res = await apiRequest("POST", `/api/deals/${selectedDeal.id}/terminal-economics/reject`, { reason: approvalReason });
      if (res.ok) {
        toast({ title: "Terminal rejected" });
        queryClient.invalidateQueries({ queryKey: ["/api/deals", { pipeline: "sales" }] });
        loadTerminalEconomics(selectedDeal.id);
        setApprovalReason("");
      } else {
        const data = await res.json();
        toast({ title: data.message || "Rejection failed", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    finally { setApprovalActionPending(false); }
  };

  const handleCheckTerminalApproval = async (dealId: number) => {
    try {
      const res = await apiRequest("POST", `/api/deals/${dealId}/terminal-economics/check-approval`, {});
      if (res.ok) {
        const data = await res.json();
        if (data.approvalRequired && data.approvalStatus === "pending_approval") {
          toast({ title: "Manager approval required", description: "This terminal has a long payback period. An approval task has been created.", variant: "destructive" });
          queryClient.invalidateQueries({ queryKey: ["/api/deals", { pipeline: "sales" }] });
          loadTerminalEconomics(dealId);
        }
      }
    } catch (err) { console.error("[Pipeline] checkTerminalApproval error:", err); }
  };

  // Co-branded proposal state
  const [generatingProposal, setGeneratingProposal] = useState(false);
  const [dealProposals, setDealProposals] = useState<Array<{
    id: number; merchantName: string; status: string; viewCount: number;
    acceptedAt: string | null; deliveredAt: string | null; token: string; viewerUrl: string;
  }>>([]);
  const [dealProposalsLoading, setDealProposalsLoading] = useState(false);
  const [dealProposalsFailed, setDealProposalsFailed] = useState(false);
  const [proposalPlan, setProposalPlan] = useState("interchangePlus");

  // Cache for deal proposals to show badges on cards
  const [proposalsByDeal, setProposalsByDeal] = useState<Record<string, CoBrandedProposal[]>>({});
  const [proposalsFailedByDeal, setProposalsFailedByDeal] = useState<Record<string, boolean>>({});
  const [proposalsRetryingByDeal, setProposalsRetryingByDeal] = useState<Record<string, boolean>>({});

  const [selectedDealIds, setSelectedDealIds] = useState<Set<number>>(new Set());
  const [bulkStageResults, setBulkStageResults] = useState<BulkStageResult[] | null>(null);
  const [bulkUnresolvedIds, setBulkUnresolvedIds] = useState<Set<number>>(new Set());
  const hasUncertainStageSelection = Array.from(selectedDealIds).some(id => bulkUnresolvedIds.has(id));
  // #191 — Initialise filters from URL so bookmarks and back-nav work
  const _initParams = new URLSearchParams(search);
  const [showArchived, setShowArchivedRaw] = useState(() => _initParams.get("archived") === "true");
  const [sortMode, setSortModeRaw] = useState<"default" | "volume_desc" | "trending_down" | "no_activity" | "past_golive" | "urgency">(
    () => (["default", "volume_desc", "trending_down", "no_activity", "urgency", "past_golive"].includes(_initParams.get("sort") ?? "")
      ? _initParams.get("sort") as any : "default")
  );
  const [groupFilterContactId, setGroupFilterContactIdRaw] = useState<number | null>(() => {
    const v = _initParams.get("group");
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  });

  // Sync filter state to URL
  const syncFiltersToUrl = (overrides: { archived?: boolean; sort?: string; group?: number | null }) => {
    const params = new URLSearchParams(search);
    const a = overrides.archived ?? showArchived;
    const s = overrides.sort ?? sortMode;
    const g = overrides.group !== undefined ? overrides.group : groupFilterContactId;
    if (a) params.set("archived", "true"); else params.delete("archived");
    if (s && s !== "default") params.set("sort", s); else params.delete("sort");
    if (g) params.set("group", String(g)); else params.delete("group");
    navigatePipeline(`/dashboard/pipeline?${params.toString()}`, { replace: true });
  };

  const setShowArchived = (v: boolean) => { setShowArchivedRaw(v); syncFiltersToUrl({ archived: v }); };
  const setSortMode = (v: "default" | "volume_desc" | "trending_down" | "no_activity" | "urgency" | "past_golive") => { setSortModeRaw(v); syncFiltersToUrl({ sort: v }); };
  const setGroupFilterContactId = (v: number | null) => { setGroupFilterContactIdRaw(v); syncFiltersToUrl({ group: v }); };

  const [editStage, setEditStage] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editFollowUp, setEditFollowUp] = useState("");
  const [editExpectedGoLiveDate, setEditExpectedGoLiveDate] = useState(""); // #393
  const [editAgentId, setEditAgentId] = useState<string>("none");
  const [editMid, setEditMid] = useState("");
  const [editVertical, setEditVertical] = useState("");
  // #537 — Won/lost reason prompt
  const [closeReasonOpen, setCloseReasonOpen] = useState(false);
  const [closeReasonDraft, setCloseReasonDraft] = useState("");
  // #361 — Pipeline board vertical filter
  const [verticalFilter, setVerticalFilter] = useState("");
  // #405 — Pipeline board offer path filter
  const [offerPathFilter, setOfferPathFilter] = useState("");
  // #480 — Hide empty stages toggle
  const [hideEmptyStages, setHideEmptyStages] = useState(false);
  // #475 — No follow-up filter
  const [showNoFollowUpOnly, setShowNoFollowUpOnly] = useState(false);
  // #623 — Unassigned deals (no owner) filter
  const [showUnassignedOnly, setShowUnassignedOnly] = useState(false);
  // #739 — Filter by assigned rep
  const [repEmailFilter, setRepEmailFilter] = useState("");
  // #450 — Kanban / list view toggle
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  // #450 — List sort
  const [listSortField, setListSortField] = useState<"stage" | "volume" | "updatedAt" | "owner">("updatedAt");
  const [repPeriod, setRepPeriod] = useState<30 | 60 | 90>(30); // #1443 — period toggle for rep summary bar
  // #427 — Notes dialog handled inside NotesExpandButton (self-contained)

  const fetchSingleDealProposals = useCallback(async (dealId: number): Promise<CoBrandedProposal[] | null> => {
    const context=protectedContextToken();
    try {
      const pRes = await fetch(`/api/deals/${dealId}/co-branded-proposals`, { credentials: "include",signal:AbortSignal.timeout(10000) });
      if (pRes.ok) {
        const data: CoBrandedProposal[] = await pRes.json();
        if(context!==protectedContextToken()) return null;
        setProposalsByDeal(prev => ({ ...prev, [String(dealId)]: data }));
        setProposalsFailedByDeal(prev => { const next = { ...prev }; delete next[String(dealId)]; return next; });
        return data;
      } else {
        if(context!==protectedContextToken()) return null;
        // Clear stale cached proposals so the failure badge always takes precedence over old data
        setProposalsByDeal(prev => { const next = { ...prev }; delete next[String(dealId)]; return next; });
        setProposalsFailedByDeal(prev => ({ ...prev, [String(dealId)]: true }));
        return null;
      }
    } catch (err) {
      if(context!==protectedContextToken()) return null;
      console.error(`Error fetching proposals for deal ${dealId}:`, err);
      // Clear stale cached proposals so the failure badge always takes precedence over old data
      setProposalsByDeal(prev => { const next = { ...prev }; delete next[String(dealId)]; return next; });
      setProposalsFailedByDeal(prev => ({ ...prev, [String(dealId)]: true }));
      return null;
    }
  }, []);

  const retryDealProposals = useCallback(async (dealId: number) => {
    const context=protectedContextToken();
    setProposalsRetryingByDeal(prev => ({ ...prev, [String(dealId)]: true }));
    await fetchSingleDealProposals(dealId);
    if(context!==protectedContextToken()) return;
    setProposalsRetryingByDeal(prev => { const next = { ...prev }; delete next[String(dealId)]; return next; });
  }, [fetchSingleDealProposals]);

  const dealScopeFilters={pipeline:"sales",includeArchived:String(showArchived),
    noFollowUp:String(showNoFollowUpOnly),unassigned:String(showUnassignedOnly),pastGoLive:String(sortMode==="past_golive"),
    ...(repEmailFilter?{assignedTo:repEmailFilter}:{}),...(verticalFilter?{vertical:verticalFilter}:{}),
    ...(offerPathFilter?{offerPath:offerPathFilter}:{}),...(groupFilterContactId?{groupContactId:String(groupFilterContactId)}:{})};
  const dealPagesQueryKey = ["/api/deals", dealScopeFilters] as const;
  type DealPage = { data: Deal[]; total: number; stageDistribution:Record<string,number> };
  const { data: dealPages, isLoading: firstPageLoading, isFetchingNextPage, isFetchNextPageError, hasNextPage, fetchNextPage, isError: dealsError, refetch: refetchDeals } = useCrmInfiniteQuery<
    DealPage,
    Error,
    InfiniteData<DealPage, number>,
    typeof dealPagesQueryKey,
    number
  >({
    queryKey: dealPagesQueryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const params=new URLSearchParams({limit:"250",offset:String(pageParam)});
      for(const [key,value] of Object.entries(dealScopeFilters))if(value!==undefined)params.set(key,value);
      const res = await fetch(`/api/deals?${params}`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Failed to fetch deals");
      const result = await res.json();
      if(!result || !Array.isArray(result.data) || !Number.isInteger(result.total) || result.total<0 ||
        !result.stageDistribution || typeof result.stageDistribution!=="object" || Array.isArray(result.stageDistribution) ||
        Object.values(result.stageDistribution).some(value=>!Number.isInteger(value)||Number(value)<0) ||
        result.data.some((deal:Deal)=>!Number.isInteger(deal.id)||typeof deal.stage!=="string"))
        throw new Error("Malformed Pipeline page/count response; no empty state is assumed.");
      return result;
    },
    getNextPageParam: (lastPage, pages) => {
      const offset = pages.reduce((total, page) => total + page.data.length, 0);
      return offset < lastPage.total ? offset : undefined;
    },
  });
  const allDealPages = dealPages?.pages ?? [];
  const dealsResult = allDealPages.length ? {
    data: allDealPages.flatMap(page => page.data),
    total: allDealPages[allDealPages.length - 1].total,
    stageDistribution:allDealPages[allDealPages.length-1].stageDistribution,
  } : undefined;
  const dealsLoading = firstPageLoading || isFetchingNextPage;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, allDealPages.length]);
  const deals = dealsResult?.data;
  const hasCompleteDealSnapshot = Boolean(deals && dealsResult?.total === deals.length);
  const { data: pipelineMetrics } = useQuery<{
    sales: { total: number; stageDistribution: Record<string, number>; wonLast30Days: number };
  }>({
    enabled:user?.role==="admin"||user?.role==="manager",
    queryKey: ["/api/analytics/pipeline"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/pipeline", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch pipeline metrics");
      return res.json();
    },
  });

  // Collect unique non-null contactIds from all loaded deals for the batch hook
  const dealContactIds = useMemo(
    () => (deals ?? []).map((d: Deal) => d.contactId).filter((id): id is number => id != null),
    [deals],
  );
  const { failedMap: confirmationFailedMap } = useConfirmationFailedBatch(dealContactIds);

  // Linked facts are supplied by the authorized deal reader. Picker search has
  // its own scoped/paged read; page one is never a linked-contact inventory.
  const contacts=useMemo(()=>[...new Map((deals??[]).filter(deal=>deal.contactId!=null).map(deal=>{
    const facts=deal as Deal&{contactName?:string;contactVertical?:string;contactEmployeeCount?:number;contactLeadSource?:string};
    return [deal.contactId,{id:deal.contactId,firstName:facts.contactName??"",lastName:"",
      vertical:facts.contactVertical,employeeCount:facts.contactEmployeeCount,leadSource:facts.contactLeadSource} as Contact] as const;
  })).values()],[deals]);

  const { data: midSummaryData, isError: midSummaryError, refetch: refetchMidSummaries } = useQuery<{ summaries: Record<string, MidSummary>; days: number }>({
    queryKey: ["/api/mid-stats/pipeline-summary"],
    queryFn: async () => {
      const res = await fetch("/api/mid-stats/pipeline-summary?days=30", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch MID summaries");
      const result=await res.json();
      if(!result||!result.summaries||typeof result.summaries!=="object"||Array.isArray(result.summaries))
        throw new Error("Processing summaries are unavailable");
      return result;
    },
    staleTime: 5 * 60 * 1000,
  });
  const midSummaries = midSummaryData?.summaries || {};

  // Parent accounts available in the filter dropdown
  const [newDealContactChoice,setNewDealContactChoice]=useState<ContactChoice|null>(null);
  const [groupPickerOpen,setGroupPickerOpen]=useState(false);

  const { data: pipelineStages } = useQuery<PipelineStage[]>({
    queryKey: ["/api/pipeline-stages", configPipeline],
    queryFn: async () => {
      const res = await fetch(`/api/pipeline-stages?pipeline=${configPipeline}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch pipeline stages");
      return res.json();
    },
  });

  const { data: agentsList, isError: agentsError, refetch: refetchAgents } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
    queryFn: async ({signal}) => {
      const res = await fetch("/api/agents", { credentials: "include",signal });
      if (!res.ok) throw new Error("Rep choices unavailable");
      const data=await res.json();
      if(!Array.isArray(data))throw new Error("Invalid rep choices response");
      return data;
    },
    enabled: isManagerOrAdmin,
  });

  const { data: dealAssignment, refetch: refetchDealAssignment } = useQuery<AgentMerchant | null>({
    queryKey: ["/api/agent-merchants/deal", selectedDeal?.id],
    queryFn: async () => {
      if (!selectedDeal) return null;
      const res = await fetch(`/api/agent-merchants/deal/${selectedDeal.id}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: isManagerOrAdmin && !!selectedDeal,
  });

  const assignAgentMutation = useMutation({
    mutationFn: async ({ dealId, agentId }: { dealId: number; agentId: number | null }) => {
      const res = await apiRequest("PUT", `/api/agent-merchants/deal/${dealId}/assign`, { agentId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent-merchants/deal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/my-day"] });
      toast({ title: "Agent assignment updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update agent assignment", description: err.message, variant: "destructive" });
    },
  });

  const createStageMutation = useMutation({
    mutationFn: async (data: { pipeline: string; stageName: string; color: string; sortOrder: number }) => {
      const res = await apiRequest("POST", "/api/pipeline-stages", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline-stages"] });
      setAddStageName("");
      setAddStageColor("#6366f1");
      toast({ title: "Stage created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create stage", description: err.message, variant: "destructive" });
    },
  });

  const updateStageMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; stageName?: string; color?: string }) => {
      const res = await apiRequest("PUT", `/api/pipeline-stages/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline-stages"] });
      setEditingStage(null);
      toast({ title: "Stage updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update stage", description: err.message, variant: "destructive" });
    },
  });

  const deleteStageMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/pipeline-stages/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline-stages"] });
      setDeleteConfirmStage(null);
      toast({ title: "Stage deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete stage", description: err.message, variant: "destructive" });
    },
  });

  const reorderStagesMutation = useMutation({
    mutationFn: async (stages: { id: number; sortOrder: number }[]) => {
      const res = await apiRequest("POST", "/api/pipeline-stages/reorder", { stages });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline-stages"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to reorder stages", description: err.message, variant: "destructive" });
    },
  });

  const archiveDealMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/deals/${id}/archive`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Deal archived" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to archive deal", description: err.message, variant: "destructive" });
    },
  });

  const restoreDealMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/deals/${id}/restore`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Deal restored" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to restore deal", description: err.message, variant: "destructive" });
    },
  });

  const sortedStages = (pipelineStages || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  // Presentation only: retain every actual recorded stage without inventing a
  // transition registry or silently dropping a legal legacy deal from both views.
  const displayStages = [...new Set<string>([
    ...SALES_STAGES, ...Object.keys(dealsResult?.stageDistribution ?? {}),
    ...(deals ?? []).map(deal=>deal.stage).filter((stage):stage is string=>typeof stage==="string"&&stage.length>0),
  ])];
  const hasLoadedSignalFilter=sortMode==="trending_down"||sortMode==="no_activity";

  const handleDragStart = (event: DragStartEvent) => {
    const deal = deals?.find((d) => d.id === event.active.id);
    setActiveDeal(deal || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDeal(null);
    const { active, over } = event;
    if (!over) return;

    const activeDealId = active.id as number;
    const overStage = (over.data.current as any)?.stage || (over.data.current as any)?.sortable?.containerId;

    let newStage: string | null = null;

    if (typeof over.id === "string" && (SALES_STAGES as readonly string[]).includes(over.id)) {
      newStage = over.id;
    } else {
      const overDeal = deals?.find((d) => d.id === over.id);
      if (overDeal) {
        newStage = overDeal.stage;
      } else if (overStage && SALES_STAGES.includes(overStage)) {
        newStage = overStage;
      }
    }

    if (!newStage) return;

    const activeDealObj = deals?.find((d) => d.id === activeDealId);
    if (!activeDealObj || activeDealObj.stage === newStage) return;

    updateDealMutation.mutate({ id: activeDealId, stage: newStage, expectedStage: activeDealObj.stage });
  };

  const getDealsInStage = (stageName: string) => {
    return (deals || []).filter((d) => d.stage === stageName).length;
  };

  const handleAddStage = () => {
    if (!addStageName.trim()) return;
    const maxOrder = sortedStages.length > 0 ? Math.max(...sortedStages.map((s) => s.sortOrder)) : -1;
    createStageMutation.mutate({
      pipeline: configPipeline,
      stageName: addStageName.trim(),
      color: addStageColor,
      sortOrder: maxOrder + 1,
    });
  };

  const handleMoveStage = (stage: PipelineStage, direction: "up" | "down") => {
    const idx = sortedStages.findIndex((s) => s.id === stage.id);
    if (direction === "up" && idx <= 0) return;
    if (direction === "down" && idx >= sortedStages.length - 1) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    const reordered = sortedStages.map((s, i) => {
      if (i === idx) return { id: s.id, sortOrder: swapIdx };
      if (i === swapIdx) return { id: s.id, sortOrder: idx };
      return { id: s.id, sortOrder: i };
    });
    reorderStagesMutation.mutate(reordered);
  };

  const handleSaveEditStage = () => {
    if (!editingStage || !editStageName.trim()) return;
    updateStageMutation.mutate({
      id: editingStage.id,
      stageName: editStageName.trim(),
      color: editStageColor,
    });
  };

  const createDealMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", "/api/deals", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      setCreateOpen(false);
      setNewDeal({ contactId: "", pipeline: "sales", stage: "New Lead", offerPath: "", notes: "", vertical: "" });
      toast({ title: "Deal created successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create deal", description: err.message, variant: "destructive" });
    },
  });

  const updateDealMutation = useMutation({
    onMutate: async variables => {
      const context = protectedContextToken();
      const scopedKey = [...dealPagesQueryKey, protectedScope(user)];
      await queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      if (context !== protectedContextToken()) throw new Error("Workspace changed; review the deal before saving.");
      const previous = queryClient.getQueryData<InfiniteData<DealPage, number>>(scopedKey);
      const previousDeal = previous?.pages.flatMap(page => page.data).find(deal => deal.id === variables.id);
      if (typeof variables.stage === "string") {
        try {
          if(typeof variables.expectedStage!=="string")throw new DealTransitionObservationError("Displayed source stage unavailable; no move was sent.");
          const observed=await (await apiRequest("GET",`/api/deals/${variables.id}/transition-options`)).json();
          requireDealTransitionObservation(observed,variables.id,variables.expectedStage,variables.stage);
          if(context!==protectedContextToken())throw new DealTransitionObservationError("Workspace changed; review the deal before moving it.");
        } catch(error) {
          throw new DealTransitionObservationError(error instanceof DealTransitionObservationError?error.message:
            "Structural transition read unavailable; no move was sent.",context);
        }
        queryClient.setQueryData<InfiniteData<DealPage, number>>(scopedKey, old => old ? ({
          ...old, pages: old.pages.map(page => ({
            ...page, data: page.data.map(deal => deal.id === variables.id
              ? { ...deal, stage: variables.stage as string } : deal),
          })),
        }) : old);
      }
      return { context, scopedKey, previousDeal };
    },
    mutationFn: async ({ id, ...data }: { id: number; expectedStage?: string } & Record<string, unknown>) => {
      const res = await apiRequest("PUT", `/api/deals/${id}`, data);
      return res.json();
    },
    onSuccess: (_data, variables, context) => {
      if (context?.context !== protectedContextToken()) return;
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      if (selectedDealRef.current?.id === variables.id) {
        setDetailOpen(false);
        setSelectedDeal(current => current?.id === variables.id ? null : current);
      }
      toast({ title: "Deal updated successfully" });
    },
    onError: async (err: Error, variables, context) => {
      if(err instanceof DealTransitionObservationError){
        if(err.scope===protectedContextToken())toast({title:"Move not sent",description:err.message,variant:"destructive"});
        return;
      }
      if (context?.context !== protectedContextToken()) return;
      if (context.previousDeal) {
        queryClient.setQueryData<InfiniteData<DealPage, number>>(context.scopedKey, old => old ? ({
          ...old, pages: old.pages.map(page => ({
            ...page, data: page.data.map(deal => deal.id === variables.id ? context.previousDeal! : deal),
          })),
        }) : old);
      }
      let readbackNote = "";
      if (typeof variables.stage === "string") {
        try {
          const response = await apiRequest("GET", `/api/deals/${variables.id}`);
          const authoritativeDeal = await response.json() as Deal;
          if (context.context !== protectedContextToken()) return;
          queryClient.setQueryData<InfiniteData<DealPage, number>>(context.scopedKey, old => old ? ({
            ...old,
            pages: old.pages.map(page => ({
              ...page,
              data: page.data.map(deal => deal.id === authoritativeDeal.id ? authoritativeDeal : deal),
            })),
          }) : old);
          setSelectedDeal(current => current?.id === authoritativeDeal.id ? authoritativeDeal : current);
          if (selectedDealRef.current?.id === authoritativeDeal.id) setEditStage(authoritativeDeal.stage);
          readbackNote = ` Server read-back confirms the current stage is “${authoritativeDeal.stage}”.`;
        } catch {
          readbackNote = " Server read-back was unavailable; the board is being refreshed before another move.";
        }
      }
      if (context.context !== protectedContextToken()) return;
      void queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Deal update not confirmed", description: `${err.message} The board is being refreshed to restore the saved state.${readbackNote}`, variant: "destructive" });
    },
  });

  const autoProgressMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai/auto-progress-deals");
      return res.json();
    },
    onSuccess: (data: { progressed: number; progressions: Array<{ dealId: number; from: string; to: string; reason: string }> }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      if (data.progressed === 0) {
        toast({ title: "No deals to advance", description: "All deals are at the correct stage based on their data." });
      } else {
        toast({ title: `AI advanced ${data.progressed} deal${data.progressed > 1 ? "s" : ""}`, description: data.progressions.map(p => `Deal #${p.dealId}: ${p.from} → ${p.to}`).join(", ") });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Auto-progression failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkStageMutation = useMutation({
    onMutate:()=>({context:protectedContextToken()}),
    mutationFn: async ({ dealIds, stage }: { dealIds: number[]; stage: string }) => {
      const expectedStages=Object.fromEntries(dealIds.map(id=>{
        const displayed=deals?.find(deal=>deal.id===id);
        if(!displayed)throw new Error("A selected deal has no displayed stage. Read back the board before moving it.");
        return [id,displayed.stage];
      }));
      const res = await apiRequest("POST", "/api/deals/bulk-stage", { dealIds, stage,expectedStages });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to move deals");
      }
      return res.json() as Promise<BulkStageResponse>;
    },
    onSuccess: (result,_variables,context) => {
      if(context?.context!==protectedContextToken())return;
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      const confirmedIds = new Set(result.confirmedDealIds ?? []);
      const unresolvedIds = new Set(result.unresolvedDealIds ?? result.results
        .filter(row => row.outcome === "unknown" || row.outcome === "unattempted")
        .map(row => row.id));
      setSelectedDealIds(current => new Set([...current].filter(id => !confirmedIds.has(id))));
      setBulkUnresolvedIds(previous => new Set([...previous, ...unresolvedIds]));
      setBulkStageResults(previous => {
        const byDealId = new Map((previous ?? []).map(row => [row.id, row]));
        (result.results ?? []).forEach(row => byDealId.set(row.id, row));
        return Array.from(byDealId.values());
      });
      const unknownCount = result.results.filter(row => row.outcome === "unknown").length;
      const unattemptedCount = result.results.filter(row => row.outcome === "unattempted").length;
      const blockedCount = result.results.filter(row => row.outcome === "blocked").length;
      const confirmedCount = confirmedIds.size;
      toast({
        title: unknownCount || unattemptedCount
          ? `${confirmedCount} confirmed · batch stopped for reconciliation`
          : `${confirmedCount} confirmed · ${blockedCount} blocked`,
        description: `${confirmedCount} confirmed deal${confirmedCount === 1 ? "" : "s"} removed from selection. Blocked, unknown, and unattempted deals remain selected with their server reasons.`,
        variant: unknownCount || unattemptedCount || blockedCount ? "destructive" : "default",
      });
    },
    onError: (err: Error,variables,context) => {
      if(context?.context!==protectedContextToken())return;
      // Middleware denies these requests before any per-record dispatch.
      // Keep the selection, but do not invent an unknown partial outcome.
      if(/^(401|403):/.test(err.message)){
        toast({title:"Stage move denied",description:`${err.message} No stage movement was authorized. Selection retained.`,variant:"destructive"});
        return;
      }
      setBulkUnresolvedIds(previous=>new Set([...previous,...variables.dealIds]));
      void queryClient.invalidateQueries({queryKey:["/api/deals"]});
      toast({ title: "Move outcome unconfirmed", description: `${err.message} Selection retained. Read back before retrying; do not replay the uncertain batch.`, variant: "destructive" });
    },
  });

  const bulkArchiveMutation = useMutation({
    mutationFn: async (dealIds: number[]) => {
      const results = await Promise.all(
        dealIds.map((id) => apiRequest("POST", `/api/deals/${id}/archive`))
      );
      return results;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      setSelectedDealIds(new Set());
      toast({ title: "Deals archived successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to archive deals", description: err.message, variant: "destructive" });
    },
  });

  const toggleDealSelection = (dealId: number) => {
    setSelectedDealIds((prev) => {
      const next = new Set(prev);
      if (next.has(dealId)) {
        next.delete(dealId);
      } else {
        next.add(dealId);
      }
      return next;
    });
  };

  const toggleAllDeals = () => {
    if (!deals) return;
    if (selectedDealIds.size === deals.length) {
      setSelectedDealIds(new Set());
    } else {
      setSelectedDealIds(new Set(deals.map((d) => d.id)));
    }
  };

  const reconcileUnresolvedBulkMoves = async () => {
    const refreshed = await refetchDeals();
    const pages = refreshed.data?.pages ?? [];
    const latestPage = pages[pages.length - 1];
    const currentDeals = pages.flatMap(page => page.data);
    if (refreshed.isError || !latestPage || latestPage.total !== currentDeals.length) {
      toast({
        title: "Stage reconciliation incomplete",
        description: "The deal list is not a complete read-back. Unknown and unattempted deals remain selected and cannot be moved again yet.",
        variant: "destructive",
      });
      return;
    }
    const stageById = new Map(currentDeals.map(deal => [deal.id, deal.stage]));
    setBulkStageResults(previous => previous?.map(row =>
      bulkUnresolvedIds.has(row.id) && stageById.has(row.id)
        ? { ...row, currentStage: stageById.get(row.id) }
        : row,
    ) ?? null);
    setBulkUnresolvedIds(new Set());
    toast({ title: "Current stages read back", description: "Review the reported stages and reasons before choosing another move." });
  };

  const contactsMap = new Map<number, Contact>();
  contacts?.forEach((c) => contactsMap.set(c.id, c));

  const getDealCardIdentity = (
    deal: { id: number },
    contactId: number | null
  ): { primary: string; secondary: string | null } => {
    const contact = contactId ? contactsMap.get(contactId) : undefined;
    return dealCardIdentityFn(deal, contact);
  };

  const getContactVertical = (contactId: number | null): string | null => {
    if (!contactId) return null;
    const contact = contactsMap.get(contactId);
    return contact?.vertical || null;
  };

  // #1146 — Employee count: read from deal's embedded contactEmployeeCount (included by server JOIN)
  // Fallback to contactsMap for any deals not covered by the join result
  const getContactEmployeeCount = (contactId: number | null, dealEmployeeCount?: number | null): number | null => {
    if (dealEmployeeCount != null) return Number(dealEmployeeCount) || null;
    if (!contactId) return null;
    const contact = contactsMap.get(contactId);
    const ec = (contact as any)?.employeeCount;
    return ec != null ? Number(ec) || null : null;
  };

  // Lead source / import batch from the contact record
  const getContactLeadSource = (contactId: number | null): string | null => {
    if (!contactId) return null;
    const contact = contactsMap.get(contactId);
    return (contact as any)?.leadSource || null;
  };

  const handleCreateDeal = () => {
    if (!newDeal.stage) {
      toast({ title: "Stage required", description: "Select a pipeline stage before creating the deal.", variant: "destructive" });
      return;
    }
    const payload: Record<string, unknown> = {
      pipeline: newDeal.pipeline,
      stage: newDeal.stage,
      notes: newDeal.notes || undefined,
      offerPath: newDeal.offerPath || undefined,
      vertical: newDeal.vertical || undefined,
    };
    if (newDeal.contactId) {
      payload.contactId = Number(newDeal.contactId);
    }
    createDealMutation.mutate(payload);
  };

  // #537 — Won/lost reason dialog handler
  const submitDealUpdateWithReason = async (reason?: string) => {
    if (!selectedDeal) return;
    const updates: Record<string, unknown> = {};
    if (editStage && editStage !== selectedDeal.stage) updates.stage = editStage;
    if (editNotes !== (selectedDeal.notes || "")) updates.notes = editNotes;
    else if (reason) updates.notes = reason; // embed reason in notes when no other note change
    if (editFollowUp) updates.nextFollowUp = new Date(editFollowUp).toISOString();
    if (editExpectedGoLiveDate) (updates as any).expectedGoLiveDate = new Date(editExpectedGoLiveDate).toISOString(); // #393
    // REV-05A: MID changes must go through the canonical service (PUT /api/admin/merchants/:id/mid),
    // not the generic deal PUT. Handled separately below.
    if (editVertical !== (selectedDeal.vertical || "")) updates.vertical = editVertical || null;
    if (reason && !updates.notes) updates.closeReason = reason;

    const midChanged = editMid.trim() !== (selectedDeal.mid || "").trim();

    // REV-05A: If MID changed, call canonical endpoint.
    // Clearing (empty input) shows a message — full revoke requires an admin action.
    if (midChanged) {
      if (!editMid.trim()) {
        // Clearing a MID requires explicit operator revocation, not a silent blank.
        toast({
          title: "Cannot clear MID here",
          description: "MID removal requires an explicit admin action from the MID Registry. Use the Boarding → MID Registry page to revoke.",
          variant: "destructive",
        });
        setEditMid(selectedDeal.mid || ""); // restore original
        return;
      }
      try {
        const midRes = await apiRequest("PUT", `/api/admin/merchants/${selectedDeal.id}/mid`, {
          mid: editMid.trim(),
        });
        if (!midRes.ok) {
          const body = await midRes.json().catch(() => ({}));
          toast({
            title: "MID assignment failed",
            description: (body as any).message ?? "Could not assign MID. Check your permissions.",
            variant: "destructive",
          });
          return; // stop; don't close dialog or run generic update
        }
        queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      } catch (err: any) {
        toast({
          title: "MID assignment failed",
          description: err?.message ?? "Network error — MID not saved.",
          variant: "destructive",
        });
        return;
      }
    }

    // If only the MID changed (no other fields), close dialog and exit.
    if (Object.keys(updates).length === 0) {
      if (midChanged) {
        toast({ title: "MID updated successfully" });
        setDetailOpen(false);
        setSelectedDeal(null);
      } else {
        setDetailOpen(false);
      }
      setCloseReasonOpen(false);
      setCloseReasonDraft("");
      return;
    }

    const displayedStage = selectedDeal.stage;
    updateDealMutation.mutate({
      id: selectedDeal.id,
      ...updates,
      ...(typeof updates.stage === "string" ? { expectedStage: displayedStage } : {}),
    });
    setCloseReasonOpen(false);
    setCloseReasonDraft("");
  };

  const handleUpdateDeal = () => {
    if (!selectedDeal) return;
    // If stage is changing to Closed Won / Closed Lost, require a reason
    if (editStage && editStage !== selectedDeal.stage &&
        (editStage === "Closed Won" || editStage === "Closed Lost")) {
      setCloseReasonOpen(true);
      return;
    }
    submitDealUpdateWithReason();
  };

  const openDealDetail = (deal: Deal) => {
    setSelectedDeal(deal);
    setEditStage(deal.stage);
    setEditNotes(deal.notes || "");
    setEditFollowUp(deal.nextFollowUp ? new Date(deal.nextFollowUp).toISOString().slice(0, 16) : "");
    setEditExpectedGoLiveDate((deal as any).expectedGoLiveDate ? new Date((deal as any).expectedGoLiveDate).toISOString().slice(0, 10) : ""); // #393
    setEditAgentId("none");
    setEditMid(deal.mid || "");
    setEditVertical(deal.vertical || "");
    setDetailOpen(true);
    setTerminalEcon(null);
    setDealProposalsFailed(false);
    if (!Object.prototype.hasOwnProperty.call(proposalsByDeal, String(deal.id)) && !proposalsFailedByDeal[String(deal.id)]) {
      void retryDealProposals(deal.id);
    }
    if ((deal as any).partnerOrgId) {
      setDealProposals([]);
      loadDealProposals(deal.id).catch(err => console.error("[Pipeline] loadDealProposals", err));
    } else {
      setDealProposals([]);
    }
    if ((deal as any).terminalRecommendation) {
      loadTerminalEconomics(deal.id).catch(err => console.error("[Pipeline] loadTerminalEconomics", err));
    }
  };

  const loadDealProposals = async (dealId: number) => {
    setDealProposalsLoading(true);
    setDealProposalsFailed(false);
    try {
      // fetchSingleDealProposals updates the board cache (proposalsByDeal / proposalsFailedByDeal)
      // as a side-effect, keeping the Kanban card and the detail panel in sync via one fetch path.
      const data = await fetchSingleDealProposals(dealId);
      if (data !== null) {
        setDealProposals(data as any);
        setDealProposalsFailed(false);
      } else {
        setDealProposalsFailed(true);
      }
    } catch (err) {
      console.error("[Pipeline] loadDealProposals error:", err);
      setDealProposalsFailed(true);
    } finally { setDealProposalsLoading(false); }
  };

  const handleGenerateCoBrandedProposal = async () => {
    if (!selectedDeal) return;
    if (!(selectedDeal as any).partnerOrgId) {
      toast({ title: "No partner org linked to this deal", description: "Assign a partner organization to this deal first.", variant: "destructive" });
      return;
    }
    setGeneratingProposal(true);
    try {
      const res = await apiRequest("POST", `/api/deals/${selectedDeal.id}/co-branded-proposal`, { pricingPlan: proposalPlan });
      if (!res.ok) {
        const data = await res.json();
        toast({ title: data.message || "Failed to generate proposal", variant: "destructive" });
        return;
      }
      const data = await res.json();
      toast({ title: "Co-branded proposal created!", description: "Copy the link to share it with the merchant." });
      navigator.clipboard.writeText(data.viewerUrl).catch(() => {});
      loadDealProposals(selectedDeal.id);
    } catch {
      toast({ title: "Network error — please try again", variant: "destructive" });
    } finally {
      setGeneratingProposal(false);
    }
  };

  useEffect(() => {
    if (dealIdParam == null || !selectedRecord.data) return;
    const deal = selectedRecord.data;
    if (deal && (!detailOpen || selectedDeal?.id !== dealIdParam)) {
      openDealDetail(deal);
      // #229 — Auto-scroll the kanban card into view
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-testid="deal-card-${dealIdParam}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }, 300);
    }
  }, [dealIdParam, selectedRecord.data]);
  useEffect(()=>{if(selectedRecord.isError || selectedRecord.invalid) {setDetailOpen(false);setSelectedDeal(null);}},
    [selectedRecord.isError,selectedRecord.invalid]);

  const getDealsByStage = (stage: string) => {
    const filtered = (deals || []).filter((d) => {
      if (d.stage !== stage) return false;
      const isArchived = !!(d as any).archivedAt;
      if (!showArchived && isArchived) return false;
      // Group membership and all population filters are resolved by the
      // existing authorized reader, not the first contact page.
      // #1055 — past expected go-live date filter (overdue, not yet closed/live)
      if ((d as any).showPastGoLiveOnly) { /* handled as sort mode */ }
      if (sortMode === "trending_down") {
        const s = midSummaries[String(d.id)];
        if (!s || s.totalVolume <= 0 || s.trendPct >= 0) return false;
      } else if (sortMode === "no_activity") {
        if (!d.mid) return false;
        const s = midSummaries[String(d.id)];
        if (!s || s.totalVolume > 0) return false;
      } else if (sortMode === "past_golive") {
        // #1055 — filter to deals where expected go-live is in the past and not already closed/live
        const egl = (d as any).expectedGoLiveDate;
        const bs = (d as any).boardingStatus;
        if (!egl || bs === "live" || bs === "approved") return false;
        if (new Date(egl).getTime() >= Date.now()) return false;
      }
      return true;
    });

    if (sortMode === "urgency") {
      // #1199 — Urgency = volume score + go-live proximity score
      filtered.sort((a, b) => {
        const volA = parseFloat(String((a as any).estimatedProcessingVolume ?? "").replace(/[^0-9.]/g, "")) || 0;
        const volB = parseFloat(String((b as any).estimatedProcessingVolume ?? "").replace(/[^0-9.]/g, "")) || 0;
        const eglA = (a as any).expectedGoLiveDate ? Math.max(0, 90 - Math.floor((new Date((a as any).expectedGoLiveDate).getTime() - Date.now()) / 86400000)) : 0;
        const eglB = (b as any).expectedGoLiveDate ? Math.max(0, 90 - Math.floor((new Date((b as any).expectedGoLiveDate).getTime() - Date.now()) / 86400000)) : 0;
        return (volB / 10000 + eglB) - (volA / 10000 + eglA);
      });
    } else if (sortMode === "volume_desc") {
      filtered.sort((a, b) => {
        const av = midSummaries[String(a.id)]?.totalVolume || 0;
        const bv = midSummaries[String(b.id)]?.totalVolume || 0;
        return bv - av;
      });
    } else if (sortMode === "trending_down") {
      filtered.sort((a, b) => {
        const at = midSummaries[String(a.id)]?.trendPct ?? 0;
        const bt = midSummaries[String(b.id)]?.trendPct ?? 0;
        return at - bt;
      });
    }
    return filtered;
  };

  if (dealsLoading) {
    return (
      <CrmPage className="space-y-6">
        <CrmPageHeader title="Pipeline" description="A stage-by-stage view of authorized sales opportunities." />
        <div className="flex gap-4 overflow-x-auto pb-4">
          {Array.from({ length: 5 }).map((_, colIdx) => (
            <div key={colIdx} className="flex-shrink-0 w-72 space-y-3">
              <Skeleton className="h-6 w-32" />
              {Array.from({ length: 3 }).map((_, cardIdx) => (
                <div key={cardIdx} className="border rounded-md p-3 space-y-2 bg-muted/20">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </CrmPage>
    );
  }

  if (dealsError) {
    return <CrmPage className="space-y-5"><CrmPageHeader title="Pipeline" description="Sales opportunities in your authorized scope." />
      <DashboardErrorState title="Pipeline unavailable" message="The deal list could not be refreshed; counts and stages are not assumed to be empty." onRetry={() => void refetchDeals()} />
    </CrmPage>;
  }

  return (
    <CrmPage className="space-y-6">
      {(selectedRecord.isError || selectedRecord.invalid) && <div role="alert">Requested record unavailable.
        {!selectedRecord.invalid && <Button onClick={()=>void selectedRecord.refetch()}>Retry selected record</Button>}
      </div>}
      {/* #190 — Sticky header on scroll */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 -mx-2 px-2 pb-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold" data-testid="text-pipeline-title">
            Sales Pipeline
            {dealsResult?.total != null && (
              <span className="ml-2 text-base font-normal text-muted-foreground" data-testid="text-pipeline-total-count">({dealsResult.total})</span>
            )}
          </h1>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2" data-testid="toggle-show-archived-deals">
            <Switch
              checked={showArchived}
              onCheckedChange={setShowArchived}
              data-testid="switch-show-archived-deals"
            />
            <Label className="text-sm cursor-pointer" onClick={() => setShowArchived(!showArchived)}>
              Show Archived
            </Label>
          </div>
          {/* #480 — Hide empty stages */}
          <div className="flex items-center gap-2" data-testid="toggle-hide-empty-stages">
            <Switch
              checked={hideEmptyStages}
              onCheckedChange={setHideEmptyStages}
              data-testid="switch-hide-empty-stages"
            />
            <Label className="text-sm cursor-pointer" onClick={() => setHideEmptyStages(v => !v)}>
              Hide empty
            </Label>
          </div>
          {/* #623 — Unassigned deals toggle */}
          <div className="flex items-center gap-2" data-testid="toggle-unassigned-only">
            <Switch
              checked={showUnassignedOnly}
              onCheckedChange={setShowUnassignedOnly}
              data-testid="switch-unassigned-only"
            />
            <Label className="text-sm cursor-pointer" onClick={() => setShowUnassignedOnly(v => !v)}>
              Unassigned
            </Label>
          </div>
          {/* #450 — Kanban / List view toggle */}
          <div className="flex items-center gap-1 border rounded-md overflow-hidden" data-testid="toggle-view-mode">
            <Button
              variant={viewMode === "kanban" ? "secondary" : "ghost"}
              size="sm" className="h-8 px-3 rounded-none text-xs"
              onClick={() => setViewMode("kanban")}
              data-testid="button-view-kanban"
            >
              Kanban
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="sm" className="h-8 px-3 rounded-none text-xs"
              onClick={() => setViewMode("list")}
              data-testid="button-view-list"
            >
              List
            </Button>
          </div>
          <Select value={sortMode} onValueChange={(v) => setSortMode(v as any)}>
            <SelectTrigger aria-label="Sort pipeline deals" className="h-9 w-[180px]" data-testid="select-pipeline-sort">
              <ArrowUpDown className="w-3.5 h-3.5 mr-1.5 opacity-70" />
              <SelectValue placeholder="Sort / Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default" data-testid="sort-default">Default order</SelectItem>
              <SelectItem value="past_golive" data-testid="sort-past-golive">Past expected go-live</SelectItem>
              <SelectItem value="urgency" data-testid="sort-urgency">By urgency (size + timeline)</SelectItem>
              <SelectItem value="volume_desc" data-testid="sort-volume-desc">Highest 30d volume</SelectItem>
              <SelectItem value="trending_down" data-testid="sort-trending-down">Trending down only</SelectItem>
              <SelectItem value="no_activity" data-testid="sort-no-activity">No activity (MID idle)</SelectItem>
            </SelectContent>
          </Select>
          {/* #739 — Rep filter */}
          {agentsList && agentsList.length > 0 && (
            <Select value={repEmailFilter || "__all__"} onValueChange={v => setRepEmailFilter(v === "__all__" ? "" : v)}>
              <SelectTrigger aria-label="Filter pipeline by representative" className="h-9 w-[160px]" data-testid="select-pipeline-rep-filter">
                <SelectValue placeholder="All reps" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All reps</SelectItem>
                {(agentsList || []).filter((a: any) => a.status === "active").map((agent: any) => (
                  <SelectItem key={agent.id} value={agent.email}>
                    {agent.firstName} {agent.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* #361 — Vertical filter on pipeline board */}
          <Select value={verticalFilter || "__all__"} onValueChange={v => setVerticalFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger aria-label="Filter pipeline by vertical" className="h-9 w-[150px]" data-testid="select-pipeline-vertical-filter">
              <SelectValue placeholder="All verticals" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All verticals</SelectItem>
              {VERTICALS.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* #405 — Offer path filter on pipeline board */}
          <Select value={offerPathFilter || "__all__"} onValueChange={v => setOfferPathFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger aria-label="Filter pipeline by offer path" className="h-9 w-[150px]" data-testid="select-pipeline-offerpath-filter">
              <SelectValue placeholder="All paths" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All paths</SelectItem>
              {OFFER_PATHS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* #475 — No follow-up filter chip */}
          <button
            onClick={() => setShowNoFollowUpOnly(v => !v)}
            data-testid="chip-no-followup"
            className={`h-9 px-3 rounded-md text-sm border flex items-center gap-1.5 transition-colors ${
              showNoFollowUpOnly
                ? "bg-orange-50 border-orange-300 text-orange-700"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            No follow-up
          </button>
          <Dialog open={groupPickerOpen} onOpenChange={setGroupPickerOpen}>
            <DialogTrigger asChild><Button type="button" variant="outline" data-testid="select-pipeline-group-filter">
              {groupFilterContactId?`Account group ${groupFilterContactId}`:"All groups"}
            </Button></DialogTrigger>
            <DialogContent><DialogHeader><DialogTitle>Filter by authorized account group</DialogTitle></DialogHeader>
              <AuthorizedContactPicker parentOnly label="account groups" value={null} testId="pipeline-group"
                onSelect={choice=>{setGroupFilterContactId(choice?.id??null);setGroupPickerOpen(false);}}/>
              <Button type="button" variant="outline" onClick={()=>{setGroupFilterContactId(null);setGroupPickerOpen(false);}} data-testid="group-filter-all">All groups</Button>
            </DialogContent>
          </Dialog>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const exportData = (deals || []).map(d => {
                const c = d.contactId ? contactsMap.get(d.contactId) : undefined;
                // Contact column: best available identifier (same fallback chain as visual display, written separately — no-duplicate rule does not apply to CSV columns)
                const fullName = c ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() : "";
                const contactCol = fullName || c?.companyName || c?.email || c?.phone || `Deal #${d.id}`;
                // Company column: explicit fallback; may equal contactCol when companyName is the only identifier
                const companyCol = c?.companyName || "N/A";
                return {
                  contact: contactCol,
                  company: companyCol,
                  pipeline: d.pipeline,
                  stage: d.stage,
                  priorityScore: d.priorityScore,
                  estVolume: d.totalVolume || "",
                  estProfit: d.estimatedGrossProfitMonthly || "",
                  followUp: d.nextFollowUp ? new Date(d.nextFollowUp).toLocaleDateString() : "",
                  createdAt: d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "",
                };
              });
              exportToCSV(exportData, "deals", [
                { key: "contact", label: "Contact" },
                { key: "company", label: "Company" },
                { key: "pipeline", label: "Pipeline" },
                { key: "stage", label: "Stage" },
                { key: "priorityScore", label: "Priority Score" },
                { key: "estVolume", label: "Est. Volume" },
                { key: "estProfit", label: "Est. Profit" },
                { key: "followUp", label: "Follow-up" },
                { key: "createdAt", label: "Created At" },
              ]);
            }}
            data-testid="button-export-deals"
          >
            <Download className="w-4 h-4 mr-1" /> Export Deals
          </Button>
          <Button
            variant="outline"
            data-testid="button-ai-auto-progress"
            className="gap-2"
            onClick={() => autoProgressMutation.mutate()}
            disabled={autoProgressMutation.isPending}
          >
            {autoProgressMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            AI Auto-Progress
          </Button>
          <Button
            variant="outline"
            data-testid="button-configure-stages"
            className="gap-2"
            onClick={() => setConfigOpen(true)}
          >
            <Settings className="w-4 h-4" />
            Configure Stages
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-deal" className="gap-2">
                <Plus className="w-4 h-4" />
                New Deal
              </Button>
            </DialogTrigger>
            <DialogContent data-testid="dialog-create-deal">
            <DialogHeader>
              <DialogTitle>Create New Deal</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Contact</Label>
                <AuthorizedContactPicker value={newDeal.contactId?newDealContactChoice:null} testId="new-deal-contact"
                  onSelect={choice=>{setNewDealContactChoice(choice);setNewDeal({...newDeal,contactId:choice?String(choice.id):""});}}/>
              </div>
              <div className="space-y-2">
                <Label>Pipeline</Label>
                <Input value={newDeal.pipeline} disabled data-testid="input-pipeline" />
              </div>
              <div className="space-y-2">
                <Label>Stage</Label>
                <Select value={newDeal.stage} onValueChange={(v) => setNewDeal({ ...newDeal, stage: v })}>
                  <SelectTrigger data-testid="select-stage">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SALES_STAGES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Offer Path</Label>
                <Select value={newDeal.offerPath} onValueChange={(v) => setNewDeal({ ...newDeal, offerPath: v })}>
                  <SelectTrigger data-testid="select-offer-path">
                    <SelectValue placeholder="Select offer path" />
                  </SelectTrigger>
                  <SelectContent>
                    {OFFER_PATHS.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Vertical</Label>
                <Select value={newDeal.vertical} onValueChange={(v) => setNewDeal({ ...newDeal, vertical: v })}>
                  <SelectTrigger data-testid="select-deal-vertical">
                    <SelectValue placeholder="Select vertical (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {VERTICALS.map((v) => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={newDeal.notes}
                  onChange={(e) => setNewDeal({ ...newDeal, notes: e.target.value })}
                  placeholder="Deal notes..."
                  data-testid="input-notes"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setCreateOpen(false)} data-testid="button-cancel-create">
                  Cancel
                </Button>
                <Button onClick={handleCreateDeal} disabled={createDealMutation.isPending} data-testid="button-submit-deal">
                  {createDealMutation.isPending ? "Creating..." : "Create Deal"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </div>
      </div>{/* end sticky header */}

      {selectedDealIds.size > 0 && (
        <div className="flex items-center gap-3 flex-wrap" data-testid="pipeline-bulk-bar">
          {!isManagerOrAdmin && <p className="text-sm text-muted-foreground">
            Bulk stage movement requires an admin or manager. Open a deal for its authorized individual stage editor.
          </p>}
          <span className="text-sm text-muted-foreground" data-testid="text-selected-count">
            {selectedDealIds.size} deal{selectedDealIds.size > 1 ? "s" : ""} selected
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-bulk-actions">
                Bulk Actions
                <ChevronDown className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={!isManagerOrAdmin || hasUncertainStageSelection}
                  title={!isManagerOrAdmin ? "Bulk movement requires an admin or manager. Open a deal to use its authorized individual editor." : undefined}
                  data-testid="button-bulk-move-stage">
                  Move to Stage
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {SALES_STAGES.map((stage) => (
                    <DropdownMenuItem
                      key={stage}
                      disabled={hasUncertainStageSelection || bulkStageMutation.isPending}
                      data-testid={`button-bulk-stage-${stage.replace(/\s+/g, "-").toLowerCase()}`}
                      onClick={() => bulkStageMutation.mutate({ dealIds: Array.from(selectedDealIds), stage })}
                    >
                      {stage}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {/* #574 — Bulk assign to agent */}
              {isManagerOrAdmin && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="button-bulk-assign-agent">
                    Assign to Rep
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {(agentsList || []).filter(a => a.status === "active").map(agent => (
                      <DropdownMenuItem
                        key={agent.id}
                        data-testid={`button-bulk-assign-${agent.id}`}
                        onClick={async () => {
                           if (!agent.email) {
                             toast({ title: "Cannot assign agent", description: "This agent has no ownership email.", variant: "destructive" });
                             return;
                           }
                          await Promise.all(
                            Array.from(selectedDealIds).map(id =>
                               apiRequest("PUT", `/api/deals/${id}`, { owner: agent.email })
                            )
                          );
                          queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
                        }}
                      >
                        {agent.firstName} {agent.lastName}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem
                data-testid="button-bulk-archive"
                onClick={() => bulkArchiveMutation.mutate(Array.from(selectedDealIds))}
              >
                <Archive className="w-4 h-4 mr-2" />
                Archive Selected
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedDealIds(new Set())}
            data-testid="button-clear-selection"
          >
            Clear Selection
          </Button>
          {hasUncertainStageSelection && <span className="basis-full text-xs text-amber-700" role="status">
            Stage moves are paused for unknown or unattempted deals. Read back the complete board before another move.
          </span>}
        </div>
      )}

      {bulkStageResults && bulkStageResults.length > 0 && (
        <Card className="border-amber-300" data-testid="pipeline-bulk-stage-results">
          <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
            <div>
              <CardTitle className="text-sm">Bulk stage results</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Only server-confirmed moves were removed from selection. Other outcomes remain selected.
              </p>
            </div>
            {bulkUnresolvedIds.size > 0 && (
              <Button size="sm" variant="outline" disabled={firstPageLoading || isFetchingNextPage}
                onClick={() => void reconcileUnresolvedBulkMoves()} data-testid="button-reconcile-bulk-stage">
                {firstPageLoading || isFetchingNextPage ? "Reading…" : "Read back current stages"}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {bulkStageResults.map(row => (
              <div key={row.id} className="flex flex-wrap items-start justify-between gap-2 border-t pt-2 text-xs" data-testid={`bulk-stage-result-${row.id}`}>
                <div>
                  <span className="font-semibold">Deal #{row.id}</span>
                  <Badge variant={row.outcome === "confirmed" ? "secondary" : row.outcome === "blocked" ? "outline" : "destructive"} className="ml-2 capitalize">
                    {row.outcome}
                  </Badge>
                  {row.currentStage && <span className="ml-2 text-muted-foreground">Current stage: {row.currentStage}</span>}
                  {row.reason && <p className="mt-1 text-muted-foreground">{row.reason}</p>}
                </div>
                {bulkUnresolvedIds.has(row.id) && <span className="text-amber-700">Reconcile before retry</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <SavedFilterBar
        entityType="deal"
        currentFilters={{ showArchived: String(showArchived) }}
        onApplyFilter={(filters) => {
          setShowArchived(filters.showArchived === "true");
        }}
      />
      {hasLoadedSignalFilter&&<CrmDataState state={midSummaryError?"unavailable":"degraded"}
        message={`${midSummaryError?"Processing summaries unavailable.":"Loaded processing-signal filter."} Only deals with known processing summaries are classified. Missing summaries are unknown, not zero activity; matching population totals are unavailable.`}
        onRetry={midSummaryError?()=>void refetchMidSummaries():undefined}/>}
      {agentsError&&<CrmDataState state="unavailable" message="Rep choices unavailable. The current Pipeline scope remains in effect; this is not an empty team." onRetry={()=>void refetchAgents()}/>}

      {/* #228 — Stage count summary bar above the kanban board */}
      {displayStages.length > 0 && deals && (
        <div className="flex flex-wrap gap-2 text-xs" data-testid="pipeline-stage-summary">
          {displayStages.map(stage => {
            const stageDealsArr = getDealsByStage(stage);
            const count = dealsResult && !hasLoadedSignalFilter ? dealsResult.stageDistribution[stage] ?? 0 : undefined;
            const stageRevenue = stageDealsArr.reduce((s, d) => s + ((d as any).totalVolume || (d as any).estMonthlyRevenue || 0), 0);
            return (
              <span key={stage} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 bg-muted/50">
                <span className={`w-2 h-2 rounded-full ${STAGE_COLORS[stage] || "bg-gray-500"}`} />
                <span className="text-muted-foreground">{stage}:</span>
                <span className="font-semibold">{count ?? "Unavailable"}</span>
                {hasCompleteDealSnapshot && stageRevenue > 0 && <span className="text-muted-foreground/70 ml-0.5">~${Math.round(stageRevenue / 1000)}k</span>}
              </span>
            );
          })}
          {/* #951 — Deals due to go live in next 30 days */}
          {hasCompleteDealSnapshot && deals && (() => {
            const now = Date.now();
            const in30days = now + 30 * 24 * 60 * 60 * 1000;
            const soonCount = (deals || []).filter((d: any) => {
              if (!d.expectedGoLiveDate || d.archivedAt || d.stage === "Closed Won" || d.stage === "Closed Lost") return false;
              const t = new Date(d.expectedGoLiveDate).getTime();
              return t >= now && t <= in30days;
            }).length;
            if (soonCount === 0) return null;
            return (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-300 px-2 py-0.5 bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 font-medium" data-testid="badge-go-live-soon">
                📆 {soonCount} going live in 30d
              </span>
            );
          })()}
          {/* #645 — Won this month */}
          {pipelineMetrics && !showArchived && !repEmailFilter && !verticalFilter && !offerPathFilter &&
            !groupFilterContactId && !showNoFollowUpOnly && !showUnassignedOnly && sortMode==="default" && (() => {
            const wonCount = pipelineMetrics.sales.wonLast30Days;
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const wonVolume = (deals || []).filter((d: any) => d.stage === "Closed Won" && d.updatedAt && new Date(d.updatedAt) >= thirtyDaysAgo)
              .reduce((s: number, d: any) => s + (Number(d.totalVolume) || 0), 0);
            if (wonCount === 0) return null;
            return (
              <span className="inline-flex items-center gap-1 rounded-full border border-green-300 px-2 py-0.5 bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300 font-medium" data-testid="badge-won-this-month">
                🏆 {wonCount} won in 30d{hasCompleteDealSnapshot && wonVolume > 0 ? ` · ~$${Math.round(wonVolume / 1000)}k` : ""}
              </span>
            );
          })()}
          {/* #530 — Upcoming follow-ups this week */}
          {hasCompleteDealSnapshot && deals && (() => {
            const now = Date.now();
            const weekAhead = now + 7 * 24 * 60 * 60 * 1000;
            const dueCount = deals.filter((d: any) => {
              if (!d.nextFollowUp || d.archivedAt) return false;
              const t = new Date(d.nextFollowUp).getTime();
              return t >= now && t <= weekAhead;
            }).length;
            return dueCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 px-2 py-0.5 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-medium" data-testid="badge-follow-ups-due">
                📅 {dueCount} follow-up{dueCount !== 1 ? "s" : ""} due this week
              </span>
            ) : null;
          })()}
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 px-2 py-0.5 bg-primary/5 text-primary font-medium ml-auto">
            Total: {hasLoadedSignalFilter?"Unavailable (loaded signal filter)":dealsResult?.total ?? "Unavailable"}
            {hasCompleteDealSnapshot && deals && (() => {
              const totalRev = deals.reduce((s: number, d: any) => s + ((d.totalVolume || d.estMonthlyRevenue || 0) as number), 0);
              return totalRev > 0 ? <span className="ml-1 text-primary/70">~${Math.round(totalRev / 1000)}k</span> : null;
            })()}
          </span>
          {/* #695 — Closed-won volume total */}
          {hasCompleteDealSnapshot && deals && (() => {
            const closedWonDeals = (deals || []).filter((d: any) => d.stage === "Closed Won" && !d.archivedAt);
            const closedVol = closedWonDeals.reduce((s: number, d: any) => s + (Number(d.totalVolume) || 0), 0);
            if (closedVol === 0 || closedWonDeals.length === 0) return null;
            return (
              <span className="inline-flex items-center gap-1 rounded-full border border-green-300 px-2 py-0.5 bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200 text-xs font-medium" data-testid="badge-closed-volume">
                Closed: ~${Math.round(closedVol / 1000)}k across {closedWonDeals.length} won
              </span>
            );
          })()}
        </div>
      )}

      {/* #1157 / #1443 — Deals per rep summary bar with 30/60/90-day period toggle */}
      {hasCompleteDealSnapshot && deals && (() => {
        const now = Date.now();
        const cutoff = now - repPeriod * 24 * 60 * 60 * 1000;
        const allFiltered = displayStages.flatMap(s => getDealsByStage(s));
        // Snapshot (current): all deals; Period: only deals created within the period
        const periodDeals = allFiltered.filter((d: any) => d.createdAt && new Date(d.createdAt).getTime() >= cutoff);
        const repCounts: Record<string, number> = {};
        for (const d of periodDeals) {
          const owner = (d as any).owner || (d as any).assignedTo || "Unassigned";
          repCounts[owner] = (repCounts[owner] || 0) + 1;
        }
        const repEntries = Object.entries(repCounts).sort((a, b) => b[1] - a[1]);
        if (allFiltered.length === 0) return null;
        return (
          <div className="space-y-1.5" data-testid="pipeline-rep-summary">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">New deals per rep:</span>
              {([30, 60, 90] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setRepPeriod(p)}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${repPeriod === p ? "bg-secondary border-primary text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
                  data-testid={`rep-period-${p}d`}
                >
                  {p}d
                </button>
              ))}
            </div>
            {repEntries.length === 0 ? (
              <span className="text-xs text-muted-foreground">No new deals in the last {repPeriod} days</span>
            ) : (
              <div className="flex flex-wrap gap-2 text-xs">
                {repEntries.map(([rep, count]) => (
                  <span key={rep} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 bg-muted/50">
                    <span className="text-muted-foreground truncate max-w-[120px]">{rep.includes("@") ? rep.split("@")[0] : rep}:</span>
                    <span className="font-semibold">{count}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* #450 — Flat list view of deals */}
      {viewMode === "list" && (() => {
        const allVisibleDeals = displayStages.flatMap(s => getDealsByStage(s));
        const sorted = [...allVisibleDeals].sort((a, b) => {
          if (listSortField === "volume") return ((b as any).totalVolume || 0) - ((a as any).totalVolume || 0);
          if (listSortField === "stage") return (a.stage || "").localeCompare(b.stage || "");
          if (listSortField === "owner") return ((a as any).owner || "").localeCompare((b as any).owner || "");
          return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
        });
        return (
          <div className="space-y-2" data-testid="pipeline-list-view">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <span>Sort:</span>
              {([["updatedAt","Recent"], ["stage","Stage"], ["volume","Volume"], ["owner","Owner"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setListSortField(k as any)}
                  className={`px-2 py-0.5 rounded border ${listSortField === k ? "bg-secondary border-primary text-primary" : "border-border"}`}
                  data-testid={`sort-list-${k}`}
                >{label}</button>
              ))}
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground bg-muted/40 border-b">
                    <th className="text-left px-3 py-2">Deal</th>
                    <th className="text-left px-3 py-2">Stage</th>
                    <th className="text-left px-3 py-2">Owner</th>
                    <th className="text-right px-3 py-2">Volume</th>
                    <th className="text-left px-3 py-2">Follow-up</th>
                    <th className="text-left px-3 py-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(deal => {
                    const identity = getDealCardIdentity(deal, deal.contactId);
                    return (
                      <tr key={deal.id} onClick={() => openDealDetail(deal)} className="cursor-pointer hover:bg-muted/30 border-b last:border-0 transition-colors" data-testid={`list-row-deal-${deal.id}`}>
                        <td className="px-3 py-2 font-medium max-w-[200px] truncate">{identity.primary}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${STAGE_COLORS[deal.stage] || "bg-slate-400"}`} />
                          {deal.stage}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground text-xs">{(deal as any).owner || "—"}</td>
                        <td className="px-3 py-2 text-right text-xs font-mono">{(deal as any).totalVolume ? `$${Number((deal as any).totalVolume).toLocaleString()}` : "—"}</td>
                        <td className="px-3 py-2 text-xs">{deal.nextFollowUp ? new Date(deal.nextFollowUp).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{deal.updatedAt ? new Date(deal.updatedAt).toLocaleDateString() : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <ScrollArea className={`w-full ${viewMode === "list" ? "hidden" : ""}`} data-testid="pipeline-board">
          <div className="flex gap-4 pb-4" style={{ minWidth: `${displayStages.length * 280}px` }}>
            {displayStages.filter(stage => !hideEmptyStages || getDealsByStage(stage).length > 0).map((stage) => {
              const stageDeals = getDealsByStage(stage);
              const colorClass = STAGE_COLORS[stage] || "bg-gray-500";
              return (
                <DroppableColumn
                  key={stage}
                  stage={stage}
                  colorClass={colorClass}
                  stageDeals={stageDeals}
                  selectedDealIds={selectedDealIds}
                  toggleDealSelection={toggleDealSelection}
                  openDealDetail={openDealDetail}
                  archiveDealMutation={archiveDealMutation}
                  restoreDealMutation={restoreDealMutation}
                  getDealCardIdentity={getDealCardIdentity}
                  getContactVertical={getContactVertical}
                  getContactEmployeeCount={getContactEmployeeCount}
                  getContactLeadSource={getContactLeadSource}
                  setCreateOpen={setCreateOpen}
                  midSummaries={midSummaries}
                  proposalsByDeal={proposalsByDeal}
                  proposalsFailedByDeal={proposalsFailedByDeal}
                  onRetryProposals={retryDealProposals}
                  proposalsRetryingByDeal={proposalsRetryingByDeal}
                  confirmationFailedMap={confirmationFailedMap}
                  onQuickEdit={(deal) => setQuickEditDeal(deal)}
                />
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        <DragOverlay>
          {activeDeal && (() => {
            const overlayIdentity = getDealCardIdentity(activeDeal, activeDeal.contactId);
            return (
              <div className="w-[270px] opacity-90 shadow-xl">
                <Card className="cursor-grabbing">
                  <CardContent className="p-3">
                    <div className="font-medium text-sm">{overlayIdentity.primary}</div>
                    {overlayIdentity.secondary && (
                      <div className="text-xs text-muted-foreground">{overlayIdentity.secondary}</div>
                    )}
                  </CardContent>
                </Card>
              </div>
            );
          })()}
        </DragOverlay>
      </DndContext>

      {/* ── Deal Quick-Edit Sheet ─────────────────────────────────── */}
      <DealQuickEditSheet
        deal={quickEditDeal}
        open={quickEditDeal !== null}
        onClose={() => setQuickEditDeal(null)}
      />

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="dialog-deal-detail">
          <DialogHeader>
            <DialogTitle>Deal Details</DialogTitle>
          </DialogHeader>
          {selectedDeal && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                {(() => {
                  const detailPrimary = getDealCardIdentity(selectedDeal, selectedDeal.contactId).primary;
                  const detailContact = selectedDeal.contactId ? contactsMap.get(selectedDeal.contactId) : undefined;
                  return (
                    <>
                      <div>
                        <span className="text-muted-foreground">Contact</span>
                        {/* #503 — Clickable link to contact profile */}
                        {selectedDeal.contactId ? (
                          <a
                            href={`/dashboard/contacts/${selectedDeal.contactId}`}
                            className="font-medium text-primary hover:underline"
                            data-testid="text-detail-contact"
                            onClick={e => { e.preventDefault(); navigatePipeline(`/dashboard/contacts/${selectedDeal.contactId}`); }}
                          >
                            {detailPrimary}
                          </a>
                        ) : (
                          <div className="font-medium" data-testid="text-detail-contact">{detailPrimary}</div>
                        )}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Company</span>
                        {/* Company always resolves independently to the raw company name — never email or phone */}
                        <div className="font-medium" data-testid="text-detail-company">{detailContact?.companyName || "N/A"}</div>
                      </div>
                    </>
                  );
                })()}
                <div>
                  <span className="text-muted-foreground">Pipeline</span>
                  <div className="font-medium" data-testid="text-detail-pipeline">{selectedDeal.pipeline}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Offer Path</span>
                  <div className="font-medium" data-testid="text-detail-offer">{selectedDeal.offerPath || "N/A"}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Created</span>
                  <div className="font-medium" data-testid="text-detail-created">
                    {selectedDeal.createdAt ? new Date(selectedDeal.createdAt).toLocaleDateString() : "N/A"}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Owner</span>
                  <div className="font-medium" data-testid="text-detail-owner">{selectedDeal.owner || "Unassigned"}</div>
                </div>
                {/* #610 — Follow-up date readonly display */}
                {selectedDeal.nextFollowUp && (
                  <div>
                    <span className="text-muted-foreground">Follow-up</span>
                    <div className="font-medium" data-testid="text-detail-followup">{new Date(selectedDeal.nextFollowUp).toLocaleString()}</div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Stage</Label>
                <Select value={editStage} onValueChange={setEditStage}>
                  <SelectTrigger aria-label="Deal stage" data-testid="select-edit-stage">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SALES_STAGES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Vertical</Label>
                <Select
                  value={editVertical || "none"}
                  onValueChange={(v) => setEditVertical(v === "none" ? "" : v)}
                >
                  <SelectTrigger aria-label="Deal vertical" data-testid="select-edit-vertical">
                    <SelectValue placeholder="Select vertical (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {VERTICALS.map((v) => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="Add notes..."
                  data-testid="input-edit-notes"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Next Follow-Up</Label>
                  {/* #576 — Stage-based follow-up suggestion */}
                  {editStage && !editFollowUp && (() => {
                    const STAGE_FOLLOWUP_DAYS: Record<string, number> = {
                      "Call Booked": 2,
                      "Proposal Sent": 7,
                      "Negotiation / Follow-Up": 3,
                      "Verbal Commit": 1,
                      "Statement Received": 2,
                      "Review In Progress": 5,
                    };
                    const days = STAGE_FOLLOWUP_DAYS[editStage];
                    if (!days) return null;
                    const suggested = new Date(Date.now() + days * 86400000);
                    const iso = suggested.toISOString().slice(0, 16);
                    return (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        data-testid="button-suggest-followup"
                        onClick={() => setEditFollowUp(iso)}
                      >
                        Suggest +{days}d
                      </button>
                    );
                  })()}
                </div>
                <Input
                  type="datetime-local"
                  value={editFollowUp}
                  onChange={(e) => setEditFollowUp(e.target.value)}
                  data-testid="input-edit-followup"
                />
              </div>

              {/* #393 — Expected go-live date */}
              <div className="space-y-2">
                <Label>Expected Go-Live Date</Label>
                <Input
                  type="date"
                  value={editExpectedGoLiveDate}
                  onChange={(e) => setEditExpectedGoLiveDate(e.target.value)}
                  data-testid="input-edit-expected-go-live"
                />
                <p className="text-xs text-muted-foreground">When you expect this merchant to start processing.</p>
              </div>

              <div className="space-y-2">
                <Label>Merchant ID (MID)</Label>
                <Input
                  value={editMid}
                  onChange={(e) => setEditMid(e.target.value)}
                  placeholder="e.g. 5491234567890"
                  className="font-mono"
                  data-testid="input-edit-mid"
                />
                <p className="text-xs text-muted-foreground">
                  Used to match incoming residual reports back to this deal.
                </p>
              </div>

              {selectedDeal && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <Monitor className="w-3.5 h-3.5" />
                    Terminal Economics
                  </Label>
                  <TerminalEconomicsCard
                    dealId={selectedDeal.id}
                    terminalRecommendation={(selectedDeal as any).terminalRecommendation}
                    monthlyVolume={(selectedDeal as any).totalVolume}
                    isManagerOrAdmin={isManagerOrAdmin}
                  />
                </div>
              )}

              {isManagerOrAdmin && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <UserRound className="w-3.5 h-3.5" />
                    Assigned Agent
                  </Label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={editAgentId !== "none" ? editAgentId : (dealAssignment ? String(dealAssignment.agentId) : "none")}
                      onValueChange={(val) => {
                        setEditAgentId(val);
                        if (!selectedDeal) return;
                        assignAgentMutation.mutate({
                          dealId: selectedDeal.id,
                          agentId: val === "none" ? null : Number(val),
                        });
                      }}
                    >
                      <SelectTrigger aria-label="Assigned agent" data-testid="select-assign-agent" className="flex-1">
                        <SelectValue placeholder="Unassigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {(agentsList || []).filter(a => a.status === "active").map((agent) => (
                          <SelectItem key={agent.id} value={String(agent.id)}>
                            {agent.firstName} {agent.lastName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {assignAgentMutation.isPending && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                  </div>
                </div>
              )}

              {(selectedDeal as any).archivedAt && (
                <div className="flex items-center gap-2 p-2 rounded-md bg-muted">
                  <Archive className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground flex-1">This deal is archived</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { restoreDealMutation.mutate(selectedDeal.id); setDetailOpen(false); }}
                    data-testid="button-restore-deal-detail"
                  >
                    <RotateCcw className="w-4 h-4 mr-1" /> Restore
                  </Button>
                </div>
              )}

              {/* #1005 — Deal age metric */}
              {selectedDeal?.createdAt && (
                <div className="text-xs text-muted-foreground flex items-center gap-1" data-testid="text-deal-age">
                  <span>Deal age:</span>
                  <span className="font-medium text-foreground">
                    {Math.floor((Date.now() - new Date(selectedDeal.createdAt).getTime()) / 86400000)} days
                  </span>
                </div>
              )}

              {/* #1445 — Underwriting Checklist: auto-created when deal enters an underwriting stage */}
              {selectedDeal?.stage?.toLowerCase().includes("underwriting") && (
                <div className="border rounded-md p-3 space-y-2" data-testid="card-underwriting-checklist">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <ListChecks className="w-4 h-4 text-primary" />
                    Underwriting Checklist
                    {!uwTasksError && !uwTasksLoading && uwTasks.length > 0 && (
                      <Badge variant="secondary" className="ml-auto text-xs">
                        {uwTasks.filter((t: any) => t.status === "completed").length}/{uwTasks.length} done
                      </Badge>
                    )}
                  </p>
                  {uwTasksError ? (
                    <div role="alert" className="text-sm">
                      Underwriting work unavailable; no empty checklist is assumed.
                      <Button variant="outline" onClick={() => void refetchUwTasks()}>Retry</Button>
                    </div>
                  ) : uwTasksLoading ? <p role="status">Loading underwriting work…</p> : uwTasks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No checklist items yet. Items are auto-created when this deal enters an underwriting stage.
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {uwTasks.map((task: any) => (
                        <div key={task.id} className="flex items-start gap-2 text-sm">
                          <button
                            type="button"
                            className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                              task.status === "completed"
                                ? "bg-green-500 border-green-500 text-white"
                                : "border-muted-foreground/40 hover:border-primary"
                            }`}
                            onClick={() => {
                              const newStatus = task.status === "completed" ? "pending" : "completed";
                              apiRequest("PATCH", `/api/deals/${selectedDeal!.id}/underwriting-tasks/${task.id}`, { status: newStatus })
                                .then(() => refetchUwTasks())
                                .catch(() => {});
                            }}
                            data-testid={`uw-task-toggle-${task.id}`}
                          >
                            {task.status === "completed" && <CheckCircle2 className="w-3 h-3" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <span className={task.status === "completed" ? "line-through text-muted-foreground" : ""}>
                              {task.title}
                            </span>
                            {task.dueDate && (
                              <span className="text-xs text-muted-foreground ml-1.5">
                                (due {new Date(task.dueDate).toLocaleDateString()})
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* #527 — Submit deal for manager review */}
              {!(selectedDeal as any).archivedAt && (selectedDeal as any).boardingStatus !== "pending_review" && (
                <div className="border rounded-md p-3 bg-amber-50 dark:bg-amber-900/10">
                  <p className="text-xs text-muted-foreground mb-2">
                    Ready for boarding? Submit this deal for manager review before boarding.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-amber-400 text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-700"
                    disabled={updateDealMutation.isPending}
                    onClick={() => {
                      updateDealMutation.mutate({
                        id: selectedDeal.id,
                        boardingStatus: "pending_review",
                      });
                    }}
                    data-testid="button-submit-for-review"
                  >
                    📋 Submit for Manager Review
                  </Button>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                {!(selectedDeal as any).archivedAt && (
                  <Button
                    variant="outline"
                    onClick={() => { archiveDealMutation.mutate(selectedDeal.id); setDetailOpen(false); }}
                    data-testid="button-archive-deal-detail"
                  >
                    <Archive className="w-4 h-4 mr-1" /> Archive
                  </Button>
                )}
                <Button variant="outline" onClick={() => setDetailOpen(false)} data-testid="button-cancel-edit">
                  Cancel
                </Button>
                <Button onClick={handleUpdateDeal} disabled={updateDealMutation.isPending} data-testid="button-save-deal">
                  {updateDealMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </div>

              {/* #537 — Won/Lost reason dialog */}
              <Dialog open={closeReasonOpen} onOpenChange={setCloseReasonOpen}>
                <DialogContent data-testid="dialog-close-reason">
                  <DialogHeader>
                    <DialogTitle>{editStage === "Closed Won" ? "🎉 Mark as Won" : "Mark as Lost"}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 py-2">
                    <p className="text-sm text-muted-foreground">
                      {editStage === "Closed Won"
                        ? "What clinched the deal? This helps track what's working."
                        : "What caused this deal to be lost? This helps improve future pitches."}
                    </p>
                    <Textarea
                      placeholder={editStage === "Closed Won" ? "e.g. Rate match, fast approval, referral…" : "e.g. Pricing, went with competitor, no budget…"}
                      value={closeReasonDraft}
                      onChange={e => setCloseReasonDraft(e.target.value)}
                      rows={3}
                      data-testid="textarea-close-reason"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => { setCloseReasonOpen(false); setCloseReasonDraft(""); }} data-testid="button-close-reason-cancel">
                      Cancel
                    </Button>
                    <Button
                      onClick={() => submitDealUpdateWithReason(closeReasonDraft || undefined)}
                      disabled={updateDealMutation.isPending}
                      data-testid="button-close-reason-save"
                    >
                      {updateDealMutation.isPending ? "Saving…" : `Save as ${editStage}`}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Co-branded proposal section — only shows when deal has a partner org */}
              {(selectedDeal as any).partnerOrgId && (
                <div className="border-t pt-4 space-y-3" data-testid="section-co-branded-proposals">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <h4 className="text-sm font-semibold flex items-center gap-1.5">
                        <FileText className="w-4 h-4 text-blue-600" />
                        Co-Branded Proposals
                      </h4>
                      <p className="text-xs text-muted-foreground mt-0.5">Generate a white-labeled proposal for this merchant.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select value={proposalPlan} onValueChange={setProposalPlan}>
                        <SelectTrigger className="h-8 text-xs w-[180px]" data-testid="select-proposal-plan">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="interchangePlus">Interchange Plus</SelectItem>
                          <SelectItem value="cashDiscount">Cash Discount</SelectItem>
                          <SelectItem value="flatRate">Flat Rate</SelectItem>
                          <SelectItem value="tieredReduction">Tiered Reduction</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={handleGenerateCoBrandedProposal}
                        disabled={generatingProposal}
                        data-testid="button-generate-co-branded-proposal"
                      >
                        {generatingProposal ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <><Plus className="w-3.5 h-3.5" /> Generate</>
                        )}
                      </Button>
                    </div>
                  </div>

                  {dealProposalsLoading ? (
                    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                    </div>
                  ) : dealProposalsFailed ? (
                    <div
                      className="flex items-center justify-between gap-2 p-2.5 border border-dashed rounded-md bg-muted/30"
                      data-testid="badge-proposal-detail-unavailable"
                    >
                      <span className="text-xs text-muted-foreground">Details unavailable — could not load proposal status for this deal.</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs shrink-0"
                        onClick={() => loadDealProposals(selectedDeal.id)}
                        disabled={dealProposalsLoading}
                        data-testid="button-retry-deal-proposals"
                      >
                        <RotateCcw className="w-3 h-3 mr-1" /> Retry
                      </Button>
                    </div>
                  ) : dealProposals.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No proposals yet. Click "Generate" to create one.</p>
                  ) : (
                    <div className="space-y-2">
                      {dealProposals.map(p => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between gap-2 p-2.5 border rounded-md bg-muted/30 text-sm"
                          data-testid={`row-deal-proposal-${p.id}`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-xs truncate">{p.merchantName}</span>
                              {p.acceptedAt ? (
                                <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 px-1.5 py-0.5 rounded-full border border-green-200">
                                  <CheckCircle2 className="w-3 h-3" />Accepted
                                </span>
                              ) : p.viewCount > 0 ? (
                                <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded-full border border-blue-200">
                                  Viewed {p.viewCount}×
                                </span>
                              ) : p.deliveredAt ? (
                                <span className="inline-flex items-center gap-1 text-xs text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded-full border border-sky-200">
                                  <Send className="w-3 h-3" />Sent
                                </span>
                              ) : (
                                <span className="inline-flex text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border">Draft</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                apiRequest("POST", `/api/co-branded-proposals/${p.id}/send`, {})
                                  .then(() => toast({ title: "Proposal sent via GHL!" }))
                                  .catch((err) => toast({ title: "Failed to send", description: err.message, variant: "destructive" }));
                              }}
                              title="Send via GHL"
                              data-testid={`button-send-ghl-deal-proposal-${p.id}`}
                            >
                              <Send className="w-3.5 h-3.5" />
                            </Button>
                            <button
                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                              onClick={() => { navigator.clipboard.writeText(p.viewerUrl); toast({ title: "Link copied!" }); }}
                              title="Copy link"
                              data-testid={`button-copy-deal-proposal-${p.id}`}
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            <a href={p.viewerUrl} target="_blank" rel="noopener noreferrer">
                              <button
                                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                                title="Open proposal"
                                data-testid={`button-view-deal-proposal-${p.id}`}
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </button>
                            </a>
                            {/* #476 — Manually mark proposal as viewed */}
                            {!p.acceptedAt && p.viewCount === 0 && p.deliveredAt && (
                              <button
                                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                                title="Mark as viewed"
                                data-testid={`button-mark-viewed-proposal-${p.id}`}
                                onClick={() => {
                                  updateDealMutation.mutate({ id: selectedDeal.id, proposalStatus: "viewed" });
                                  toast({ title: "Marked as viewed" });
                                }}
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {(selectedDeal as any).terminalRecommendation && (
                <div className="border-t pt-4 space-y-3" data-testid="section-terminal-economics">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h4 className="text-sm font-semibold flex items-center gap-1.5">
                      <Monitor className="w-4 h-4 text-primary" />
                      Equipment Economics
                    </h4>
                    <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate">
                      {(selectedDeal as any).terminalRecommendation}
                    </Badge>
                  </div>

                  {terminalEconLoading ? (
                    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> Calculating payback...
                    </div>
                  ) : terminalEcon && terminalEcon.available ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div className="bg-muted/40 rounded-md p-2.5">
                          <div className="text-xs text-muted-foreground mb-0.5">Terminal Cost</div>
                          <div className="font-semibold">${terminalEcon.terminalCost?.toFixed(0)}</div>
                          <div className="text-xs text-muted-foreground">MSRP: ${terminalEcon.msrp?.toFixed(0)}</div>
                        </div>
                        <div className="bg-muted/40 rounded-md p-2.5">
                          <div className="text-xs text-muted-foreground mb-0.5">Monthly Gross Profit</div>
                          <div className="font-semibold">{terminalEcon.estimatedMonthlyGrossProfit && terminalEcon.estimatedMonthlyGrossProfit > 0 ? `$${terminalEcon.estimatedMonthlyGrossProfit.toFixed(0)}` : "Not set"}</div>
                        </div>
                      </div>

                      <div className={`rounded-md p-3 flex items-center justify-between gap-2 ${
                        terminalEcon.tier === "green" ? "bg-green-50 border border-green-200 dark:bg-green-950/20 dark:border-green-800" :
                        terminalEcon.tier === "yellow" ? "bg-amber-50 border border-amber-200 dark:bg-amber-950/20 dark:border-amber-800" :
                        "bg-red-50 border border-red-200 dark:bg-red-950/20 dark:border-red-800"
                      }`} data-testid="terminal-payback-result">
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 shrink-0 opacity-70" />
                          <div>
                            <div className="text-sm font-semibold">
                              {terminalEcon.paybackMonths != null ? `${terminalEcon.paybackMonths}-month payback` : "Payback N/A"}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              ≤{terminalEcon.greenThreshold}mo = green · ≤{terminalEcon.yellowThreshold}mo = yellow
                            </div>
                          </div>
                        </div>
                        {terminalEcon.tier === "green" && <Badge className="bg-green-100 text-green-700 border-green-200 no-default-hover-elevate no-default-active-elevate">On Track</Badge>}
                        {terminalEcon.tier === "yellow" && <Badge className="bg-amber-100 text-amber-700 border-amber-200 no-default-hover-elevate no-default-active-elevate">Caution</Badge>}
                        {terminalEcon.tier === "red" && <Badge className="bg-red-100 text-red-700 border-red-200 no-default-hover-elevate no-default-active-elevate">Needs Approval</Badge>}
                      </div>

                      {terminalEcon.leaseComparison && (
                        <div className="text-xs text-muted-foreground bg-muted/30 rounded-md p-2.5">
                          vs. competitor lease: <strong>${terminalEcon.leaseComparison.competitorMonthlyLease}/mo × 36mo</strong> = ${terminalEcon.leaseComparison.savingsVsLease3Year.toLocaleString()} total cost
                          — buying saves <strong className="text-green-600">${(terminalEcon.leaseComparison.savingsVsLease3Year - (terminalEcon.terminalCost || 0)).toLocaleString()}</strong>
                        </div>
                      )}

                      {(() => {
                        const apStatus = (selectedDeal as any).terminalApprovalStatus;
                        if (!apStatus || apStatus === "not_required") return null;
                        return (
                          <div className="flex items-center gap-2 flex-wrap" data-testid="terminal-approval-status">
                            {apStatus === "approved" && <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-md"><ShieldCheck className="w-3.5 h-3.5" /> Manager approved</span>}
                            {apStatus === "pending_approval" && <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-md"><ShieldAlert className="w-3.5 h-3.5" /> Awaiting manager approval</span>}
                            {apStatus === "rejected" && <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded-md"><ShieldX className="w-3.5 h-3.5" /> Manager rejected — use a different terminal</span>}
                          </div>
                        );
                      })()}

                      {isManagerOrAdmin && (selectedDeal as any).terminalApprovalStatus === "pending_approval" && (
                        <div className="space-y-2" data-testid="terminal-approval-actions">
                          <Input
                            value={approvalReason}
                            onChange={(e) => setApprovalReason(e.target.value)}
                            placeholder="Rejection reason (optional)"
                            className="text-sm h-8"
                            data-testid="input-rejection-reason"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                              onClick={handleTerminalApprove}
                              disabled={approvalActionPending}
                              data-testid="button-approve-terminal"
                            >
                              {approvalActionPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5 border-red-300 text-red-700 hover:bg-red-50"
                              onClick={handleTerminalReject}
                              disabled={approvalActionPending}
                              data-testid="button-reject-terminal"
                            >
                              {approvalActionPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldX className="w-3.5 h-3.5" />}
                              Reject
                            </Button>
                          </div>
                        </div>
                      )}

                      {terminalEcon.tier === "red" && (!(selectedDeal as any).terminalApprovalStatus || (selectedDeal as any).terminalApprovalStatus === "not_required") && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 w-full border-amber-300 text-amber-700"
                          onClick={() => handleCheckTerminalApproval(selectedDeal.id)}
                          data-testid="button-request-terminal-approval"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" /> Request Manager Approval
                        </Button>
                      )}
                    </div>
                  ) : terminalEcon && !terminalEcon.available ? (
                    <p className="text-xs text-muted-foreground">Terminal model "{(selectedDeal as any).terminalRecommendation}" not in catalog. Add it in the Equipment Model Catalog to enable economics tracking.</p>
                  ) : null}
                </div>
              )}

              {/* #1281 — Deal competitors section */}
              <DealCompetitorsSection dealId={selectedDeal.id} />

              <div className="border-t pt-4">
                <Comments entityType="deal" entityId={selectedDeal.id} />
              </div>

              <div className="border-t pt-4" data-testid="deal-history-section">
                <p className="text-sm font-medium mb-3 flex items-center gap-2">
                  <History className="h-4 w-4" /> Change History
                </p>
                <DealChangeHistory dealId={selectedDeal.id} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="dialog-configure-stages">
          <DialogHeader>
            <DialogTitle>Configure Pipeline Stages</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>Pipeline</Label>
              <Select value={configPipeline} onValueChange={setConfigPipeline}>
                <SelectTrigger data-testid="select-config-pipeline">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sales">Sales</SelectItem>
                  <SelectItem value="onboarding">Onboarding</SelectItem>
                  <SelectItem value="support">Support</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Current Stages</Label>
              {sortedStages.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-stages">
                  No custom stages configured for this pipeline.
                </div>
              ) : (
                <div className="space-y-2" data-testid="stage-list">
                  {sortedStages.map((stage, idx) => {
                    const dealCount = getDealsInStage(stage.stageName);
                    return (
                      <div
                        key={stage.id}
                        className="flex items-center gap-2 p-2 border rounded-md"
                        data-testid={`stage-config-item-${stage.id}`}
                      >
                        <div
                          className="w-4 h-4 rounded-sm flex-shrink-0"
                          style={{ backgroundColor: stage.color || "#6366f1" }}
                          data-testid={`stage-color-${stage.id}`}
                        />
                        {editingStage?.id === stage.id ? (
                          <div className="flex-1 flex items-center gap-2 flex-wrap">
                            <Input
                              value={editStageName}
                              onChange={(e) => setEditStageName(e.target.value)}
                              className="flex-1"
                              data-testid="input-edit-stage-name"
                            />
                            <div className="flex items-center gap-1 flex-wrap">
                              {PRESET_COLORS.map((c) => (
                                <button
                                  key={c}
                                  className={`w-5 h-5 rounded-sm border-2 ${editStageColor === c ? "border-foreground" : "border-transparent"}`}
                                  style={{ backgroundColor: c }}
                                  onClick={() => setEditStageColor(c)}
                                  data-testid={`color-edit-${c.replace("#", "")}`}
                                />
                              ))}
                            </div>
                            <div className="flex gap-1">
                              <Button size="sm" onClick={handleSaveEditStage} disabled={updateStageMutation.isPending} data-testid="button-save-stage-edit">
                                Save
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setEditingStage(null)} data-testid="button-cancel-stage-edit">
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <span className="flex-1 text-sm font-medium" data-testid={`text-stage-name-${stage.id}`}>
                              {stage.stageName}
                            </span>
                            {dealCount > 0 && (
                              <Badge variant="secondary" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-stage-deals-${stage.id}`}>
                                {dealCount} deal{dealCount !== 1 ? "s" : ""}
                              </Badge>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Move stage up"
                              onClick={() => handleMoveStage(stage, "up")}
                              disabled={idx === 0 || reorderStagesMutation.isPending}
                              data-testid={`button-move-up-${stage.id}`}
                            >
                              <ArrowUp className="w-4 h-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Move stage down"
                              onClick={() => handleMoveStage(stage, "down")}
                              disabled={idx === sortedStages.length - 1 || reorderStagesMutation.isPending}
                              data-testid={`button-move-down-${stage.id}`}
                            >
                              <ArrowDown className="w-4 h-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Edit stage"
                              onClick={() => {
                                setEditingStage(stage);
                                setEditStageName(stage.stageName);
                                setEditStageColor(stage.color || "#6366f1");
                              }}
                              data-testid={`button-edit-stage-${stage.id}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Delete stage"
                              onClick={() => setDeleteConfirmStage(stage)}
                              data-testid={`button-delete-stage-${stage.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2 border-t pt-4">
              <Label>Add New Stage</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={addStageName}
                  onChange={(e) => setAddStageName(e.target.value)}
                  placeholder="Stage name"
                  className="flex-1"
                  data-testid="input-add-stage-name"
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddStage(); }}
                />
                <Button
                  onClick={handleAddStage}
                  disabled={!addStageName.trim() || createStageMutation.isPending}
                  data-testid="button-add-stage"
                  className="gap-1"
                >
                  {createStageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add
                </Button>
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`w-5 h-5 rounded-sm border-2 ${addStageColor === c ? "border-foreground" : "border-transparent"}`}
                    style={{ backgroundColor: c }}
                    onClick={() => setAddStageColor(c)}
                    data-testid={`color-add-${c.replace("#", "")}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteConfirmStage} onOpenChange={(open) => { if (!open) setDeleteConfirmStage(null); }}>
        <AlertDialogContent data-testid="dialog-delete-stage-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Stage</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmStage && getDealsInStage(deleteConfirmStage.stageName) > 0
                ? `Warning: There are ${getDealsInStage(deleteConfirmStage.stageName)} deal(s) currently in the "${deleteConfirmStage.stageName}" stage. Deleting this stage will not move those deals automatically. Are you sure you want to delete it?`
                : `Are you sure you want to delete the "${deleteConfirmStage?.stageName}" stage? This action cannot be undone.`
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-stage">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteConfirmStage) deleteStageMutation.mutate(deleteConfirmStage.id); }}
              data-testid="button-confirm-delete-stage"
            >
              {deleteStageMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CrmPage>
  );
}
