import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select as UISelect, SelectContent as UISelectContent, SelectItem as UISelectItem, SelectTrigger as UISelectTrigger, SelectValue as UISelectValue } from "@/components/ui/select";
import {
  Search, FileText, Building2, Mail, Calendar,
  CheckCircle2, XCircle, SendHorizonal, MessageSquarePlus,
  ChevronLeft, Loader2, User, CreditCard,
  MapPin, Landmark, ClipboardCheck, Paperclip, ExternalLink, History, MailCheck,
  AlertTriangle, GitFork, Pencil, Save, X,
} from "lucide-react";
import { PageHeader, CrmPage } from "@/components/crm/CrmPresentation";
import type { MerchantApplication, MerchantProfile, Document as DocType, UnderwritingNoteEntry } from "@shared/schema";
import { applicationStatuses } from "@/lib/crm-destination-state";
import { useC4RetainedSelection } from "@/hooks/use-c4-retained-selection";

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "under_review", label: "Under Review" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
  { value: "draft", label: "Draft" },
];

function getStatusVariant(status: string | null | undefined): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved": return "default";
    case "declined": return "destructive";
    case "under_review": return "outline";
    case "submitted": return "secondary";
    default: return "secondary";
  }
}

function getStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "draft": return "Draft";
    case "in_progress": return "In Progress";
    case "submitted": return "Submitted";
    case "under_review": return "Under Review";
    case "approved": return "Approved";
    case "declined": return "Declined";
    case "withdrawn": return "Withdrawn";
    default: return status || "Unknown";
  }
}

function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function DetailSection({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b pb-1">
        <Icon className="w-4 h-4 text-primary" />
        {title}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {children}
      </div>
    </div>
  );
}

