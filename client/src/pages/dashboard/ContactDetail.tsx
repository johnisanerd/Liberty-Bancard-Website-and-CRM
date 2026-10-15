import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { useState, useEffect, useRef } from "react";
import { useParams, useLocation, Link, useSearch } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useUpdateContact } from "@/hooks/use-contacts";
import { apiRequest, getCsrfToken, protectedContextToken } from "@/lib/queryClient";
import { useOwnedToast as useToast } from "@/hooks/use-owned-toast";
import { useAuth } from "@/hooks/use-auth";
import {useRetainedLocalIntent} from "@/hooks/use-retained-local-intent";
import {useTicketCreateCommand} from "@/hooks/use-rfi-command";
import { useOutboundPauseObservation } from "@/hooks/use-outbound-pause-observation";
import { invalidateWorkFacts } from "@/hooks/use-work-commands";
import { isPendingTask } from "@/lib/task-source";
import type { Contact, Deal, Ticket as TicketType, Task as TaskType, Company, ContactCompany, Document, Agent } from "@shared/schema";
import { VERTICALS, OFFER_PATHS } from "@shared/schema";
import RfiTab from "@/components/RfiTab";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeft, Edit2, Save, X, Plus, StickyNote, TrendingUp, CheckSquare,
  Ticket, Mail, Phone, Building2,
  Activity, Link2, Trash2, Star, AlertTriangle,
  RefreshCw, CheckCircle2, AlertCircle, Linkedin, FolderOpen, Info,
  ChevronDown, ChevronUp, Brain, AlertOctagon, ShieldCheck, GitFork, Bot, MapPin, Store,
  FileSearch2, Merge, SendHorizonal, ClipboardList, BarChart2, UserCheck,
  Zap, Clock, User, Copy, Check as CheckIcon, FileText,
} from "lucide-react";
import {
  labelForConfirmationStatus,
  variantForConfirmationStatus,
  type ConfirmationState,
  type SubmissionStatus,
} from "@shared/confirmation-status-types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import Comments from "@/components/Comments";
import { EmailComposer } from "@/components/EmailComposer";
import { ReadinessCard } from "@/components/ReadinessCard";
import { CrmDataState, CrmPage, RecordHeader, CrmPageHeader, CrmAreaNav, CrmDetailDrawer } from "@/components/crm/CrmPresentation";
import { contactAreaSections, contactAreas, contactSectionArea, contactSections, contactWorkspaceState, buildContactWorkspaceHref, parseLocalEntityId, type ContactArea, type ContactSection } from "@/lib/crm-destination-state";
import { useEmployeeCrm } from "@/components/crm/employee-crm-context";

// #240 — One-click copy button for phone/email
function CopyButton({ value, label, menuItem = false }: { value: string; label: string; menuItem?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  if (menuItem) {
    return (
      <DropdownMenuItem
        className="min-h-11"
        onSelect={copy}
        data-testid={`menu-action-copy-${label}`}
      >
        {copied ? <CheckIcon className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        Copy {label}
      </DropdownMenuItem>
    );
  }
  return (
    <button
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); copy(); }}
      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity ml-0.5 p-0.5 rounded hover:bg-muted"
      aria-label={`Copy ${label}`}
      data-testid={`button-copy-${label}`}
      title={copied ? "Copied!" : `Copy ${label}`}
      type="button"
    >
      {copied ? <CheckIcon className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
    </button>
  );
}

function restoreFocusOnClose<T extends HTMLElement>(ref: { readonly current: T | null }) {
  return (event: Event) => {
    event.preventDefault();
    window.setTimeout(() => ref.current?.focus(), 0);
  };
}

import {
  type ActivityEvent,
  type ContactDetailData,
  statusColor,
} from "./contact-detail-tabs/shared";
import { OnboardingStagesChecklist } from "@/components/OnboardingStagesChecklist";
import { OverviewTab } from "./contact-detail-tabs/OverviewTab";
import { DealsTab } from "./contact-detail-tabs/DealsTab";
import { LiveProcessingTabBody } from "./contact-detail-tabs/LiveProcessingTabBody";
import { TicketsTab } from "./contact-detail-tabs/TicketsTab";
import { TasksTab } from "./contact-detail-tabs/TasksTab";
import { NotesTab } from "./contact-detail-tabs/NotesTab";
import { ContactDocumentsTab } from "./contact-detail-tabs/DocumentsTab";
import { ContactChargebacksTab } from "./contact-detail-tabs/ChargebacksTab";
import { ActivityTimelineFull } from "./contact-detail-tabs/ActivityTab";
import { LinkedinEnrichmentSection } from "./contact-detail-tabs/LinkedinEnrichmentSection";
import { ChangeHistoryTab } from "./contact-detail-tabs/ChangeHistoryTab";
  import { CreateDialogs } from "./contact-detail-tabs/CreateDialogs";
import { GhlSyncStatus } from "./contact-detail-tabs/GhlSyncStatus";
import { RelationshipsTab } from "./contact-detail-tabs/RelationshipsTab";
import { LocationsTab } from "./contact-detail-tabs/LocationsTab";
import { CompanyIntelligenceTab } from "./contact-detail-tabs/CompanyIntelligenceTab";
import { CommunicationHealthTab } from "./contact-detail-tabs/CommunicationHealthTab";
import { OfferIntelligenceTab } from "./contact-detail-tabs/OfferIntelligenceTab";
import { SalesPrepTab } from "./contact-detail-tabs/SalesPrepTab";
import { DeliveryLogTab } from "./contact-detail-tabs/DeliveryLogTab";
import { CommunicationTimelineTab } from "./contact-detail-tabs/CommunicationTimelineTab";
import { CallLogsTab } from "./contact-detail-tabs/CallLogsTab"; // #460
import { SalesIntelPanel } from "./contact-detail-tabs/SalesIntelPanel"; // #1475
import { LogCallSheet } from "./contact-detail-tabs/LogCallSheet"; // #1475
import { NextStepsWidget } from "./contact-detail-tabs/NextStepsWidget"; // #1475
import CallAssistPanel from "@/components/CallAssistPanel";

// ── Confirmation Status Section ───────────────────────────────────────────────
/**
 * Always renders. Shows "Not Sent" when submissions is empty.
 * Shows the latest submission prominently; when multiple exist, the history is
 * collapsible (older submissions sorted DESC, hidden until user expands).
 */
