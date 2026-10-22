import { CrmPage, CrmPageHeader } from "@/components/crm/CrmPresentation";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Users, Handshake, DollarSign, Award, Plus, PlayCircle, Target, BookOpen, TrendingUp, Star, ChevronDown, ChevronUp, Link2, CheckCircle, XCircle, Copy, ExternalLink, Eye, Trophy, Medal } from "lucide-react";
import type { Referral } from "@shared/schema";
import type { PartnerOperatorRecord as Partner } from "@shared/partner-response";
import { PARTNER_TYPES, REFERRAL_STATUSES } from "@shared/schema";
import { HelpCenter } from "@/components/HelpCenter";
import referralVideo from "@assets/videos/referral-explainer.mp4";

const partnerFormSchema = z.object({
  companyName: z.string().min(1, "Required"),
  contactName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  partnerType: z.string().min(1, "Required"),
  commissionPercent: z.coerce.number().min(0).max(100).default(10),
  notes: z.string().optional(),
});

const referralFormSchema = z.object({
  partnerId: z.coerce.number().min(1, "Select a partner"),
  referredName: z.string().optional(),
  referredEmail: z.string().email().optional().or(z.literal("")),
  referredPhone: z.string().optional(),
  referredCompany: z.string().optional(),
  incentiveType: z.string().optional(),
  incentiveAmount: z.string().optional(),
  notes: z.string().optional(),
});

type PartnerFormData = z.infer<typeof partnerFormSchema>;
type ReferralFormData = z.infer<typeof referralFormSchema>;

