import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getCsrfToken } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell, ReferenceLine,
} from "recharts";
import {
  User, ClipboardList, FileText, Headphones,
  CheckCircle, Circle, Loader2, Plus, Upload,
  Calendar, Hash, CreditCard, Activity, ArrowRight,
  PlayCircle, BookOpen, ChevronDown, ChevronUp, Shield, Clock, Zap, Star,
  Phone, Mail, AlertCircle, AlertTriangle, FileCheck, CheckCircle2, Gift, Copy, ExternalLink,
  TrendingUp, TrendingDown, DollarSign, BarChart2, PieChart, Target, Info,
  FileSearch2, RefreshCw,
} from "lucide-react";
import { Link } from "wouter";
import type { MerchantProfile, OnboardingStep, Ticket, MerchantReferral } from "@shared/schema";
import { trackPhoneCallClick } from "@/lib/analytics";
import type { Document as DocType } from "@shared/schema";
import { HelpCenter } from "@/components/HelpCenter";

type TabKey = "guide" | "account" | "onboarding" | "documents" | "support" | "referrals" | "financial" | "chargebacks";

const TABS: { key: TabKey; label: string; icon: typeof User }[] = [
  { key: "guide", label: "Getting Started", icon: BookOpen },
  { key: "account", label: "My Account", icon: User },
  { key: "financial", label: "Financial", icon: BarChart2 },
  { key: "onboarding", label: "Onboarding Progress", icon: ClipboardList },
  { key: "documents", label: "My Documents", icon: FileText },
  { key: "support", label: "Support", icon: Headphones },
  { key: "referrals", label: "Refer & Earn", icon: Gift },
  { key: "chargebacks", label: "Chargebacks", icon: AlertTriangle },
];

function getStatusBadgeVariant(status: string | null | undefined): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active": return "default";
    case "pending": return "secondary";
    case "under_review": return "outline";
    case "suspended": return "destructive";
    default: return "secondary";
  }
}

function getStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "active": return "Active";
    case "pending": return "Pending Review";
    case "under_review": return "Under Review";
    case "suspended": return "Suspended";
    default: return "Pending";
  }
}

function getStatusColor(status: string | null | undefined): string {
  switch (status) {
    case "active": return "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800";
    case "under_review": return "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800";
    case "suspended": return "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800";
    default: return "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800";
  }
}

function getStatusTextColor(status: string | null | undefined): string {
  switch (status) {
    case "active": return "text-emerald-700 dark:text-emerald-300";
    case "under_review": return "text-blue-700 dark:text-blue-300";
    case "suspended": return "text-red-700 dark:text-red-300";
    default: return "text-amber-700 dark:text-amber-300";
  }
}