function UnderwritingNotesTimeline({
  log,
  legacyNote,
}: {
  log: UnderwritingNoteEntry[];
  legacyNote: string | null | undefined;
}) {
  const entries = Array.isArray(log) ? [...log] : [];
  const hasLegacyOnly = entries.length === 0 && legacyNote && legacyNote.trim().length > 0;
  const sorted = entries.sort((a, b) => {
    const ad = new Date(a.createdAt).getTime();
    const bd = new Date(b.createdAt).getTime();
    return ad - bd;
  });

  return (
    <div className="space-y-3" data-testid="section-underwriting-notes-history">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b pb-1">
        <History className="w-4 h-4 text-primary" />
        Underwriting Notes History
      </div>
      {sorted.length === 0 && !hasLegacyOnly ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-uw-notes">
          No underwriting notes yet. Use "Request Info" to add a timestamped note.
        </p>
      ) : (
        <div className="space-y-2" data-testid="list-uw-notes">
          {sorted.map((entry, idx) => (
            <div
              key={`${entry.createdAt}-${idx}`}
              className="rounded-md border bg-muted/30 p-3 space-y-1"
              data-testid={`uw-note-${idx}`}
            >
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground" data-testid={`uw-note-author-${idx}`}>
                  {entry.author || "Unknown"}
                </span>
                <span data-testid={`uw-note-date-${idx}`}>{formatDateTime(entry.createdAt)}</span>
              </div>
              <p className="text-sm text-foreground whitespace-pre-wrap" data-testid={`uw-note-text-${idx}`}>
                {entry.note}
              </p>
            </div>
          ))}
          {hasLegacyOnly && (
            <div
              className="rounded-md border bg-muted/30 p-3 space-y-1"
              data-testid="uw-note-legacy"
            >
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Legacy note</span>
                <span>—</span>
              </div>
              <p className="text-sm text-foreground whitespace-pre-wrap">{legacyNote}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApplicationDetailView({
  application,
  onClose,
  onUpdated,
}: {
  application: MerchantApplication;
  onClose: () => void;
  onUpdated: (app: MerchantApplication) => void;
}) {
  const { toast } = useToast();
  const [requestInfoNote, setRequestInfoNote] = useState("");
  const [showRequestInfo, setShowRequestInfo] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [showDecline, setShowDecline] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editFields, setEditFieldsApp] = useState({
    legalBusinessName: application.legalBusinessName || "",
    dba: (application as any).dba || "",
    ownerFirstName: application.ownerFirstName || "",
    ownerLastName: application.ownerLastName || "",
    ownerEmail: application.ownerEmail || "",
    businessEmail: application.businessEmail || "",
    status: application.status || "submitted",
  });

  const { data: riskRelationships } = useQuery<Array<{
    id: number;
    relationshipType: string;
    confidence: number;
    riskFlag: boolean;
    riskReason: string | null;
    counterpartyType: string;
    counterpartyId: number;
    counterpartyName: string;
    source: string;
    note: string | null;
  }>>({
    queryKey: ["/api/contacts", application.contactId, "relationships"],
    enabled: !!application.contactId,
    select: (data) => data.filter((r) => r.riskFlag),
  });

  const { data: allDocuments } = useQuery<DocType[]>({
    queryKey: ["/api/documents"],
    enabled: !!application.contactId,
  });

  const documents = allDocuments?.filter(
    (d) => application.contactId && d.contactId === application.contactId
  ) ?? [];

  const { data: allProfiles } = useQuery<MerchantProfile[]>({
    queryKey: ["/api/merchant-profiles"],
    enabled: application.status === "approved",
  });

  const merchantProfile = allProfiles?.find(
    (p) => p.applicationId === application.id
  );

  const { data: welcomeStatus, refetch: refetchWelcomeStatus } = useQuery<{
    lastSentAt: string | null;
    cooldownRemaining: number;
  }>({
    queryKey: ["/api/merchant-profiles", merchantProfile?.id, "welcome-email-status"],
    queryFn: async () => {
      const res = await fetch(`/api/merchant-profiles/${merchantProfile!.id}/welcome-email-status`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json();
    },
    enabled: !!merchantProfile?.id,
    refetchOnWindowFocus: false,
  });

  const { data: esignStatus } = useQuery<{
    status: string;
    cooldownRemaining: number;
    lastSentAt: string | null;
  }>({
    queryKey: ["/api/merchant-applications", application.id, "esign-status"],
    queryFn: async () => {
      const res = await fetch(`/api/merchant-applications/${application.id}/esign-status`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch e-sign status");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const [welcomeHistoryOffset, setWelcomeHistoryOffset] = useState(0);
  const WELCOME_HISTORY_LIMIT = 10;

  const { data: welcomeEmailHistoryData, isLoading: isLoadingWelcomeHistory } = useQuery<{
    logs: Array<{
      id: number;
      action: string;
      createdAt: string | null;
      details: {
        contactId?: number;
        mid?: string | null;
        method?: string;
        triggeredBy?: string | null;
        triggeredByRole?: string | null;
        recipientEmail?: string | null;
      } | null;
    }>;
    total: number;
    offset: number;
    limit: number;
  } | Array<{
    id: number;
    action: string;
    createdAt: string | null;
    details: { contactId?: number; mid?: string | null; method?: string } | null;
  }>>({
    queryKey: ["/api/merchant-profiles", merchantProfile?.id, "welcome-email-history", welcomeHistoryOffset],
    queryFn: async () => {
      const res = await fetch(
        `/api/merchant-profiles/${merchantProfile!.id}/welcome-email-history?limit=${WELCOME_HISTORY_LIMIT}&offset=${welcomeHistoryOffset}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch welcome email history");
      return res.json();
    },
    enabled: !!merchantProfile?.id,
  });

  // Support both old array shape and new paginated shape
  const welcomeEmailHistory = Array.isArray(welcomeEmailHistoryData)
    ? welcomeEmailHistoryData
    : (welcomeEmailHistoryData as any)?.logs ?? [];
  const welcomeHistoryTotal = Array.isArray(welcomeEmailHistoryData)
    ? welcomeEmailHistoryData.length
    : (welcomeEmailHistoryData as any)?.total ?? 0;

  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [esignCooldownSeconds, setEsignCooldownSeconds] = useState(0);

  useEffect(() => {
    if (welcomeStatus?.cooldownRemaining && welcomeStatus.cooldownRemaining > 0) {
      setCooldownSeconds(welcomeStatus.cooldownRemaining);
    }
  }, [welcomeStatus]);

  useEffect(() => {
    if (esignStatus?.cooldownRemaining && esignStatus.cooldownRemaining > 0) {
      setEsignCooldownSeconds(esignStatus.cooldownRemaining);
    }
  }, [esignStatus]);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownSeconds]);

  useEffect(() => {
    if (esignCooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setEsignCooldownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [esignCooldownSeconds]);

  const formatCooldown = useCallback((seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, []);


  const resendWelcomeMutation = useMutation({
    mutationFn: async (profileId: number) => {
      const res = await apiRequest("POST", `/api/merchant-profiles/${profileId}/send-welcome`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Welcome email sent", description: "The merchant portal welcome email has been resent." });
      setCooldownSeconds(300);
      refetchWelcomeStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/merchant-profiles", merchantProfile?.id, "welcome-email-history"] });
    },
    onError: (err: any) => {
      const msg: string = err.message || "";
      if (msg.startsWith("429:")) {
        try {
          const body = JSON.parse(msg.slice(4).trim());
          if (body.retryAfter) {
            setCooldownSeconds(body.retryAfter);
            toast({ title: "Cooldown active", description: body.message || "Please wait before resending.", variant: "destructive" });
            return;
          }
        } catch { /* fall through */ }
      }
      if (msg.includes("wait") || msg.includes("minute")) {
        toast({ title: "Cooldown active", description: msg, variant: "destructive" });
        refetchWelcomeStatus();
      } else {
        toast({ title: "Failed to send email", description: msg || "Could not resend welcome email.", variant: "destructive" });
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (updates: Partial<MerchantApplication>) => {
      const res = await apiRequest("PATCH", `/api/merchant-applications/${application.id}`, updates);
      return (await res.json()) as MerchantApplication;
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant-applications"] });
      onUpdated(updated);
    },
  });

  const esignMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/merchant-applications/${application.id}/send-esign`, {}),
    onSuccess: () => {
      toast({ title: "E-sign sent", description: "E-signature request sent to the merchant." });
      setEsignCooldownSeconds(300);
      queryClient.invalidateQueries({ queryKey: ["/api/merchant-applications"] });
    },
    onError: (err: any) => {
      const msg = err.message || "";
      if (msg.startsWith("429:")) {
        try {
          const body = JSON.parse(msg.slice(4).trim());
          if (body.retryAfter) {
            setEsignCooldownSeconds(body.retryAfter);
            toast({ title: "Cooldown active", description: body.message || "Please wait before resending.", variant: "destructive" });
            return;
          }
        } catch {
        }
      }
      toast({ title: "E-sign failed", description: msg || "Could not send e-signature request.", variant: "destructive" });
    },
  });

  const handleApprove = async () => {
    try {
      await updateMutation.mutateAsync({ status: "approved", approvedAt: new Date() });
      toast({ title: "Application approved", description: "The merchant application has been approved." });
      onClose();
    } catch {
      toast({ title: "Error", description: "Could not approve application.", variant: "destructive" });
    }
  };

  const handleDecline = async () => {
    try {
      await updateMutation.mutateAsync({
        status: "declined",
        declinedAt: new Date(),
        declineReason: declineReason.trim() || null,
      });
      toast({ title: "Application declined", description: "The merchant application has been declined and the merchant has been notified." });
      setShowDecline(false);
      setDeclineReason("");
      onClose();
    } catch {
      toast({ title: "Error", description: "Could not decline application.", variant: "destructive" });
    }
  };

  const handleRequestInfo = async () => {
    const trimmed = requestInfoNote.trim();
    if (!trimmed) {
      toast({ title: "Note required", description: "Please add a note describing what's needed.", variant: "destructive" });
      return;
    }
    try {
      await updateMutation.mutateAsync({
        status: "under_review",
        underwritingStatus: "documents_needed",
        underwritingNotes: trimmed,
      });
      toast({ title: "Note added", description: "Underwriting note saved to the application history." });
      setRequestInfoNote("");
      setShowRequestInfo(false);
    } catch {
      toast({ title: "Error", description: "Could not update application.", variant: "destructive" });
    }
  };

  const handleSaveEditFields = async () => {
    try {
      // Send null for cleared optional fields so storage persists the clear.
      const payload: Partial<MerchantApplication> = {
        legalBusinessName: editFields.legalBusinessName.trim() || null,
        ownerFirstName: editFields.ownerFirstName.trim() || null,
        ownerLastName: editFields.ownerLastName.trim() || null,
        ownerEmail: editFields.ownerEmail.trim() || null,
        businessEmail: editFields.businessEmail.trim() || null,
        status: (editFields.status as any) || undefined, // status must be a valid enum; undefined = no change
      };
      // dba stored in metadata or as top-level; pass through if supported
      (payload as any).dba = editFields.dba.trim() || null;
      await updateMutation.mutateAsync(payload);
      toast({ title: "Application updated", description: "Changes saved successfully." });
      setIsEditMode(false);
    } catch {
      toast({ title: "Error", description: "Could not save changes.", variant: "destructive" });
    }
  };

  const businessName = application.legalBusinessName || (application as any).dba || "Unnamed Business";
  const contactName = [application.ownerFirstName, application.ownerLastName].filter(Boolean).join(" ") || "—";
  const contactEmail = application.ownerEmail || application.businessEmail || "—";

  const APPLICATION_STATUSES = ["draft", "submitted", "in_progress", "under_review", "approved", "declined", "withdrawn"] as const;

  return (
    <div className="space-y-6" data-testid="application-detail-view">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Button variant="ghost" size="sm" onClick={onClose} className="mb-2 -ml-2" data-testid="button-back-to-list">
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back to Applications
          </Button>
          <h2 className="text-xl font-bold text-foreground" data-testid="text-app-business-name">{businessName}</h2>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <Badge variant={getStatusVariant(application.status)} data-testid="badge-app-status">
              {getStatusLabel(application.status)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Submitted {formatDate(application.submittedAt || application.createdAt)}
            </span>
            {application.id && (
              <span className="text-xs text-muted-foreground font-mono" data-testid="text-app-id">
                #{application.id}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {application.status !== "approved" && application.status !== "declined" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRequestInfo(!showRequestInfo)}
                data-testid="button-request-info"
              >
                <MessageSquarePlus className="w-4 h-4 mr-2" />
                Request Info
              </Button>
              <div className="flex flex-col items-start gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => esignMutation.mutate()}
                  disabled={esignMutation.isPending || esignCooldownSeconds > 0}
                  data-testid="button-send-esign"
                >
                  {esignMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <SendHorizonal className="w-4 h-4 mr-2" />
                  )}
                  {esignCooldownSeconds > 0
                    ? `Available in ${formatCooldown(esignCooldownSeconds)}`
                    : "Send E-Sign"}
                </Button>
                {esignCooldownSeconds > 0 && (
                  <span className="text-xs text-muted-foreground" data-testid="text-esign-cooldown">
                    E-sign cooldown active
                  </span>
                )}
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDecline(!showDecline)}
                disabled={updateMutation.isPending}
                data-testid="button-decline-application"
              >
                <XCircle className="w-4 h-4 mr-2" />
                Decline
              </Button>
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={updateMutation.isPending}
                data-testid="button-approve-application"
              >
                {updateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                )}
                Approve
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditFieldsApp({
                legalBusinessName: application.legalBusinessName || "",
                dba: (application as any).dba || "",
                ownerFirstName: application.ownerFirstName || "",
                ownerLastName: application.ownerLastName || "",
                ownerEmail: application.ownerEmail || "",
                businessEmail: application.businessEmail || "",
                status: application.status || "submitted",
              });
              setIsEditMode(!isEditMode);
            }}
            data-testid="button-edit-application"
          >
            {isEditMode ? <><X className="w-4 h-4 mr-2" />Cancel Edit</> : <><Pencil className="w-4 h-4 mr-2" />Edit Details</>}
          </Button>
          {application.status === "approved" && merchantProfile?.accountStatus === "active" && (
            <div className="flex flex-col items-start gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => resendWelcomeMutation.mutate(merchantProfile.id)}
                disabled={resendWelcomeMutation.isPending || cooldownSeconds > 0}
                data-testid="button-resend-welcome-email"
              >
                {resendWelcomeMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <MailCheck className="w-4 h-4 mr-2" />
                )}
                {cooldownSeconds > 0
                  ? `Retry in ${formatCooldown(cooldownSeconds)}`
                  : "Resend Welcome Email"}
              </Button>
              {welcomeStatus?.lastSentAt && (
                <span className="text-xs text-muted-foreground" data-testid="text-last-welcome-sent">
                  Last sent: {new Date(welcomeStatus.lastSentAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Inline Field Edit Form ─────────────────────────────────────────── */}
      {isEditMode && (
        <Card data-testid="card-edit-application-fields">
          <CardContent className="p-4 space-y-4">
            <p className="text-sm font-semibold text-foreground">Edit Application Details</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-legal-name">Legal Business Name</Label>
                <Input
                  id="edit-legal-name"
                  value={editFields.legalBusinessName}
                  onChange={(e) => setEditFieldsApp((p) => ({ ...p, legalBusinessName: e.target.value }))}
                  placeholder="Legal business name"
                  data-testid="input-edit-app-legal-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-dba">DBA (Trade Name)</Label>
                <Input
                  id="edit-dba"
                  value={editFields.dba}
                  onChange={(e) => setEditFieldsApp((p) => ({ ...p, dba: e.target.value }))}
                  placeholder="Doing business as..."
                  data-testid="input-edit-app-dba"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-owner-first">Owner First Name</Label>
                <Input
                  id="edit-owner-first"
                  value={editFields.ownerFirstName}
                  onChange={(e) => setEditFieldsApp((p) => ({ ...p, ownerFirstName: e.target.value }))}
                  placeholder="First name"
                  data-testid="input-edit-app-owner-first"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-owner-last">Owner Last Name</Label>
                <Input
                  id="edit-owner-last"
                  value={editFields.ownerLastName}
                  onChange={(e) => setEditFieldsApp((p) => ({ ...p, ownerLastName: e.target.value }))}
                  placeholder="Last name"
                  data-testid="input-edit-app-owner-last"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-owner-email">Owner Email</Label>
                <Input
                  id="edit-owner-email"
                  type="email"
                  value={editFields.ownerEmail}
                  onChange={(e) => setEditFieldsApp((p) => ({ ...p, ownerEmail: e.target.value }))}
                  placeholder="owner@example.com"
                  data-testid="input-edit-app-owner-email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-business-email">Business Email</Label>
                <Input
                  id="edit-business-email"
                  type="email"
                  value={editFields.businessEmail}
                  onChange={(e) => setEditFieldsApp((p) => ({ ...p, businessEmail: e.target.value }))}
                  placeholder="info@business.com"
                  data-testid="input-edit-app-business-email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-app-status">Status</Label>
                <UISelect
                  value={editFields.status}
                  onValueChange={(v) => setEditFieldsApp((p) => ({ ...p, status: v }))}
                >
                  <UISelectTrigger id="edit-app-status" data-testid="select-edit-app-status">
                    <UISelectValue />
                  </UISelectTrigger>
                  <UISelectContent>
                    {APPLICATION_STATUSES.map((s) => (
                      <UISelectItem key={s} value={s}>{getStatusLabel(s)}</UISelectItem>
                    ))}
                  </UISelectContent>
                </UISelect>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                onClick={handleSaveEditFields}
                disabled={updateMutation.isPending}
                data-testid="button-save-edit-app-fields"
              >
                {updateMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
                ) : (
                  <><Save className="w-4 h-4 mr-2" />Save Changes</>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setIsEditMode(false)}
                data-testid="button-cancel-edit-app-fields"
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {showDecline && (
        <Card data-testid="card-decline-reason">
          <CardContent className="p-4 space-y-3">
            <Label htmlFor="decline-reason">Reason for decline (optional, included in email)</Label>
            <Textarea
              id="decline-reason"
              placeholder="e.g. Unable to verify business documentation, prohibited industry, etc."
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              data-testid="input-decline-reason"
              rows={3}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDecline}
                disabled={updateMutation.isPending}
                data-testid="button-confirm-decline"
              >
                {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Confirm Decline & Notify Merchant
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowDecline(false)} data-testid="button-cancel-decline">
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {showRequestInfo && (
        <Card data-testid="card-request-info">
          <CardContent className="p-4 space-y-3">
            <Label htmlFor="request-info-note">Note for merchant (optional)</Label>
            <Textarea
              id="request-info-note"
              placeholder="Describe what additional information or documents are needed..."
              value={requestInfoNote}
              onChange={(e) => setRequestInfoNote(e.target.value)}
              data-testid="input-request-info-note"
              rows={3}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleRequestInfo} disabled={updateMutation.isPending} data-testid="button-submit-request-info">
                {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Send Request
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowRequestInfo(false)} data-testid="button-cancel-request-info">
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-6">
        <DetailSection title="Business Information" icon={Building2}>
          <DetailField label="Legal Business Name" value={application.legalBusinessName} />
          <DetailField label="DBA" value={application.dba} />
          <DetailField label="EIN" value={application.ein} />
          <DetailField label="Business Type" value={application.businessType} />
          <DetailField label="Started" value={application.businessStartDate} />
          <DetailField label="Vertical" value={application.vertical} />
        </DetailSection>

        <DetailSection title="Contact" icon={User}>
          <DetailField label="Owner Name" value={contactName} />
          <DetailField label="Owner Email" value={contactEmail} />
          <DetailField label="Owner Phone" value={application.ownerPhone} />
          <DetailField label="Business Phone" value={application.businessPhone} />
          <DetailField label="Business Email" value={application.businessEmail} />
          <DetailField label="Website" value={application.website} />
        </DetailSection>

        <DetailSection title="Address" icon={MapPin}>
          <DetailField label="Business Address" value={application.businessAddress} />
          <DetailField label="City" value={application.businessCity} />
          <DetailField label="State" value={application.businessState} />
          <DetailField label="ZIP" value={application.businessZip} />
        </DetailSection>

        <DetailSection title="Processing" icon={CreditCard}>
          <DetailField label="Estimated Monthly Volume" value={application.estimatedMonthlyVolume} />
          <DetailField label="Avg Ticket" value={application.estimatedAvgTicket} />
          <DetailField label="Highest Ticket" value={application.highestTicket} />
          <DetailField label="Current Processor" value={application.currentProcessor} />
          <DetailField label="Current Rate" value={application.currentRate} />
          <DetailField label="Preferred Program" value={application.preferredProgram} />
        </DetailSection>

        <DetailSection title="Banking" icon={Landmark}>
          <DetailField label="Bank Name" value={application.bankName} />
          <DetailField label="Account Type" value={application.bankAccountType} />
        </DetailSection>

        {riskRelationships && riskRelationships.length > 0 && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-3" data-testid="section-risk-relationships">
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Risk Relationships Detected ({riskRelationships.length})
            </div>
            <div className="space-y-2">
              {riskRelationships.map((rel) => (
                <div key={rel.id} className="rounded-md border border-destructive/20 bg-background px-3 py-2 space-y-0.5" data-testid={`risk-rel-${rel.id}`}>
                  <div className="flex items-center gap-2">
                    <GitFork className="w-3 h-3 text-destructive shrink-0" />
                    <span className="text-xs font-semibold text-foreground capitalize">
                      {rel.relationshipType.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-muted-foreground">→ {rel.counterpartyName}</span>
                    <Badge variant="destructive" className="text-xs ml-auto">{Math.round(rel.confidence * 100)}%</Badge>
                  </div>
                  {rel.riskReason && (
                    <p className="text-xs text-muted-foreground pl-5">{rel.riskReason}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <DetailSection title="E-Signature & Underwriting" icon={ClipboardCheck}>
          <DetailField label="E-Sign Status" value={application.esignStatus} />
          <DetailField label="E-Signed At" value={formatDate(application.esignedAt)} />
          <DetailField label="Underwriting Status" value={application.underwritingStatus} />
          <DetailField label="Latest UW Note" value={application.underwritingNotes} />
          <DetailField label="Approved At" value={formatDate(application.approvedAt)} />
          <DetailField label="Declined At" value={formatDate(application.declinedAt)} />
          {application.declineReason && (
            <DetailField label="Decline Reason" value={application.declineReason} />
          )}
        </DetailSection>

        <UnderwritingNotesTimeline
          log={(application.underwritingNotesLog as UnderwritingNoteEntry[] | null) ?? []}
          legacyNote={application.underwritingNotes}
        />

        {application.status === "approved" && merchantProfile && (
          <div className="space-y-3" data-testid="section-welcome-email-history">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b pb-1">
              <Mail className="w-4 h-4 text-primary" />
              Welcome Email History
            </div>
            {isLoadingWelcomeHistory ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
              </div>
            ) : !welcomeEmailHistory || welcomeEmailHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-welcome-emails">
                No welcome emails have been sent yet.
              </p>
            ) : (
              <div className="space-y-2" data-testid="list-welcome-emails">
                {(welcomeEmailHistory as any[]).map((log: any, idx: number) => {
                  const details = log.details as {
                    contactId?: number;
                    mid?: string | null;
                    method?: string;
                    triggeredBy?: string | null;
                    triggeredByRole?: string | null;
                    recipientEmail?: string | null;
                  } | null;
                  const methodLabel = details?.method === "ghl_workflow" ? "GHL Workflow"
                    : details?.method === "ghl_direct_email" ? "GHL Email"
                    : details?.method === "smtp" ? "SMTP"
                    : details?.method || "Unknown";
                  return (
                    <div
                      key={log.id}
                      className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
                      data-testid={`welcome-email-entry-${idx}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <MailCheck className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium" data-testid={`welcome-email-date-${idx}`}>
                            {formatDateTime(log.createdAt)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Sent via {methodLabel}
                            {details?.triggeredBy && (
                              <> · by <span className="font-medium">{details.triggeredBy}</span>
                              {details.triggeredByRole && ` (${details.triggeredByRole})`}</>
                            )}
                          </p>
                          {details?.recipientEmail && (
                            <p className="text-xs text-muted-foreground">To: {details.recipientEmail}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {/* #226 — Load More button */}
                {welcomeHistoryTotal > welcomeHistoryOffset + WELCOME_HISTORY_LIMIT && (
                  <button
                    className="w-full text-xs text-primary hover:underline py-1"
                    onClick={() => setWelcomeHistoryOffset(welcomeHistoryOffset + WELCOME_HISTORY_LIMIT)}
                    data-testid="button-load-more-welcome-history"
                  >
                    Load older emails ({welcomeHistoryTotal - welcomeHistoryOffset - WELCOME_HISTORY_LIMIT} more)
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b pb-1">
            <Paperclip className="w-4 h-4 text-primary" />
            Uploaded Documents
          </div>
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-documents">
              No documents uploaded for this merchant.
            </p>
          ) : (
            <div className="space-y-2" data-testid="list-documents">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  data-testid={`row-document-${doc.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" data-testid={`text-doc-name-${doc.id}`}>{doc.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {doc.type} · {doc.category} · {formatDate(doc.createdAt)}
                      </p>
                    </div>
                  </div>
                  {doc.storageKey && (
                    <a
                      href={`/api/documents/${doc.id}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0"
                      data-testid={`link-doc-download-${doc.id}`}
                    >
                      <Button variant="ghost" size="sm">
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MerchantApplicationsList() {
  const statusState=useC4RetainedSelection("/dashboard/merchant-applications","status",applicationStatuses,"all");
  const statusFilter=statusState.value;
  const setStatusFilter=(value:string)=>{if(applicationStatuses.includes(value as typeof statusFilter))statusState.setValue(value as typeof statusFilter);};
  const [search, setSearch] = useState("");
  const [selectedApp, setSelectedApp] = useState<MerchantApplication | null>(null);

  const params = new URLSearchParams();
  if (statusFilter !== "all") params.set("status", statusFilter);
  if (search) params.set("search", search);
  params.set("limit", "100");

  const { data, isLoading } = useQuery<{ applications: MerchantApplication[]; total: number }>({
    queryKey: ["/api/merchant-applications", statusFilter, search],
    queryFn: async () => {
      const res = await fetch(`/api/merchant-applications?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch applications");
      return res.json();
    },
  });

  const applications = data?.applications || [];
  const total = data?.total || 0;

  if (selectedApp) {
    return (
      <ApplicationDetailView
        application={selectedApp}
        onClose={() => setSelectedApp(null)}
        onUpdated={(updated) => setSelectedApp(updated)}
      />
    );
  }

  return (
    <CrmPage className="space-y-6" data-testid="merchant-applications-list">
      <PageHeader
        title="Merchant Applications"
        subtitle="Review and manage submitted merchant applications"
        testId="text-merchant-applications-header"
        actions={
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-total-count">
            <FileText className="w-4 h-4" />
            {total} total
          </div>
        }
      />

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by business name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-applications"
          />
        </div>
      </div>

      <Tabs value={statusFilter} onValueChange={setStatusFilter} data-testid="tabs-status-filter">
        <TabsList className="flex-wrap h-auto gap-1">
          {STATUS_TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              data-testid={`tab-status-${tab.value}`}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {statusState.issues.map(issue=><p key={issue.key} role="status" className="text-sm text-destructive">{issue.reason}</p>)}

      <Card data-testid="card-applications-table">
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-6 space-y-3" data-testid="applications-loading">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex gap-4 items-center">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          ) : applications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground" data-testid="empty-applications">
              <FileText className="w-10 h-10" />
              <p className="text-sm font-medium">No applications found</p>
              <p className="text-xs">
                {search || statusFilter !== "all"
                  ? "Try adjusting your filters."
                  : "Merchant applications will appear here once submitted."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Business</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications.map((app) => {
                  const businessName = app.legalBusinessName || app.dba || "—";
                  const contactName = [app.ownerFirstName, app.ownerLastName].filter(Boolean).join(" ") || "—";
                  const contactEmail = app.ownerEmail || app.businessEmail || "—";
                  return (
                    <TableRow
                      key={app.id}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setSelectedApp(app)}
                      data-testid={`row-application-${app.id}`}
                    >
                      <TableCell>
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground" data-testid={`text-biz-name-${app.id}`}>{businessName}</p>
                          {app.vertical && (
                            <p className="text-xs text-muted-foreground">{app.vertical}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          <p className="text-sm" data-testid={`text-contact-name-${app.id}`}>{contactName}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Mail className="w-3 h-3" />
                            {contactEmail}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusVariant(app.status)} data-testid={`badge-status-${app.id}`}>
                          {getStatusLabel(app.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground flex items-center gap-1" data-testid={`text-submitted-${app.id}`}>
                          <Calendar className="w-3 h-3" />
                          {formatDate(app.submittedAt || app.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); setSelectedApp(app); }}
                          data-testid={`button-review-${app.id}`}
                        >
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </CrmPage>
  );
}