function KpiCard({ icon: Icon, label, value, testId }: { icon: typeof Users; label: string; value: string | number; testId: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <Icon className="h-4 w-4 text-primary" />
            </div>
            <span className="text-sm text-muted-foreground">{label}</span>
          </div>
          <span className="text-2xl font-bold" data-testid={testId}>{value}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function partnerTypeBadgeVariant(type: string): "default" | "secondary" | "outline" {
  switch (type) {
    case "iso_agent": return "default";
    case "bank_partner": return "secondary";
    case "strategic": return "default";
    default: return "outline";
  }
}

function referralStatusColor(status: string): string {
  switch (status) {
    case "pending": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
    case "contacted": return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    case "qualified": return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200";
    case "converted": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    case "lost": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
    case "paid": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200";
    default: return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
  }
}

function formatPartnerType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ReferralExplainer() {
  const [expanded, setExpanded] = useState(false);

  const guides = [
    {
      icon: PlayCircle,
      title: "What Is Liberty Bancard's Referral Program?",
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-100 dark:bg-blue-900",
      content: "Our referral program lets you earn commissions by connecting businesses with Liberty Bancard's payment processing solutions. Whether you're an ISO agent, bank partner, or business referrer, you earn when your referrals become merchants. We handle the sales process, onboarding, and ongoing support — you just make the introduction.",
    },
    {
      icon: Target,
      title: "How It Works: Step by Step",
      color: "text-green-600 dark:text-green-400",
      bg: "bg-green-100 dark:bg-green-900",
      content: "1. Register as a partner using the 'Add Partner' button above.\n2. Submit referrals with basic contact details — name, email, phone, and business name.\n3. Our sales team reaches out, reviews their statement, and presents a savings proposal.\n4. When the merchant signs up, your referral status updates to 'Converted.'\n5. You earn your commission based on your agreed-upon structure (flat fee, percentage, or bonus).\n\nTrack everything in real time right here on this dashboard.",
    },
    {
      icon: Star,
      title: "Best Practices for Sales Referrals",
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-100 dark:bg-amber-900",
      content: "• Lead with value: Tell the merchant we do a free, no-obligation statement review that typically finds $200–$500/month in savings.\n• Warm introductions convert best: A quick email intro or 3-way call dramatically increases close rates.\n• Focus on pain points: Ask if they're happy with their current rates, customer service, or terminal reliability.\n• Quality over quantity: One qualified referral with a processing statement is worth more than ten cold leads.\n• Follow up: Check your referral status here and ask us for updates — engaged partners close more deals.",
    },
    {
      icon: TrendingUp,
      title: "Commission & Payout Structure",
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-100 dark:bg-emerald-900",
      content: "• Standard referral bonus: Flat fee per converted merchant (varies by partner agreement).\n• Residual commissions: Ongoing monthly percentage of processing revenue for ISO/agent partners.\n• Tiered bonuses: Volume incentives when you hit referral milestones.\n• Payouts tracked automatically in your Total Payouts column — no chasing checks.\n\nAll commission terms are set when you register as a partner. Contact us to discuss custom structures.",
    },
  ];

  return (
    <Card data-testid="referral-explainer">
      <CardContent className="p-4">
        <button
          className="w-full flex items-center justify-between gap-2"
          onClick={() => setExpanded(!expanded)}
          data-testid="btn-toggle-explainer"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div className="text-left">
              <p className="text-sm font-semibold">Referral Program Guide & Best Practices</p>
              <p className="text-xs text-muted-foreground">Learn how to maximize your referral earnings</p>
            </div>
          </div>
          {expanded ? <ChevronUp className="w-5 h-5 text-muted-foreground" /> : <ChevronDown className="w-5 h-5 text-muted-foreground" />}
        </button>

        {expanded && (
          <div className="mt-4 space-y-4" data-testid="explainer-content">
            <div className="rounded-lg overflow-hidden border bg-black" data-testid="referral-video">
              <video
                src={referralVideo}
                controls
                className="w-full aspect-video"
                poster=""
                preload="metadata"
                data-testid="video-referral-explainer"
              >
                Your browser does not support video playback.
              </video>
              <div className="bg-muted/50 px-4 py-2">
                <p className="text-xs font-medium">Referral Program Overview</p>
                <p className="text-[11px] text-muted-foreground">Watch this short explainer to learn how to earn commissions by referring merchants to Liberty Bancard.</p>
              </div>
            </div>

            {guides.map((guide, i) => {
              const Icon = guide.icon;
              return (
                <div key={i} className="border rounded-lg p-4" data-testid={`guide-section-${i}`}>
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-lg ${guide.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                      <Icon className={`w-4.5 h-4.5 ${guide.color}`} />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold mb-2">{guide.title}</h4>
                      <p className="text-sm text-muted-foreground whitespace-pre-line leading-relaxed">{guide.content}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type LeaderboardEntry = {
  rank: number;
  displayName: string;
  referrals: number;
  conversions: number;
  earnings: number;
  badge: "Bronze" | "Silver" | "Gold" | "Platinum";
  partnerId: number;
};

type LeaderboardResponse = {
  period: "monthly" | "alltime";
  leaderboard: LeaderboardEntry[];
  lastMonth: LeaderboardEntry[];
  month: string;
  lastMonthDate: string;
  currentPartnerId: number | null;
};

const BADGE_STYLES: Record<string, { label: string; className: string }> = {
  Bronze:   { label: "Bronze",   className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-700" },
  Silver:   { label: "Silver",   className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-600" },
  Gold:     { label: "Gold",     className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 border border-yellow-300 dark:border-yellow-700" },
  Platinum: { label: "Platinum", className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 border border-indigo-300 dark:border-indigo-700" },
};

function LeaderboardTable({
  entries,
  currentPartnerId,
  testIdPrefix,
}: {
  entries: LeaderboardEntry[];
  currentPartnerId: number | null;
  testIdPrefix: string;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">No referral activity recorded for this period.</p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-14">Rank</TableHead>
          <TableHead>Affiliate</TableHead>
          <TableHead className="text-center">Referrals</TableHead>
          <TableHead className="text-center">Conversions</TableHead>
          <TableHead className="text-right">Earnings</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const badgeStyle = BADGE_STYLES[entry.badge] || BADGE_STYLES.Bronze;
          const isCurrentUser = currentPartnerId != null && entry.partnerId === currentPartnerId;
          const rankIcons = [
            <Trophy key="1" className="w-4 h-4 text-yellow-500" />,
            <Medal key="2" className="w-4 h-4 text-slate-400" />,
            <Medal key="3" className="w-4 h-4 text-amber-600" />,
          ];
          return (
            <TableRow
              key={entry.partnerId}
              className={isCurrentUser ? "bg-primary/5 dark:bg-primary/10 font-semibold" : ""}
              data-testid={`${testIdPrefix}-row-${entry.rank}`}
            >
              <TableCell>
                <div className="flex items-center gap-1.5">
                  {entry.rank <= 3 ? rankIcons[entry.rank - 1] : (
                    <span className="text-sm font-bold text-muted-foreground">#{entry.rank}</span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm" data-testid={`text-leaderboard-name-${entry.rank}`}>
                    {entry.displayName}
                    {isCurrentUser && (
                      <span className="ml-1 text-[11px] text-primary font-semibold">(you)</span>
                    )}
                  </span>
                  <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${badgeStyle.className}`} data-testid={`badge-leaderboard-${entry.rank}`}>
                    {entry.badge}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-center font-medium" data-testid={`text-leaderboard-referrals-${entry.rank}`}>{entry.referrals}</TableCell>
              <TableCell className="text-center font-medium" data-testid={`text-leaderboard-conversions-${entry.rank}`}>{entry.conversions}</TableCell>
              <TableCell className="text-right font-semibold text-emerald-600 dark:text-emerald-400" data-testid={`text-leaderboard-earnings-${entry.rank}`}>
                ${entry.earnings.toLocaleString()}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function LeaderboardTab() {
  const [lastMonthOpen, setLastMonthOpen] = useState(false);
  const [period, setPeriod] = useState<"alltime" | "monthly">("alltime");

  const { data, isLoading } = useQuery<LeaderboardResponse>({
    queryKey: ["/api/partners/leaderboard", period],
    queryFn: () =>
      fetch(`/api/partners/leaderboard?period=${period}`, { credentials: "include" })
        .then((r) => r.json()),
  });

  const monthLabel = data?.month
    ? new Date(data.month).toLocaleString("en-US", { month: "long", year: "numeric" })
    : "";
  const lastMonthLabel = data?.lastMonthDate
    ? new Date(data.lastMonthDate).toLocaleString("en-US", { month: "long", year: "numeric" })
    : "";

  const leaderboard = data?.leaderboard || [];
  const lastMonth = data?.lastMonth || [];
  const currentPartnerId = data?.currentPartnerId ?? null;

  const headingLabel = period === "monthly"
    ? `Top Affiliates — ${monthLabel || "This Month"}`
    : "Top Affiliates — All Time";
  const subLabel = period === "monthly"
    ? "Ranked by referrals this calendar month"
    : "Ranked by all-time referrals";
  const emptyLabel = period === "monthly"
    ? "No referral activity yet this month"
    : "No referral activity recorded yet";

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="leaderboard-loading">
        {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="leaderboard-tab">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Trophy className="w-5 h-5 text-yellow-500" />
            {headingLabel}
          </h2>
          <p className="text-sm text-muted-foreground">{subLabel}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Period toggle */}
          <div className="flex rounded-md border border-border overflow-hidden" data-testid="leaderboard-period-toggle">
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${period === "alltime" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
              onClick={() => setPeriod("alltime")}
              data-testid="button-period-alltime"
            >
              All Time
            </button>
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors border-l border-border ${period === "monthly" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
              onClick={() => setPeriod("monthly")}
              data-testid="button-period-monthly"
            >
              This Month
            </button>
          </div>
          {/* Badge legend */}
          <div className="flex gap-2 flex-wrap">
            {Object.entries(BADGE_STYLES).map(([key, val]) => (
              <span key={key} className={`text-xs font-medium px-2 py-0.5 rounded-full ${val.className}`}>
                {val.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {leaderboard.length === 0 ? (
        <Card data-testid="card-leaderboard-empty">
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <Trophy className="w-12 h-12 text-muted-foreground/40" />
            <div className="text-center space-y-1">
              <p className="font-semibold text-foreground">{emptyLabel}</p>
              <p className="text-sm text-muted-foreground">
                The leaderboard will populate once affiliates start converting referrals.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="card-leaderboard">
          <CardContent className="p-0">
            <LeaderboardTable entries={leaderboard} currentPartnerId={currentPartnerId} testIdPrefix={period === "monthly" ? "this-month" : "all-time"} />
          </CardContent>
        </Card>
      )}

      {/* Last Month Winners Accordion — only shown in monthly view */}
      {period === "monthly" && (
      <Card data-testid="card-last-month-accordion">
        <button
          className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-colors text-left"
          onClick={() => setLastMonthOpen((o) => !o)}
          data-testid="button-last-month-toggle"
        >
          <div className="flex items-center gap-2">
            <Medal className="w-5 h-5 text-amber-600" />
            <div>
              <span className="font-semibold text-sm">Last Month's Winners</span>
              {lastMonthLabel && (
                <span className="ml-2 text-xs text-muted-foreground">({lastMonthLabel})</span>
              )}
            </div>
          </div>
          {lastMonthOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>
        {lastMonthOpen && (
          <CardContent className="p-0 border-t border-border" data-testid="last-month-content">
            <LeaderboardTable entries={lastMonth} currentPartnerId={currentPartnerId} testIdPrefix="last-month" />
          </CardContent>
        )}
      </Card>
      )}

      <Card className="border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Star className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-blue-800 dark:text-blue-200 mb-1">Badge Tiers (All-Time)</p>
              <p className="text-sm text-blue-700 dark:text-blue-300">
                <strong>Bronze</strong>: 1+ conversions · <strong>Silver</strong>: 5+ · <strong>Gold</strong>: 10+ · <strong>Platinum</strong>: 25+ converted referrals.
                Your row is highlighted if you're registered as an affiliate.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ReferralProgram() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"partners" | "referrals" | "tiers" | "leaderboard">("partners");
  const [isPartnerDialogOpen, setIsPartnerDialogOpen] = useState(false);
  const [isReferralDialogOpen, setIsReferralDialogOpen] = useState(false);
  const [isTierDialogOpen, setIsTierDialogOpen] = useState(false);

  const { data: partners = [], isLoading: loadingPartners } = useQuery<Partner[]>({
    queryKey: ["/api/partners"],
  });

  const { data: referrals = [], isLoading: loadingReferrals } = useQuery<Referral[]>({
    queryKey: ["/api/referrals"],
  });

  const { data: commissionTiers = [] } = useQuery<any[]>({
    queryKey: ["/api/commission-tiers"],
  });

  const createPartner = useMutation({
    mutationFn: async (data: PartnerFormData) => {
      const res = await apiRequest("POST", "/api/partners", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partners"] });
      toast({ title: "Partner created" });
      setIsPartnerDialogOpen(false);
      partnerForm.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updatePartnerStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/partners/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partners"] });
      toast({ title: "Partner status updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updatePartnerCommission = useMutation({
    mutationFn: async ({ id, commissionPercent }: { id: number; commissionPercent: number }) => {
      const res = await apiRequest("PATCH", `/api/partners/${id}`, { commissionPercent });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partners"] });
      toast({ title: "Commission rate updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createTier = useMutation({
    mutationFn: async (data: { minReferrals: number; maxReferrals: number | null; commissionAmount: string; label: string }) => {
      const res = await apiRequest("POST", "/api/commission-tiers", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/commission-tiers"] });
      toast({ title: "Commission tier created" });
      setIsTierDialogOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteTier = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/commission-tiers/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/commission-tiers"] });
      toast({ title: "Tier deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createReferral = useMutation({
    mutationFn: async (data: ReferralFormData) => {
      const res = await apiRequest("POST", "/api/referrals", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/referrals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/partners"] });
      toast({ title: "Referral created" });
      setIsReferralDialogOpen(false);
      referralForm.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const partnerForm = useForm<PartnerFormData>({
    resolver: zodResolver(partnerFormSchema),
    defaultValues: {
      companyName: "",
      contactName: "",
      email: "",
      phone: "",
      partnerType: "referral",
      commissionPercent: 10,
      notes: "",
    },
  });

  const referralForm = useForm<ReferralFormData>({
    resolver: zodResolver(referralFormSchema),
    defaultValues: {
      partnerId: 0,
      referredName: "",
      referredEmail: "",
      referredPhone: "",
      referredCompany: "",
      incentiveType: "commission",
      incentiveAmount: "",
      notes: "",
    },
  });

  const totalPartners = partners.length;
  const affiliatePartners = partners.filter((p) => p.partnerType === "affiliate");
  const pendingApproval = partners.filter((p) => p.status === "pending");
  const activeReferrals = referrals.filter((r) => r.status !== "lost" && r.status !== "paid").length;
  const totalConverted = referrals.filter((r) => r.status === "converted" || r.status === "paid").length;
  const conversionRate = referrals.length > 0 ? Math.round((totalConverted / referrals.length) * 100) : 0;
  const totalPayouts = partners.reduce((sum, p) => sum + parseFloat(p.totalPayouts || "0"), 0);
  const totalClicks = partners.reduce((sum, p) => sum + ((p as any).totalClicks || 0), 0);

  const getPartnerName = (partnerId: number | null) => {
    if (!partnerId) return "—";
    const p = partners.find((partner) => partner.id === partnerId);
    return p ? p.companyName : "—";
  };

  return (
    <CrmPage className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between gap-4">
        <CrmPageHeader title="Referral & Partner Program" titleTestId="text-page-title" />
        <div className="flex items-center gap-2 flex-wrap">
          <Dialog open={isPartnerDialogOpen} onOpenChange={setIsPartnerDialogOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2" data-testid="button-add-partner">
                <Plus className="w-4 h-4" /> Add Partner
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Partner</DialogTitle>
              </DialogHeader>
              <Form {...partnerForm}>
                <form onSubmit={partnerForm.handleSubmit((d) => createPartner.mutate(d))} className="space-y-4">
                  <FormField control={partnerForm.control} name="companyName" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company Name</FormLabel>
                      <FormControl><Input {...field} data-testid="input-partner-company" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={partnerForm.control} name="contactName" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact Name</FormLabel>
                        <FormControl><Input {...field} data-testid="input-partner-contact" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={partnerForm.control} name="email" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl><Input {...field} type="email" data-testid="input-partner-email" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={partnerForm.control} name="phone" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl><Input {...field} data-testid="input-partner-phone" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={partnerForm.control} name="partnerType" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Partner Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-partner-type">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {PARTNER_TYPES.map((t) => (
                              <SelectItem key={t} value={t}>{formatPartnerType(t)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <FormField control={partnerForm.control} name="commissionPercent" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Commission %</FormLabel>
                      <FormControl><Input {...field} type="number" min={0} max={100} data-testid="input-partner-commission" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={partnerForm.control} name="notes" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes</FormLabel>
                      <FormControl><Textarea {...field} className="resize-none" data-testid="input-partner-notes" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <div className="flex justify-end pt-4">
                    <Button type="submit" disabled={createPartner.isPending} data-testid="button-submit-partner">
                      {createPartner.isPending ? "Creating..." : "Create Partner"}
                    </Button>
                  </div>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <KpiCard icon={Users} label="Total Partners" value={loadingPartners ? "..." : totalPartners} testId="kpi-total-partners" />
        <KpiCard icon={Link2} label="Affiliates" value={loadingPartners ? "..." : affiliatePartners.length} testId="kpi-affiliates" />
        <KpiCard icon={Eye} label="Link Clicks" value={loadingPartners ? "..." : totalClicks} testId="kpi-total-clicks" />
        <KpiCard icon={Handshake} label="Active Referrals" value={loadingReferrals ? "..." : activeReferrals} testId="kpi-active-referrals" />
        <KpiCard icon={Award} label="Conversion Rate" value={loadingReferrals ? "..." : `${conversionRate}%`} testId="kpi-conversion-rate" />
        <KpiCard icon={DollarSign} label="Total Payouts" value={loadingPartners ? "..." : `$${totalPayouts.toLocaleString()}`} testId="kpi-total-payouts" />
      </div>

      {pendingApproval.length > 0 && (
        <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
              <Users className="w-5 h-5" />
              <span className="font-semibold">{pendingApproval.length} affiliate{pendingApproval.length > 1 ? "s" : ""} pending approval</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {pendingApproval.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center gap-2 bg-white dark:bg-background rounded px-3 py-1.5 text-sm border">
                  <span>{p.contactName || p.companyName}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-green-600"
                    onClick={() => updatePartnerStatus.mutate({ id: p.id, status: "active" })}
                    data-testid={`button-quick-approve-${p.id}`}
                  >
                    <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approve
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 flex-wrap">
        <Button
          variant={activeTab === "partners" ? "default" : "outline"}
          onClick={() => setActiveTab("partners")}
          data-testid="tab-partners"
        >
          Partners
        </Button>
        <Button
          variant={activeTab === "referrals" ? "default" : "outline"}
          onClick={() => setActiveTab("referrals")}
          data-testid="tab-referrals"
        >
          Referrals
        </Button>
        <Button
          variant={activeTab === "tiers" ? "default" : "outline"}
          onClick={() => setActiveTab("tiers")}
          data-testid="tab-tiers"
        >
          Commission Tiers
        </Button>
        <Button
          variant={activeTab === "leaderboard" ? "default" : "outline"}
          onClick={() => setActiveTab("leaderboard")}
          className="gap-2"
          data-testid="tab-leaderboard"
        >
          <Trophy className="w-4 h-4" />
          Leaderboard
        </Button>
      </div>

      {activeTab === "partners" && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table className="min-w-[1100px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Company / Contact</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Affiliate Code</TableHead>
                  <TableHead>Commission</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Clicks</TableHead>
                  <TableHead>Referrals</TableHead>
                  <TableHead>Conversions</TableHead>
                  <TableHead>Payouts</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingPartners ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center h-24">
                      <div className="flex items-center justify-center gap-2">
                        <Skeleton className="h-4 w-32" />
                      </div>
                    </TableCell>
                  </TableRow>
                ) : partners.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center h-24 text-muted-foreground" data-testid="text-no-partners">
                      No partners yet
                    </TableCell>
                  </TableRow>
                ) : (
                  partners.map((partner) => (
                    <TableRow key={partner.id} data-testid={`row-partner-${partner.id}`}>
                      <TableCell data-testid={`text-partner-company-${partner.id}`}>
                        <div className="font-medium">{partner.companyName}</div>
                        <div className="text-xs text-muted-foreground">{partner.contactName || ""}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{partner.email || "—"}</TableCell>
                      <TableCell>
                        <Badge variant={partnerTypeBadgeVariant(partner.partnerType || "referral")} data-testid={`badge-partner-type-${partner.id}`}>
                          {formatPartnerType(partner.partnerType || "referral")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {(partner as any).affiliateCode ? (
                          <button
                            className="font-mono text-xs bg-muted px-2 py-1 rounded flex items-center gap-1 hover:bg-muted/80"
                            onClick={() => {
                              navigator.clipboard.writeText(`${window.location.origin}?ref=${(partner as any).affiliateCode}`);
                              toast({ title: "Affiliate link copied!" });
                            }}
                            data-testid={`button-copy-affiliate-${partner.id}`}
                          >
                            {(partner as any).affiliateCode} <Copy className="w-3 h-3" />
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          defaultValue={String(partner.commissionPercent ?? 10)}
                          onValueChange={(val) => updatePartnerCommission.mutate({ id: partner.id, commissionPercent: Number(val) })}
                        >
                          <SelectTrigger className="w-[70px] h-8 text-xs" data-testid={`select-commission-${partner.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[5, 10, 15, 20, 25, 30].map((pct) => (
                              <SelectItem key={pct} value={String(pct)}>{pct}%</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Badge variant={partner.status === "active" ? "default" : partner.status === "pending" ? "secondary" : "outline"} data-testid={`badge-partner-status-${partner.id}`}>
                          {partner.status || "pending"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center" data-testid={`text-partner-clicks-${partner.id}`}>{(partner as any).totalClicks ?? 0}</TableCell>
                      <TableCell className="text-center" data-testid={`text-partner-referrals-${partner.id}`}>{partner.totalReferrals ?? 0}</TableCell>
                      <TableCell className="text-center" data-testid={`text-partner-conversions-${partner.id}`}>{partner.totalConversions ?? 0}</TableCell>
                      <TableCell data-testid={`text-partner-payouts-${partner.id}`}>${parseFloat(partner.totalPayouts || "0").toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {partner.status !== "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-green-600"
                              onClick={() => updatePartnerStatus.mutate({ id: partner.id, status: "active" })}
                              data-testid={`button-approve-${partner.id}`}
                              title="Approve"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </Button>
                          )}
                          {partner.status === "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-red-600"
                              onClick={() => updatePartnerStatus.mutate({ id: partner.id, status: "suspended" })}
                              data-testid={`button-suspend-${partner.id}`}
                              title="Suspend"
                            >
                              <XCircle className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {activeTab === "referrals" && (
        <>
          <div className="flex justify-end">
            <Dialog open={isReferralDialogOpen} onOpenChange={setIsReferralDialogOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2" data-testid="button-add-referral">
                  <Plus className="w-4 h-4" /> Add Referral
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New Referral</DialogTitle>
                </DialogHeader>
                <Form {...referralForm}>
                  <form onSubmit={referralForm.handleSubmit((d) => createReferral.mutate(d))} className="space-y-4">
                    <FormField control={referralForm.control} name="partnerId" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Partner</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={String(field.value)}>
                          <FormControl>
                            <SelectTrigger data-testid="select-referral-partner">
                              <SelectValue placeholder="Select partner" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {partners.map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>{p.companyName}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={referralForm.control} name="referredName" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Referred Name</FormLabel>
                          <FormControl><Input {...field} data-testid="input-referral-name" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={referralForm.control} name="referredEmail" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <FormControl><Input {...field} type="email" data-testid="input-referral-email" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={referralForm.control} name="referredPhone" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Phone</FormLabel>
                          <FormControl><Input {...field} data-testid="input-referral-phone" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={referralForm.control} name="referredCompany" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Company</FormLabel>
                          <FormControl><Input {...field} data-testid="input-referral-company" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={referralForm.control} name="incentiveType" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Incentive Type</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-incentive-type">
                                <SelectValue placeholder="Select type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="commission">Commission</SelectItem>
                              <SelectItem value="flat_fee">Flat Fee</SelectItem>
                              <SelectItem value="bonus">Bonus</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={referralForm.control} name="incentiveAmount" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Incentive Amount</FormLabel>
                          <FormControl><Input {...field} data-testid="input-referral-incentive" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={referralForm.control} name="notes" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Notes</FormLabel>
                        <FormControl><Textarea {...field} className="resize-none" data-testid="input-referral-notes" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="flex justify-end pt-4">
                      <Button type="submit" disabled={createReferral.isPending} data-testid="button-submit-referral">
                        {createReferral.isPending ? "Creating..." : "Create Referral"}
                      </Button>
                    </div>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Referred Company</TableHead>
                    <TableHead>Referred Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Partner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Incentive</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingReferrals ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center h-24">
                        <div className="flex items-center justify-center gap-2">
                          <Skeleton className="h-4 w-32" />
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : referrals.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center h-24 text-muted-foreground" data-testid="text-no-referrals">
                        No referrals yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    referrals.map((referral) => (
                      <TableRow key={referral.id} data-testid={`row-referral-${referral.id}`}>
                        <TableCell className="font-medium" data-testid={`text-referral-company-${referral.id}`}>{referral.referredCompany || "—"}</TableCell>
                        <TableCell>{referral.referredName || "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{referral.referredEmail || "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{referral.referredPhone || "—"}</TableCell>
                        <TableCell>{getPartnerName(referral.partnerId)}</TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${referralStatusColor(referral.status || "pending")}`} data-testid={`badge-referral-status-${referral.id}`}>
                            {referral.status || "pending"}
                          </span>
                        </TableCell>
                        <TableCell data-testid={`text-referral-incentive-${referral.id}`}>
                          {referral.incentiveAmount ? `$${parseFloat(referral.incentiveAmount).toLocaleString()}` : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {referral.createdAt ? new Date(referral.createdAt).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "tiers" && (
        <>
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">Set tiered commission rates based on the number of converted referrals an affiliate has.</p>
            <Dialog open={isTierDialogOpen} onOpenChange={setIsTierDialogOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2" data-testid="button-add-tier">
                  <Plus className="w-4 h-4" /> Add Tier
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Commission Tier</DialogTitle>
                </DialogHeader>
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.target as HTMLFormElement);
                    const maxVal = fd.get("maxReferrals") as string;
                    createTier.mutate({
                      minReferrals: Number(fd.get("minReferrals")) || 1,
                      maxReferrals: maxVal ? Number(maxVal) : null,
                      commissionAmount: (fd.get("commissionAmount") as string) || "100",
                      label: (fd.get("label") as string) || "",
                    });
                  }}
                >
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium block mb-1">Min Referrals</label>
                      <Input name="minReferrals" type="number" min={1} defaultValue={1} data-testid="input-tier-min" />
                    </div>
                    <div>
                      <label className="text-sm font-medium block mb-1">Max Referrals (blank = unlimited)</label>
                      <Input name="maxReferrals" type="number" min={1} placeholder="e.g. 5" data-testid="input-tier-max" />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">Commission Amount ($)</label>
                    <Input name="commissionAmount" defaultValue="100" data-testid="input-tier-amount" />
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">Label (optional)</label>
                    <Input name="label" placeholder="e.g. Bronze Tier" data-testid="input-tier-label" />
                  </div>
                  <div className="flex justify-end pt-4">
                    <Button type="submit" disabled={createTier.isPending} data-testid="button-submit-tier">
                      {createTier.isPending ? "Creating..." : "Create Tier"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Label</TableHead>
                    <TableHead>Min Referrals</TableHead>
                    <TableHead>Max Referrals</TableHead>
                    <TableHead>Commission Amount</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {commissionTiers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center h-24 text-muted-foreground" data-testid="text-no-tiers">
                        No commission tiers configured. Add tiers to enable tiered pricing (e.g., 1-5 referrals = $100, 6-10 = $150, 11+ = $200).
                      </TableCell>
                    </TableRow>
                  ) : (
                    commissionTiers.map((tier: any) => (
                      <TableRow key={tier.id} data-testid={`row-tier-${tier.id}`}>
                        <TableCell className="font-medium">{tier.label || "—"}</TableCell>
                        <TableCell>{tier.minReferrals}</TableCell>
                        <TableCell>{tier.maxReferrals ?? "Unlimited"}</TableCell>
                        <TableCell className="font-semibold">${tier.commissionAmount}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-red-600"
                            onClick={() => deleteTier.mutate(tier.id)}
                            data-testid={`button-delete-tier-${tier.id}`}
                          >
                            <XCircle className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <DollarSign className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold text-blue-800 dark:text-blue-200 mb-1">How Tiered Commissions Work</p>
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    When tiers are configured, the commission per referral is determined by the affiliate's total number of converted referrals. 
                    For example: 1-5 referrals = $100 each, 6-10 = $150 each, 11+ = $200 each. 
                    If no tiers are set, the default $100 per referral is used.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "leaderboard" && <LeaderboardTab />}

      <ReferralExplainer />

      <HelpCenter context="referral" />
    </CrmPage>
  );
}