function ConfirmationStatusSection({
  confirmationResult,
}: {
  confirmationResult: {
    latestStatus: SubmissionStatus | null;
    submissions: SubmissionStatus[];
    hasConfirmationRecord: boolean;
  } | null;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const submissions = confirmationResult?.submissions ?? [];
  const latest = submissions[0] ?? null;
  const history = submissions.slice(1); // older submissions in DESC order

  useEffect(() => {
    if (confirmationResult === null) return;
    if (window.location.hash !== "#confirmation-status") return;
    document.getElementById("confirmation-status")?.scrollIntoView({ behavior: "smooth" });
  }, [confirmationResult]);

  return (
    <Card id="confirmation-status" data-testid="section-confirmation-status">
      <CardContent className="pt-4 pb-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground shrink-0">
              <SendHorizonal className="h-4 w-4" />
              <span>Confirmation:</span>
            </div>

            {!latest ? (
              <Badge variant="secondary" data-testid="badge-confirmation-not-sent">
                Not Sent
              </Badge>
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant={variantForConfirmationStatus(latest.state as ConfirmationState)}
                      className="gap-1 cursor-default"
                      data-testid={`badge-confirmation-${latest.submissionId}`}
                    >
                      {labelForConfirmationStatus(latest.state as ConfirmationState, latest.provider)}
                      {latest.formType && (
                        <span className="opacity-70 font-normal">· {latest.formType}</span>
                      )}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <div className="text-xs space-y-0.5">
                      <p>{new Date(latest.timestamp).toLocaleString()}</p>
                      {latest.safeReason && (
                        <p className="text-red-400">{latest.safeReason}</p>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {history.length > 0 && (
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-confirmation-history-toggle"
              >
                {historyOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                {history.length} earlier
              </button>
            )}
          </div>

          {historyOpen && history.length > 0 && (
            <div className="flex flex-wrap gap-2 pl-6 pt-1" data-testid="section-confirmation-history">
              {history.map((sub) => (
                <TooltipProvider key={sub.submissionId}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant={variantForConfirmationStatus(sub.state as ConfirmationState)}
                        className="gap-1 cursor-default opacity-70"
                        data-testid={`badge-confirmation-history-${sub.submissionId}`}
                      >
                        {labelForConfirmationStatus(sub.state as ConfirmationState, sub.provider)}
                        {sub.formType && (
                          <span className="opacity-70 font-normal">· {sub.formType}</span>
                        )}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <div className="text-xs space-y-0.5">
                        <p>{new Date(sub.timestamp).toLocaleString()}</p>
                        {sub.safeReason && (
                          <p className="text-red-400">{sub.safeReason}</p>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── ZeroBounce Validation History ────────────────────────────────────────────
interface ZbHistoryEntry {
  validatedAt: string;
  status: string | null;
  subStatus: string | null;
  email: string | null;
  source: string | null;
}

function ZeroBounceHistorySection({ contactId }: { contactId: number }) {
  const [open, setOpen] = useState(false);

  const { data: history = [], isLoading } = useQuery<ZbHistoryEntry[]>({
    queryKey: ["/api/contacts", contactId, "zerobounce-history"],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/contacts/${contactId}/zerobounce-history`, { signal, credentials: "include" });
      if (!r.ok) throw new Error("Failed to load validation history");
      return r.json();
    },
    staleTime: 60_000,
  });

  const latest = history[0] ?? null;
  const older = history.slice(1);

  const statusLabel = (s: string | null) => {
    if (!s) return "Unknown";
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const isNegative = (s: string | null) =>
    s === "invalid" || s === "bounced" || s === "unsafe" || s === "do_not_mail";

  const statusCls = (s: string | null) =>
    isNegative(s)
      ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
      : s === "valid"
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";

  return (
    <Card data-testid="section-zerobounce-history">
      <CardContent className="pt-4 pb-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground shrink-0">
              <ShieldCheck className="h-4 w-4" />
              <span>Email Validation:</span>
            </div>

            {isLoading ? (
              <span className="text-xs text-muted-foreground">Loading…</span>
            ) : !latest ? (
              <Badge variant="secondary" data-testid="badge-zb-not-validated">Not yet validated</Badge>
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      className={`border-0 gap-1 cursor-default ${statusCls(latest.status)}`}
                      data-testid="badge-zb-latest-status"
                    >
                      {isNegative(latest.status) && <AlertCircle className="h-3 w-3" />}
                      {statusLabel(latest.status)}
                      {latest.subStatus && (
                        <span className="opacity-70 font-normal">· {latest.subStatus}</span>
                      )}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <div className="text-xs space-y-0.5">
                      <p>{new Date(latest.validatedAt).toLocaleString()}</p>
                      {latest.source && <p className="capitalize text-muted-foreground">via {latest.source}</p>}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {older.length > 0 && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-zb-history-toggle"
              >
                {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {older.length} earlier
              </button>
            )}
          </div>

          {open && older.length > 0 && (
            <div className="flex flex-wrap gap-2 pl-6 pt-1" data-testid="section-zb-history-older">
              {older.map((entry, idx) => (
                <TooltipProvider key={idx}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        className={`border-0 gap-1 cursor-default opacity-70 ${statusCls(entry.status)}`}
                        data-testid={`badge-zb-history-${idx}`}
                      >
                        {statusLabel(entry.status)}
                        {entry.subStatus && (
                          <span className="opacity-70 font-normal">· {entry.subStatus}</span>
                        )}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <div className="text-xs space-y-0.5">
                        <p>{new Date(entry.validatedAt).toLocaleString()}</p>
                        {entry.source && <p className="capitalize text-muted-foreground">via {entry.source}</p>}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface SfpReadinessDecision {
  eligibilityId: string;
  businessId: number;
  policyStatus: string;
  zbOutcome: string | null;
  validatedAt: string | null;
  expiresAt: string | null;
  fresh: boolean;
  operationId: string | null;
  receiptId: string | null;
  linkDecisionId: string | null;
  currentLink: boolean;
  intentId: string | null;
  intentState: string | null;
  masterLeadId: string | null;
  enrollmentId: string | null;
  enrollmentStatus: string | null;
  receiptStatus: "matched" | "unresolved";
}

interface SfpReadinessResult {
  contactId: number;
  crmEmailStatus: string | null;
  separateFromCrm: true;
  decisions: SfpReadinessDecision[];
}

function SfpReadinessSection({ contactId }: { contactId: number }) {
  const readinessQuery = useQuery<SfpReadinessResult>({
    queryKey: ["/api/contacts", contactId, "sfp-readiness"],
    queryFn: async ({ signal }) => (await apiRequest("GET", `/api/contacts/${contactId}/sfp-readiness`, undefined, undefined, signal)).json(),
    enabled: Number.isInteger(contactId) && contactId > 0,
    staleTime: 30_000,
    retry: false,
  });
  const decisions = readinessQuery.data?.decisions ?? [];

  return (
    <Card data-testid="section-sfp-readiness">
      <CardContent className="space-y-3 pt-4 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">South Florida program (SFP) validation &amp; readiness</h3>
            <Badge variant="outline">Separate from CRM</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            This is an SFP-only decision, separate from the CRM Email Validation badge and history when present. An unvalidated CRM email
            plus a stored valid SFP outcome does not certify eligibility; a receipt is an eligible match only when it is matched,
            fresh, linked to the current employer, and the policy is eligible.
          </p>
        </div>

        {readinessQuery.isLoading ? (
          <p className="text-xs text-muted-foreground" role="status">Loading separate SFP readiness…</p>
        ) : readinessQuery.isError ? (
          <p className="text-xs text-destructive" role="alert">
            SFP readiness is unavailable; CRM email-validation history is unchanged: {(readinessQuery.error as Error).message}
          </p>
        ) : readinessQuery.data && decisions.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" role="status">
            No SFP validation decisions were returned for this contact. This is not a CRM validation result.
          </p>
        ) : readinessQuery.data ? (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              CRM email status: <span className="font-medium text-foreground">{readinessQuery.data.crmEmailStatus || "Not recorded"}</span>
              {" · "}SFP decisions: {decisions.length}
            </p>
            <div className="space-y-2">
              {decisions.map((decision, index) => {
                const eligibleMatchedReceipt = decision.receiptStatus === "matched"
                  && decision.fresh
                  && decision.currentLink
                  && decision.policyStatus.trim().toLowerCase() === "eligible";
                return (
                  <article
                    key={decision.eligibilityId || `${decision.businessId}-${index}`}
                    className="space-y-2 rounded-md border bg-muted/15 p-3"
                    data-testid={`sfp-readiness-decision-${index}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={decision.receiptStatus === "unresolved" ? "secondary" : eligibleMatchedReceipt ? "default" : "outline"}>
                        {decision.receiptStatus === "unresolved"
                          ? "Retained validation receipt unresolved"
                          : eligibleMatchedReceipt
                            ? "Matched SFP receipt · current eligible link"
                            : "Matched receipt · SFP eligibility conditions not met"}
                      </Badge>
                      <Badge variant="outline">Policy: {decision.policyStatus || "unknown"}</Badge>
                      {decision.businessId > 0 && (
                        <Link
                          href={`/dashboard/lead-ops/business/${decision.businessId}`}
                          className="text-xs underline underline-offset-2"
                        >
                          Open employer record
                        </Link>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                      <p>
                        Validation outcome: <span className="font-medium">{decision.receiptStatus === "unresolved"
                          ? "Retained validation receipt unresolved"
                          : decision.zbOutcome || "Not returned"}</span>
                      </p>
                      <p>Freshness: <span className="font-medium">{decision.fresh ? "Fresh" : "Expired or not fresh"}</span></p>
                      <p>Employer link: <span className="font-medium">{decision.currentLink ? "Current" : "Not current"}</span></p>
                      <p>SFP outcome timestamp: <span className="font-medium">{decision.validatedAt ? new Date(decision.validatedAt).toLocaleString() : "Not recorded"}</span></p>
                      <p>Expires: <span className="font-medium">{decision.expiresAt ? new Date(decision.expiresAt).toLocaleString() : "No expiry returned"}</span></p>
                      <p>Intent: <span className="font-medium">{decision.intentState || "None recorded"}</span></p>
                      <p>Enrollment: <span className="font-medium">{decision.enrollmentStatus || "None recorded"}</span></p>
                      <p>Master lead: <span className="font-medium">{decision.masterLeadId ? "Associated" : "None recorded"}</span></p>
                    </div>
                    {decision.receiptStatus === "unresolved" && (
                      <p className="text-[11px] text-muted-foreground" role="note">
                        The retained validation receipt could not be resolved to this current employer decision. This record is not represented as validated or eligible.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Lifecycle Stage Transition History ───────────────────────────────────────
interface LifecycleHistoryEntry {
  id: number;
  fromState: string | null;
  toState: string;
  trigger: string | null;
  actorType: string | null;
  actorId: string | null;
  source: string | null;
  reason: string | null;
  transitionedAt: string;
}

function LifecycleHistorySection({ contactId }: { contactId: number }) {
  const [open, setOpen] = useState(false);

  const { data: history = [], isLoading, isError, refetch } = useQuery<LifecycleHistoryEntry[]>({
    queryKey: ["/api/contacts", contactId, "lifecycle-history"],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/contacts/${contactId}/lifecycle-history`, { credentials: "include", signal });
      if (!r.ok) throw new Error("Failed to load lifecycle history");
      return r.json();
    },
    staleTime: 60_000,
    enabled: open,
  });

  const formatState = (s: string | null) =>
    s ? s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : "—";

  return (
    <Card data-testid="section-lifecycle-history">
      <CardContent className="pt-4 pb-4">
        <button
          className="flex items-center justify-between w-full text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setOpen(o => !o)}
          data-testid="button-toggle-lifecycle-history"
          aria-expanded={open}
        >
          <span className="flex items-center gap-1.5">
            <GitFork className="h-4 w-4" />
            Stage History
          </span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {open && (
          <div className="mt-3 space-y-0" data-testid="list-lifecycle-history">
            {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
            {isError && <p role="alert" className="text-sm">Stage history unavailable. <button className="min-h-11 px-3" onClick={()=>void refetch()}>Retry</button></p>}
            {!isError && !isLoading && history.length === 0 && (
              <p className="text-xs text-muted-foreground">No stage transitions recorded yet.</p>
            )}
            {history.map(entry => (
              <div
                key={entry.id}
                className="flex items-start gap-2 py-1.5 border-b last:border-0 text-xs"
                data-testid={`lifecycle-history-row-${entry.id}`}
              >
                <div className="flex-1 min-w-0">
                  <span className="font-medium">
                    {entry.fromState ? `${formatState(entry.fromState)} → ` : "Entered "}
                    {formatState(entry.toState)}
                  </span>
                  {(entry.trigger || entry.reason) && (
                    <span className="text-muted-foreground ml-1">
                      · {entry.trigger ?? entry.reason}
                    </span>
                  )}
                  {entry.actorType && (
                    <span className="text-muted-foreground/60 ml-1 text-[10px]">
                      via {entry.actorType}
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground shrink-0">
                  {new Date(entry.transitionedAt).toLocaleString("en-US", {
                    month: "short", day: "numeric",
                    hour: "numeric", minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── NPS History Panel ─────────────────────────────────────────────────────────
interface NpsResponse {
  id: number;
  token: string;
  dayTrigger: number;
  score: number | null;
  comment: string | null;
  submittedAt: string | null;
  emailSentAt: string | null;
  createdAt: string;
  reviewRequestQueued: boolean | null;
  healthAlertCreated: boolean | null;
}

function NpsScoreBadge({ score }: { score: number }) {
  if (score >= 9) return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">Promoter ({score})</span>;
  if (score >= 7) return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">Passive ({score})</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">Detractor ({score})</span>;
}

function NpsHistoryPanel({ contactId }: { contactId: number }) {
  const { data: responses = [], isLoading, isError, refetch } = useQuery<NpsResponse[]>({
    queryKey: ["/api/contacts", contactId, "nps-responses"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/contacts/${contactId}/nps-responses`, { credentials: "include", signal });
      if (!res.ok) throw new Error("NPS history unavailable");
      const data=await res.json();
      if(!Array.isArray(data))throw new Error("Invalid NPS history response");
      return data;
    },
    enabled: !!contactId,
  });

  if (isLoading) return <div className="p-6 text-center text-muted-foreground text-sm">Loading NPS history…</div>;
  if (isError) return <CrmDataState state="unavailable" message="Survey history unavailable. This does not mean no surveys exist." onRetry={()=>void refetch()}/>;

  if (responses.length === 0) {
    return (
      <Card>
        <CardContent className="pt-8 pb-8 text-center text-muted-foreground text-sm">
          No NPS surveys have been sent to this merchant yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {responses.map(r => (
        <Card key={r.id}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {r.dayTrigger === 1 ? "Go-Live Survey" : `Day-${r.dayTrigger} Check-in`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Sent: {r.emailSentAt ? new Date(r.emailSentAt).toLocaleDateString() : r.emailSentAt === null ? "Email not sent" : "—"}
                </p>
                {r.submittedAt && (
                  <p className="text-xs text-muted-foreground">
                    Submitted: {new Date(r.submittedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                {r.score !== null
                  ? <NpsScoreBadge score={r.score} />
                  : <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-muted text-muted-foreground">Pending</span>
                }
                {r.reviewRequestQueued && (
                  <span className="text-xs text-green-600">Review request sent</span>
                )}
                {r.healthAlertCreated && (
                  <span className="text-xs text-red-600">Health alert created</span>
                )}
              </div>
            </div>
            {r.comment && (
              <p className="mt-3 text-sm text-muted-foreground border-l-2 border-muted pl-3 italic">
                &ldquo;{r.comment}&rdquo;
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Churn Risk Panel ──────────────────────────────────────────────────────────
type MerchantHealthScore = {
  id: number;
  contactId: number;
  churnScore: number;
  riskTier: string;
  volumeTrendScore: number | null;
  chargebackTrendScore: number | null;
  ticketVelocityScore: number | null;
  npsScore: number | null;
  portalActivityScore: number | null;
  outreachResponseScore: number | null;
  overrideScore: number | null;
  overrideNote: string | null;
  overriddenAt: string | null;
  overriddenBy: string | null;
  retentionCampaignTriggered: boolean | null;
  agentNotified: boolean | null;
  computedAt: string | null;
};

const TIER_CFG: Record<string, { textClass: string; bgClass: string; label: string }> = {
  Critical: { textClass: "text-red-700 dark:text-red-400", bgClass: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900", label: "Critical Risk" },
  High: { textClass: "text-orange-600 dark:text-orange-400", bgClass: "bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-900", label: "High Risk" },
  Medium: { textClass: "text-amber-600 dark:text-amber-400", bgClass: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900", label: "Medium Risk" },
  Low: { textClass: "text-green-700 dark:text-green-400", bgClass: "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900", label: "Low Risk" },
};

function tierFromScore(s: number) {
  return s > 85 ? "Critical" : s > 70 ? "High" : s >= 40 ? "Medium" : "Low";
}

function ScoreBar({ value, max = 30 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const color = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-400" : "bg-green-500";
  return (
    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ChurnRiskPanel({ contactId, isManagerOrAdmin }: { contactId: number; isManagerOrAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overrideScore, setOverrideScore] = useState<string>("");
  const [overrideNote, setOverrideNote] = useState<string>("");

  const { data: score, isLoading, isError, refetch } = useQuery<MerchantHealthScore | null>({
    queryKey: ["/api/churn-scores/contact", contactId],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/churn-scores/contact/${contactId}`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Contact churn score unavailable");
      return res.json();
    },
    enabled: !!contactId,
  });

  const { data: churnWeights = [] } = useQuery<{ signalKey: string; weight: number; label: string }[]>({
    queryKey: ["/api/churn-score-weights"],
  });
  const weightsMap = Object.fromEntries(churnWeights.map(w => [w.signalKey, w.weight]));

  const computeMutation = useMutation({
    mutationFn: async () => {
      const csrf = getCsrfToken();
      const res = await fetch(`/api/churn-scores/contact/${contactId}/compute`, {
        method: "POST",
        credentials: "include",
        headers: { ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      });
      if (!res.ok) throw new Error("Computation failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/churn-scores/contact", contactId] });
      toast({ title: "Churn score recomputed successfully" });
    },
    onError: () => toast({ title: "Failed to compute churn score", variant: "destructive" }),
  });

  const overrideMutation = useMutation({
    mutationFn: async () => {
      const val = Number(overrideScore);
      if (isNaN(val) || val < 0 || val > 100) throw new Error("Score must be 0–100");
      if (!overrideNote.trim()) throw new Error("Justification is required");
      const csrf = getCsrfToken();
      const res = await fetch(`/api/churn-scores/contact/${contactId}/override`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        body: JSON.stringify({ overrideScore: val, overrideNote: overrideNote.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Override failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/churn-scores/contact", contactId] });
      setShowOverrideForm(false);
      setOverrideScore("");
      setOverrideNote("");
      toast({ title: "Churn score override saved" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const clearOverrideMutation = useMutation({
    mutationFn: async () => {
      const csrf = getCsrfToken();
      const res = await fetch(`/api/churn-scores/contact/${contactId}/override`, {
        method: "DELETE",
        credentials: "include",
        headers: { ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      });
      if (!res.ok) throw new Error("Clear override failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/churn-scores/contact", contactId] });
      toast({ title: "Override cleared — reverted to computed score" });
    },
    onError: () => toast({ title: "Failed to clear override", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16" data-testid="churn-panel-loading">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (isError) return <CrmDataState state="unavailable" message="Contact churn score unavailable; no unassessed/zero conclusion." onRetry={()=>void refetch()}/>;
  if (!score) {
    return (
      <Card data-testid="churn-panel-empty">
        <CardContent className="pt-8 pb-8 text-center space-y-4">
          <Brain className="h-12 w-12 mx-auto text-muted-foreground opacity-30" />
          <div>
            <p className="font-medium text-muted-foreground">No churn score yet</p>
            <p className="text-sm text-muted-foreground mt-1">Scores are computed nightly. You can trigger a manual computation now.</p>
          </div>
          <Button onClick={() => computeMutation.mutate()} disabled={computeMutation.isPending} data-testid="button-compute-churn">
            {computeMutation.isPending ? <span className="animate-spin mr-1 h-4 w-4 border-2 border-white border-t-transparent rounded-full inline-block" /> : <Brain className="h-4 w-4 mr-1" />}
            Compute Now
          </Button>
        </CardContent>
      </Card>
    );
  }

  const effectiveScore = score.overrideScore !== null ? score.overrideScore : score.churnScore;
  const effectiveTier = tierFromScore(effectiveScore);
  const tierCfg = TIER_CFG[effectiveTier] || TIER_CFG.Low;

  const components = [
    { key: "volume_trend", label: "Processing Volume Trend", value: score.volumeTrendScore ?? 0 },
    { key: "chargeback_trend", label: "Chargeback Ratio Trend", value: score.chargebackTrendScore ?? 0 },
    { key: "ticket_velocity", label: "Support Ticket Velocity", value: score.ticketVelocityScore ?? 0 },
    { key: "nps_score", label: "NPS Score", value: score.npsScore ?? 0 },
    { key: "portal_activity", label: "Portal Activity", value: score.portalActivityScore ?? 0 },
    { key: "outreach_response", label: "Outreach Response Rate", value: score.outreachResponseScore ?? 0 },
  ];

  return (
    <div className="space-y-4" data-testid="churn-risk-panel">
      {/* Main score card */}
      <Card className={`border-2 ${tierCfg.bgClass}`} data-testid="card-churn-score">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className={`text-4xl font-bold ${tierCfg.textClass}`} data-testid="text-churn-score">
                  {Math.round(effectiveScore)}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">/ 100</div>
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-lg font-semibold ${tierCfg.textClass}`} data-testid="text-churn-tier">{tierCfg.label}</span>
                  {score.overrideScore !== null && (
                    <Badge variant="outline" className="text-xs border-amber-400 text-amber-600" data-testid="badge-override-active">
                      Manual Override
                    </Badge>
                  )}
                  {score.retentionCampaignTriggered && (
                    <Badge variant="secondary" className="text-xs" data-testid="badge-retention-triggered">
                      <ShieldCheck className="h-3 w-3 mr-1" />
                      Retention Active
                    </Badge>
                  )}
                </div>
                {score.computedAt && (
                  <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-computed-at">
                    Last computed {new Date(score.computedAt).toLocaleDateString()} at {new Date(score.computedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
                {score.overrideScore !== null && score.overrideNote && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5" data-testid="text-override-note">
                    Override by {score.overriddenBy}: "{score.overrideNote}"
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => computeMutation.mutate()} disabled={computeMutation.isPending} data-testid="button-recompute-churn">
                <RefreshCw className={`h-4 w-4 mr-1 ${computeMutation.isPending ? "animate-spin" : ""}`} />
                Recompute
              </Button>
              {isManagerOrAdmin && (
                <>
                  {score.overrideScore !== null ? (
                    <Button variant="outline" size="sm" onClick={() => clearOverrideMutation.mutate()} disabled={clearOverrideMutation.isPending} data-testid="button-clear-override">
                      <X className="h-4 w-4 mr-1" />
                      Clear Override
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setShowOverrideForm(true)} data-testid="button-set-override">
                      <AlertOctagon className="h-4 w-4 mr-1" />
                      Override Score
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Override form */}
      {showOverrideForm && isManagerOrAdmin && (
        <Card className="border-amber-200 dark:border-amber-800" data-testid="card-override-form">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <AlertOctagon className="h-4 w-4" />
              Manual Score Override
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">New Score (0–100)</label>
              <Input
                type="number"
                min="0"
                max="100"
                value={overrideScore}
                onChange={e => setOverrideScore(e.target.value)}
                placeholder="e.g. 25"
                className="mt-1"
                data-testid="input-override-score"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Justification (required)</label>
              <Textarea
                value={overrideNote}
                onChange={e => setOverrideNote(e.target.value)}
                placeholder="Reason for overriding the computed score..."
                className="mt-1 min-h-[80px]"
                data-testid="input-override-note"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => overrideMutation.mutate()} disabled={overrideMutation.isPending} data-testid="button-save-override">
                {overrideMutation.isPending ? "Saving…" : "Save Override"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowOverrideForm(false)} data-testid="button-cancel-override">
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Score breakdown */}
      <Card data-testid="card-churn-breakdown">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            Signal Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Column headers */}
          <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b">
            <span>Signal</span>
            <span className="text-center">Raw</span>
            <span className="text-right">Weight</span>
          </div>
          {components.map(c => {
            const weight = weightsMap[c.key] ?? 1.0;
            return (
              <div key={c.key} data-testid={`row-signal-${c.key}`}>
                <div className="grid grid-cols-3 items-center text-sm mb-1">
                  <span className="text-muted-foreground text-xs">{c.label}</span>
                  <span className="font-medium text-center">{Math.round(c.value)}</span>
                  <span className="text-right text-xs text-muted-foreground">×{weight.toFixed(2)}</span>
                </div>
                <ScoreBar value={c.value} />
              </div>
            );
          })}
          {score.overrideScore !== null && (
            <p className="text-xs text-muted-foreground pt-1 italic">
              Computed score: {Math.round(score.churnScore)} · Override applied: {Math.round(score.overrideScore)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* #1337 — Trigger signals: why this account was flagged */}
      {Array.isArray((score as any).triggerSignals) && (score as any).triggerSignals.length > 0 && (
        <Card data-testid="card-churn-trigger-signals">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Why Flagged — Trigger Signals
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground mb-2">
              These are the specific signals that triggered this account's churn risk flag.
            </p>
            <div className="flex flex-wrap gap-2">
              {((score as any).triggerSignals as string[]).map((sig: string) => (
                <Badge key={sig} variant="outline" className="text-xs border-amber-300 bg-amber-50 text-amber-800">
                  {sig.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Next Best Action Card ─────────────────────────────────────────────────────
// Compact card shown above the tab section. Fetches NBA for the contact and
// provides Execute / Dismiss actions. Non-intrusive: only renders when there is
// an OPEN or BLOCKED recommendation.

const NBA_URGENCY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high:     "bg-orange-100 text-orange-800 border-orange-200",
  normal:   "bg-blue-100 text-blue-800 border-blue-200",
  low:      "bg-gray-100 text-gray-600 border-gray-200",
};

interface NbaData {
  id: number;
  contactId?: number;
  actionType: string | null;
  channel: string | null;
  ownerRole: string | null;
  dueAt: string | null;
  urgency: string | null;
  reasonCode: string | null;
  explanation: string | null;
  confidence: number | null;
  humanRequired: boolean | null;
  automationEligible: boolean | null;
  status: string | null;
}

function ContactNbaCard({ contactId }: { contactId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<{ nba: NbaData | null }>({
    queryKey: [`/api/contacts/${contactId}/nba`],
    refetchInterval: 60_000,
    retry: false,
  });

  const executeMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/contacts/${contactId}/nba/execute`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/contacts/${contactId}/nba`] });
      toast({ title: "Action marked as done — next recommendation will compute shortly." });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/contacts/${contactId}/nba/dismiss`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/contacts/${contactId}/nba`] });
      toast({ title: "Recommendation dismissed." });
    },
  });

  if (isLoading) {
    return <div className="text-xs text-muted-foreground" role="status">Loading next best action…</div>;
  }
  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert" data-testid="nba-load-error">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Next best action is unavailable: {(error as Error)?.message ?? "request failed"}
      </div>
    );
  }
  if (!data?.nba) {
    return <div className="text-xs text-muted-foreground" role="status">No next best action is currently available.</div>;
  }
  const nba = data.nba;

  // Only show OPEN or BLOCKED (BLOCKED still informs the rep)
  if (!["OPEN", "BLOCKED"].includes(nba.status ?? "")) return null;

  const urgency = nba.urgency ?? "normal";
  const urgencyStyle = NBA_URGENCY_STYLE[urgency] ?? NBA_URGENCY_STYLE.normal;
  const isBlocked = nba.status === "BLOCKED";
  const dueAt = nba.dueAt ? new Date(nba.dueAt) : null;
  const isOverdue = dueAt != null && !Number.isNaN(dueAt.getTime()) && dueAt < new Date();

  const dueSuffix = (() => {
    if (!dueAt || Number.isNaN(dueAt.getTime())) return null;
    const d = dueAt;
    const diffH = Math.round((d.getTime() - Date.now()) / 3_600_000);
    if (diffH < 0) return `${Math.abs(diffH)}h overdue`;
    if (diffH < 24) return `due in ${diffH}h`;
    return `due in ${Math.round(diffH / 24)}d`;
  })();

  return (
    <Card
      className={`border ${isOverdue && !isBlocked ? "border-orange-300 bg-orange-50/40 dark:bg-orange-950/20" : isBlocked ? "border-gray-200 bg-gray-50/60 dark:bg-gray-900/30" : "border-primary/20 bg-primary/5"}`}
      data-testid="card-nba"
    >
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Icon + label */}
          <div className={`p-1.5 rounded-md border ${urgencyStyle}`}>
            <Zap className="h-3.5 w-3.5" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">
                {(nba.actionType ?? "Recommended action").replace(/_/g, " ")}
              </span>
              <Badge variant="outline" className={`text-xs ${urgencyStyle}`}>
                {urgency}
              </Badge>
              {nba.humanRequired && (
                <Badge variant="outline" className="text-xs text-orange-700 border-orange-300">
                  Human required
                </Badge>
              )}
              {isBlocked && (
                <Badge variant="outline" className="text-xs text-gray-500 dark:text-gray-300 border-gray-300">
                  Blocked
                </Badge>
              )}
              {isOverdue && !isBlocked && (
                <Badge variant="outline" className="text-xs text-red-700 border-red-300">
                  Overdue
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
              {nba.channel && (
                <span className="flex items-center gap-1">
                  <Mail className="h-3 w-3" />
                  {nba.channel.replace(/_/g, " ")}
                </span>
              )}
              {nba.ownerRole && (
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  {nba.ownerRole}
                </span>
              )}
              {dueSuffix && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {dueSuffix}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground/70 italic">
                {(nba.reasonCode ?? "Reason not provided").replace(/_/g, " ")}
              </span>
            </div>

            {nba.explanation && (
              <p className="mt-1 text-xs text-muted-foreground italic line-clamp-1">
                {nba.explanation}
              </p>
            )}
          </div>

          {/* Human workflow only; this records completion/dismissal and never sends outreach. */}
          {!isBlocked && (
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => executeMutation.mutate()}
                disabled={executeMutation.isPending}
                data-testid="button-nba-execute"
              >
                {executeMutation.isPending ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Mark done"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => dismissMutation.mutate()}
                disabled={dismissMutation.isPending}
                data-testid="button-nba-dismiss"
              >
                Dismiss
              </Button>
            </div>
          )}
        </div>
        {isBlocked && (
          <p className="mt-2 text-xs text-muted-foreground">
            This recommendation is blocked. No action or outreach can be started from this card.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Document Access History ───────────────────────────────────────────────────
// Shows which users accessed documents belonging to this contact.
interface AccessEntry {
  id: number;
  documentId: number;
  documentName: string;
  userId: string;
  ip: string | null;
  accessedAt: string;
}
function DocumentAccessHistory({ contactId }: { contactId: number }) {
  const { data: logs = [], isLoading } = useQuery<AccessEntry[]>({
    queryKey: [`/api/contacts/${contactId}/document-access-history`],
  });
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (!logs.length) return <p className="text-xs text-muted-foreground">No document access events recorded.</p>;
  return (
    <div className="space-y-0">
      {logs.slice(0, 20).map(entry => (
        <div key={entry.id} className="flex items-center gap-2 text-xs py-1.5 border-b last:border-0">
          <span className="font-medium truncate max-w-[160px]">{entry.documentName}</span>
          <span className="text-muted-foreground shrink-0">accessed by</span>
          <span className="font-mono text-[10px] truncate">{entry.userId}</span>
          {entry.ip && <span className="text-muted-foreground font-mono text-[10px] shrink-0">{entry.ip}</span>}
          <span className="ml-auto text-muted-foreground shrink-0">
            {new Date(entry.accessedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ContactDetail() {
  const params = useParams<{ id: string }>();
  useAuth();
  const requested=contactWorkspaceState(useSearch());
  if (!parseLocalEntityId("contactId", params.id ?? "")) {
    return <div className="crm-page">
      <CrmPageHeader title="Contact unavailable" description="The Contact reference is not a valid local Contact ID." />
      <p role="alert">No record was opened. Choose a Contact from People.</p>
      <Link href="/dashboard/contacts" className="inline-flex min-h-11 items-center underline"
        data-testid="link-invalid-contact-people">Back to People</Link>
    </div>;
  }
  if(requested.issues.length) return <CrmPage>
    <CrmPageHeader title="Contact view unavailable" description="The requested area, section or drawer is invalid or conflicting." />
    <CrmDataState state="unavailable" message="No protected record or child reads were opened for this URL." />
    <Link href={`/dashboard/contacts/${params.id}`} className="inline-flex min-h-11 items-center underline">Open contact overview</Link>
  </CrmPage>;
  return <ContactDetailRecord key={`${params.id}:${protectedContextToken()}`} />;
}

function ContactDetailRecord() {
  const outbound=useOutboundPauseObservation();
  const employeeCrm = useEmployeeCrm();
  const params = useParams<{ id: string }>();
  const search = useSearch();
  const contactId = Number(params.id);
  const moreActionsButtonRef = useRef<HTMLButtonElement>(null);
  const primaryActionButtonRef = useRef<HTMLButtonElement>(null);
  const newTaskActionButtonRef = useRef<HTMLButtonElement>(null);
  const requestedDrawer = contactWorkspaceState(search).drawer;
  const requestedWorkspace = contactWorkspaceState(search);
  const requestedSection = requestedWorkspace.section ?? "overview";
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const { user } = useAuth();
  const noteIntents=useRetainedLocalIntent();
  const isManagerOrAdmin = user?.role === "admin" || user?.role === "manager";
  const [isEditing, setIsEditing] = useState(false);

  const { data: agentsList } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/agents", { credentials: "include", signal });
      if (!res.ok) throw new Error("Agent list unavailable");
      return res.json();
    },
    enabled: isManagerOrAdmin && isEditing,
  });

  const [editFields, setEditFields] = useState<Record<string, string | null | undefined>>({});
  const [tagInput, setTagInput] = useState("");
  const [editSupportedVerticals, setEditSupportedVerticals] = useState<string[]>([]); // #1443
  // Deal field editing — populated from the first active deal when entering edit mode
  const [editDealId, setEditDealId] = useState<number | null>(null);
  const [editDealFields, setEditDealFields] = useState<{ name: string; offerPath: string }>({ name: "", offerPath: "" });
  // (RFI dialog state is managed inside RfiTab component)

  // #259 — warn before leaving with unsaved edits
  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isEditing]);

  // Edits remain local until Save. A remote autosave cannot satisfy Cancel's
  // zero-write contract; abandoning the form must not modify the record.
  const [noteContent, setNoteContent] = useState("");

  const [showLinkedinHistory, setShowLinkedinHistory] = useState(false);

  const [showDealDialog, setShowDealDialog] = useState(false);
  const [dealForm, setDealForm] = useState({ pipeline: "sales", stage: "New Lead", offerPath: "", notes: "" });

  // Retirement is not a configuration problem. Do not probe a retired
  // provider on record mount or suggest a key can restore this action.
  const proxycurlConfigured = false;

  const enrichLinkedInMutation = useMutation({
    mutationFn: async () => {
      throw new Error("Direct LinkedIn enrichment is retired; CRO-03 provider transport is disabled.");
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
      if (data.fieldsUpdated && data.fieldsUpdated.length > 0) {
        toast({ title: "LinkedIn enrichment complete", description: `Updated: ${data.fieldsUpdated.join(", ")}` });
      } else {
        toast({ title: "LinkedIn enrichment complete", description: "No new fields to update — all fields already populated." });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Direct LinkedIn enrichment retired", description: err.message, variant: "destructive" });
    },
  });

  const [showTicketDialog, setShowTicketDialog] = useState(false);
  const [ticketForm, setTicketForm] = useState({ subject: "", description: "", priority: "Normal", category: "Other" });
  const ticketCreation=useTicketCreateCommand(`contact:${contactId}`);
  const ticketBusy=useRef(false);
  const [ticketSaving,setTicketSaving]=useState(false);
  useEffect(()=>{
    setShowTicketDialog(false);
    setTicketForm({subject:"",description:"",priority:"Normal",category:"Other"});
  },[ticketCreation.context]);

  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", description: "", dueDate: "" });
  const [taskSaving,setTaskSaving]=useState(false);
  const [taskSaveError,setTaskSaveError]=useState<string|null>(null);

  const [emailComposerOpen, setEmailComposerOpen] = useState(false);
  const [logCallOpen, setLogCallOpen] = useState(false); // #1475
  const [nextStepsOpen, setNextStepsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [showCompanyDialog, setShowCompanyDialog] = useState(false);
  const [companyMode, setCompanyMode] = useState<"existing" | "new">("existing");
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [companyRole, setCompanyRole] = useState("");
  const [companyIsPrimary, setCompanyIsPrimary] = useState(false);
  const [newCompanyForm, setNewCompanyForm] = useState({ legalName: "", dba: "", vertical: "", website: "" });
  const [companySearch, setCompanySearch] = useState("");

  const { data, isLoading, error, refetch } = useQuery<ContactDetailData>({
    queryKey: ["/api/contacts", contactId, "detail", requestedSection],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/contacts/${contactId}/detail?section=${encodeURIComponent(requestedSection)}`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Failed to fetch contact details");
      return res.json();
    },
    enabled: !!contactId,
  });
  const detailAuthorized = Boolean(data?.contact && !error);
  const sectionReadAllowed = (section: ContactSection) => {
    if (!detailAuthorized || requestedSection !== section) return false;
    if (section === "company-intelligence") return !!data?.contact?.isParentAccount;
    if (section === "call-assist") return user?.role === "agent" || user?.role === "manager" || user?.role === "admin";
    if (section === "onboarding-stages") return data?.capabilities?.hasOnboarding === true;
    return true;
  };

  const { data: activityEvents, isLoading: activityLoading, isError: activityError, refetch: retryActivity } = useQuery<ActivityEvent[]>({
    queryKey: ["/api/contacts", contactId, "activity"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/contacts/${contactId}/activity`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Contact activity is unavailable");
      return res.json();
    },
    enabled: detailAuthorized && requestedDrawer === "activity",
  });

  const { data: contactCompanies, isLoading: contactCompaniesLoading, isError: contactCompaniesError, refetch: retryContactCompanies } = useQuery<ContactCompany[]>({
    queryKey: ["/api/contacts", contactId, "companies"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/contacts/${contactId}/companies`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Contact company associations unavailable");
      return res.json();
    },
    enabled: sectionReadAllowed("overview") || (detailAuthorized && showCompanyDialog),
  });

  type RateReviewEntry = {
    id: number;
    status: string | null;
    createdAt: string | null;
    repViewedAt: string | null;
    resolvedAt: string | null;
    resolution: string | null;
    dealId: number | null;
    document?: { id: number; fileName: string } | null;
  };
  const { data: rateReviews, isError: rateReviewsError, isLoading: rateReviewsLoading, refetch: refetchRateReviews } = useQuery<RateReviewEntry[]>({
    queryKey: ["/api/rate-reviews/contact", contactId],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/rate-reviews/contact/${contactId}`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Rate review status unavailable");
      return res.json();
    },
    enabled: sectionReadAllowed("overview"),
  });

  const markRateReviewViewedMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/rate-reviews/${id}/mark-viewed`);
      return res.json();
    },
    onSuccess: () => {
      refetchRateReviews();
      toast({ title: "Marked as viewed" });
    },
  });

  const generateRetentionProposalMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/rate-reviews/${id}/generate-proposal`);
      return res.json();
    },
    onSuccess: () => {
      refetchRateReviews();
      toast({ title: "Retention proposal queued", description: "AI is generating the proposal. Check the deal's proposals tab shortly." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const { data: allCompanies = [], isLoading: companiesLoading, isError: companiesError, refetch: retryCompanies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: detailAuthorized && showCompanyDialog,
  });

  const { data: confirmationResult } = useQuery<{
    latestStatus: SubmissionStatus | null;
    submissions: SubmissionStatus[];
    hasConfirmationRecord: boolean;
  }>({
    queryKey: ["/api/contacts", contactId, "confirmation-status"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/contacts/${contactId}/confirmation-status`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Contact confirmation status unavailable");
      return res.json();
    },
    enabled: sectionReadAllowed("overview"),
  });

  const addCompanyAssociation = useMutation({
    mutationFn: async (body: { companyId: number; role?: string; isPrimary?: boolean }) => {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/companies`, body);
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "companies"] });
      setShowCompanyDialog(false);
      setSelectedCompanyId("");
      setCompanyRole("");
      setCompanyIsPrimary(false);
      setNewCompanyForm({ legalName: "", dba: "", vertical: "", website: "" });
      toast({ title: "Company linked",description:result.extractionState==="completed"?"Relationship reconciliation completed.":
        "Membership is saved. Relationship reconciliation remains incomplete or requires management review." });
    },
    onError: () => {
      toast({ title: "Failed to link company", variant: "destructive" });
    },
  });

  const removeCompanyAssociation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/contact-companies/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "companies"] });
      toast({ title: "Company unlinked" });
    },
    onError: () => {
      toast({ title: "Failed to unlink company", variant: "destructive" });
    },
  });

  const { data: ghlSyncStatus, refetch: refetchGhlStatus } = useQuery<{
    ghlContactId: string | null;
    isSynced: boolean;
    isRecent: boolean;
    lastSyncedAt: string | null;
    syncAgeMs: number | null;
  }>({
    queryKey: ["/api/ghl/sync-status/contact", contactId],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/ghl/sync-status/contact/${contactId}`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Failed to fetch sync status");
      return res.json();
    },
    refetchInterval: 60000,
    staleTime: 30000,
    enabled: sectionReadAllowed("overview"),
  });

  const { data: repsList = [] } = useQuery<{ id: string; email: string; firstName: string; lastName: string; role: string }[]>({
    queryKey: ["/api/users/reps"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/users/reps", { credentials: "include", signal });
      if (!res.ok) throw new Error("Representative list unavailable");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: detailAuthorized && isEditing,
  });

  const { data: parentAccount } = useQuery<Contact | null>({
    queryKey: ["/api/contacts", contactId, "parent"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/contacts/${contactId}/parent`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Parent account context unavailable");
      return res.json();
    },
    enabled: sectionReadAllowed("overview"),
    staleTime: 30000,
  });

  const resyncToGhlMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/ghl/sync-contact/${contactId}`);
      return res.json();
    },
    onSuccess: (data: { success: boolean; ghlContactId?: string; error?: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
      refetchGhlStatus();
      if (data.success) {
        toast({ title: "Re-synced to GHL", description: `GHL Contact ID: ${data.ghlContactId}` });
      } else {
        toast({ title: "Sync failed", description: data.error || "GHL sync encountered an error", variant: "destructive" });
      }
    },
    onError: () => {
      toast({ title: "GHL sync failed", variant: "destructive" });
    },
  });

  const createAndLinkCompany = useMutation({
    mutationFn: async () => {
      const companyRes = await apiRequest("POST", "/api/companies", {
        legalName: newCompanyForm.legalName,
        dba: newCompanyForm.dba || undefined,
        vertical: newCompanyForm.vertical || undefined,
        website: newCompanyForm.website || undefined,
      });
      const company = await companyRes.json();
      const linkRes = await apiRequest("POST", `/api/contacts/${contactId}/companies`, {
        companyId: company.id,
        role: companyRole || undefined,
        isPrimary: companyIsPrimary,
      });
      return linkRes.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      setShowCompanyDialog(false);
      setSelectedCompanyId("");
      setCompanyRole("");
      setCompanyIsPrimary(false);
      setNewCompanyForm({ legalName: "", dba: "", vertical: "", website: "" });
      toast({ title: "Company created and linked" });
    },
    onError: () => {
      toast({ title: "Failed to create company", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className={`${employeeCrm ? "crm-page" : "p-4 md:p-6"} space-y-6`} data-testid="contact-detail-loading">
        <h1>Contact record</h1>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-6 w-32" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  if (error || !data?.contact) {
    return (
      <div className={`${employeeCrm ? "crm-page" : "p-4 md:p-6"} space-y-4`} data-testid="contact-detail-error">
        <h1>Contact record unavailable</h1>
        <Button variant="ghost" onClick={() => setLocation("/dashboard/contacts")} data-testid="button-back-error">
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Contacts
        </Button>
        <CrmDataState state="unavailable" message={error instanceof Error ? error.message : "Contact not found."} onRetry={() => void refetch()} />
      </div>
    );
  }

  const { contact } = data;
  const dealsLoaded = data.loaded?.deals ?? Array.isArray(data.deals);
  const ticketsLoaded = data.loaded?.tickets ?? Array.isArray(data.tickets);
  const tasksLoaded = data.loaded?.tasks ?? Array.isArray(data.tasks);
  const notesLoaded = data.loaded?.notes ?? Array.isArray(data.notes);
  const deals = data.deals ?? [];
  const tickets = data.tickets ?? [];
  const tasks = data.tasks ?? [];
  const allNotes = notesLoaded ? data.notes ?? [] : [];
  const notes = notesLoaded ? data.notes ?? [] : undefined;
  const sortedNotes = [...allNotes].sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());

  const openTickets = ticketsLoaded ? tickets.filter(t => t.status !== "Resolved" && t.status !== "Closed") : undefined;
  const pendingTasks = tasksLoaded
    ? tasks.filter(isPendingTask)
    : undefined;
  const totalDealVolume = dealsLoaded ? (() => {
    const activeDeals = deals.filter(deal => !deal.archivedAt);
    if (!activeDeals.length) return 0;
    const volumes = activeDeals.map(deal => {
      const raw = deal.totalVolume ?? (deal as any).monthlyVolume;
      if (raw == null || String(raw).trim() === "") return null;
      const value = Number.parseFloat(String(raw));
      return Number.isFinite(value) ? value : null;
    });
    return volumes.some(volume => volume === null)
      ? null
      : volumes.reduce<number>((sum, volume) => sum + (volume ?? 0), 0);
  })() : null;
  const hasHeaderActiveDealFact = !!data.headerDealFacts && Object.prototype.hasOwnProperty.call(data.headerDealFacts, "activeDeal");
  const activeHeaderDeal = hasHeaderActiveDealFact
    ? data.headerDealFacts?.activeDeal ?? null
    : dealsLoaded
      ? deals.find(deal => !deal.archivedAt && deal.stage !== "Closed Won" && deal.stage !== "Closed Lost") ?? null
      : undefined;
  const headerActiveDealKnown = hasHeaderActiveDealFact || dealsLoaded;
  const hasHeaderNextFollowUpFact = !!data.headerDealFacts && Object.prototype.hasOwnProperty.call(data.headerDealFacts, "nextFollowUp");
  const nextFollowUp = hasHeaderNextFollowUpFact
    ? data.headerDealFacts?.nextFollowUp ?? null
    : dealsLoaded
      ? deals.find(deal => deal.nextFollowUp && !deal.archivedAt)?.nextFollowUp?.toString() ?? null
      : undefined;
  const nextFollowUpDate = nextFollowUp ? new Date(nextFollowUp) : null;
  const headerNextAction = nextFollowUpDate
    ? Number.isNaN(nextFollowUpDate.getTime())
      ? "Follow-up date needs review"
      : `Follow up ${nextFollowUpDate.toLocaleString()}`
    : pendingTasks?.[0]
      ? `Complete task: ${pendingTasks[0].title}`
      : nextFollowUp === undefined || pendingTasks === undefined
        ? "Scheduled action unavailable"
        : "No next action scheduled";

  const startEdit = () => {
    setEditFields({
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      companyName: contact.companyName,
      vertical: contact.vertical,
      monthlyVolume: contact.monthlyVolume,
      currentProvider: contact.currentProvider,
      preferredChannel: contact.preferredChannel,
      assignedTo: (contact as any).assignedTo ?? null,
      referralSource: (contact as any).referralSource ?? "", // #508
    });
    // #1443 — Initialise supported verticals from tags prefixed with "vertical:"
    const tagVerticals = (contact.tags ?? [])
      .filter((t: string) => t.startsWith("vertical:"))
      .map((t: string) => t.slice("vertical:".length));
    setEditSupportedVerticals(tagVerticals);
    // Populate deal edit fields from the first active (non-archived, non-closed) deal
    const activeDeal = deals?.find((d: any) => !d.archivedAt && d.stage !== "Closed Won" && d.stage !== "Closed Lost");
    if (activeDeal) {
      setEditDealId(activeDeal.id);
      setEditDealFields({
        name: (activeDeal as any).name ?? "",
        offerPath: (activeDeal as any).offerPath ?? "",
      });
    } else {
      setEditDealId(null);
      setEditDealFields({ name: "", offerPath: "" });
    }
    setIsEditing(true);
  };

  const finishEdit = () => {
    setIsEditing(false);
    window.setTimeout(() => moreActionsButtonRef.current?.focus(), 0);
  };

  const saveEdit = async () => {
    try {
      // assignedTo routes through the validated PATCH /assign endpoint.
      // All other fields go through the generic PUT.
      // Assignment is done FIRST — if the user lacks permission it fails before
      // any other fields are persisted, avoiding a partial-save state.
      const { assignedTo: newAssignedTo, ...otherFields } = editFields;
      const originalAssignedTo = (contact as any).assignedTo ?? null;
      const canAssign = user?.role === "admin" || user?.role === "manager";

      if (canAssign && newAssignedTo !== originalAssignedTo) {
        const csrfToken = await getCsrfToken();
        const assignRes = await fetch(`/api/contacts/${contactId}/assign`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          body: JSON.stringify({ assignedTo: newAssignedTo ?? null }),
        });
        if (!assignRes.ok) {
          const err = await assignRes.json().catch(() => ({}));
          throw new Error(err.message || "Failed to assign contact");
        }
      }

      // #1443 — Merge supportedVerticals back into tags as "vertical:X" prefixed entries
      const currentTags = (contact.tags ?? []).filter((t: string) => !t.startsWith("vertical:"));
      const newTags = [...currentTags, ...editSupportedVerticals.map(v => `vertical:${v}`)];
      await updateContact.mutateAsync({ id: contactId, ...otherFields, tags: newTags });

      // Save deal name + offerPath if a deal was selected for editing.
      // A failure here is surfaced to the user — we must not exit edit mode or toast success
      // when the deal fields were not persisted (reviewer feedback on silent partial-saves).
      if (editDealId) {
        const dealPayload: Record<string, unknown> = {
          name: editDealFields.name.trim() || null,
          offerPath: editDealFields.offerPath || null,
        };
        const dealRes = await apiRequest("PUT", `/api/deals/${editDealId}`, dealPayload);
        if (!dealRes.ok) {
          const errBody = await dealRes.json().catch(() => ({}));
          throw new Error(errBody.message || "Failed to save deal name / offer path");
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
      finishEdit();
      toast({ title: "Contact updated" });
    } catch (err: any) {
      toast({ title: "Failed to update contact", description: err?.message, variant: "destructive" });
    }
  };

  const addTag = async () => {
    const tag = tagInput.trim();
    if (!tag) return;
    const currentTags = contact.tags ?? [];
    if (currentTags.includes(tag)) { setTagInput(""); return; }
    try {
      await updateContact.mutateAsync({ id: contactId, tags: [...currentTags, tag] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
      setTagInput("");
    } catch {
      toast({ title: "Failed to add tag", variant: "destructive" });
    }
  };

  const removeTag = async (tag: string) => {
    const currentTags = contact.tags ?? [];
    try {
      await updateContact.mutateAsync({ id: contactId, tags: currentTags.filter(t => t !== tag) });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
    } catch {
      toast({ title: "Failed to remove tag", variant: "destructive" });
    }
  };

  const addNote = async () => {
    if (!noteContent.trim()) return;
    try {
      await apiRequest("POST", "/api/notes",noteIntents.payload(`create:${contactId}`,{
        entityType: "contact",
        entityId: contactId,
        content: noteContent.trim(),
      }));
      noteIntents.accepted(`create:${contactId}`);
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
      setNoteContent("");
      toast({ title: "Note added" });
    } catch {
      toast({ title: "Failed to add note", variant: "destructive" });
    }
  };

  const createDeal = async () => {
    if (!dealForm.stage) {
      toast({ title: "Stage required", description: "Select a pipeline stage before creating the deal.", variant: "destructive" });
      return;
    }
    try {
      await apiRequest("POST", "/api/deals", {
        contactId,
        pipeline: dealForm.pipeline,
        stage: dealForm.stage,
        offerPath: dealForm.offerPath || undefined,
        notes: dealForm.notes || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
      setShowDealDialog(false);
      setDealForm({ pipeline: "sales", stage: "New Lead", offerPath: "", notes: "" });
      toast({ title: "Deal created" });
    } catch {
      toast({ title: "Failed to create deal", variant: "destructive" });
    }
  };

  const createTicket = async () => {
    if (ticketBusy.current||!ticketForm.subject.trim() || !ticketForm.description.trim()) return;
    ticketBusy.current=true;setTicketSaving(true);
    try {
      const result=await ticketCreation.execute({
        contactId,
        subject: ticketForm.subject,
        description: ticketForm.description,
        priority: ticketForm.priority,
        category: ticketForm.category,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
      setShowTicketDialog(false);
      setTicketForm({ subject: "", description: "", priority: "Normal", category: "Other" });
      toast({ title: result.command.reused?"Existing active ticket retained":"Local ticket creation confirmed",
        description:"No native delivery was attempted." });
    } catch(error:any) {
      toast({ title: "Ticket creation failed or unconfirmed",description:error?.message, variant: "destructive" });
    }finally{ticketBusy.current=false;setTicketSaving(false);}
  };
  const retryTicketCreation=async()=>{
    if(ticketBusy.current)return;
    ticketBusy.current=true;setTicketSaving(true);
    try{
      const result=await ticketCreation.retry("create");
      queryClient.invalidateQueries({queryKey:["/api/contacts",contactId,"detail"]});
      setShowTicketDialog(false);
      setTicketForm({subject:"",description:"",priority:"Normal",category:"Other"});
      toast({title:result.command.reused?"Existing active ticket retained":"Captured local ticket intent confirmed"});
    }catch(error:any){toast({title:"Ticket intent remains unconfirmed",description:error?.message,variant:"destructive"});}
    finally{ticketBusy.current=false;setTicketSaving(false);}
  };

  const createTask = async () => {
    if(taskSaving)return;
    if (!taskForm.title.trim()) {setTaskSaveError("Task title is required.");return;}
    setTaskSaving(true);setTaskSaveError(null);
    try {
      const response=await apiRequest("POST", "/api/tasks", noteIntents.payload("task",{
        contactId,
        title: taskForm.title.trim(),
        description: taskForm.description || undefined,
        dueDate: taskForm.dueDate ? new Date(taskForm.dueDate).toISOString() : undefined,
      }));
      const saved=await response.json();
      if(!Number.isSafeInteger(saved?.id)||saved.contactId!==contactId)throw new Error("Task confirmation did not match this record.");
      noteIntents.accepted("task");invalidateWorkFacts();
      setShowTaskDialog(false);
      setTaskForm({ title: "", description: "", dueDate: "" });
      toast({ title: "Task created" });
    } catch(error) {
      const message=error instanceof Error?error.message:"Task confirmation unavailable";
      setTaskSaveError(`${message} Save is not confirmed. Retry the unchanged intent to avoid duplicating a committed task.`);
    } finally {setTaskSaving(false);}
  };

  const permittedSections = contactSections.filter((section) => {
    if (section === "activity" || section === "history") return true;
    if (section === "call-assist") return user?.role === "agent" || user?.role === "manager" || user?.role === "admin";
    if (section === "company-intelligence") return !!contact?.isParentAccount;
    if (section === "sales-prep") return data.capabilities?.sdrSourced === true;
    if (section === "onboarding-stages") return data.capabilities?.hasOnboarding === true;
    return true;
  });
  const workspace = contactWorkspaceState(search, permittedSections);
  const activeTab = workspace.section ?? "";
  const setActiveTab = (section: string) => {
    if (!contactSections.includes(section as ContactSection) || section === "activity" || section === "history") return;
    const area = contactSectionArea(section as ContactSection);
    if (!area) return;
    setLocation(buildContactWorkspaceHref(window.location.href, { area, section: section as ContactSection, drawer: null }));
  };
  const setDrawer = (drawer: "activity" | "history" | null) => {
    setLocation(buildContactWorkspaceHref(window.location.href, { drawer }));
  };
  const areaLabels: Record<ContactArea, string> = {
    overview: "Overview",
    "sales-work": "Sales work",
    conversations: "Conversations",
    lifecycle: "Lifecycle",
    "service-performance": "Service & performance",
  };
  const sectionLabels: Record<ContactSection, string> = {
    overview: "Summary", relationships: "Relationships", locations: "Locations", "company-intelligence": "Company intelligence",
    deals: "Deals", tasks: "Tasks", "call-logs": "Calls & VMs", "call-assist": "Call assist",
    "offer-intelligence": "Offer intelligence", "sales-prep": "Sales prep", "comm-timeline": "Communication timeline",
    "comm-health": "Communication health", "delivery-log": "Delivery log", notes: "Notes", comments: "Comments",
    documents: "Documents", "onboarding-stages": "Onboarding stages", rfis: "RFIs", tickets: "Tickets",
    "live-processing": "Live processing", chargebacks: "Chargebacks", "churn-risk": "Churn risk", nps: "NPS",
    activity: "Activity", history: "History",
  };
  const areaEntries = contactAreas.map((area) => {
    const first = contactAreaSections[area].find(section => workspace.permittedSections.includes(section));
    return {
      label: areaLabels[area],
      href: first ? buildContactWorkspaceHref(window.location.href, { area, section: first, drawer: null }) : "#",
      allowed: !!first,
      reason: "No sections are available for this Contact.",
    };
  });
  const currentAreaFirst = workspace.area
    ? contactAreaSections[workspace.area].find(section => workspace.permittedSections.includes(section))
    : undefined;
  const currentAreaHref = workspace.area && currentAreaFirst
    ? buildContactWorkspaceHref(window.location.href, { area: workspace.area, section: currentAreaFirst, drawer: null })
    : "";

  return (
    <div className={`${employeeCrm ? "crm-page" : ""} space-y-4 pb-6`} data-testid="contact-detail-page">
      {/* Header */}
      <RecordHeader className="flex flex-col gap-3">
        <Button variant="ghost" className="self-start" onClick={() => setLocation("/dashboard/contacts")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Contacts
        </Button>

        {!isEditing && (
          <div className="min-w-0 space-y-3" data-testid="contact-compact-header">
            <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-2">
                <h1 className="break-words text-2xl font-semibold tracking-tight" data-testid="text-contact-name">
                  {contact.companyName ||
                    `${contact.firstName || ""} ${contact.lastName || ""}`.trim() ||
                    contact.email ||
                    contact.phone ||
                    "Unnamed Contact"}
                </h1>
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {contact.companyName && <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="text-company"><Building2 className="h-4 w-4 shrink-0" /><span className="break-words">{contact.companyName}</span></span>}
                  {contact.email && (
                    <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="text-email">
                      <Mail className="h-4 w-4 shrink-0" />
                        <span className="break-all">{contact.email}</span>
                    </span>
                  )}
                  {contact.phone && (
                    <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="text-phone">
                      <Phone className="h-4 w-4 shrink-0" />
                        <span className="break-all">{contact.phone}</span>
                    </span>
                  )}
                  <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="text-assigned-rep"><UserCheck className="h-4 w-4 shrink-0" /><span className="break-words">Owner: {(contact as any).assignedTo || "Unassigned"}</span></span>
                  {contact.vertical && <Badge variant="outline" data-testid="badge-vertical">{contact.vertical}</Badge>}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="contact-authority-status">
                  <Badge variant={statusColor(contact.status)} data-testid="badge-status">{contact.status}</Badge>
                  <Badge variant="outline" data-testid="badge-lifecycle-state">
                    Lifecycle: {(contact as any).lifecycleState
                      ? String((contact as any).lifecycleState).replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase())
                      : "Not recorded"}
                  </Badge>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="contactability-status">
                    <span>Email consent: <strong className="font-medium text-foreground">{(contact as any).consentEmail ? "Recorded" : "Not recorded"}</strong></span>
                    <span>SMS consent: <strong className="font-medium text-foreground">{(contact as any).consentSms ? "Recorded" : "Not recorded"}</strong></span>
                    {(contact as any).doNotContact && <span className="font-medium text-destructive">Do not contact{(contact as any).dncReason ? ` · ${(contact as any).dncReason}` : ""}</span>}
                    {(contact as any).emailStatus && <span>Email status: <strong className="font-medium text-foreground">{String((contact as any).emailStatus).replace(/_/g, " ")}</strong></span>}
                  </span>
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="outbound-pause-status" role="status">
                    <span className="font-medium">
                      {outbound.isLoading
                        ? "Checking outbound pause state"
                        : outbound.isError
                          ? "Outbound pause state unavailable"
                          : outbound.data?.state === "paused"
                            ? "Outbound paused"
                            : outbound.data?.state === "activating"
                              ? "Outbound pause is changing"
                              : "Outbound send eligibility still required"}
                    </span>
                    {outbound.reason && <span className="break-words text-muted-foreground">{outbound.reason}</span>}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground" data-testid="contact-next-action">
                  <span className="font-medium text-foreground">Next action:</span>{" "}
                  {headerNextAction}
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end" data-testid="contact-primary-actions">
                <Button ref={primaryActionButtonRef} className="min-h-11" onClick={() => setLogCallOpen(true)} data-testid="contact-primary-action">
                  <Phone className="mr-1.5 h-4 w-4" /> Log Call
                </Button>
                <Button className="min-h-11" variant="outline" onClick={() => setActiveTab("notes")} data-testid="contact-secondary-add-note">
                  <StickyNote className="mr-1.5 h-4 w-4" /> Add Note
                </Button>
                <Button ref={newTaskActionButtonRef} className="min-h-11" variant="outline" onClick={() => setShowTaskDialog(true)} data-testid="contact-secondary-new-task">
                  <CheckSquare className="mr-1.5 h-4 w-4" /> New Task
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button ref={moreActionsButtonRef} className="min-h-11" variant="outline" aria-label="More actions" data-testid="contact-more-actions">
                      More actions <ChevronDown className="ml-1.5 h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
                    <DropdownMenuLabel>Contact actions</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {contact.email && <CopyButton value={contact.email} label="email" menuItem />}
                    {contact.phone && <CopyButton value={contact.phone} label="phone" menuItem />}
                    {contact.phone && (outbound.blocked ? (
                      <DropdownMenuItem
                        className="min-h-11 items-start whitespace-normal"
                        disabled
                        title={outbound.reason}
                        aria-label={`Call phone unavailable. Outbound paused: ${outbound.reason}`}
                        data-outbound-blocked="true"
                        data-testid="menu-action-call-phone"
                      >
                        <Phone className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block font-medium">Call phone · Outbound paused</span>
                          <span className="block break-words text-xs text-muted-foreground">{outbound.reason}</span>
                        </span>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        asChild
                        className="min-h-11"
                        data-outbound-blocked="false"
                        data-testid="menu-action-call-phone"
                      >
                        <a
                          href={`tel:${contact.phone}`}
                          title={outbound.reason}
                          onClick={() => {
                            const _csrfToken = getCsrfToken();
                            fetch("/api/analytics/phone-call-click", {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                ...(_csrfToken ? { "X-CSRF-Token": _csrfToken } : {}),
                              },
                              credentials: "include",
                              body: JSON.stringify({ contactId, sourcePage: "contact_detail" }),
                            }).catch(() => {});
                          }}
                        >
                          <Phone className="h-4 w-4" /> Call phone
                        </a>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem className="min-h-11" onSelect={() => { window.setTimeout(() => startEdit(), 0); }} data-testid="menu-action-edit">
                      <Edit2 className="h-4 w-4" /> Edit contact
                    </DropdownMenuItem>
                    <DropdownMenuItem className="min-h-11" onSelect={() => { window.setTimeout(() => setEmailComposerOpen(true), 0); }} data-testid="menu-action-email">
                      <Mail className="h-4 w-4" /> Compose email
                    </DropdownMenuItem>
                    <DropdownMenuItem className="min-h-11" onSelect={() => { window.setTimeout(() => setShowDealDialog(true), 0); }} data-testid="menu-action-deal">
                      <TrendingUp className="h-4 w-4" /> Create deal
                    </DropdownMenuItem>
                    <DropdownMenuItem className="min-h-11" onSelect={() => { window.setTimeout(() => setShowTicketDialog(true), 0); }} data-testid="menu-action-ticket">
                      <Ticket className="h-4 w-4" /> Create ticket
                    </DropdownMenuItem>
                    <DropdownMenuItem className="min-h-11" onSelect={() => { window.setTimeout(() => setNextStepsOpen(true), 0); }} data-testid="menu-action-schedule-follow-up">
                      <Clock className="h-4 w-4" /> Schedule follow-up
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => {
                      const v = contact.vertical ? encodeURIComponent(contact.vertical) : null;
                      setLocation(`/dashboard/chat${v ? `?vertical=${v}` : ""}`);
                    }} className="min-h-11" data-testid="menu-action-ai">
                      <Bot className="h-4 w-4" /> Ask AI advisor
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        )}
        {isEditing && <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="space-y-1">
            {isEditing ? (
              <>
              <h1 className="sr-only">Editing contact: {contact.firstName} {contact.lastName}</h1>
              <div className="flex flex-wrap gap-2 items-center">
                <Input
                  value={editFields.firstName ?? ""}
                  onChange={e => setEditFields(p => ({ ...p, firstName: e.target.value }))}
                  className="w-36"
                  data-testid="input-edit-firstname"
                />
                <Input
                  value={editFields.lastName ?? ""}
                  onChange={e => setEditFields(p => ({ ...p, lastName: e.target.value }))}
                  className="w-36"
                  data-testid="input-edit-lastname"
                />
              </div>
              </>
            ) : (
              <h1 className="text-2xl font-bold" data-testid="text-contact-name">
                {/* #1475 — Best identifier: company → full name → email → phone */}
                {contact.companyName ||
                  `${contact.firstName || ""} ${contact.lastName || ""}`.trim() ||
                  contact.email ||
                  contact.phone ||
                  "Unnamed Contact"}
              </h1>
            )}

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {/* #535 — Created date */}
              {contact.createdAt && (
                <span className="flex items-center gap-1 text-xs" data-testid="text-contact-added-date">
                  Added: {new Date(contact.createdAt).toLocaleDateString()}
                </span>
              )}
              {/* #414 — Days since last contact */}
              {(contact as any).lastContactedAt && (() => {
                const days = Math.floor((Date.now() - new Date((contact as any).lastContactedAt).getTime()) / 86400000);
                const label = days === 0 ? "Contacted today" : days === 1 ? "Contacted yesterday" : `Last contacted ${days}d ago`;
                return (
                  <span className={`flex items-center gap-1 text-xs ${days > 30 ? "text-destructive/70" : days > 14 ? "text-muted-foreground" : ""}`}
                    data-testid="text-days-since-contact" title={new Date((contact as any).lastContactedAt).toLocaleDateString()}>
                  {label}
                  </span>
                );
              })()}
              {contact.companyName && (
                <span className="flex items-center gap-1" data-testid="text-company">
                  <Building2 className="h-3.5 w-3.5" /> {isEditing ? (
                    <Input
                      value={editFields.companyName ?? ""}
                      onChange={e => setEditFields(p => ({ ...p, companyName: e.target.value }))}
                      className="w-40"
                      data-testid="input-edit-company"
                    />
                  ) : contact.companyName}
                </span>
              )}
              {contact.email && (
                <span className="flex items-center gap-1" data-testid="text-email">
                  <Mail className="h-3.5 w-3.5" /> {isEditing ? (
                    <Input
                      value={editFields.email ?? ""}
                      onChange={e => setEditFields(p => ({ ...p, email: e.target.value }))}
                      className="w-48"
                      data-testid="input-edit-email"
                    />
                  ) : (
                    <span className="flex items-center gap-1 group">
                      <span>{contact.email}</span>
                      {/* #240 — One-click copy for email */}
                      <CopyButton value={contact.email} label="email" />
                    </span>
                  )}
                </span>
              )}
              {contact.phone && (
                <span className="flex items-center gap-1" data-testid="text-phone">
                  <Phone className="h-3.5 w-3.5" /> {isEditing ? (
                    <Input
                      value={editFields.phone ?? ""}
                      onChange={e => setEditFields(p => ({ ...p, phone: e.target.value }))}
                      className="w-40"
                      data-testid="input-edit-phone"
                    />
                  ) : (
                    <span className="flex items-center gap-1 group">
                      <a
                        href={outbound.blocked ? undefined : `tel:${contact.phone}`}
                        aria-disabled={outbound.blocked}
                        title={outbound.reason}
                        className="hover:underline"
                        data-testid="link-phone-call"
                        onClick={(event) => {
                          if(outbound.blocked){event.preventDefault();return;}
                          // Public analytics endpoint — authenticated session but
                          // fire-and-forget; CSRF token attached for authenticated mutation safety.
                          const _csrfToken = getCsrfToken();
                          fetch("/api/analytics/phone-call-click", {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              ...(_csrfToken ? { "X-CSRF-Token": _csrfToken } : {}),
                            },
                            credentials: "include",
                            body: JSON.stringify({ contactId, sourcePage: "contact_detail" }),
                          }).catch(() => {/* fire-and-forget */});
                        }}
                      >
                        {contact.phone}
                      </a>
                      {/* #240 — One-click copy for phone */}
                      <CopyButton value={contact.phone} label="phone" />
                    </span>
                  )}
                </span>
              )}
              {isEditing ? (
                <span className="flex items-center gap-1">
                  <Select
                    value={editFields.vertical ?? ""}
                    onValueChange={(v) => setEditFields(p => ({ ...p, vertical: v === "_none" ? "" : v }))}
                  >
                    <SelectTrigger className="w-44 h-7 text-xs" data-testid="select-edit-vertical">
                      <SelectValue placeholder="Set vertical…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none" data-testid="option-vertical-none">No vertical</SelectItem>
                      {VERTICALS.map(v => (
                        <SelectItem key={v} value={v} data-testid={`option-vertical-${v.toLowerCase().replace(/\W+/g, "-")}`}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
              ) : contact.vertical ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary" data-testid="badge-vertical">
                  {contact.vertical}
                </span>
              ) : null}
              {/* Assigned Rep — edit only available to admin/manager */}
              {isEditing && (user?.role === "admin" || user?.role === "manager") ? (
                <span className="flex items-center gap-1" data-testid="edit-assigned-to">
                  <UserCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Select
                    value={editFields.assignedTo ?? "_unassigned"}
                    onValueChange={(v) => setEditFields(p => ({ ...p, assignedTo: v === "_unassigned" ? null : v }))}
                  >
                    <SelectTrigger className="w-52 h-7 text-xs" data-testid="select-edit-assigned-to">
                      <SelectValue placeholder="Assign to rep…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_unassigned">Unassigned</SelectItem>
                      {repsList.map(r => (
                        <SelectItem key={r.id} value={r.email} data-testid={`option-rep-${r.id}`}>
                          {r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : r.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
              ) : (contact as any).assignedTo ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-assigned-rep">
                  <UserCheck className="h-3.5 w-3.5 shrink-0" />
                  {(contact as any).assignedTo}
                </span>
              ) : null}
              {/* #508 — Referral source edit field */}
              {isEditing && (
                <span className="flex items-center gap-1 text-xs">
                  <Input
                    placeholder="Referral source (optional)"
                    value={(editFields as any).referralSource ?? ""}
                    onChange={e => setEditFields(p => ({ ...p, referralSource: e.target.value }))}
                    className="w-44 h-7 text-xs"
                    data-testid="input-edit-referral-source"
                  />
                </span>
              )}
              {!isEditing && (contact as any).referralSource && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-referral-source">
                  {(contact as any).referralSource}
                </span>
              )}
              {/* Deal name + offer path (edit mode) — shown when an active deal is linked */}
              {isEditing && editDealId && (
                <span className="flex flex-col gap-1 text-xs w-full" data-testid="edit-deal-fields">
                  <span className="text-muted-foreground font-medium">Active Deal Fields</span>
                  <span className="flex flex-wrap gap-2">
                    <Input
                      placeholder="Deal name"
                      value={editDealFields.name}
                      onChange={e => setEditDealFields(p => ({ ...p, name: e.target.value }))}
                      className="w-44 h-7 text-xs"
                      data-testid="input-edit-deal-name"
                    />
                    <Select
                      value={editDealFields.offerPath || "_none"}
                      onValueChange={(v) => setEditDealFields(p => ({ ...p, offerPath: v === "_none" ? "" : v }))}
                    >
                      <SelectTrigger className="w-44 h-7 text-xs" data-testid="select-edit-deal-offer-path">
                        <SelectValue placeholder="Offer path" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">No offer path</SelectItem>
                        {OFFER_PATHS.map(op => (
                          <SelectItem key={op} value={op}>{op}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </span>
                </span>
              )}
              {/* #1443 — Supported Verticals multi-select (edit mode) */}
              {isEditing && (
                <span className="flex flex-col gap-1 text-xs w-full" data-testid="edit-supported-verticals">
                  <span className="text-muted-foreground font-medium">Supported Verticals</span>
                  <span className="flex flex-wrap gap-1.5">
                    {VERTICALS.map(v => {
                      const selected = editSupportedVerticals.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setEditSupportedVerticals(prev =>
                            selected ? prev.filter(x => x !== v) : [...prev, v]
                          )}
                          data-testid={`toggle-vertical-${v.toLowerCase().replace(/\W+/g, "-")}`}
                          className={`px-2 py-0.5 rounded border text-xs transition-colors ${
                            selected
                              ? "bg-primary/10 border-primary text-primary"
                              : "border-border text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </span>
                </span>
              )}
              {/* #1443 — Supported Verticals read display */}
              {!isEditing && (() => {
                const suppVerts = (contact.tags ?? [])
                  .filter((t: string) => t.startsWith("vertical:"))
                  .map((t: string) => t.slice("vertical:".length));
                if (suppVerts.length === 0) return null;
                return (
                  <span className="flex items-center gap-1 flex-wrap" data-testid="supported-verticals-display">
                    <span className="text-xs text-muted-foreground">Also serves:</span>
                    {suppVerts.map((v: string) => (
                      <Badge key={v} variant="outline" className="text-xs py-0">
                        {v}
                      </Badge>
                    ))}
                  </span>
                );
              })()}
              <Badge variant={statusColor(contact.status)} data-testid="badge-status">
                {contact.status}
              </Badge>
              {contact.isParentAccount && (
                <Badge className="bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 border-0" data-testid="badge-parent-account">
                  <Store className="h-3 w-3 mr-1" /> Parent Account
                </Badge>
              )}
              {(contact as any).isDecisionMaker && (
                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border-0" data-testid="badge-decision-maker">
                  <Star className="h-3 w-3 mr-1 fill-amber-500 text-amber-500" /> Decision Maker
                </Badge>
              )}
              {(contact as any).emailStatus && (contact as any).emailStatus !== "active" && (
                <Badge
                  className={`border-0 ${(contact as any).emailStatus === "bounced" || (contact as any).emailStatus === "invalid" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}
                  data-testid="badge-email-status"
                >
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Email {(contact as any).emailStatus}
                </Badge>
              )}
              {/* #490 — In Active Deal badge */}
              {headerActiveDealKnown && activeHeaderDeal && (
                <Badge
                  className="border-0 bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                  data-testid="badge-in-active-deal"
                  title={`Active deal: ${activeHeaderDeal.stage}`}
                >
                  In Deal · {activeHeaderDeal.stage}
                </Badge>
              )}
              {!headerActiveDealKnown && <Badge variant="outline" data-testid="badge-active-deal-unknown">Deal status · Unknown</Badge>}
              {/* #1390 — Lifecycle stage badge */}
              {(contact as any).lifecycleState && (
                <Badge
                  className="border-0 bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200"
                  data-testid="badge-lifecycle-state"
                  title={`Lifecycle stage: ${(contact as any).lifecycleState}${(contact as any).lifecycleStateUpdatedAt ? ` · Updated ${new Date((contact as any).lifecycleStateUpdatedAt).toLocaleDateString()}` : ""}`}
                >
                  {(contact as any).lifecycleState
                    .replace(/_/g, " ")
                    .toLowerCase()
                    .replace(/\b\w/g, (c: string) => c.toUpperCase())}
                </Badge>
              )}
              {parentAccount && (
                <button
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  onClick={() => setLocation(`/dashboard/contacts/${parentAccount.id}`)}
                  data-testid="badge-part-of-parent"
                >
                  <MapPin className="h-3 w-3" />
                  Part of: {parentAccount.companyName || `${parentAccount.firstName} ${parentAccount.lastName}`}
                </button>
              )}
            </div>

            {/* #423 — Hot Contact Banner (lead score > 80) */}
            {contact.leadScore != null && contact.leadScore >= 80 && (
              <div className="flex items-center gap-2 text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-3 py-1.5" data-testid="banner-hot-contact">
                <span className="text-red-600 dark:text-red-400 font-semibold">🔥 Hot Contact</span>
                <span className="text-xs text-red-500 dark:text-red-300">Lead score {contact.leadScore} — prioritize for outreach</span>
              </div>
            )}

            {/* Contact Quality Signals — Lead Score + Data Completeness */}
            {(contact.leadScore != null || contact.dataCompletenessScore != null) && (
              <div className="flex flex-col gap-2 pt-1" data-testid="section-contact-quality">
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  {contact.leadScore != null && (
                    <span className="flex items-center gap-1" data-testid="text-lead-score">
                      <TrendingUp className="h-3 w-3" />
                      Lead Score: <strong className="text-foreground">{contact.leadScore}</strong>
                    </span>
                  )}
                  {contact.dataCompletenessScore != null && (
                    <span className="flex items-center gap-2" data-testid="section-data-completeness">
                      <span>Data Completeness:</span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-20 h-1.5 bg-muted rounded-full overflow-hidden inline-block">
                          <span
                            className="h-full bg-primary block rounded-full transition-all"
                            style={{ width: `${Math.min(100, Math.max(0, contact.dataCompletenessScore))}%` }}
                            data-testid="bar-data-completeness"
                          />
                        </span>
                        <strong className="text-foreground" data-testid="text-data-completeness-score">
                          {contact.dataCompletenessScore}%
                        </strong>
                      </span>
                    </span>
                  )}
                </div>
                {/* Field-contribution checklist — shows which key fields are present or missing */}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" data-testid="section-field-checklist">
                  {([
                    { key: "name",    label: "Name",    present: !!(contact.firstName || contact.lastName) },
                    { key: "email",   label: "Email",   present: !!contact.email },
                    { key: "phone",   label: "Phone",   present: !!contact.phone },
                    { key: "company", label: "Company", present: !!contact.companyName },
                    { key: "website", label: "Website", present: !!contact.website },
                    { key: "vertical",label: "Vertical",present: !!contact.vertical },
                  ] as const).map(({ key, label, present }) => (
                    <span
                      key={key}
                      className={`inline-flex items-center gap-0.5 ${present ? "text-green-700 dark:text-green-400" : "text-muted-foreground/60"}`}
                      data-testid={`field-indicator-${key}`}
                    >
                      <span aria-hidden="true">{present ? "✓" : "✗"}</span>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Desktop action buttons — hidden on mobile (mobile uses sticky bottom bar) */}
          <div className="hidden sm:flex gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => {
                const v = contact.vertical ? encodeURIComponent(contact.vertical) : null;
                setLocation(`/dashboard/chat${v ? `?vertical=${v}` : ""}`);
              }}
              data-testid="button-ask-ai-advisor"
            >
              <Bot className="h-4 w-4 mr-1" /> Ask AI Advisor
            </Button>
            {isEditing ? (
              <>
                <Button onClick={saveEdit} disabled={updateContact.isPending} data-testid="button-save-edit">
                  <Save className="h-4 w-4 mr-1" /> Save
                </Button>
                <Button variant="outline" onClick={finishEdit} data-testid="button-cancel-edit">
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={startEdit} data-testid="button-edit">
                  <Edit2 className="h-4 w-4 mr-1" /> Edit
                </Button>
                <Button variant="outline" onClick={() => setEmailComposerOpen(true)} data-testid="button-compose-email-contact">
                  <Mail className="h-4 w-4 mr-1" /> Compose Email
                </Button>
              </>
            )}
          </div>
        </div>}
      </RecordHeader>

      <EmailComposer
        open={emailComposerOpen}
        onClose={() => setEmailComposerOpen(false)}
        contactId={contact.id}
        initialVertical={contact.vertical ?? undefined}
        onCloseAutoFocus={restoreFocusOnClose(moreActionsButtonRef)}
      />
      <CrmAreaNav entries={areaEntries} current={currentAreaHref} className="crm-contact-area-nav" />
      <details
        className="rounded-lg border border-border bg-card"
        open={diagnosticsOpen}
        onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
        data-testid="contact-context-details"
      >
        <summary
          className="min-h-11 cursor-pointer select-none px-4 py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          data-testid="contact-context-details-toggle"
        >
          Validation, readiness &amp; record diagnostics
        </summary>
        {diagnosticsOpen && <div className="space-y-4 border-t p-4" data-testid="contact-context-details-content">
      {/* GHL Sync Status */}
        <GhlSyncStatus
          contact={contact}
          ghlSyncStatus={ghlSyncStatus}
          resyncToGhlMutation={resyncToGhlMutation}
        />

      {/* #248 — View in GHL direct link */}
      {ghlSyncStatus?.ghlContactId && (
        <div className="flex items-center gap-2 px-1">
          <a
            href={`https://app.gohighlevel.com/contacts/${ghlSyncStatus.ghlContactId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            data-testid="link-view-in-ghl"
          >
            <Link2 className="h-3 w-3" />
            View in GHL
          </a>
        </div>
      )}

      {/* Rate Review Banner */}
      {requestedSection === "overview" && rateReviewsError && <div className="rounded-md border border-destructive/40 p-3 text-sm" role="alert">
        Rate review status is unavailable.
        <Button size="sm" variant="outline" className="ml-2" onClick={() => void refetchRateReviews()}>Retry</Button>
      </div>}
      {requestedSection === "overview" && rateReviewsLoading && <div className="h-12 animate-pulse rounded bg-muted" role="status" aria-label="Loading rate review status" />}
      {(rateReviews ?? []).filter(r => r.status !== "resolved").map((review) => {
        const statusLabels: Record<string, string> = {
          requested: "Submitted — Awaiting Review",
          analysis_pending: "Analyzing Statement…",
          analysis_complete: "Analysis Complete",
          rep_viewed: "Under Review",
          proposal_sent: "Proposal Sent",
        };
        const statusLabel = statusLabels[review.status ?? "requested"] ?? review.status;
        return (
          <Card key={review.id} className="border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30" data-testid={`card-rate-review-banner-${review.id}`}>
            <CardContent className="py-3 px-4">
              <div className="flex flex-wrap items-start gap-3">
                <FileSearch2 className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-amber-800 dark:text-amber-200">Rate Review Requested</span>
                    <Badge variant="outline" className="text-xs border-amber-400 text-amber-700 dark:text-amber-300" data-testid={`badge-rate-review-status-${review.id}`}>
                      {statusLabel}
                    </Badge>
                    {review.repViewedAt && (
                      <Badge variant="secondary" className="text-xs" data-testid={`badge-rate-review-viewed-${review.id}`}>Viewed</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-700 dark:text-amber-400">
                    <span>Submitted: {review.createdAt ? new Date(review.createdAt).toLocaleDateString() : "—"}</span>
                    {review.document && (
                      <span>Statement: <span className="font-medium" data-testid={`text-rate-review-doc-${review.id}`}>{review.document.fileName}</span></span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {!review.repViewedAt && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-amber-400 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                        onClick={() => markRateReviewViewedMutation.mutate(review.id)}
                        disabled={markRateReviewViewedMutation.isPending}
                        data-testid={`button-mark-reviewed-${review.id}`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                        Mark Reviewed
                      </Button>
                    )}
                    {review.dealId && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-amber-400 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                        onClick={() => generateRetentionProposalMutation.mutate(review.id)}
                        disabled={generateRetentionProposalMutation.isPending}
                        data-testid={`button-generate-retention-proposal-${review.id}`}
                      >
                        <TrendingUp className="w-3.5 h-3.5 mr-1" />
                        {generateRetentionProposalMutation.isPending ? "Generating…" : "Generate Retention Proposal"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-amber-400 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                      onClick={() => setActiveTab("documents")}
                      data-testid={`button-view-rate-review-doc-${review.id}`}
                    >
                      <FolderOpen className="w-3.5 h-3.5 mr-1" />
                      View Statement
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* LinkedIn Enrichment */}
        <LinkedinEnrichmentSection
          contact={contact}
          proxycurlConfigured={proxycurlConfigured}
          showLinkedinHistory={showLinkedinHistory}
          setShowLinkedinHistory={setShowLinkedinHistory}
          enrichLinkedInMutation={enrichLinkedInMutation}
        />


      {/* Confirmation Status — always rendered; shows "Not Sent" when no record exists */}
      {confirmationResult !== undefined && (
        <ConfirmationStatusSection confirmationResult={confirmationResult} />
      )}

      {/* ZeroBounce Validation History */}
      {contact.email && <ZeroBounceHistorySection contactId={contactId} />}
      <SfpReadinessSection contactId={contactId} />

      {/* Lifecycle Stage Transition History */}
      <LifecycleHistorySection contactId={contactId} />

      {/* Tags */}
      <Card data-testid="section-tags">
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground mr-1">Tags:</span>
            {(contact.tags ?? []).map(tag => (
              <Badge key={tag} variant="secondary" className="gap-1" data-testid={`badge-tag-${tag}`}>
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="ml-0.5 hover:text-destructive"
                  data-testid={`button-remove-tag-${tag}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <form
              className="flex gap-1"
              onSubmit={e => { e.preventDefault(); addTag(); }}
            >
              <Input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                placeholder="Add tag..."
                className="w-28"
                data-testid="input-add-tag"
              />
              <Button type="submit" size="sm" variant="outline" aria-label="Add contact tag" data-testid="button-add-tag">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>

      {/* Data Readiness */}
      <div className="space-y-2">
        <ReadinessCard
          score={contact.dataReadinessScore ?? null}
          grade={contact.dataReadinessGrade ?? null}
          breakdown={contact.readinessBreakdown ?? null}
          readinessUpdatedAt={contact.readinessUpdatedAt ? String(contact.readinessUpdatedAt) : null}
          readinessModelVersion={contact.readinessModelVersion ?? null}
          lastMeaningfulContactMutationAt={contact.lastMeaningfulContactMutationAt ? String(contact.lastMeaningfulContactMutationAt) : null}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground"
            data-testid="button-trigger-rescore"
            onClick={async () => {
              try {
                await apiRequest("POST", `/api/contacts/${contact.id}/trigger-rescore`, {});
                toast({ title: "Re-score queued", description: "Readiness score will update within a minute." });
              } catch {
                toast({ title: "Error", description: "Could not queue re-score. Try again.", variant: "destructive" });
              }
            }}
          >
            ↻ Re-score readiness
          </Button>
        </div>
      </div>
        </div>}
      </details>

      {/* Associated Companies */}
      {requestedSection === "overview" && <Card data-testid="section-associated-companies">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Associated Companies
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCompanyMode("existing");
              setShowCompanyDialog(true);
            }}
            data-testid="button-add-company"
          >
            <Link2 className="h-4 w-4 mr-1" /> Link Company
          </Button>
        </CardHeader>
        <CardContent>
          {contactCompaniesLoading ? <p className="text-sm text-muted-foreground">Loading company links…</p>
            : contactCompaniesError ? <div className="text-sm" role="alert">
              Company links could not be read. <Button size="sm" variant="outline" onClick={() => void retryContactCompanies()}>Retry</Button>
            </div>
            : !contactCompanies?.length ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-companies">No companies linked yet</p>
          ) : (
            <div className="space-y-2">
              {contactCompanies.map(cc => {
                const company = allCompanies.find(c => c.id === cc.companyId);
                return (
                  <div
                    key={cc.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                    data-testid={`company-association-${cc.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      <button
                        className="font-medium text-left hover:text-primary hover:underline"
                        onClick={() => setLocation(`/dashboard/companies/${cc.companyId}`)}
                        data-testid={`link-company-detail-${cc.id}`}
                      >
                        {company?.legalName || `Company #${cc.companyId}`}
                      </button>
                      {company?.dba && (
                        <span className="text-sm text-muted-foreground" data-testid={`text-company-dba-${cc.id}`}>
                          (DBA: {company.dba})
                        </span>
                      )}
                      {cc.role && (
                        <Badge variant="outline" data-testid={`badge-company-role-${cc.id}`}>
                          {cc.role}
                        </Badge>
                      )}
                      {cc.isPrimary && (
                        <Badge variant="default" data-testid={`badge-company-primary-${cc.id}`}>
                          <Star className="h-3 w-3 mr-1" /> Primary
                        </Badge>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove company association"
                      onClick={() => removeCompanyAssociation.mutate(cc.id)}
                      disabled={removeCompanyAssociation.isPending}
                      data-testid={`button-remove-company-${cc.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>}

      {workspace.issues.length > 0 && <div className="crm-state-panel" role="status" data-testid="contact-selection-notice">
        <span className="crm-state-kicker">Selection adjusted</span><p>{workspace.issues[0].reason}</p>
      </div>}
      {/* Five destination areas keep the complete authorized section set, while
          inactive interiors remain unmounted by Radix TabsContent. */}
      <div className="crm-contact-drawer-actions">
        <Button variant="outline" onClick={() => setDrawer("activity")} aria-expanded={workspace.drawer === "activity"}>Activity</Button>
        <Button variant="outline" onClick={() => setDrawer("history")} aria-expanded={workspace.drawer === "history"}>History</Button>
      </div>
      {/* Section selector is deliberately scoped to the current area. */}
      <Tabs value={activeTab} onValueChange={setActiveTab} data-testid="contact-tabs">
        <div className="crm-contact-section-nav">
          <TabsList data-testid="contact-tabs-list">
            {(workspace.area ? contactAreaSections[workspace.area] : []).filter(section => workspace.permittedSections.includes(section)).map(section =>
              <TabsTrigger key={section} value={section} data-testid={`tab-${section}`}>
                {sectionLabels[section]}
                {section === "deals" ? ` (${dealsLoaded ? deals.length : "Unknown"})` : section === "tasks" ? ` (${tasksLoaded ? tasks.length : "Unknown"})` :
                  section === "tickets" ? ` (${ticketsLoaded ? tickets.length : "Unknown"})` : section === "notes" ? ` (${notesLoaded ? sortedNotes.length : "Unknown"})` :
                  ""}
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="overview" data-testid="tab-content-overview">
          <div className="mb-4 space-y-3">
            <ContactNbaCard contactId={contactId} />
            <SalesIntelPanel contact={contact} nextFollowUp={nextFollowUp} />
          </div>
          <OverviewTab
            contact={contact}
            dealsCount={dealsLoaded ? deals.length : null}
            totalDealVolume={totalDealVolume}
            openTicketsCount={openTickets?.length ?? null}
            pendingTasksCount={pendingTasks?.length ?? null}
            onOpenTicketsClick={() => setActiveTab("tickets")}
          />
        </TabsContent>

        <TabsContent value="deals" data-testid="tab-content-deals">
          {dealsLoaded ? <DealsTab
            deals={deals}
            contactId={contactId}
            isManagerOrAdmin={isManagerOrAdmin}
            agentsList={agentsList}
            setLocation={setLocation}
          /> : <CrmDataState state="unavailable" message="Deal details were not included in this section response." />}
        </TabsContent>

        <TabsContent value="live-processing" data-testid="tab-content-live-processing">
          {dealsLoaded ? <LiveProcessingTabBody deals={deals} /> : <CrmDataState state="unavailable" message="Deal details were not included in this section response." />}
        </TabsContent>

        <TabsContent value="tickets" data-testid="tab-content-tickets">
          {ticketsLoaded ? <TicketsTab tickets={tickets} contactId={contact.id} /> : <CrmDataState state="unavailable" message="Ticket details were not included in this section response." />}
        </TabsContent>

        <TabsContent value="tasks" data-testid="tab-content-tasks">
          {tasksLoaded ? <TasksTab tasks={tasks} /> : <CrmDataState state="unavailable" message="Task details were not included in this section response." />}
        </TabsContent>

        <TabsContent value="notes" data-testid="tab-content-notes">
          {!notesLoaded ? <CrmDataState state="unavailable" message="Notes were not included in this section response." onRetry={() => void refetch()} /> :
          <NotesTab
            sortedNotes={sortedNotes}
            noteContent={noteContent}
            setNoteContent={setNoteContent}
            addNote={addNote}
            onUpdateNote={async (noteId, content) => {
              // #243 — inline note editing via PATCH /api/notes/:id
              const note=notes?.find(row=>row.id===noteId);
              if(!note) throw new Error("Note version unavailable. Reload notes.");
              const res = await apiRequest("PATCH", `/api/notes/${noteId}`,noteIntents.payload(`edit:${noteId}`,{content,expectedVersion:note.version}));
              if (!res.ok) throw new Error("Failed to update note");
              noteIntents.accepted(`edit:${noteId}`);
              queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
              toast({ title: "Note updated" });
            }}
            onPinNote={async (noteId, pinned) => {
              // #1475 — pin/unpin note
              const note=notes?.find(row=>row.id===noteId);
              if(!note) throw new Error("Note version unavailable. Reload notes.");
              const res = await apiRequest("PATCH", `/api/contacts/${contactId}/notes/${noteId}/pin`,noteIntents.payload(`pin:${noteId}`,{pinned,expectedVersion:note.version}));
              if (!res.ok) throw new Error("Failed to update pin state");
              noteIntents.accepted(`pin:${noteId}`);
              queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "detail"] });
            }}
            onDeleteNote={async noteId=>{
              const note=notes?.find(row=>row.id===noteId);
              if(!note) throw new Error("Note version unavailable. Reload notes.");
              await apiRequest("DELETE",`/api/notes/${noteId}`,noteIntents.payload(`delete:${noteId}`,{expectedVersion:note.version}));
              noteIntents.accepted(`delete:${noteId}`);
              void queryClient.invalidateQueries({queryKey:["/api/contacts",contactId,"detail"]});
            }}
          />}
        </TabsContent>

        <TabsContent value="documents" data-testid="tab-content-documents">
          <div className="space-y-4">
            <ContactDocumentsTab contactId={contactId} userRole={user?.role ?? undefined} isPartnerContact={!!contact?.partnerOrgId} />
            <Card data-testid="section-document-access-history">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <FolderOpen className="h-4 w-4" /> Document Access History
                </CardTitle>
              </CardHeader>
              <CardContent>
                <DocumentAccessHistory contactId={contactId} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="chargebacks" data-testid="tab-content-chargebacks">
          <ContactChargebacksTab contactId={contactId} />
        </TabsContent>

        {/* #1475 — Calls & Voicemails tab */}
        <TabsContent value="call-logs" data-testid="tab-content-call-logs">
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setLogCallOpen(true)} data-testid="button-log-call-in-tab">
                <Phone className="h-3.5 w-3.5 mr-1.5" /> Log Call
              </Button>
            </div>
            <CallLogsTab contactId={contactId} />
          </div>
        </TabsContent>
        {(user?.role === "agent" || user?.role === "manager" || user?.role === "admin") && (
          <TabsContent value="call-assist" data-testid="tab-content-call-assist">
            <CallAssistPanel contactId={contact.id} />
          </TabsContent>
        )}

        <TabsContent value="relationships" data-testid="tab-content-relationships">
          <RelationshipsTab contactId={contactId} />
        </TabsContent>

        <TabsContent value="locations" data-testid="tab-content-locations">
          <LocationsTab contact={contact} />
        </TabsContent>

        <TabsContent value="comments" data-testid="tab-content-comments">
          <Card>
            <CardContent className="pt-4">
              <Comments entityType="contact" entityId={contactId} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="churn-risk" data-testid="tab-content-churn-risk">
          <ChurnRiskPanel contactId={contactId} isManagerOrAdmin={isManagerOrAdmin} />
        </TabsContent>

        <TabsContent value="delivery-log" data-testid="tab-content-delivery-log">
          <DeliveryLogTab contactId={contactId} />
        </TabsContent>

        <TabsContent value="comm-timeline" data-testid="tab-content-comm-timeline">
          <CommunicationTimelineTab contactId={contactId} />
        </TabsContent>

        <TabsContent value="comm-health" data-testid="tab-content-comm-health">
          <CommunicationHealthTab contactId={contactId} />
        </TabsContent>

        <TabsContent value="offer-intelligence" data-testid="tab-content-offer-intelligence">
          <OfferIntelligenceTab contact={contact} isManagerOrAdmin={isManagerOrAdmin} />
        </TabsContent>

        {contact.isParentAccount && (
          <TabsContent value="company-intelligence" data-testid="tab-content-company-intelligence">
            <CompanyIntelligenceTab contact={contact} />
          </TabsContent>
        )}

        {data.capabilities?.sdrSourced === true && (
          <TabsContent value="sales-prep" data-testid="tab-content-sales-prep">
            <SalesPrepTab contactId={contactId} />
          </TabsContent>
        )}
        {data.capabilities?.hasOnboarding === true && (
          <TabsContent value="onboarding-stages" data-testid="tab-content-onboarding-stages">
            {!dealsLoaded ? <CrmDataState state="unavailable" message="Onboarding deal stages were not included in this section response." /> :
              deals.filter(d => d.pipeline === "onboarding" && !d.archivedAt).map(deal => (
                <OnboardingStagesChecklist key={deal.id} dealId={deal.id} />
              ))}
          </TabsContent>
        )}

        {/* ── RFIs Tab ───────────────────────────────────────────────── */}
        <TabsContent value="rfis" data-testid="tab-content-rfis">
          <RfiTab contactId={contactId} />
        </TabsContent>

        <TabsContent value="nps" data-testid="tab-content-nps">
          <NpsHistoryPanel contactId={contactId} />
        </TabsContent>
      </Tabs>

      <CrmDetailDrawer open={workspace.drawer === "activity"} onOpenChange={(open) => setDrawer(open ? "activity" : null)}
        title="Activity" description={`Record-bound events for ${contact.firstName} ${contact.lastName} · Contact #${contact.id}`}>
        {activityLoading ? <div role="status" className="space-y-2"><div className="h-12 animate-pulse rounded bg-muted" /><div className="h-12 animate-pulse rounded bg-muted" /></div>
          : activityError ? <div role="alert" className="space-y-3 rounded-md border p-4 text-sm">
            <p>Contact activity could not be read. No events are assumed absent.</p>
            <Button variant="outline" onClick={() => void retryActivity()}>Retry activity</Button>
          </div>
            : <ActivityTimelineFull events={activityEvents ?? []} />}
      </CrmDetailDrawer>
      <CrmDetailDrawer open={workspace.drawer === "history"} onOpenChange={(open) => setDrawer(open ? "history" : null)}
        title="Change history" description={`Immutable record history · Contact #${contact.id}`}>
        {workspace.drawer === "history" && <ChangeHistoryTab entityType="contact" entityId={contactId} />}
      </CrmDetailDrawer>

      <CreateDialogs
          showDealDialog={showDealDialog}
          setShowDealDialog={setShowDealDialog}
          dealForm={dealForm}
          setDealForm={setDealForm}
          createDeal={createDeal}
          showTicketDialog={showTicketDialog}
          setShowTicketDialog={setShowTicketDialog}
          ticketForm={ticketForm}
          setTicketForm={setTicketForm}
          createTicket={createTicket}
          ticketSaving={ticketSaving}
          ticketUnconfirmed={ticketCreation.uncertain.includes("create")}
          retryTicketCreation={retryTicketCreation}
          onDealCloseAutoFocus={restoreFocusOnClose(moreActionsButtonRef)}
          onTicketCloseAutoFocus={restoreFocusOnClose(moreActionsButtonRef)}
          onTaskCloseAutoFocus={restoreFocusOnClose(newTaskActionButtonRef)}
          showTaskDialog={showTaskDialog}
          setShowTaskDialog={setShowTaskDialog}
          taskForm={taskForm}
          taskSaving={taskSaving}
          taskSaveError={taskSaveError}
          setTaskForm={setTaskForm}
          createTask={createTask}
          showCompanyDialog={showCompanyDialog}
          setShowCompanyDialog={setShowCompanyDialog}
          companyMode={companyMode}
          setCompanyMode={setCompanyMode}
          companySearch={companySearch}
          setCompanySearch={setCompanySearch}
          selectedCompanyId={selectedCompanyId}
          setSelectedCompanyId={setSelectedCompanyId}
          newCompanyForm={newCompanyForm}
          setNewCompanyForm={setNewCompanyForm}
          companyRole={companyRole}
          setCompanyRole={setCompanyRole}
          companyIsPrimary={companyIsPrimary}
          setCompanyIsPrimary={setCompanyIsPrimary}
          allCompanies={allCompanies}
          companiesLoading={companiesLoading}
          companiesError={companiesError}
          retryCompanies={() => void retryCompanies()}
          contactCompanies={contactCompanies ?? []}
          addCompanyAssociation={addCompanyAssociation}
          createAndLinkCompany={createAndLinkCompany}
        />

      {/* #1475 — Log Call Sheet */}
      <LogCallSheet
        open={logCallOpen}
        onClose={() => setLogCallOpen(false)}
        contactId={contactId}
        dealId={deals.find(d => !d.archivedAt)?.id ?? null}
        onCloseAutoFocus={restoreFocusOnClose(primaryActionButtonRef)}
      />

      {/* #1475 — Next Steps scheduler, opened from the compact record actions */}
      <NextStepsWidget
        contactId={contactId}
        dealId={activeHeaderDeal?.id}
        nextFollowUp={nextFollowUp}
        open={nextStepsOpen}
        onOpenChange={setNextStepsOpen}
        onCloseAutoFocus={restoreFocusOnClose(moreActionsButtonRef)}
        dialogOnly
      />
    </div>
  );
}