function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  return new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function AccountStatusBanner({ profile, isLoading }: { profile: MerchantProfile | null | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="sticky top-14 z-20 rounded-lg border p-3 mb-2">
        <Skeleton className="h-5 w-48" />
      </div>
    );
  }

  const status = profile?.accountStatus || "pending";
  const colorClass = getStatusColor(status);
  const textColorClass = getStatusTextColor(status);

  return (
    <div
      className={`sticky top-14 z-20 rounded-lg border px-4 py-3 flex flex-wrap items-center gap-3 ${colorClass}`}
      data-testid="account-status-banner"
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <Badge variant={getStatusBadgeVariant(status)} className="shrink-0" data-testid="banner-status-badge">
          {getStatusLabel(status)}
        </Badge>
        {profile?.merchantMid && (
          <span className="text-sm font-mono text-muted-foreground flex items-center gap-1 shrink-0" data-testid="banner-mid">
            <Hash className="w-3 h-3" />
            MID: {profile.merchantMid}
          </span>
        )}
        {!profile?.merchantMid && (
          <span className={`text-xs ${textColorClass}`} data-testid="banner-mid-pending">
            {status === "pending" ? "MID will be assigned after approval" : status === "under_review" ? "Application under review" : ""}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
        <a href="tel:9542668214" className="flex items-center gap-1 hover:text-foreground transition-colors" data-testid="banner-rep-phone"
          onClick={() => trackPhoneCallClick({ sourcePage: "/dashboard/merchant-portal" })}>
          <Phone className="w-3 h-3" />
          954-266-8214
        </a>
        <a href="mailto:support@libertybancard.com" className="flex items-center gap-1 hover:text-foreground transition-colors hidden sm:flex" data-testid="banner-rep-email">
          <Mail className="w-3 h-3" />
          support@libertybancard.com
        </a>
      </div>
    </div>
  );
}

function AdminMidEditor({ profile }: { profile: MerchantProfile }) {
  const { toast } = useToast();
  const [value, setValue] = useState(profile.merchantMid || "");
  const [editing, setEditing] = useState(false);

  const mutation = useMutation({
    mutationFn: async (mid: string) => {
      const res = await apiRequest("PATCH", `/api/merchant-profiles/${profile.id}`, { merchantMid: mid });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant-profile"] });
      toast({ title: "MID updated", description: "Merchant MID saved." });
      setEditing(false);
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  if (!editing) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => { setValue(profile.merchantMid || ""); setEditing(true); }}
        data-testid="button-admin-edit-mid"
      >
        Edit MID
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-1">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Enter MID"
        className="font-mono h-8 text-sm w-48"
        data-testid="input-admin-mid"
      />
      <Button
        size="sm"
        onClick={() => mutation.mutate(value.trim())}
        disabled={mutation.isPending}
        data-testid="button-save-admin-mid"
      >
        {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)} data-testid="button-cancel-admin-mid">
        Cancel
      </Button>
    </div>
  );
}

type RateReviewStatus = {
  reviews: Array<{
    id: number;
    status: string | null;
    requestNotes: string | null;
    createdAt: string | null;
    repViewedAt: string | null;
    resolvedAt: string | null;
    resolution: string | null;
    document?: { id: number; fileName: string; storageKey: string } | null;
  }>;
  eligible: boolean;
};

const RATE_REVIEW_STATUS_LABELS: Record<string, string> = {
  requested: "Submitted — Under Review",
  analysis_pending: "Analyzing Statement…",
  analysis_complete: "Analysis Complete",
  rep_viewed: "Under Review by Your Rep",
  proposal_sent: "Proposal Prepared",
  resolved: "Resolved",
};

function RateReviewCard({ profile }: { profile: MerchantProfile }) {
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  // Idempotency key: generated once per logical submission, reused on retry, rotated on success.
  const [rateReviewIdempotencyKey, setRateReviewIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const { data, isLoading, refetch } = useQuery<RateReviewStatus>({
    queryKey: ["/api/merchant-portal/rate-review"],
    queryFn: async () => {
      const res = await fetch("/api/merchant-portal/rate-review", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || isUploading) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      if (notes) formData.append("notes", notes);
      const rateReviewHeaders: Record<string, string> = {};
      const csrfRateReview = getCsrfToken();
      if (csrfRateReview) rateReviewHeaders["X-CSRF-Token"] = csrfRateReview;
      rateReviewHeaders["Idempotency-Key"] = rateReviewIdempotencyKey;
      const res = await fetch("/api/merchant-portal/rate-review", {
        method: "POST",
        body: formData,
        credentials: "include",
        headers: rateReviewHeaders,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message || "Upload failed");
      }
      toast({ title: "Rate review submitted!", description: "We'll analyze your statement and contact you within 1 business day." });
      setSelectedFile(null);
      setNotes("");
      // Rotate key after success so next submission is a new logical operation
      setRateReviewIdempotencyKey(crypto.randomUUID());
      refetch();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      // Keep same key on error so a retry is deduplicated
    } finally {
      setIsUploading(false);
    }
  };

  if (isLoading) return <Skeleton className="h-32 w-full" data-testid="rate-review-loading" />;

  const openReview = data?.reviews?.find(r => r.status !== "resolved");

  if (!data?.eligible && !openReview) {
    const goLive = profile.goLiveDate ? new Date(profile.goLiveDate) : null;
    const daysRemaining = goLive ? Math.max(0, 30 - Math.floor((Date.now() - goLive.getTime()) / 86400000)) : null;
    return (
      <Card data-testid="card-rate-review-ineligible" className="border-dashed">
        <CardContent className="flex items-start gap-3 py-4">
          <FileSearch2 className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">Rate Review</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {profile.accountStatus !== "active"
                ? "Available once your account is active."
                : daysRemaining !== null && daysRemaining > 0
                  ? `Available in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""} — after 30 days of processing.`
                  : "Request a review of your processing rates."}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (openReview) {
    const statusLabel = RATE_REVIEW_STATUS_LABELS[openReview.status ?? "requested"] ?? openReview.status;
    return (
      <Card data-testid="card-rate-review-open">
        <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSearch2 className="w-4 h-4 text-primary" />
            Rate Review In Progress
          </CardTitle>
          <Badge variant="secondary" data-testid="badge-rate-review-status">{statusLabel}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Submitted</p>
              <p className="font-medium" data-testid="text-rate-review-submitted">{openReview.createdAt ? new Date(openReview.createdAt).toLocaleDateString() : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Statement</p>
              <p className="font-medium truncate" data-testid="text-rate-review-doc">{openReview.document?.fileName || "Uploaded"}</p>
            </div>
          </div>
          {openReview.resolution && (
            <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-3">
              <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">Resolution</p>
              <p className="text-sm mt-0.5" data-testid="text-rate-review-resolution">{openReview.resolution}</p>
            </div>
          )}
          {openReview.requestNotes && (
            <p className="text-xs text-muted-foreground">Notes: {openReview.requestNotes}</p>
          )}
          <p className="text-xs text-muted-foreground">Your account representative will contact you within 1 business day.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-rate-review-form">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <FileSearch2 className="w-4 h-4 text-primary" />
          Request a Rate Review
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 space-y-1">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200">What happens when you request a rate review?</p>
          <ul className="text-xs text-blue-700 dark:text-blue-300 space-y-1 list-disc list-inside">
            <li>Our AI analyzes your current processing statement</li>
            <li>Your rep reviews savings opportunities within 1 business day</li>
            <li>We'll present you with an optimized pricing proposal</li>
          </ul>
          <p className="text-xs text-blue-600 dark:text-blue-400 pt-1">Eligibility, card brand rules, and applicable laws apply. No savings are guaranteed without full statement review.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="rate-review-file">Upload Your Current Statement <span className="text-red-500">*</span></label>
            <div className="relative">
              <Input
                id="rate-review-file"
                type="file"
                accept=".pdf,.csv,.xls,.xlsx,.png,.jpg,.jpeg"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                className="cursor-pointer"
                required
                data-testid="input-rate-review-file"
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">Accepted: PDF, CSV, Excel, or image. Max 10MB.</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="rate-review-notes">Notes (optional)</label>
            <Textarea
              id="rate-review-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any specific concerns about your current rates, fees, or pricing?"
              rows={3}
              data-testid="textarea-rate-review-notes"
            />
          </div>
          <Button type="submit" disabled={!selectedFile || isUploading} className="w-full" data-testid="button-submit-rate-review">
            {isUploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</> : <><Upload className="w-4 h-4 mr-2" /> Submit Rate Review Request</>}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Boarding-status types & helpers ───────────────────────────────────────
type BoardingStatusData = {
  boardingStatus: string | null;
  processorApplicationId: string | null;
  boardingLog: { timestamp: string; event: string; message?: string; moreInfoRequest?: string }[];
  mid: string | null;
  /** REV-05A: masked MID for display; full MID never returned to client */
  midMasked: string | null;
  hasMid: boolean;
  boardingSubmittedAt: string | null;
  boardingApprovedAt: string | null;
};

const BOARDING_STATUS_META: Record<string, { label: string; color: string; textColor: string; description: string }> = {
  not_submitted: {
    label: "Not Submitted",
    color: "bg-muted border-muted",
    textColor: "text-muted-foreground",
    description: "Your application has not yet been submitted to the processor.",
  },
  submitted: {
    label: "Submitted",
    color: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800",
    textColor: "text-blue-700 dark:text-blue-300",
    description: "Your application has been submitted and is queued for review.",
  },
  under_review: {
    label: "Under Review",
    color: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800",
    textColor: "text-amber-700 dark:text-amber-300",
    description: "Payarc is reviewing your application. Typical decisions take 1–3 business days.",
  },
  more_info_needed: {
    label: "More Information Needed",
    color: "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800",
    textColor: "text-orange-700 dark:text-orange-300",
    description: "Payarc has requested additional information before they can proceed.",
  },
  approved: {
    label: "Approved",
    color: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800",
    textColor: "text-emerald-700 dark:text-emerald-300",
    description: "Your application has been approved — welcome aboard!",
  },
  declined: {
    label: "Declined",
    color: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800",
    textColor: "text-red-700 dark:text-red-300",
    description: "Your application was declined. Please contact your representative for next steps.",
  },
};

const BOARDING_STEPS = [
  { key: "not_submitted", label: "Application Prepared" },
  { key: "submitted", label: "Submitted to Processor" },
  { key: "under_review", label: "Under Review" },
  { key: "approved", label: "Approved & Live" },
] as const;

const STEP_ORDER = ["not_submitted", "submitted", "under_review", "approved"];

function ApplicationStatusCard() {
  const { data, isLoading } = useQuery<BoardingStatusData>({
    queryKey: ["/api/merchant-portal/boarding-status"],
    queryFn: async () => {
      const res = await fetch("/api/merchant-portal/boarding-status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch boarding status");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <Card data-testid="card-boarding-status">
        <CardHeader><CardTitle className="text-base">Application Status</CardTitle></CardHeader>
        <CardContent><Skeleton className="h-24 w-full" /></CardContent>
      </Card>
    );
  }

  const status = data?.boardingStatus ?? "not_submitted";
  const meta = BOARDING_STATUS_META[status] ?? BOARDING_STATUS_META["not_submitted"];
  const currentStepIdx = STEP_ORDER.indexOf(status === "more_info_needed" ? "under_review" : status);
  const isDeclined = status === "declined";

  // Find the most recent more_info_needed log entry
  const moreInfoEntry = status === "more_info_needed"
    ? [...(data?.boardingLog ?? [])].reverse().find(e => e.event === "more_info_needed" || e.moreInfoRequest)
    : null;

  return (
    <Card data-testid="card-boarding-status">
      <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base">Application Status</CardTitle>
        <Badge
          className={`border ${meta.color} ${meta.textColor} font-medium`}
          variant="outline"
          data-testid="badge-boarding-status"
        >
          {meta.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status timeline */}
        {!isDeclined && (
          <ol className="flex items-center gap-0 w-full" aria-label="Application progress">
            {BOARDING_STEPS.map((step, idx) => {
              const done = currentStepIdx > idx;
              const active = currentStepIdx === idx;
              return (
                <li key={step.key} className="flex items-center flex-1 last:flex-none" aria-current={active ? "step" : undefined}>
                  <div className="flex flex-col items-center gap-1 shrink-0">
                    <span
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2
                        ${done ? "bg-primary border-primary text-primary-foreground"
                          : active ? "bg-amber-400 border-amber-400 text-white"
                          : "bg-muted border-muted-foreground/30 text-muted-foreground"}`}
                      data-testid={`step-${step.key}`}
                    >
                      {done ? "✓" : idx + 1}
                    </span>
                    <span className={`text-[10px] text-center leading-tight max-w-[60px] ${active ? "font-semibold text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground"}`}>
                      {step.label}
                    </span>
                  </div>
                  {idx < BOARDING_STEPS.length - 1 && (
                    <div className={`h-0.5 flex-1 mx-1 ${done ? "bg-primary" : "bg-muted"}`} />
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {/* Human-readable explanation */}
        <p className="text-sm text-muted-foreground" data-testid="text-boarding-description">{meta.description}</p>

        {/* Reference number */}
        {data?.processorApplicationId && (
          <div className="flex items-center gap-2 text-sm" data-testid="text-processor-app-id">
            <Hash className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Reference #:</span>
            <span className="font-mono font-medium">{data.processorApplicationId}</span>
          </div>
        )}

        {/* Date submitted */}
        {data?.boardingSubmittedAt && (
          <div className="flex items-center gap-2 text-sm" data-testid="text-boarding-submitted-at">
            <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Submitted:</span>
            <span>{formatDate(data.boardingSubmittedAt)}</span>
          </div>
        )}

        {/* MID (approved) */}
        {status === "approved" && (data?.midMasked || data?.hasMid) && (
          <div className={`rounded-lg p-3 border ${meta.color}`}>
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              🎉 Your Merchant ID (MID) has been assigned!
            </p>
            <p className="text-sm font-mono font-bold mt-1" data-testid="text-approved-mid">{data.midMasked || data.mid}</p>
            <p className="text-xs text-muted-foreground mt-1">Keep this number for your records. Your processing account is now active.</p>
          </div>
        )}

        {/* More info needed */}
        {status === "more_info_needed" && (
          <div className="rounded-lg p-3 border bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800">
            <p className="text-sm font-semibold text-orange-700 dark:text-orange-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Action Required
            </p>
            {moreInfoEntry?.moreInfoRequest && (
              <p className="text-sm mt-1 text-orange-800 dark:text-orange-200" data-testid="text-more-info-request">
                {moreInfoEntry.moreInfoRequest}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2">Please contact your representative or upload the requested documents to the Documents tab.</p>
          </div>
        )}

        <p className="text-xs text-muted-foreground">Typical approval timeline: 3–5 business days. Questions? Call 954-266-8214.</p>
      </CardContent>
    </Card>
  );
}

// ─── Chargebacks Tab ────────────────────────────────────────────────────────
type ChargebackRow = {
  id: number;
  transactionDate: string;
  amount: number;
  cardBrand: string;
  reasonCode: string;
  reasonDescription: string | null;
  status: string;
  responseDeadline: string | null;
  respondedAt: string | null;
  outcome: string | null;
  createdAt: string;
};

function getChargebackStatusBadge(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "Won": return "default";
    case "Lost": return "destructive";
    case "Responded": return "secondary";
    case "Under Review": return "outline";
    default: return "secondary";
  }
}

function ChargebacksTab() {
  const { data: chargebacks, isLoading } = useQuery<ChargebackRow[]>({
    queryKey: ["/api/merchant-portal/chargebacks"],
    queryFn: async () => {
      const res = await fetch("/api/merchant-portal/chargebacks", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  return (
    <div className="space-y-4" data-testid="chargebacks-tab">
      <div>
        <h2 className="text-lg font-semibold" data-testid="text-chargebacks-title">Chargeback Cases</h2>
        <p className="text-sm text-muted-foreground">View-only. Contact your representative to respond to or dispute any case.</p>
      </div>

      {isLoading ? (
        <Card><CardContent className="p-6"><Skeleton className="h-40 w-full" /></CardContent></Card>
      ) : !chargebacks || chargebacks.length === 0 ? (
        <Card data-testid="card-chargebacks-empty">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="text-base font-semibold" data-testid="text-chargebacks-empty">No chargebacks on file — great news!</p>
            <p className="text-sm text-muted-foreground max-w-sm">Maintaining a low chargeback rate keeps your processing account in good standing.</p>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="card-chargebacks-list">
          <CardContent className="p-0 overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Case #</TableHead>
                  <TableHead>Transaction Date</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Card Brand</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Response Deadline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {chargebacks.map((cb) => {
                  const isOverdue = cb.responseDeadline && new Date(cb.responseDeadline) < new Date() && cb.status !== "Won" && cb.status !== "Lost" && cb.status !== "Responded";
                  return (
                    <TableRow key={cb.id} data-testid={`row-chargeback-${cb.id}`}>
                      <TableCell className="font-mono text-sm" data-testid={`text-chargeback-id-${cb.id}`}>#{cb.id}</TableCell>
                      <TableCell className="text-sm" data-testid={`text-chargeback-date-${cb.id}`}>{formatDate(cb.transactionDate)}</TableCell>
                      <TableCell className="font-semibold" data-testid={`text-chargeback-amount-${cb.id}`}>
                        ${cb.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell data-testid={`text-chargeback-card-${cb.id}`}>{cb.cardBrand}</TableCell>
                      <TableCell className="max-w-[180px]" data-testid={`text-chargeback-reason-${cb.id}`}>
                        <span className="font-mono text-xs text-muted-foreground">{cb.reasonCode}</span>
                        {cb.reasonDescription && <span className="block text-xs text-foreground truncate">{cb.reasonDescription}</span>}
                      </TableCell>
                      <TableCell data-testid={`text-chargeback-status-${cb.id}`}>
                        <Badge variant={getChargebackStatusBadge(cb.status)}>{cb.status}</Badge>
                        {cb.outcome && <span className="block text-xs text-muted-foreground mt-0.5">{cb.outcome}</span>}
                      </TableCell>
                      <TableCell data-testid={`text-chargeback-deadline-${cb.id}`}>
                        {cb.responseDeadline ? (
                          <span className={isOverdue ? "text-red-600 font-semibold dark:text-red-400" : "text-sm"}>
                            {isOverdue && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                            {formatDate(cb.responseDeadline)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-sm">N/A</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AccountTab({ profile, isLoading, isAdmin }: { profile: MerchantProfile | null | undefined; isLoading: boolean; isAdmin: boolean }) {
  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="account-loading">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!profile) {
    return (
      <Card data-testid="card-no-profile">
        <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <CreditCard className="w-8 h-8 text-primary" />
          </div>
          <div className="text-center space-y-2">
            <h3 className="text-lg font-semibold" data-testid="text-no-profile-title">Application in Progress</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Your merchant profile hasn't been set up yet. Complete your application to get started with payment processing.
            </p>
          </div>
          <Link href="/apply">
            <Button data-testid="button-start-application">
              <ArrowRight className="w-4 h-4 mr-2" />
              Complete Your Application
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card data-testid="card-account-status">
        <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">Account Overview</CardTitle>
          <Badge variant={getStatusBadgeVariant(profile.accountStatus)} data-testid="badge-account-status">
            {getStatusLabel(profile.accountStatus)}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">MID Number</p>
              <p className="text-sm font-medium flex items-center gap-2" data-testid="text-mid-number">
                <Hash className="w-4 h-4 text-muted-foreground" />
                {profile.merchantMid || "Not assigned yet"}
              </p>
              {isAdmin && <AdminMidEditor profile={profile} />}
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Program Type</p>
              <p className="text-sm font-medium flex items-center gap-2" data-testid="text-program-type">
                <CreditCard className="w-4 h-4 text-muted-foreground" />
                {profile.programType || "Not set"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Go-Live Date</p>
              <p className="text-sm font-medium flex items-center gap-2" data-testid="text-go-live-date">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                {formatDate(profile.goLiveDate)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Current Monthly Volume</p>
              <p className="text-sm font-medium flex items-center gap-2" data-testid="text-monthly-volume">
                <Activity className="w-4 h-4 text-muted-foreground" />
                {profile.currentMonthlyVolume ? `$${Number(profile.currentMonthlyVolume).toLocaleString()}` : "N/A"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <ApplicationStatusCard />

      <Card data-testid="card-account-rep">
        <CardHeader>
          <CardTitle className="text-base">Your Account Representative</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <User className="w-6 h-6 text-primary" />
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <p className="font-semibold text-foreground" data-testid="text-rep-name">Liberty Bancard Support Team</p>
                <p className="text-sm text-muted-foreground">Dedicated merchant success team</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <a href="tel:9542668214" className="flex items-center gap-2 text-sm hover:text-primary transition-colors" data-testid="link-rep-phone"
                  onClick={() => trackPhoneCallClick({ sourcePage: "/dashboard/merchant-portal" })}>
                  <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                  954-266-8214
                </a>
                <a href="mailto:support@libertybancard.com" className="flex items-center gap-2 text-sm hover:text-primary transition-colors" data-testid="link-rep-email">
                  <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                  support@libertybancard.com
                </a>
              </div>
              <p className="text-xs text-muted-foreground">Response within 4 business hours · Available Mon–Fri 9am–6pm ET</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {profile.accountStatus === "active" && (
        <Card data-testid="card-processing-history">
          <CardHeader>
            <CardTitle className="text-base">Processing Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Monthly Volume</p>
                <p className="text-lg font-bold text-foreground" data-testid="text-summary-volume">
                  {profile.currentMonthlyVolume ? `$${Number(profile.currentMonthlyVolume).toLocaleString()}` : "—"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Last Statement</p>
                <p className="text-sm font-medium text-foreground" data-testid="text-last-statement">
                  {formatDate(profile.lastStatementDate)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Next Statement</p>
                <p className="text-sm font-medium text-foreground" data-testid="text-next-statement">
                  {formatDate(profile.nextStatementDate)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <RateReviewCard profile={profile} />
    </div>
  );
}

type PortalChecklistItem = {
  id: number;
  dealId: number;
  itemKey: string;
  status: string | null;
  documentId: number | null;
  notes: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

const CHECKLIST_ITEM_LABELS: Record<string, string> = {
  voided_check: "Voided Check",
  government_id: "Government-Issued ID",
  signed_agreement: "Signed Merchant Agreement",
  bank_letter: "Bank Letter",
  business_license: "Business License",
};

const PORTAL_STATUS_MAP: Record<string, { label: string; color: string; description: string }> = {
  not_requested: { label: "Not Yet Requested", color: "text-muted-foreground", description: "Your rep will request this when needed." },
  requested: { label: "Requested — Action Needed", color: "text-amber-600 dark:text-amber-400", description: "Please upload this document to the Documents tab." },
  received: { label: "Received — Under Review", color: "text-blue-600 dark:text-blue-400", description: "We received your document and are reviewing it." },
  approved: { label: "Approved", color: "text-emerald-600 dark:text-emerald-400", description: "This document has been approved." },
  rejected: { label: "Needs Correction", color: "text-red-600 dark:text-red-400", description: "This document needs to be re-uploaded. Check the notes or contact your rep." },
};

type PortalTask = { id: number; title: string; status: string | null; priority: string | null; dueDate: string | null; completedAt: string | null };

function OnboardingTasksCard({ dealId }: { dealId: number | null | undefined }) {
  const { data: portalTasks, isLoading } = useQuery<PortalTask[]>({
    queryKey: ["/api/merchant-portal/onboarding-tasks", dealId],
    queryFn: async () => {
      if (!dealId) return [];
      const res = await fetch(`/api/merchant-portal/onboarding-tasks?dealId=${dealId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!dealId,
  });

  if (!dealId || isLoading) return null;

  if (!portalTasks || portalTasks.length === 0) {
    return (
      <Card data-testid="card-onboarding-tasks-empty">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-primary" />
            Onboarding Milestones
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-onboarding-tasks-empty">
            Your onboarding milestones will appear here once assigned.
          </p>
        </CardContent>
      </Card>
    );
  }

  const formatDue = (d: string | null) => {
    if (!d) return null;
    const date = new Date(d);
    const now = new Date();
    const overdue = date < now;
    const label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return { label, overdue };
  };

  return (
    <Card data-testid="card-onboarding-tasks">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-primary" />
          Onboarding Milestones
        </CardTitle>
        <p className="text-xs text-muted-foreground">Key steps our team is working through to get your account live.</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {portalTasks.map(task => {
          const due = formatDue(task.dueDate);
          const isDone = task.status === "completed" || task.status === "done";
          return (
            <div key={task.id} className="flex flex-col gap-1 py-1.5 border-b last:border-0" data-testid={`portal-task-${task.id}`}>
              <div className="flex items-center gap-3">
                <div className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${isDone ? "bg-emerald-100 border-emerald-500 dark:bg-emerald-900 dark:border-emerald-400" : "border-muted-foreground/30 bg-muted"}`}>
                  {isDone && <CheckCircle className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${isDone ? "line-through text-muted-foreground" : "text-foreground"}`} data-testid={`portal-task-title-${task.id}`}>{task.title}</p>
                </div>
                {due && !isDone && (
                  <span className={`text-xs shrink-0 ${due.overdue ? "text-red-500" : "text-muted-foreground"}`} data-testid={`portal-task-due-${task.id}`}>
                    {due.overdue ? "Overdue" : `Due ${due.label}`}
                  </span>
                )}
                {isDone && (
                  <div className="flex flex-col items-end shrink-0 gap-0.5">
                    <Badge variant="secondary" className="text-xs" data-testid={`portal-task-done-${task.id}`}>Done</Badge>
                    {task.completedAt && (
                      <span className="text-[10px] text-muted-foreground" data-testid={`portal-task-completed-at-${task.id}`}>
                        {new Date(task.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {/* KYC upload CTA — shown only when server explicitly flags the task as a KYC upload task */}
              {!isDone && (task as any).isKycUploadTask === true && (
                <div className="ml-8">
                  <a
                    href="#upload-documents"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                    data-testid={`link-kyc-upload-${task.id}`}
                    onClick={e => { e.preventDefault(); document.getElementById("upload-documents")?.scrollIntoView({ behavior: "smooth" }); }}
                  >
                    <Upload className="w-3 h-3" />
                    Upload KYC documents
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function OnboardingTab({ dealId, profile }: { dealId: number | null | undefined; profile: MerchantProfile | null | undefined }) {
  const { data: steps, isLoading } = useQuery<OnboardingStep[]>({
    queryKey: ["/api/onboarding-steps/deal", dealId],
    queryFn: async () => {
      const res = await fetch(`/api/onboarding-steps/deal/${dealId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!dealId,
  });

  const { data: checklistItems } = useQuery<PortalChecklistItem[]>({
    queryKey: ["/api/deals", dealId, "onboarding-checklist"],
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/onboarding-checklist`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!dealId,
  });

  if (!dealId) {
    return (
      <Card data-testid="card-no-onboarding">
        <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
          <ClipboardList className="w-12 h-12 text-muted-foreground" />
          <div className="text-center space-y-2">
            <h3 className="text-lg font-semibold">No Onboarding Data</h3>
            <p className="text-sm text-muted-foreground">Onboarding steps will appear here once your application is processed.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="onboarding-loading">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-3 items-center">
            <Skeleton className="h-8 w-8 rounded-full shrink-0" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const sortedSteps = steps?.sort((a, b) => a.stepOrder - b.stepOrder) || [];
  const completedCount = sortedSteps.filter(s => s.status === "completed").length;
  const currentIndex = sortedSteps.findIndex((s) => s.status !== "completed");
  const progressPct = sortedSteps.length > 0 ? Math.round((completedCount / sortedSteps.length) * 100) : 0;

  const getActionForStep = (step: OnboardingStep): string | null => {
    const name = step.stepName?.toLowerCase() || "";
    if (name.includes("voided check") || name.includes("bank")) return "Upload to Documents tab";
    if (name.includes("statement")) return "Upload to Documents tab";
    if (name.includes("id") || name.includes("identification")) return "Upload to Documents tab";
    if (name.includes("sign") || name.includes("agreement")) return "Check your email";
    if (name.includes("terminal") || name.includes("equipment")) return "Our team will contact you";
    return null;
  };

  if (sortedSteps.length === 0) {
    return (
      <Card data-testid="card-no-steps">
        <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
          <ClipboardList className="w-12 h-12 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No onboarding steps found for this deal.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card data-testid="card-onboarding-progress-summary">
        <CardContent className="p-4 sm:p-6">
          <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-foreground">{completedCount} of {sortedSteps.length} steps complete</p>
              <p className="text-xs text-muted-foreground">Account status: {getStatusLabel(profile?.accountStatus)}</p>
            </div>
            <span className="text-lg font-bold text-primary">{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-2.5" data-testid="onboarding-progress-bar" />
        </CardContent>
      </Card>

      <Card data-testid="card-onboarding-steps">
        <CardHeader>
          <CardTitle className="text-base">Your Onboarding Checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {sortedSteps.map((step, index) => {
              const isCompleted = step.status === "completed";
              const isCurrent = index === currentIndex;
              const isLast = index === sortedSteps.length - 1;
              const actionText = getActionForStep(step);

              return (
                <div key={step.id} className="relative flex gap-3 pb-5" data-testid={`onboarding-step-${step.id}`}>
                  <div className="flex flex-col items-center">
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 ${
                      isCompleted
                        ? "bg-green-100 border-green-500 dark:bg-green-900 dark:border-green-400"
                        : isCurrent
                          ? "bg-blue-100 border-blue-500 dark:bg-blue-900 dark:border-blue-400"
                          : "bg-muted border-muted-foreground/30"
                    }`}>
                      {isCompleted ? (
                        <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : isCurrent ? (
                        <Loader2 className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-spin" />
                      ) : (
                        <Circle className="h-4 w-4 text-muted-foreground/50" />
                      )}
                    </div>
                    {!isLast && (
                      <div className={`w-0.5 flex-1 mt-1 ${isCompleted ? "bg-green-400" : "bg-border"}`} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5 pb-1">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <p className={`text-sm font-medium ${isCompleted ? "text-muted-foreground line-through" : isCurrent ? "text-blue-600 dark:text-blue-400" : "text-foreground"}`} data-testid={`text-step-name-${step.id}`}>
                        {step.stepName}
                      </p>
                      <Badge
                        variant={isCompleted ? "secondary" : isCurrent ? "default" : "outline"}
                        className="text-xs shrink-0"
                        data-testid={`badge-step-status-${step.id}`}
                      >
                        {isCompleted ? "Complete" : isCurrent ? "In Progress" : "Pending"}
                      </Badge>
                    </div>
                    {isCompleted && step.completedAt && (
                      <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-step-date-${step.id}`}>
                        Completed {formatDate(step.completedAt)}
                      </p>
                    )}
                    {isCurrent && actionText && (
                      <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 flex items-center gap-1" data-testid={`text-step-action-${step.id}`}>
                        <ArrowRight className="w-3 h-3 shrink-0" />
                        {actionText}
                      </p>
                    )}
                    {!isCompleted && !isCurrent && (
                      <p className="text-xs text-muted-foreground mt-0.5">Waiting for previous steps</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <OnboardingTasksCard dealId={dealId} />

      {checklistItems && checklistItems.length > 0 && (
        <Card data-testid="card-document-checklist">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-primary" />
              Document Status
            </CardTitle>
            <p className="text-xs text-muted-foreground">Track the review status of each required document. Upload files in the Documents tab.</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {checklistItems.map((item) => {
              const statusInfo = PORTAL_STATUS_MAP[item.status || "not_requested"] ?? PORTAL_STATUS_MAP.not_requested;
              const label = CHECKLIST_ITEM_LABELS[item.itemKey] ?? item.itemKey;
              const needsAction = item.status === "requested" || item.status === "rejected";
              return (
                <div
                  key={item.id}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${needsAction ? "border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700" : "border-border bg-muted/30"}`}
                  data-testid={`checklist-item-${item.itemKey}`}
                >
                  <div className="mt-0.5">
                    {item.status === "approved" ? (
                      <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    ) : item.status === "rejected" ? (
                      <AlertTriangle className="w-4 h-4 text-red-500" />
                    ) : item.status === "received" ? (
                      <FileText className="w-4 h-4 text-blue-500" />
                    ) : item.status === "requested" ? (
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                    ) : (
                      <Circle className="w-4 h-4 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" data-testid={`text-checklist-label-${item.itemKey}`}>{label}</p>
                    <p className={`text-xs mt-0.5 ${statusInfo.color}`} data-testid={`text-checklist-status-${item.itemKey}`}>{statusInfo.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{statusInfo.description}</p>
                    {item.notes && (
                      <p className="text-xs mt-1 italic text-muted-foreground border-l-2 border-border pl-2" data-testid={`text-checklist-notes-${item.itemKey}`}>{item.notes}</p>
                    )}
                  </div>
                  {needsAction && (
                    <Badge variant="outline" className="text-xs text-amber-600 border-amber-400 shrink-0" data-testid={`badge-action-needed-${item.itemKey}`}>
                      Action Needed
                    </Badge>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const MAX_FILE_SIZE_MB = 20;
const ACCEPTED_TYPES = ".pdf, .png, .jpg, .jpeg, .csv";

const MERCHANT_DOC_CATEGORIES = [
  "Statement",
  "Voided Check",
  "Photo ID",
  "Bank Statement",
  "EIN Letter",
  "Signed Proposal",
  "KYC",
  "Other",
] as const;

function DocumentsTab({ contactId }: { contactId: number | null | undefined }) {
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadCategory, setUploadCategory] = useState<string>("Statement");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  // Idempotency key: generated once per logical upload, reused on retry, rotated on success.
  const [uploadIdempotencyKey, setUploadIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const { data: documents = [], isLoading } = useQuery<DocType[]>({
    queryKey: ["/api/merchant-documents/contact", contactId],
    queryFn: async () => {
      if (!contactId) return [];
      const res = await fetch(`/api/merchant-documents/contact/${contactId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!contactId,
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setFileError(null);
    if (file) {
      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        setFileError(`File is too large. Maximum size is ${MAX_FILE_SIZE_MB} MB.`);
        setSelectedFile(null);
        e.target.value = "";
        return;
      }
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!["pdf", "png", "jpg", "jpeg", "csv"].includes(ext || "")) {
        setFileError("Invalid file type. Please upload a PDF, PNG, JPG, JPEG, or CSV.");
        setSelectedFile(null);
        e.target.value = "";
        return;
      }
    }
    setSelectedFile(file);
  };

  const handleUpload = async () => {
    if (!selectedFile || uploading) return;
    setUploading(true);
    setUploadProgress(10);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("category", uploadCategory);
      setUploadProgress(30);
      const uploadHeaders: Record<string, string> = {};
      const csrfVal = getCsrfToken();
      if (csrfVal) uploadHeaders["X-CSRF-Token"] = csrfVal;
      uploadHeaders["Idempotency-Key"] = uploadIdempotencyKey;
      const res = await fetch("/api/merchant-portal/upload-statement", {
        method: "POST",
        credentials: "include",
        body: formData,
        headers: uploadHeaders,
      });
      setUploadProgress(80);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      setUploadProgress(100);
      const newDoc = await res.json().catch(() => null);
      const categoryLabel = uploadCategory !== "Statement" ? ` (${uploadCategory})` : "";
      toast({ title: "Document uploaded", description: `${selectedFile.name}${categoryLabel} has been uploaded successfully.` });
      setSelectedFile(null);
      setUploadProgress(0);
      const fileInput = document.querySelector('[data-testid="input-upload-file"]') as HTMLInputElement;
      if (fileInput) fileInput.value = "";
      // Rotate key after success so next upload is a new logical operation
      setUploadIdempotencyKey(crypto.randomUUID());
      queryClient.invalidateQueries({ queryKey: ["/api/merchant-documents/contact", contactId] });
    } catch (err: any) {
      setUploadProgress(0);
      toast({ title: "Upload failed", description: err.message || "Something went wrong.", variant: "destructive" });
      // Keep same key on error so a retry is deduplicated
    } finally {
      setUploading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="documents-loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card data-testid="card-upload-section">
        <CardHeader>
          <CardTitle className="text-base">Upload Document</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-0 space-y-2">
              <Select value={uploadCategory} onValueChange={setUploadCategory} disabled={uploading}>
                <SelectTrigger className="w-full" data-testid="select-upload-category">
                  <SelectValue placeholder="Document category" />
                </SelectTrigger>
                <SelectContent>
                  {MERCHANT_DOC_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat} data-testid={`option-category-${cat.replace(/\s+/g, "-").toLowerCase()}`}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.csv"
                onChange={handleFileChange}
                disabled={uploading}
                data-testid="input-upload-file"
                className="cursor-pointer"
              />
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span data-testid="text-accepted-types">
                  Accepted: PDF, PNG, JPG, JPEG, CSV
                </span>
                <span data-testid="text-max-size">
                  Max size: {MAX_FILE_SIZE_MB} MB
                </span>
              </div>
              {fileError && (
                <p className="text-xs text-destructive flex items-center gap-1" data-testid="text-file-error">
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  {fileError}
                </p>
              )}
            </div>
            <Button
              onClick={handleUpload}
              disabled={!selectedFile || uploading || !!fileError}
              data-testid="button-upload-statement"
              className="shrink-0"
            >
              {uploading ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" />Uploading...</>
              ) : (
                <><Upload className="w-4 h-4 mr-2" />Upload</>
              )}
            </Button>
          </div>
          {uploading && (
            <div className="space-y-1" data-testid="upload-progress-container">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Uploading {selectedFile?.name}...</span>
                <span>{uploadProgress}%</span>
              </div>
              <Progress value={uploadProgress} className="h-1.5" data-testid="upload-progress-bar" />
            </div>
          )}
        </CardContent>
      </Card>
      <Card data-testid="card-documents-list">
        <CardHeader>
          <CardTitle className="text-base">Uploaded Documents</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table className="sm:min-w-[480px]">
            <TableHeader>
              <TableRow>
                <TableHead>File Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center h-24 text-muted-foreground" data-testid="text-no-documents">
                    No documents uploaded yet
                  </TableCell>
                </TableRow>
              ) : (
                documents.map((doc) => (
                  <TableRow key={doc.id} data-testid={`row-document-${doc.id}`}>
                    <TableCell className="font-medium" data-testid={`text-doc-name-${doc.id}`}>
                      <div className="flex items-center gap-2 max-w-[200px]">
                        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{doc.fileName}</span>
                      </div>
                    </TableCell>
                    <TableCell data-testid={`text-doc-type-${doc.id}`}>
                      <Badge variant="secondary" className="text-xs">{doc.type}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-doc-date-${doc.id}`}>{formatDate(doc.createdAt)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/merchant-documents/${doc.id}/access-token`, { credentials: "include" });
                            if (!res.ok) throw new Error("Could not get download link");
                            const { url } = await res.json();
                            window.open(url, "_blank");
                          } catch {
                            toast({ title: "Download failed", description: "Could not generate a download link.", variant: "destructive" });
                          }
                        }}
                        data-testid={`button-download-doc-${doc.id}`}
                      >
                        <FileText className="w-4 h-4 mr-1" />
                        Download
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

type StepMeta = { action: string; href?: string; hrefLabel?: string; eta: string; tabTarget?: string };

function getStepMeta(step: OnboardingStep): StepMeta {
  const name = step.stepName?.toLowerCase() || "";
  if (name.includes("voided check") || name.includes("bank")) {
    return { action: "Upload a voided check or bank letter to verify your deposit account.", hrefLabel: "Go to Documents", href: "#documents", eta: "Today", tabTarget: "documents" };
  }
  if (name.includes("statement")) {
    return { action: "Upload your most recent processing statement so we can complete your analysis.", hrefLabel: "Go to Documents", href: "#documents", eta: "Today", tabTarget: "documents" };
  }
  if (name.includes("id") || name.includes("identification")) {
    return { action: "Upload a government-issued photo ID for the primary business owner.", hrefLabel: "Go to Documents", href: "#documents", eta: "Today", tabTarget: "documents" };
  }
  if (name.includes("sign") || name.includes("agreement") || name.includes("mpa")) {
    return { action: "Check your email for the Merchant Processing Agreement and complete the e-signature.", eta: "Today — check your inbox" };
  }
  if (name.includes("terminal") || name.includes("equipment")) {
    return { action: "Our team will contact you to confirm your terminal or gateway setup.", eta: "3–5 business days" };
  }
  if (name.includes("review") || name.includes("underwriting") || name.includes("approval")) {
    return { action: "Our underwriting team will review your application. No action needed from you.", eta: "1–2 business days" };
  }
  if (name.includes("go-live") || name.includes("go live") || name.includes("activate")) {
    return { action: "You're almost live! Our team will confirm your go-live date.", eta: "5–7 business days" };
  }
  return { action: "Our team is working on this step and will update you shortly.", eta: "1–3 business days" };
}

function GettingStartedTab({ dealId, profile, onTabChange }: { dealId: number | null | undefined; profile: MerchantProfile | null | undefined; onTabChange?: (tab: string) => void }) {
  const [expandedSection, setExpandedSection] = useState<number | null>(null);

  const { data: steps, isLoading: stepsLoading } = useQuery<OnboardingStep[]>({
    queryKey: ["/api/onboarding-steps/deal", dealId],
    queryFn: async () => {
      const res = await fetch(`/api/onboarding-steps/deal/${dealId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!dealId,
  });

  const sortedSteps = steps?.sort((a, b) => a.stepOrder - b.stepOrder) || [];
  const completedCount = sortedSteps.filter(s => s.status === "completed").length;
  const currentStep = sortedSteps.find(s => s.status !== "completed");

  const staticSections = [
    {
      icon: PlayCircle,
      title: "Welcome to Liberty Bancard",
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-100 dark:bg-blue-900",
      content: "Liberty Bancard is your payment processing partner. We specialize in finding real savings on your credit card processing costs through our proprietary statement review process. Unlike other processors, we don't just sell you a rate — we prove your real cost and fix it.\n\nThis portal is your home base to track your application, onboarding progress, uploaded documents, and get support whenever you need it.",
    },
    {
      icon: Clock,
      title: "What to Expect: Your Onboarding Timeline",
      color: "text-green-600 dark:text-green-400",
      bg: "bg-green-100 dark:bg-green-900",
      content: "Day 1–2: Application review and underwriting — we verify your business details and processing history.\n\nDay 3–5: Account approval and terminal/gateway setup — your MID (Merchant ID) is assigned.\n\nDay 5–7: Go-live — your new processing begins. You'll see your first batch settlement within 24–48 hours.\n\nDay 14: First check-in — we review your first two weeks of processing to ensure everything is running smoothly.\n\nDay 30: Full review — we compare your actual savings against your old statement to confirm results.",
    },
    {
      icon: FileText,
      title: "Documents You May Need",
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-100 dark:bg-amber-900",
      content: "• Recent processing statement (last 3 months preferred)\n• Voided check or bank letter for deposit account\n• Government-issued ID for business owner(s)\n• Business license or articles of incorporation\n• Tax ID / EIN documentation\n\nYou can upload any of these in the 'My Documents' tab. Our team will let you know if anything else is needed.",
    },
    {
      icon: Shield,
      title: "Security & Compliance",
      color: "text-purple-600 dark:text-purple-400",
      bg: "bg-purple-100 dark:bg-purple-900",
      content: "Your data is protected with bank-level encryption. We never store full card numbers or sensitive authentication data. Our platform is designed to support PCI DSS compliance, and we'll guide you through a simple self-assessment to make sure your business stays compliant.\n\nAll communications are logged for your protection, and you can request copies of any documents or data at any time.",
    },
    {
      icon: Zap,
      title: "Getting the Most from Your Account",
      color: "text-orange-600 dark:text-orange-400",
      bg: "bg-orange-100 dark:bg-orange-900",
      content: "• Check your onboarding progress regularly — each step gets you closer to go-live.\n• Upload your processing statement early — it speeds up the savings analysis.\n• Use the Support tab to create tickets for any issues — our team responds within 4 business hours.\n• Ask about our Cash Discount and Surcharging programs — they can eliminate processing costs entirely for qualifying merchants.\n• Refer other business owners through our referral program and earn bonuses.",
    },
    {
      icon: Star,
      title: "Why Merchants Choose Liberty Bancard",
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-100 dark:bg-emerald-900",
      content: "• Free statement review with transparent savings analysis — no obligation.\n• Multiple program options: Cash Discount, Interchange Plus, and Tiered Reduction.\n• Dedicated account manager for ongoing support.\n• Next-day funding available for qualifying merchants.\n• No long-term contracts or hidden fees — we earn your business every month.\n• 24/7 terminal support and rapid equipment replacement.",
    },
  ];

  return (
    <div className="space-y-4" data-testid="getting-started-tab">
      {stepsLoading && dealId && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {sortedSteps.length > 0 && (
        <Card data-testid="card-dynamic-checklist">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-primary" />
              Your Getting Started Checklist
              <Badge variant="secondary" className="ml-auto" data-testid="checklist-progress-badge">
                {completedCount}/{sortedSteps.length} done
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {currentStep && (
              <div className="flex items-start gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 mb-3" data-testid="current-step-action">
                <AlertCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Action needed: {currentStep.stepName}</p>
                  <p className="text-xs text-blue-600/80 dark:text-blue-400/80 mt-0.5">
                    Complete this step to keep your onboarding on track.
                  </p>
                </div>
              </div>
            )}
            <div className="space-y-2">
              {sortedSteps.map((step, i) => {
                const isComplete = step.status === "completed";
                const isCurrent = step.id === currentStep?.id;
                const meta = getStepMeta(step);
                return (
                  <div
                    key={step.id}
                    className={`rounded-md border p-3 ${
                      isComplete
                        ? "bg-green-50/50 dark:bg-green-950/20 border-green-200 dark:border-green-800"
                        : isCurrent
                        ? "bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800"
                        : "bg-muted/30 border-muted"
                    }`}
                    data-testid={`checklist-step-${step.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                        isComplete ? "bg-green-500" : isCurrent ? "bg-blue-500" : "bg-muted-foreground/20"
                      }`}>
                        {isComplete ? (
                          <CheckCircle className="w-3 h-3 text-white" />
                        ) : isCurrent ? (
                          <Loader2 className="w-3 h-3 text-white animate-spin" />
                        ) : (
                          <Circle className="w-3 h-3 text-muted-foreground/50" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <p className={`text-sm font-medium ${isComplete ? "line-through text-muted-foreground" : "text-foreground"}`}>
                            {step.stepName}
                          </p>
                          <Badge
                            variant={isComplete ? "secondary" : isCurrent ? "default" : "outline"}
                            className="text-xs shrink-0"
                            data-testid={`checklist-badge-${step.id}`}
                          >
                            {isComplete ? "Done" : isCurrent ? "Now" : "Pending"}
                          </Badge>
                        </div>
                        {isComplete && step.completedAt && (
                          <p className="text-xs text-muted-foreground mt-0.5">Completed {formatDate(step.completedAt)}</p>
                        )}
                        {!isComplete && (
                          <div className="mt-1.5 space-y-1.5">
                            <p className="text-xs text-muted-foreground leading-snug" data-testid={`checklist-action-${step.id}`}>
                              {meta.action}
                            </p>
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="text-[11px] text-muted-foreground flex items-center gap-1" data-testid={`checklist-eta-${step.id}`}>
                                <Clock className="w-3 h-3 shrink-0" />
                                ETA: {meta.eta}
                              </span>
                              {isCurrent && meta.tabTarget && onTabChange && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2 py-0"
                                  onClick={() => onTabChange(meta.tabTarget!)}
                                  data-testid={`checklist-action-btn-${step.id}`}
                                >
                                  <ArrowRight className="w-3 h-3 mr-1" />
                                  {meta.hrefLabel || "Take action"}
                                </Button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" />
            Getting Started with Liberty Bancard
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Everything you need to know about your merchant account, onboarding process, and what to expect.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {staticSections.map((section, i) => {
            const Icon = section.icon;
            const isExpanded = expandedSection === i;
            return (
              <div key={i} className="border rounded-lg overflow-hidden" data-testid={`guide-section-${i}`}>
                <button
                  className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left"
                  onClick={() => setExpandedSection(isExpanded ? null : i)}
                  data-testid={`guide-toggle-${i}`}
                >
                  <div className={`w-9 h-9 rounded-lg ${section.bg} flex items-center justify-center shrink-0`}>
                    <Icon className={`w-4.5 h-4.5 ${section.color}`} />
                  </div>
                  <span className="text-sm font-semibold flex-1">{section.title}</span>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 pl-16">
                    <p className="text-sm text-muted-foreground whitespace-pre-line leading-relaxed">{section.content}</p>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <HelpCenter context="merchant" />
    </div>
  );
}

function ReferralTab({ profile }: { profile: MerchantProfile | null | undefined }) {
  const { toast } = useToast();
  const [referredEmail, setReferredEmail] = useState("");
  const [referredName, setReferredName] = useState("");
  const [referredCompany, setReferredCompany] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const { data: referralData, isLoading, refetch } = useQuery<{
    profile: { referralCode: string | null; referralCredits: string | null; referralCount: number | null };
    referrals: MerchantReferral[];
  }>({
    queryKey: ["/api/merchant-portal/referrals"],
  });

  const generateCodeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/merchant-portal/referral-code", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant-portal/referrals"] });
      refetch();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const referralCode = referralData?.profile?.referralCode || null;
  const credits = parseFloat(referralData?.profile?.referralCredits || "0");
  const referralCount = referralData?.profile?.referralCount || 0;
  const referrals = referralData?.referrals || [];

  const creditedReferrals = referrals.filter(r => r.status === "credited");
  const pendingReferrals = referrals.filter(r => r.status === "pending" || r.status === "signed_up" || r.status === "activated");
  const creditedAmount = creditedReferrals.reduce((sum, r) => sum + parseFloat(r.creditAmount || "0"), 0);
  const pendingAmount = pendingReferrals.reduce((sum, r) => {
    const stored = parseFloat(r.creditAmount || "0");
    return sum + (stored > 0 ? stored : 50);
  }, 0);

  const referralLink = referralCode ? `${window.location.origin}/refer/${referralCode}` : null;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied!", description: "Referral link copied to clipboard." });
    });
  };

  const handleSubmitReferral = async () => {
    if (!referralCode || !referredEmail) return;
    setSubmitting(true);
    try {
      const referralHeaders: Record<string, string> = { "Content-Type": "application/json" };
      const csrfRef = getCsrfToken();
      if (csrfRef) referralHeaders["X-CSRF-Token"] = csrfRef;
      const res = await fetch("/api/merchant-referrals", {
        method: "POST",
        headers: referralHeaders,
        body: JSON.stringify({ referralCode, referredEmail, referredName, referredCompany }),
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        toast({ title: "Error", description: err.message, variant: "destructive" });
      } else {
        setSubmitted(true);
        setReferredEmail("");
        setReferredName("");
        setReferredCompany("");
        queryClient.invalidateQueries({ queryKey: ["/api/merchant-portal/referrals"] });
        toast({ title: "Referral sent!", description: "We'll notify you when they sign up." });
      }
    } catch {
      toast({ title: "Error", description: "Failed to submit referral.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const statusVariant = (s: string): "default" | "secondary" | "destructive" | "outline" => {
    if (s === "activated" || s === "credited") return "default";
    if (s === "pending") return "secondary";
    return "outline";
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="referral-tab">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card data-testid="card-referral-credits">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Credits Earned</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-600 dark:text-green-400" data-testid="text-credits-amount">
              ${credits.toFixed(2)}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="card-total-referrals">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Referrals</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold" data-testid="text-referral-count">{referralCount}</p>
          </CardContent>
        </Card>
        <Card data-testid="card-reward-per-referral">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Reward Per Referral</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-primary">$50</p>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-your-earnings">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-primary" />
              Your Earnings
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => window.open("mailto:support@libertybancard.com?subject=Referral%20Payout%20Request&body=Hi%2C%20I%27d%20like%20to%20request%20a%20payout%20for%20my%20referral%20credits.%20My%20referral%20code%20is%3A%20" + encodeURIComponent(referralCode || ""), "_blank")}
              data-testid="button-request-payout"
            >
              <DollarSign className="w-3.5 h-3.5" />
              Request Payout
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-4">
              <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium mb-1">Credited</p>
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400" data-testid="text-credited-amount">
                ${creditedAmount.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{creditedReferrals.length} conversion{creditedReferrals.length !== 1 ? "s" : ""}</p>
            </div>
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-4">
              <p className="text-xs text-amber-700 dark:text-amber-400 font-medium mb-1">Pending</p>
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="text-pending-amount">
                ${pendingAmount.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{pendingReferrals.length} referral{pendingReferrals.length !== 1 ? "s" : ""} in progress</p>
            </div>
          </div>

          {creditedReferrals.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Earnings Timeline</p>
              <div>
                {[...creditedReferrals]
                  .sort((a, b) => new Date(b.creditPaidAt || b.createdAt!).getTime() - new Date(a.creditPaidAt || a.createdAt!).getTime())
                  .map((r, idx, arr) => {
                    const firstName = (r.referredName || r.referredEmail.split("@")[0]).split(" ")[0];
                    const eventDate = r.creditPaidAt || r.createdAt;
                    return (
                      <div key={r.id} className="flex items-start gap-3" data-testid={`timeline-event-${r.id}`}>
                        <div className="flex flex-col items-center">
                          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 mt-1 shrink-0" />
                          {idx < arr.length - 1 && <div className="w-px flex-1 bg-border min-h-[28px]" />}
                        </div>
                        <div className="flex-1 pb-4">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{firstName} activated</span>
                            <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400" data-testid={`timeline-amount-${r.id}`}>
                              +${parseFloat(r.creditAmount || "50").toFixed(2)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground" data-testid={`timeline-date-${r.id}`}>
                            {eventDate ? new Date(eventDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "—"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground" data-testid="earnings-empty-state">
              <DollarSign className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No credited earnings yet. Share your referral link to start earning!</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-your-code">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gift className="w-4 h-4 text-primary" />
            Your Referral Code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {referralCode ? (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <code className="block text-2xl font-mono font-bold tracking-widest text-primary" data-testid="text-referral-code">
                    {referralCode}
                  </code>
                </div>
                <Button variant="outline" size="sm" onClick={() => copyToClipboard(referralCode)} data-testid="button-copy-code">
                  <Copy className="w-4 h-4 mr-1" /> Copy Code
                </Button>
              </div>
              {referralLink && (
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs text-muted-foreground truncate flex-1 min-w-0">{referralLink}</p>
                  <Button variant="outline" size="sm" onClick={() => copyToClipboard(referralLink)} data-testid="button-copy-link">
                    <ExternalLink className="w-4 h-4 mr-1" /> Copy Link
                  </Button>
                </div>
              )}
              {referralLink && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 justify-start"
                    onClick={() => {
                      const text = encodeURIComponent(`I've been saving on payment processing fees with Liberty Bancard. They do a free statement review — no pressure. Check it out: ${referralLink}`);
                      window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(referralLink)}&summary=${text}`, "_blank", "noopener,noreferrer,width=600,height=600");
                    }}
                    data-testid="button-share-linkedin-merchant"
                  >
                    <svg className="w-4 h-4 text-[#0A66C2]" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                    Share on LinkedIn
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 justify-start"
                    onClick={() => {
                      const body = `Hey! I save on payment processing fees through Liberty Bancard. They do a free review — ${referralLink}`;
                      window.open(`sms:?body=${encodeURIComponent(body)}`, "_self");
                    }}
                    data-testid="button-share-sms-merchant"
                  >
                    <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                    Send via SMS
                  </Button>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Share this code with other business owners. You earn <strong>$50 in credits</strong> for every merchant who activates their account using your code.
              </p>
            </>
          ) : (
            <div className="text-center space-y-3 py-4">
              <p className="text-sm text-muted-foreground">Generate your unique referral code to start earning.</p>
              <Button onClick={() => generateCodeMutation.mutate()} disabled={generateCodeMutation.isPending} data-testid="button-generate-code">
                {generateCodeMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Generate My Referral Code
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {referralCode && (
        <Card data-testid="card-send-referral">
          <CardHeader>
            <CardTitle className="text-base">Invite a Business Owner</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {submitted ? (
              <div className="text-center py-4 space-y-2">
                <CheckCircle className="w-8 h-8 text-green-500 mx-auto" />
                <p className="text-sm font-medium">Referral submitted!</p>
                <Button variant="outline" size="sm" onClick={() => setSubmitted(false)}>Send Another</Button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Their Email *</Label>
                    <Input value={referredEmail} onChange={(e) => setReferredEmail(e.target.value)} placeholder="friend@business.com" data-testid="input-referred-email" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Their Name (optional)</Label>
                    <Input value={referredName} onChange={(e) => setReferredName(e.target.value)} placeholder="Jane Smith" data-testid="input-referred-name" />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Business Name (optional)</Label>
                    <Input value={referredCompany} onChange={(e) => setReferredCompany(e.target.value)} placeholder="Smith's Bakery" data-testid="input-referred-company" />
                  </div>
                </div>
                <Button onClick={handleSubmitReferral} disabled={!referredEmail || submitting} className="w-full" data-testid="button-submit-referral">
                  {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Send Referral
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {referrals.length > 0 && (
        <Card data-testid="card-referral-history">
          <CardHeader>
            <CardTitle className="text-base">Referral History</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table className="min-w-[400px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Reward</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrals.map((r) => (
                  <TableRow key={r.id} data-testid={`row-referral-${r.id}`}>
                    <TableCell>
                      <div>
                        <p className="text-sm font-medium">{r.referredName || "—"}</p>
                        <p className="text-xs text-muted-foreground">{r.referredEmail}</p>
                      </div>
                    </TableCell>
                    <TableCell><Badge variant={statusVariant(r.status || "pending")} className="capitalize">{r.status}</Badge></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(r.createdAt!).toLocaleDateString()}</TableCell>
                    <TableCell className="text-sm">
                      {r.status === "credited" ? (
                        <span className="text-green-600 font-medium">+${r.creditAmount}</span>
                      ) : "Pending"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type FinancialOverview = {
  hasData: boolean;
  mid: string | null;
  overview: {
    vol30: number; vol60: number; vol90: number;
    netRevenue30: number; cbRatio30: number | null; cbRatioTrend: number | null;
    approvalRate30: number | null; volTrend: number | null; avgDailyVol30: number; tx30: number;
  };
  monthlyCashFlow: { month: string; label: string; grossVolume: number; netPayout: number; fees: number }[];
  feeBreakdown: {
    interchange: number; processingFee: number; monthlyFee: number; chargebackFees: number;
    totalFees: number; competitorEstimate: number; savingsVsCompetitor: number;
    effectiveRate: number; competitorRate: number; programType: string;
  };
  declineCategories: { code: string; label: string; count: number; pct: number; color: string; tip: string }[];
  revenueTrend: { month: string; volume: number; projected: boolean }[];
  industryBenchmarking: {
    vertical: string; merchantCbRatio: number | null; industryCbRatio: number;
    merchantApprovalRate: number | null; industryApprovalRate: number;
    merchantAvgTicket: number | null; industryAvgTicket: number;
  };
};

function fmt$(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return "—";
  return n.toFixed(decimals) + "%";
}

function TrendBadge({ value, label, invertColors = false }: { value: number | null; label?: string; invertColors?: boolean }) {
  if (value === null || value === undefined) return null;
  const isPositive = invertColors ? value < 0 : value > 0;
  const isNeutral = Math.abs(value) < 0.05;
  if (isNeutral) return <span className="text-xs text-muted-foreground">Flat</span>;
  return (
    <span className={`flex items-center gap-0.5 text-xs font-medium ${isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
      {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {Math.abs(value).toFixed(1)}{label || "%"}
    </span>
  );
}

function NoDataState({ mid }: { mid: string | null }) {
  return (
    <Card data-testid="card-no-financial-data">
      <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <BarChart2 className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center space-y-2 max-w-sm">
          <h3 className="text-lg font-semibold" data-testid="text-no-data-title">Financial Data Not Yet Available</h3>
          <p className="text-sm text-muted-foreground">
            {mid
              ? `Your MID (${mid}) is active. Financial metrics will appear once processing data has been ingested — typically within 24–48 hours of your first batch.`
              : "Your Merchant ID (MID) hasn't been assigned yet. Once you go live, your full financial dashboard will be available here."}
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full max-w-xs">
          <a href="tel:9542668214" onClick={() => trackPhoneCallClick({ sourcePage: "/dashboard/merchant-portal-financial" })}>
            <Button variant="outline" className="w-full" data-testid="button-call-support-financial">
              <Phone className="w-4 h-4 mr-2" />
              Call Support
            </Button>
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function FinancialTab() {
  const { data, isLoading, error } = useQuery<FinancialOverview>({
    queryKey: ["/api/merchant/financial-overview"],
    queryFn: async () => {
      const res = await fetch("/api/merchant/financial-overview", { credentials: "include" });
      if (res.status === 404) return { hasData: false, mid: null, overview: { vol30:0,vol60:0,vol90:0,netRevenue30:0,cbRatio30:null,cbRatioTrend:null,approvalRate30:null,volTrend:null,avgDailyVol30:0,tx30:0 }, monthlyCashFlow:[], feeBreakdown:{interchange:0,processingFee:0,monthlyFee:0,chargebackFees:0,totalFees:0,competitorEstimate:0,savingsVsCompetitor:0,effectiveRate:0,competitorRate:2.85,programType:"Standard"}, declineCategories:[], revenueTrend:[], industryBenchmarking:{vertical:"Industry Average",merchantCbRatio:null,industryCbRatio:0.5,merchantApprovalRate:null,industryApprovalRate:97,merchantAvgTicket:null,industryAvgTicket:80} } as FinancialOverview;
      if (!res.ok) throw new Error("Failed to load financial data");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="financial-loading">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
        <Skeleton className="h-64 w-full" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card data-testid="card-financial-error">
        <CardContent className="py-12 text-center">
          <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Unable to load financial data. Please try again later.</p>
        </CardContent>
      </Card>
    );
  }

  if (!data.hasData) {
    return <NoDataState mid={data.mid} />;
  }

  const { overview, monthlyCashFlow, feeBreakdown, declineCategories, revenueTrend, industryBenchmarking } = data;

  return (
    <div className="space-y-6" data-testid="financial-tab">

      {/* === FINANCIAL OVERVIEW KPIs === */}
      <div>
        <h2 className="text-base font-semibold mb-3 flex items-center gap-2" data-testid="section-overview">
          <DollarSign className="w-4 h-4 text-primary" />
          Financial Overview
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card data-testid="kpi-vol30">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Volume (30d)</p>
              <p className="text-xl font-bold text-foreground" data-testid="text-vol30">{fmt$(overview.vol30)}</p>
              <div className="mt-1"><TrendBadge value={overview.volTrend} /></div>
            </CardContent>
          </Card>
          <Card data-testid="kpi-net-revenue">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Net Revenue (30d)</p>
              <p className="text-xl font-bold text-foreground" data-testid="text-net-revenue">{fmt$(overview.netRevenue30)}</p>
              <p className="text-xs text-muted-foreground mt-1">After fees</p>
            </CardContent>
          </Card>
          <Card data-testid="kpi-cb-ratio">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Chargeback Ratio</p>
              <p className={`text-xl font-bold ${overview.cbRatio30 != null && overview.cbRatio30 > 1 ? "text-red-600 dark:text-red-400" : "text-foreground"}`} data-testid="text-cb-ratio">
                {fmtPct(overview.cbRatio30, 2)}
              </p>
              <div className="mt-1"><TrendBadge value={overview.cbRatioTrend} invertColors label="pp" /></div>
            </CardContent>
          </Card>
          <Card data-testid="kpi-approval-rate">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Approval Rate</p>
              <p className="text-xl font-bold text-foreground" data-testid="text-approval-rate">{fmtPct(overview.approvalRate30)}</p>
              <p className="text-xs text-muted-foreground mt-1">Avg daily: {fmt$(overview.avgDailyVol30)}</p>
            </CardContent>
          </Card>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3">
          {[
            { label: "Volume (60d)", value: fmt$(overview.vol60), testid: "text-vol60" },
            { label: "Volume (90d)", value: fmt$(overview.vol90), testid: "text-vol90" },
            { label: "Transactions (30d)", value: overview.tx30.toLocaleString(), testid: "text-tx30" },
          ].map(({ label, value, testid }) => (
            <Card key={testid} data-testid={`kpi-${testid}`}>
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-base font-semibold mt-0.5" data-testid={testid}>{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* === CASH FLOW CHART === */}
      {monthlyCashFlow.length > 0 && (
        <Card data-testid="card-cash-flow">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-primary" />
              Monthly Cash Flow
            </CardTitle>
            <p className="text-xs text-muted-foreground">Gross volume vs. net payout after fees</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={monthlyCashFlow} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={48} />
                <Tooltip
                  formatter={(value: number, name: string) => [fmt$(value), name === "grossVolume" ? "Gross Volume" : name === "netPayout" ? "Net Payout" : "Fees"]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend formatter={(v) => v === "grossVolume" ? "Gross Volume" : v === "netPayout" ? "Net Payout" : "Fees"} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="grossVolume" fill="hsl(var(--primary))" opacity={0.7} radius={[3,3,0,0]} />
                <Bar dataKey="netPayout" fill="#10b981" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* === FEES & COSTS BREAKDOWN === */}
      <Card data-testid="card-fee-breakdown">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <PieChart className="w-4 h-4 text-primary" />
            Fees & Cost Breakdown
            <Badge variant="secondary" className="ml-auto text-xs" data-testid="badge-program-type">{feeBreakdown.programType}</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">Based on your last 30 days of processing volume</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground">Your Fees</h4>
              {[
                { label: "Interchange", value: feeBreakdown.interchange, testid: "fee-interchange" },
                { label: "Processing Markup", value: feeBreakdown.processingFee, testid: "fee-processing" },
                { label: "Monthly Fee", value: feeBreakdown.monthlyFee, testid: "fee-monthly" },
                { label: "Chargeback Fees", value: feeBreakdown.chargebackFees, testid: "fee-chargeback" },
              ].map(({ label, value, testid }) => (
                <div key={testid} className="flex items-center justify-between gap-2" data-testid={testid}>
                  <span className="text-sm text-muted-foreground">{label}</span>
                  <span className="text-sm font-medium tabular-nums">{fmt$(value)}</span>
                </div>
              ))}
              <div className="border-t pt-2 flex items-center justify-between" data-testid="fee-total">
                <span className="text-sm font-semibold">Total Monthly Fees</span>
                <span className="text-sm font-bold text-foreground">{fmt$(feeBreakdown.totalFees)}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Effective rate: <span className="font-medium">{fmtPct(feeBreakdown.effectiveRate)}</span>
              </div>
            </div>
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground">vs. Typical Competitor</h4>
              <div className="rounded-lg bg-muted/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Competitor Estimate</span>
                  <span className="text-sm font-medium tabular-nums text-muted-foreground line-through">{fmt$(feeBreakdown.competitorEstimate)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Competitor Rate</span>
                  <span className="text-sm text-muted-foreground">{fmtPct(feeBreakdown.competitorRate)}</span>
                </div>
                <div className="border-t pt-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Your Savings</span>
                  <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400" data-testid="text-savings">
                    {feeBreakdown.savingsVsCompetitor > 0 ? fmt$(feeBreakdown.savingsVsCompetitor) + "/mo" : "—"}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                Competitor estimate uses industry-average blended rate of {fmtPct(feeBreakdown.competitorRate)}. Actual savings may vary.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* === DECLINE ANALYSIS === */}
      {declineCategories.length > 0 && (
        <Card data-testid="card-decline-analysis">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-primary" />
              Decline Analysis (30d)
            </CardTitle>
            <p className="text-xs text-muted-foreground">Recent decline reasons with actionable tips</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {declineCategories.map((cat) => (
              <div key={cat.code} className="space-y-1" data-testid={`decline-${cat.code}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                    <span className="text-sm font-medium truncate">{cat.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground tabular-nums">{cat.count} declines</span>
                    <Badge variant="outline" className="text-xs">{cat.pct}%</Badge>
                  </div>
                </div>
                <Progress value={cat.pct} className="h-1.5" style={{ "--progress-bar-color": cat.color } as any} />
                <p className="text-xs text-muted-foreground pl-4 leading-snug">{cat.tip}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* === REVENUE TREND & PROJECTION === */}
      {revenueTrend.length > 1 && (
        <Card data-testid="card-revenue-trend">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              Revenue Trend & Projection
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              12-month processing volume · Dashed bar = trailing-average estimate
            </p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={revenueTrend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={48} />
                <Tooltip
                  formatter={(value: number, _: any, props: any) => [
                    fmt$(value) + (props.payload?.projected ? " (est.)" : ""),
                    "Volume",
                  ]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="volume" radius={[3,3,0,0]}>
                  {revenueTrend.map((entry, index) => (
                    <Cell
                      key={index}
                      fill={entry.projected ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))"}
                      opacity={entry.projected ? 0.5 : 0.85}
                      stroke={entry.projected ? "hsl(var(--primary))" : "none"}
                      strokeWidth={entry.projected ? 1 : 0}
                      strokeDasharray={entry.projected ? "4 2" : "none"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <Info className="w-3 h-3 shrink-0" />
              Projected month uses a trailing 3-month average. For informational purposes only.
            </p>
          </CardContent>
        </Card>
      )}

      {/* === INDUSTRY BENCHMARKING === */}
      <Card data-testid="card-benchmarking">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            Industry Benchmarking
            <span className="text-xs font-normal text-muted-foreground ml-1">vs. {industryBenchmarking.vertical}</span>
          </CardTitle>
          <p className="text-xs text-muted-foreground">Anonymized averages for your industry segment</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[
              {
                label: "Chargeback Ratio",
                merchant: industryBenchmarking.merchantCbRatio,
                industry: industryBenchmarking.industryCbRatio,
                format: (v: number | null) => fmtPct(v, 2),
                betterIfLower: true,
                testid: "bench-cb-ratio",
              },
              {
                label: "Approval Rate",
                merchant: industryBenchmarking.merchantApprovalRate,
                industry: industryBenchmarking.industryApprovalRate,
                format: (v: number | null) => fmtPct(v),
                betterIfLower: false,
                testid: "bench-approval-rate",
              },
              {
                label: "Avg Transaction",
                merchant: industryBenchmarking.merchantAvgTicket,
                industry: industryBenchmarking.industryAvgTicket,
                format: (v: number | null) => v != null ? fmt$(v) : "—",
                betterIfLower: false,
                testid: "bench-avg-ticket",
              },
            ].map(({ label, merchant, industry, format, betterIfLower, testid }) => {
              const isBetter = merchant != null && (betterIfLower ? merchant < industry : merchant > industry);
              const isWorse = merchant != null && (betterIfLower ? merchant > industry : merchant < industry);
              return (
                <div key={testid} className="space-y-1" data-testid={testid}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">Industry: {format(industry)}</span>
                      <span className={`font-semibold ${isBetter ? "text-emerald-600 dark:text-emerald-400" : isWorse ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>
                        {merchant != null ? format(merchant) : "—"}
                        {isBetter && <TrendingUp className="w-3 h-3 inline ml-1" />}
                        {isWorse && <TrendingDown className="w-3 h-3 inline ml-1" />}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    <div className="h-2 rounded-full bg-muted flex-1 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${isBetter ? "bg-emerald-500" : isWorse ? "bg-red-500" : "bg-primary"}`}
                        style={{ width: merchant != null ? `${Math.min(100, (merchant / (industry * 2)) * 100)}%` : "0%" }}
                      />
                    </div>
                    <div className="h-2 rounded-full bg-muted flex-1 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-muted-foreground/40 transition-all"
                        style={{ width: `${Math.min(100, (industry / (industry * 2)) * 100)}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-primary inline-block" />You</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-muted-foreground/40 inline-block" />Industry Avg</span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-4 flex items-start gap-1">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            Benchmarks are anonymized industry averages and are for reference only. Your actual figures may vary based on business type and volume.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function SupportTab({ contactId }: { contactId: number | null | undefined }) {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [newTicket, setNewTicket] = useState({ subject: "", description: "", priority: "Normal" });

  const { data: ticketsRes, isLoading } = useQuery<{ data: Ticket[]; total: number }>({
    queryKey: ["/api/tickets"],
  });
  const allTickets = ticketsRes?.data;

  const tickets = contactId
    ? allTickets?.filter((t) => t.contactId === contactId)
    : [];

  const createMutation = useMutation({
    mutationFn: async (data: { subject: string; description: string; priority: string; contactId?: number }) => {
      const res = await apiRequest("POST", "/api/tickets", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      setCreateOpen(false);
      setNewTicket({ subject: "", description: "", priority: "Normal" });
      toast({ title: "Ticket created", description: "Your support ticket has been submitted." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create ticket.", variant: "destructive" });
    },
  });

  const handleCreateTicket = () => {
    if (!newTicket.subject || !newTicket.description) {
      toast({ title: "Missing fields", description: "Please fill in subject and description.", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      subject: newTicket.subject,
      description: newTicket.description,
      priority: newTicket.priority,
      ...(contactId ? { contactId } : {}),
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="support-loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-ticket">
              <Plus className="w-4 h-4 mr-2" />
              New Ticket
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Support Ticket</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input
                  value={newTicket.subject}
                  onChange={(e) => setNewTicket({ ...newTicket, subject: e.target.value })}
                  placeholder="Brief description of your issue"
                  data-testid="input-ticket-subject"
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={newTicket.description}
                  onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })}
                  placeholder="Provide details about your issue"
                  data-testid="input-ticket-description"
                />
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={newTicket.priority} onValueChange={(v) => setNewTicket({ ...newTicket, priority: v })}>
                  <SelectTrigger data-testid="select-ticket-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Low">Low</SelectItem>
                    <SelectItem value="Normal">Normal</SelectItem>
                    <SelectItem value="High">High</SelectItem>
                    <SelectItem value="Urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end pt-2">
                <Button onClick={handleCreateTicket} disabled={createMutation.isPending} data-testid="button-submit-ticket">
                  {createMutation.isPending ? "Submitting..." : "Submit Ticket"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <Card data-testid="card-tickets-list">
        <CardContent className="p-0 overflow-x-auto">
          <Table className="sm:min-w-[480px]">
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(!tickets || tickets.length === 0) ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center h-24 text-muted-foreground" data-testid="text-no-tickets">
                    No support tickets
                  </TableCell>
                </TableRow>
              ) : (
                tickets.map((ticket) => (
                  <TableRow key={ticket.id} data-testid={`row-ticket-${ticket.id}`}>
                    <TableCell className="font-medium" data-testid={`text-ticket-subject-${ticket.id}`}>{ticket.subject}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" data-testid={`badge-ticket-status-${ticket.id}`}>
                        {ticket.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ticket.priority === "Urgent" ? "destructive" : "secondary"} data-testid={`badge-ticket-priority-${ticket.id}`}>
                        {ticket.priority}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm" data-testid={`text-ticket-date-${ticket.id}`}>
                      {formatDate(ticket.createdAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function MerchantPortal() {
  const [activeTab, setActiveTab] = useState<TabKey>("guide");
  const { user } = useAuth();

  const { data: profile, isLoading: profileLoading } = useQuery<MerchantProfile | null>({
    queryKey: ["/api/merchant-profile"],
    queryFn: async () => {
      const res = await fetch("/api/merchant-profile", { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch profile");
      return res.json();
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <PageTitle className="text-2xl font-bold" data-testid="text-portal-title">Merchant Portal</PageTitle>
        <p className="text-sm text-muted-foreground mt-1" data-testid="text-portal-subtitle">
          {user ? `Welcome, ${user.firstName || user.email}` : "Manage your merchant account"}
        </p>
      </div>

      <AccountStatusBanner profile={profile} isLoading={profileLoading} />

      <div className="flex gap-0.5 flex-wrap border-b pb-0 overflow-x-auto" data-testid="tab-navigation">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <Button
              key={tab.key}
              variant="ghost"
              size="sm"
              className={`rounded-b-none gap-1.5 shrink-0 ${isActive ? "border-b-2 border-primary font-semibold" : ""}`}
              onClick={() => setActiveTab(tab.key)}
              data-testid={`tab-${tab.key}`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline text-xs">{tab.label}</span>
            </Button>
          );
        })}
      </div>

      <div data-testid={`tab-content-${activeTab}`}>
        {activeTab === "guide" && (
          <GettingStartedTab dealId={profile?.dealId} profile={profile} onTabChange={(tab) => setActiveTab(tab as TabKey)} />
        )}
        {activeTab === "account" && (
          <AccountTab profile={profile} isLoading={profileLoading} isAdmin={user?.role === "admin" || user?.role === "manager"} />
        )}
        {activeTab === "financial" && (
          <FinancialTab />
        )}
        {activeTab === "onboarding" && (
          <OnboardingTab dealId={profile?.dealId} profile={profile} />
        )}
        {activeTab === "documents" && (
          <DocumentsTab contactId={profile?.contactId} />
        )}
        {activeTab === "support" && (
          <SupportTab contactId={profile?.contactId} />
        )}
        {activeTab === "referrals" && (
          <ReferralTab profile={profile} />
        )}
        {activeTab === "chargebacks" && (
          <ChargebacksTab />
        )}
      </div>
    </div>
  );
}
