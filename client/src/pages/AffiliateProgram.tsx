import { useState, useEffect } from "react";
import { clearSubmissionKey, getSubmissionKey, isDefinitiveSubmissionOutcome } from "@/lib/submission-key";
import { useLocation, Link } from "wouter";
import { SEO } from "@/components/SEO";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getStoredUTMParams } from "@/lib/utm";
import { trackAffiliateSignup } from "@/lib/tracking";
import { trackConversion } from "@/lib/analytics";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users,
  DollarSign,
  Link2,
  TrendingUp,
  CheckCircle,
  ArrowRight,
  Copy,
  ExternalLink,
  BarChart3,
  Clock,
  Shield,
  Zap,
  Gift,
  Star,
  Eye,
  MousePointerClick,
  UserPlus,
  Handshake,
  Share,
  Trophy,
  Medal,
  FileText,
  Mail,
  MessageSquare,
  Image,
  Download,
  Lock,
  LogIn,
  Briefcase,
} from "lucide-react";

type ViewMode = "info" | "signup" | "login" | "dashboard";

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function useReferralAttribution() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref) {
      setCookie("lb_ref", ref, 30);
      localStorage.setItem("lb_ref_code", ref);
      fetch("/api/affiliate/track-click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: ref }),
      }).catch(() => {});
    }
  }, []);
}

export default function AffiliateProgram() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [view, setView] = useState<ViewMode>("info");
  const [submitting, setSubmitting] = useState(false);
  const [affiliateCode, setAffiliateCode] = useState<string | null>(null);
  const [dashboardCode, setDashboardCode] = useState("");
  const [stats, setStats] = useState<any>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [commissionReport, setCommissionReport] = useState<any>(null);
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    companyName: "",
    website: "",
    howHeard: "",
    password: "",
  });

  useReferralAttribution();

  useEffect(() => {
    fetch("/api/affiliate/session", { credentials: "include" })
      .then(res => { if (res.ok) return res.json(); throw new Error("no session"); })
      .then(data => {
        setAffiliateCode(data.affiliateCode);
        setDashboardCode(data.affiliateCode);
        loadDashboard(data.affiliateCode);
      })
      .catch(() => {});
  }, []);

  const handleSignup = async () => {
    if (!form.firstName || !form.email || !form.phone) {
      toast({ title: "Please fill in required fields", variant: "destructive" });
      return;
    }
    if (!form.password || form.password.length < 6) {
      toast({ title: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }
    // One key per mailbox until the server settles the occurrence: a retry after a lost response, an unreadable body or a
    // reload replays the same occurrence and lets the server finish work it already committed.
    const key = getSubmissionKey("affiliate_signup", form.email);
    setSubmitting(true);
    try {
      const utmParams = getStoredUTMParams();
      const res = await fetch("/api/affiliate/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        credentials: "include",
        body: JSON.stringify({ ...form, ...utmParams }),
      });
      const data = await res.json().catch(() => null);
      if (isDefinitiveSubmissionOutcome(res.status, data)) clearSubmissionKey("affiliate_signup", form.email);
      if (!data) {
        toast({ title: "We could not read the response. Please press Sign up again; your submission will not be duplicated.", variant: "destructive" });
        return;
      }
      if (!res.ok) {
        toast({ title: data.message || "Signup failed", variant: "destructive" });
        return;
      }
      trackAffiliateSignup();
      trackConversion("affiliate_signup", { affiliate_code: data.affiliateCode });
      setAffiliateCode(data.affiliateCode);
      setDashboardCode(data.affiliateCode);
      toast({ title: "Welcome to the affiliate program!" });
      loadDashboard(data.affiliateCode);
    } catch {
      toast({ title: "Network error — please try again", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async () => {
    if (!loginForm.email || !loginForm.password) {
      toast({ title: "Please enter email and password", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/affiliate/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(loginForm),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.message || "Login failed", variant: "destructive" });
        return;
      }
      setAffiliateCode(data.affiliateCode);
      setDashboardCode(data.affiliateCode);
      toast({ title: `Welcome back, ${data.name}!` });
      loadDashboard(data.affiliateCode);
    } catch {
      toast({ title: "Network error — please try again", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/affiliate/logout", { method: "POST", credentials: "include" });
    } catch {}
    setAffiliateCode(null);
    setStats(null);
    setCommissionReport(null);
    setLeaderboard([]);
    setView("info");
  };

  const loadDashboard = async (code?: string) => {
    const c = code || dashboardCode;
    if (!c) {
      toast({ title: "Please log in to access your dashboard", variant: "destructive" });
      return;
    }
    setLoadingStats(true);
    try {
      const res = await fetch(`/api/affiliate/stats/${c}`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 403 || res.status === 401) {
          toast({ title: "Please log in to access your dashboard", variant: "destructive" });
          setView("login");
        } else {
          toast({ title: data.message || "Error loading dashboard", variant: "destructive" });
        }
        setLoadingStats(false);
        return;
      }
      setStats(data);
      setAffiliateCode(c);
      setView("dashboard");
      fetchLeaderboard();
      fetchCommissionReport(c);
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setLoadingStats(false);
    }
  };

  const fetchLeaderboard = async () => {
    try {
      const res = await fetch("/api/affiliate/leaderboard", { credentials: "include" });
      if (res.ok) setLeaderboard(await res.json());
    } catch {}
  };

  const fetchCommissionReport = async (code: string) => {
    try {
      const res = await fetch(`/api/affiliate/commission-report/${code}`, { credentials: "include" });
      if (res.ok) setCommissionReport(await res.json());
    } catch {}
  };

  const copyLink = () => {
    const link = `${window.location.origin}?ref=${affiliateCode}`;
    navigator.clipboard.writeText(link);
    toast({ title: "Referral link copied!" });
  };

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "https://libertybancard.com";

  const benefits = [
    { icon: DollarSign, title: "Generous Commissions", desc: "Earn 10% commission on every merchant you refer who signs up for processing." },
    { icon: Clock, title: "Residual Income", desc: "Earn ongoing monthly residuals for the life of each merchant account you refer." },
    { icon: Link2, title: "Unique Tracking Link", desc: "Get your own branded referral link that tracks every click, signup, and conversion." },
    { icon: BarChart3, title: "Real-Time Dashboard", desc: "Track your referrals, conversions, and earnings in real time from your personal dashboard." },
    { icon: Shield, title: "No Risk, Free to Join", desc: "Zero cost to join. No quotas, no contracts, no hidden fees. Earn at your own pace." },
    { icon: Zap, title: "Fast Payouts", desc: "Commissions are calculated monthly and paid promptly via your preferred method." },
  ];

  const steps = [
    { icon: UserPlus, title: "Sign Up", desc: "Register in 30 seconds. Get your unique affiliate code and referral link instantly." },
    { icon: Link2, title: "Share Your Link", desc: "Share your referral link with business owners who accept credit cards. Social media, email, in person — any way works." },
    { icon: MousePointerClick, title: "Prospects Sign Up", desc: "When someone visits Liberty Bancard through your link and fills out a form, they're tracked to you automatically." },
    { icon: DollarSign, title: "Get Paid", desc: "Earn a commission for every merchant that activates. Plus ongoing residuals every month they process." },
  ];

  const marketingMaterials = [
    {
      category: "Email Templates",
      icon: Mail,
      items: [
        {
          title: "Introduction Email",
          content: `Subject: Save 20-40% on Credit Card Processing\n\nHi [Name],\n\nI wanted to reach out because I know how much credit card processing fees can eat into your profits. Liberty Bancard offers a free, no-obligation statement analysis that shows exactly how much you could save.\n\nMost businesses save 20-40% — and the analysis takes just 60 seconds.\n\nWant me to set one up for you? Here's the link:\n${baseUrl}/free-analysis?ref=${affiliateCode}\n\nBest regards`,
        },
        {
          title: "Follow-Up Email",
          content: `Subject: Quick follow-up — your free savings analysis\n\nHi [Name],\n\nJust checking in. I shared a link last week for a free credit card processing analysis from Liberty Bancard.\n\nNo strings attached — they'll show you exactly what you're paying vs. what you should be paying. Most businesses are surprised at how much they can save.\n\nHere's the link again: ${baseUrl}/free-analysis?ref=${affiliateCode}\n\nLet me know if you have any questions!`,
        },
        {
          title: "Referral Ask Email",
          content: `Subject: Know a business owner overpaying on processing?\n\nHi [Name],\n\nIf you know any business owners who accept credit cards, I'd love to connect them with Liberty Bancard. They offer a free statement review and most businesses save 20-40%.\n\nHere's a link they can use: ${baseUrl}/free-analysis?ref=${affiliateCode}\n\nI appreciate any referrals — and so will they when they see the savings!\n\nThanks`,
        },
      ],
    },
    {
      category: "Social Media Posts",
      icon: MessageSquare,
      items: [
        {
          title: "Facebook/LinkedIn Post",
          content: `💰 Business owners: are you overpaying on credit card processing fees? Most are — and don't even know it.\n\nTake this FREE 60-second quiz to find out how much you could save. No obligation, no commitment.\n\n👉 ${baseUrl}/free-analysis?ref=${affiliateCode}\n\n#SmallBusiness #SaveMoney #CreditCardProcessing`,
        },
        {
          title: "Twitter/X Post",
          content: `Most businesses overpay on credit card processing by 20-40%. Find out how much you could save with this free 60-second analysis 👉 ${baseUrl}/free-analysis?ref=${affiliateCode}`,
        },
        {
          title: "Instagram Caption",
          content: `Running a business is expensive enough. Don't let credit card processing fees eat into your profits. 💳\n\nLiberty Bancard offers a FREE savings analysis that takes just 60 seconds. Most businesses save 20-40%!\n\nLink in bio or visit: ${baseUrl}/free-analysis?ref=${affiliateCode}\n\n#BusinessTips #SaveMoney #SmallBizLife #CreditCardProcessing #Entrepreneur`,
        },
      ],
    },
    {
      category: "SMS Templates",
      icon: MessageSquare,
      items: [
        {
          title: "Quick Outreach",
          content: `Hey! Are you overpaying on credit card processing? Take this free 60-second quiz to see how much you could save: ${baseUrl}/free-analysis?ref=${affiliateCode}`,
        },
        {
          title: "Personal Recommendation",
          content: `Hey [Name]! I've been working with Liberty Bancard and they're helping businesses save 20-40% on credit card fees. Thought of you. Free analysis here: ${baseUrl}/free-analysis?ref=${affiliateCode}`,
        },
      ],
    },
    {
      category: "Explainer Content",
      icon: FileText,
      items: [
        {
          title: "Elevator Pitch",
          content: `"Do you accept credit cards? Most businesses overpay by 20-40% and don't even know it. Liberty Bancard does a free, no-obligation analysis that shows exactly what you're paying vs. what you should be paying. It takes 60 seconds and there's no commitment. Want me to send you the link?"`,
        },
        {
          title: "Key Talking Points",
          content: `• Free statement analysis — no cost, no commitment\n• Most businesses save 20-40% on processing fees\n• 0% processing program available (pass fees to customers)\n• Free terminal equipment with approved accounts\n• Next-day funding available\n• 24/7 customer support\n• No long-term contracts or early termination fees\n• Works with all business types: restaurants, retail, healthcare, services`,
        },
        {
          title: "Objection Handlers",
          content: `"I'm happy with my current processor"\n→ "That's great! The analysis is still worth doing — it only takes 60 seconds and you might find you can save without changing anything about how you operate."\n\n"I don't have time"\n→ "It literally takes 60 seconds. Just answer 4 quick questions and you'll get your results immediately."\n\n"Is there a catch?"\n→ "No catch at all. It's a free comparison tool. You're not committing to anything by taking it."\n\n"I just signed a contract"\n→ "No problem! The analysis can show you what to negotiate when your contract is up. Most businesses don't realize how much room there is to negotiate."`,
        },
      ],
    },
  ];

  if (view === "dashboard" && stats) {
    return (
      <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
        <SEO title="Affiliate Dashboard" description="Track your referrals and earnings" path="/affiliate" noindex={true} />
        <Navbar />
        <main className="flex-grow pt-28 pb-16">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
              <div>
                <h1 className="text-2xl md:text-3xl font-display font-bold text-foreground" data-testid="text-affiliate-dashboard-title">
                  Welcome back, {stats.affiliate.name}
                </h1>
                <p className="text-muted-foreground mt-1">Affiliate Code: <span className="font-mono font-semibold text-primary">{stats.affiliate.code}</span></p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={copyLink} className="gap-2" data-testid="button-copy-link">
                  <Copy className="w-4 h-4" /> Copy Referral Link
                </Button>
                <Button variant="outline" size="sm" onClick={handleLogout} data-testid="button-logout">
                  <LogIn className="w-4 h-4 rotate-180" /> Log Out
                </Button>
              </div>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 mb-8 flex flex-col sm:flex-row items-start sm:items-center gap-3">
              <Link2 className="w-5 h-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground mb-1">Your Referral Link</p>
                <p className="font-mono text-sm text-foreground truncate" data-testid="text-referral-link">
                  {baseUrl}?ref={stats.affiliate.code}
                </p>
              </div>
              <Button size="sm" onClick={copyLink} className="gap-1.5 shrink-0">
                <Copy className="w-3.5 h-3.5" /> Copy
              </Button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              <Card data-testid="stat-clicks">
                <CardContent className="p-4 text-center">
                  <Eye className="w-5 h-5 text-blue-500 mx-auto mb-2" />
                  <p className="text-2xl font-bold text-foreground">{stats.stats.totalClicks}</p>
                  <p className="text-xs text-muted-foreground">Link Clicks</p>
                </CardContent>
              </Card>
              <Card data-testid="stat-referrals">
                <CardContent className="p-4 text-center">
                  <Users className="w-5 h-5 text-indigo-500 mx-auto mb-2" />
                  <p className="text-2xl font-bold text-foreground">{stats.stats.totalReferrals}</p>
                  <p className="text-xs text-muted-foreground">Total Referrals</p>
                </CardContent>
              </Card>
              <Card data-testid="stat-converted">
                <CardContent className="p-4 text-center">
                  <CheckCircle className="w-5 h-5 text-green-500 mx-auto mb-2" />
                  <p className="text-2xl font-bold text-foreground">{stats.stats.converted}</p>
                  <p className="text-xs text-muted-foreground">Converted</p>
                </CardContent>
              </Card>
              <Card data-testid="stat-earnings">
                <CardContent className="p-4 text-center">
                  <DollarSign className="w-5 h-5 text-emerald-500 mx-auto mb-2" />
                  <p className="text-2xl font-bold text-foreground">${stats.stats.totalEarnings}</p>
                  <p className="text-xs text-muted-foreground">Total Earnings</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground mb-1">Pending Referrals</p>
                  <p className="text-xl font-bold text-foreground">{stats.stats.pending}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground mb-1">Qualified Leads</p>
                  <p className="text-xl font-bold text-foreground">{stats.stats.qualified}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground mb-1">Pending Earnings</p>
                  <p className="text-xl font-bold text-foreground">${stats.stats.pendingEarnings}</p>
                </CardContent>
              </Card>
            </div>

            <Tabs defaultValue="referrals" className="space-y-4">
              <TabsList className="grid grid-cols-4 w-full">
                <TabsTrigger value="referrals" data-testid="tab-referrals">Referrals</TabsTrigger>
                <TabsTrigger value="commissions" data-testid="tab-commissions">Commissions</TabsTrigger>
                <TabsTrigger value="leaderboard" data-testid="tab-leaderboard">Leaderboard</TabsTrigger>
                <TabsTrigger value="materials" data-testid="tab-materials">Marketing</TabsTrigger>
              </TabsList>

              <TabsContent value="referrals">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Recent Referrals</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {stats.recentReferrals.length === 0 ? (
                      <div className="text-center py-8">
                        <Users className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
                        <p className="text-muted-foreground mb-2">No referrals yet</p>
                        <p className="text-sm text-muted-foreground">Share your referral link to start earning commissions.</p>
                        <Button size="sm" className="mt-4 gap-2" onClick={copyLink}>
                          <Copy className="w-4 h-4" /> Copy Referral Link
                        </Button>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border">
                              <th className="text-left py-2 px-3 text-muted-foreground font-medium">Referral #</th>
                              <th className="text-left py-2 px-3 text-muted-foreground font-medium">Status</th>
                              <th className="text-right py-2 px-3 text-muted-foreground font-medium">Date</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stats.recentReferrals.map((r: any, idx: number) => (
                              <tr key={r.id} className="border-b border-border/50">
                                <td className="py-2 px-3 text-foreground">#{idx + 1}</td>
                                <td className="py-2 px-3">
                                  <Badge variant={r.status === "converted" || r.status === "paid" ? "default" : "secondary"} className="text-xs">
                                    {r.status}
                                  </Badge>
                                </td>
                                <td className="py-2 px-3 text-right text-muted-foreground">{r.date ? new Date(r.date).toLocaleDateString() : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="commissions">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <DollarSign className="w-5 h-5" /> Commission Report
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {commissionReport ? (
                      <div className="space-y-6">
                        {commissionReport.tiers && commissionReport.tiers.length > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Commission Tiers</h4>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              {commissionReport.tiers.map((tier: any) => (
                                <div
                                  key={tier.id}
                                  className={`rounded-lg border p-3 text-center ${
                                    commissionReport.currentTierReferrals >= tier.minReferrals &&
                                    (tier.maxReferrals === null || commissionReport.currentTierReferrals <= tier.maxReferrals)
                                      ? "border-primary bg-primary/5"
                                      : ""
                                  }`}
                                  data-testid={`tier-${tier.id}`}
                                >
                                  <p className="text-lg font-bold text-foreground">${tier.commissionAmount}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {tier.label || `${tier.minReferrals}${tier.maxReferrals ? `-${tier.maxReferrals}` : "+"} referrals`}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Monthly Payout Report</h4>
                            <p className="text-sm font-semibold text-foreground">Total: ${commissionReport.totalEarnings}</p>
                          </div>
                          {commissionReport.report.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">No commissions yet. Convert referrals to start earning!</p>
                          ) : (
                            <div className="space-y-4">
                              {commissionReport.report.map((month: any) => (
                                <div key={month.month} className="border rounded-lg p-4" data-testid={`report-month-${month.month}`}>
                                  <div className="flex items-center justify-between mb-3">
                                    <h5 className="font-semibold text-foreground">{month.month}</h5>
                                    <span className="text-sm font-bold text-primary">${month.total}</span>
                                  </div>
                                  <table className="w-full text-sm">
                                    <thead>
                                      <tr className="border-b border-border">
                                        <th className="text-left py-1.5 text-muted-foreground font-medium">Merchant</th>
                                        <th className="text-left py-1.5 text-muted-foreground font-medium">Date</th>
                                        <th className="text-left py-1.5 text-muted-foreground font-medium">Status</th>
                                        <th className="text-right py-1.5 text-muted-foreground font-medium">Commission</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {month.entries.map((entry: any) => (
                                        <tr key={entry.referralId} className="border-b border-border/50">
                                          <td className="py-1.5 text-foreground">{entry.merchantName}</td>
                                          <td className="py-1.5 text-muted-foreground">{entry.signupDate ? new Date(entry.signupDate).toLocaleDateString() : "—"}</td>
                                          <td className="py-1.5">
                                            <Badge variant={entry.status === "paid" ? "default" : "secondary"} className="text-xs">{entry.status}</Badge>
                                          </td>
                                          <td className="py-1.5 text-right font-medium">${entry.commissionAmount}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-4">Loading commission data...</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="leaderboard">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Trophy className="w-5 h-5 text-amber-500" /> Affiliate Leaderboard
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {leaderboard.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">No leaderboard data yet. Be the first to make referrals!</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border">
                              <th className="text-left py-2 px-3 text-muted-foreground font-medium">Rank</th>
                              <th className="text-left py-2 px-3 text-muted-foreground font-medium">Affiliate</th>
                              <th className="text-center py-2 px-3 text-muted-foreground font-medium">Referrals</th>
                              <th className="text-center py-2 px-3 text-muted-foreground font-medium">Conversions</th>
                              <th className="text-right py-2 px-3 text-muted-foreground font-medium">Earnings</th>
                            </tr>
                          </thead>
                          <tbody>
                            {leaderboard.map((leader: any) => (
                              <tr
                                key={leader.rank}
                                className={`border-b border-border/50 ${leader.name === stats.affiliate.name ? "bg-primary/5" : ""}`}
                                data-testid={`leaderboard-row-${leader.rank}`}
                              >
                                <td className="py-2.5 px-3">
                                  <div className="flex items-center gap-1.5">
                                    {leader.rank === 1 ? (
                                      <Trophy className="w-4 h-4 text-amber-500" />
                                    ) : leader.rank === 2 ? (
                                      <Medal className="w-4 h-4 text-gray-400" />
                                    ) : leader.rank === 3 ? (
                                      <Medal className="w-4 h-4 text-amber-700" />
                                    ) : (
                                      <span className="text-muted-foreground font-medium">#{leader.rank}</span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 font-medium text-foreground">
                                  {leader.name}
                                  {leader.name === stats.affiliate.name && (
                                    <Badge variant="outline" className="ml-2 text-xs">You</Badge>
                                  )}
                                </td>
                                <td className="py-2.5 px-3 text-center">{leader.referrals}</td>
                                <td className="py-2.5 px-3 text-center">{leader.conversions}</td>
                                <td className="py-2.5 px-3 text-right font-medium">${parseFloat(leader.earnings).toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="materials">
                <div className="space-y-6">
                  {marketingMaterials.map((category) => (
                    <Card key={category.category}>
                      <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                          <category.icon className="w-5 h-5 text-primary" /> {category.category}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {category.items.map((item, idx) => (
                          <div key={idx} className="border rounded-lg p-4" data-testid={`material-${category.category.toLowerCase().replace(/\s+/g, "-")}-${idx}`}>
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="font-semibold text-sm text-foreground">{item.title}</h4>
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 shrink-0"
                                onClick={() => {
                                  navigator.clipboard.writeText(item.content);
                                  toast({ title: `${item.title} copied!` });
                                }}
                                data-testid={`button-copy-material-${idx}`}
                              >
                                <Copy className="w-3 h-3" /> Copy
                              </Button>
                            </div>
                            <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans bg-muted/30 rounded p-3 max-h-40 overflow-y-auto">
                              {item.content}
                            </pre>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </TabsContent>
            </Tabs>

            <div className="mt-8 bg-primary/5 rounded-lg p-6">
              <h3 className="font-semibold text-foreground mb-2">Tips to Maximize Earnings</h3>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-primary mt-0.5 shrink-0" /> Share your link on social media and in local business groups</li>
                <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-primary mt-0.5 shrink-0" /> Talk to business owners you know who accept credit cards</li>
                <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-primary mt-0.5 shrink-0" /> Focus on restaurants, retail shops, and service businesses — they save the most</li>
                <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-primary mt-0.5 shrink-0" /> Mention our free statement analysis — it's an easy conversation starter</li>
              </ul>
            </div>

            <Card className="mt-8" data-testid="card-quick-share">
              <CardHeader className="flex flex-row items-center gap-3">
                <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <Share className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Quick Share Panel</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">Pre-written messages ready to share with your ref link</p>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Industry-Specific Quiz Links</p>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { label: "Restaurant", value: "restaurant" },
                      { label: "Retail", value: "retail" },
                      { label: "Healthcare", value: "healthcare" },
                      { label: "Automotive", value: "automotive" },
                      { label: "Home Services", value: "home-services" },
                    ].map((ind) => (
                      <Button
                        key={ind.value}
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          const link = `${baseUrl}/free-analysis?ref=${stats.affiliate.code}&industry=${ind.value}`;
                          navigator.clipboard.writeText(link);
                          toast({ title: `${ind.label} quiz link copied` });
                        }}
                        data-testid={`button-share-industry-${ind.value}`}
                      >
                        <Copy className="w-3 h-3" />
                        {ind.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">SMS Message</p>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-sm text-foreground" data-testid="text-share-sms">
                        Hey! Are you overpaying on credit card processing? Take this free 60-second quiz to see how much you could save: {baseUrl}/free-analysis?ref={stats.affiliate.code}
                      </p>
                    </CardContent>
                  </Card>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 mt-2"
                    onClick={() => {
                      navigator.clipboard.writeText(`Hey! Are you overpaying on credit card processing? Take this free 60-second quiz to see how much you could save: ${baseUrl}/free-analysis?ref=${stats.affiliate.code}`);
                      toast({ title: "SMS message copied" });
                    }}
                    data-testid="button-copy-sms"
                  >
                    <Copy className="w-3 h-3" /> Copy SMS
                  </Button>
                </div>

                <div className="border-t border-border pt-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Email Message</p>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-sm font-semibold text-foreground mb-1">Subject: Are you overpaying on credit card processing?</p>
                      <p className="text-sm text-foreground" data-testid="text-share-email">
                        Hi there,{"\n\n"}I wanted to share something that could save your business real money. Liberty Bancard offers a free savings analysis that shows exactly how much you're overpaying on credit card processing.{"\n\n"}It takes 60 seconds — no obligation, and you keep the breakdown even if you don't switch.{"\n\n"}Check it out here: {baseUrl}/free-analysis?ref={stats.affiliate.code}{"\n\n"}Most businesses save 20-40% on processing fees. Worth a look!
                      </p>
                    </CardContent>
                  </Card>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 mt-2"
                    onClick={() => {
                      const emailBody = `Hi there,\n\nI wanted to share something that could save your business real money. Liberty Bancard offers a free savings analysis that shows exactly how much you're overpaying on credit card processing.\n\nIt takes 60 seconds — no obligation, and you keep the breakdown even if you don't switch.\n\nCheck it out here: ${baseUrl}/free-analysis?ref=${stats.affiliate.code}\n\nMost businesses save 20-40% on processing fees. Worth a look!`;
                      navigator.clipboard.writeText(emailBody);
                      toast({ title: "Email message copied" });
                    }}
                    data-testid="button-copy-email"
                  >
                    <Copy className="w-3 h-3" /> Copy Email
                  </Button>
                </div>

                <div className="border-t border-border pt-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Social Media Post</p>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-sm text-foreground" data-testid="text-share-social">
                        Business owners: are you overpaying on credit card processing fees? Most are and don't even know it. Take this free 60-second quiz to find out how much you could save. No obligation. {baseUrl}/free-analysis?ref={stats.affiliate.code}
                      </p>
                    </CardContent>
                  </Card>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        const text = `Business owners: are you overpaying on credit card processing fees? Most are and don't even know it. Take this free 60-second quiz to find out how much you could save. No obligation. ${baseUrl}/free-analysis?ref=${stats.affiliate.code}`;
                        navigator.clipboard.writeText(text);
                        toast({ title: "Social post copied" });
                      }}
                      data-testid="button-copy-social"
                    >
                      <Copy className="w-3 h-3" /> Copy Post
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        const url = encodeURIComponent(`${baseUrl}/free-analysis?ref=${stats.affiliate.code}`);
                        window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, "_blank", "width=600,height=400");
                      }}
                      data-testid="button-share-facebook"
                    >
                      <ExternalLink className="w-3 h-3" /> Share on Facebook
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <SEO
        title="Affiliate Program — Earn Commissions Referring Merchants"
        description="Join the Liberty Bancard Affiliate Program. Earn commissions and monthly residuals by referring businesses to our payment processing solutions. Free to join."
        path="/affiliate"
        keywords="affiliate program, referral program, payment processing affiliate, earn commissions, residual income, merchant referral"
      />
      <Navbar />

      <main className="flex-grow pt-28">
        <section className="bg-gradient-to-br from-primary/5 via-background to-primary/10 py-16 md:py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
              <div>
                <Badge className="mb-4 bg-primary/10 text-primary border-primary/20" data-testid="badge-affiliate">
                  <Gift className="w-3 h-3 mr-1" /> Affiliate Program
                </Badge>
                <h1 className="text-3xl md:text-4xl lg:text-5xl font-display font-bold text-foreground mb-4" data-testid="text-affiliate-heading">
                  Earn Money Referring <span className="text-primary">Businesses</span>
                </h1>
                <p className="text-lg text-muted-foreground mb-6">
                  Join our affiliate program and earn commissions every time a business you refer signs up for payment processing. No experience needed — just share your link.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button size="lg" className="gap-2" onClick={() => setView("signup")} data-testid="button-join-now">
                    <UserPlus className="w-5 h-5" /> Join Free — Start Earning
                  </Button>
                  <Button size="lg" variant="outline" className="gap-2" onClick={() => setView("login")} data-testid="button-affiliate-login">
                    <LogIn className="w-5 h-5" /> Affiliate Login
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { icon: DollarSign, label: "10%", sub: "Commission Rate", color: "text-emerald-500" },
                  { icon: TrendingUp, label: "Residual", sub: "Monthly Income", color: "text-blue-500" },
                  { icon: Users, label: "Free", sub: "To Join", color: "text-purple-500" },
                  { icon: Zap, label: "Instant", sub: "Tracking Link", color: "text-amber-500" },
                ].map((item, i) => (
                  <Card key={i} className="text-center">
                    <CardContent className="p-5">
                      <item.icon className={`w-8 h-8 ${item.color} mx-auto mb-2`} />
                      <p className="text-xl font-bold text-foreground">{item.label}</p>
                      <p className="text-xs text-muted-foreground">{item.sub}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </div>
        </section>

        {view === "login" && (
          <section className="py-12 bg-muted/20">
            <div className="max-w-md mx-auto px-4 sm:px-6 lg:px-8">
              <Card>
                <CardHeader className="text-center">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <Lock className="w-6 h-6 text-primary" />
                  </div>
                  <CardTitle>Affiliate Login</CardTitle>
                  <p className="text-sm text-muted-foreground">Sign in to access your dashboard</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Email</label>
                    <Input
                      type="email"
                      value={loginForm.email}
                      onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                      placeholder="you@example.com"
                      data-testid="input-login-email"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Password</label>
                    <Input
                      type="password"
                      value={loginForm.password}
                      onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                      placeholder="Your password"
                      data-testid="input-login-password"
                      onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
                    />
                  </div>
                  <Button className="w-full gap-2" size="lg" onClick={handleLogin} disabled={submitting} data-testid="button-submit-login">
                    {submitting ? "Signing in..." : "Sign In"}
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                  <div className="border-t border-border pt-4 mt-4">
                    <p className="text-sm text-center text-muted-foreground mb-2">Don't have an account?</p>
                    <Button variant="outline" className="w-full" onClick={() => setView("signup")} data-testid="button-switch-signup">
                      Create Affiliate Account
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>
        )}

        {view === "signup" && (
          <section className="py-12 bg-muted/20">
            <div className="max-w-md mx-auto px-4 sm:px-6 lg:px-8">
              <Card>
                <CardHeader className="text-center">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <UserPlus className="w-6 h-6 text-primary" />
                  </div>
                  <CardTitle>Create Your Affiliate Account</CardTitle>
                  <p className="text-sm text-muted-foreground">Start earning commissions in 30 seconds</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium text-foreground mb-1 block">First Name *</label>
                      <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder="John" data-testid="input-first-name" />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground mb-1 block">Last Name</label>
                      <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder="Smith" data-testid="input-last-name" />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Email *</label>
                    <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="john@example.com" data-testid="input-email" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Password <span className="text-destructive">*</span></label>
                    <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min 6 characters" data-testid="input-password" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Phone *</label>
                    <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" data-testid="input-phone" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Company Name (optional)</label>
                    <Input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} placeholder="Your company" data-testid="input-company" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Website (optional)</label>
                    <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://yoursite.com" data-testid="input-website" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">How did you hear about us?</label>
                    <Input value={form.howHeard} onChange={(e) => setForm({ ...form, howHeard: e.target.value })} placeholder="Google, friend, social media..." data-testid="input-how-heard" />
                  </div>
                  <Button className="w-full gap-2" size="lg" onClick={handleSignup} disabled={submitting} data-testid="button-submit-signup">
                    {submitting ? "Creating Account..." : "Create Affiliate Account"}
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    By signing up you agree to our affiliate terms. No fees, no commitments — cancel anytime.
                  </p>

                  <div className="border-t border-border pt-4 mt-4">
                    <p className="text-sm text-center text-muted-foreground mb-2">Already an affiliate?</p>
                    <Button variant="outline" className="w-full" onClick={() => setView("login")} data-testid="button-switch-login">
                      Sign In Instead
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>
        )}

        <section className="bg-muted/30 py-16" data-testid="section-two-paths">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-10">
              <h2 className="text-2xl md:text-3xl font-display font-bold text-foreground mb-3" data-testid="text-two-paths-heading">
                Two Ways to Partner With Liberty Bancard
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                Not sure which path fits? Here's the difference.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card className="border-2 border-primary/20" data-testid="card-refer-merchant">
                <CardContent className="p-6">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Users className="w-6 h-6 text-primary" />
                  </div>
                  <div className="inline-flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 text-xs font-semibold px-2.5 py-1 rounded-md mb-3">
                    Passive — Refer &amp; Earn
                  </div>
                  <h3 className="text-xl font-display font-bold text-foreground mb-2">Refer a Merchant</h3>
                  <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
                    Know a business owner who accepts credit cards? Share your unique link. If they sign up, you earn a commission — no selling, no follow-up required.
                  </p>
                  <ul className="space-y-2 text-sm text-muted-foreground mb-6">
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> 10% commission on first-year fees</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Monthly residual income</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> No sales experience needed</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> We handle the sales process &amp; onboarding</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Free to join — no quotas</li>
                  </ul>
                  <Button className="w-full gap-2" onClick={() => { setView("signup"); window.scrollTo({ top: 0, behavior: "smooth" }); }} data-testid="button-path-affiliate">
                    <UserPlus className="w-4 h-4" /> Join as an Affiliate
                  </Button>
                </CardContent>
              </Card>

              <Card className="border-2 border-border" data-testid="card-become-agent">
                <CardContent className="p-6">
                  <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-950/30 flex items-center justify-center mb-4">
                    <Briefcase className="w-6 h-6 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="inline-flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 text-xs font-semibold px-2.5 py-1 rounded-md mb-3">
                    Active — Full-Time Opportunity
                  </div>
                  <h3 className="text-xl font-display font-bold text-foreground mb-2">Become a Sales Agent</h3>
                  <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
                    Want to build a real book of business in payment processing? Become an ISO sales agent and earn higher commissions with dedicated back-office support.
                  </p>
                  <ul className="space-y-2 text-sm text-muted-foreground mb-6">
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" /> Higher commission splits</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" /> Lifetime residuals on your portfolio</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" /> Training, scripts, and marketing support</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" /> No territory restrictions</li>
                    <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" /> Full back-office ops handled by Liberty</li>
                  </ul>
                  <Link href="/get-started" data-testid="link-path-agent">
                    <Button variant="outline" className="w-full gap-2">
                      <ArrowRight className="w-4 h-4" /> Apply to Become an Agent
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <section className="py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-2xl md:text-3xl font-display font-bold text-foreground mb-3" data-testid="text-how-it-works">
                How It Works
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                Start earning in 4 simple steps. No sales experience required.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {steps.map((step, i) => (
                <div key={i} className="text-center">
                  <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4 relative">
                    <step.icon className="w-6 h-6 text-primary" />
                    <span className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                      {i + 1}
                    </span>
                  </div>
                  <h3 className="font-semibold text-foreground mb-2">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-muted/30 py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-2xl md:text-3xl font-display font-bold text-foreground mb-3" data-testid="text-why-join">
                Why Join Our Program?
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                We've built one of the most rewarding affiliate programs in payment processing.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {benefits.map((b, i) => (
                <Card key={i}>
                  <CardContent className="p-6">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                      <b.icon className="w-5 h-5 text-primary" />
                    </div>
                    <h3 className="font-semibold text-foreground mb-2">{b.title}</h3>
                    <p className="text-sm text-muted-foreground">{b.desc}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-10">
              <h2 className="text-2xl md:text-3xl font-display font-bold text-foreground mb-3">
                Frequently Asked Questions
              </h2>
            </div>
            <div className="space-y-4">
              {[
                { q: "How much can I earn?", a: "You earn 10% commission on each merchant's first-year processing fees, plus ongoing monthly residuals. Top affiliates earn $1,000–$5,000/month." },
                { q: "Is there a cost to join?", a: "No — it's completely free. No signup fee, no monthly fee, no hidden costs." },
                { q: "Do I need sales experience?", a: "Not at all. Just share your link with business owners. Our team handles the sales process, setup, and support." },
                { q: "How do I get paid?", a: "Commissions are calculated monthly and paid via check, ACH, or PayPal. You can set your preferred method in your dashboard." },
                { q: "What types of businesses should I refer?", a: "Any business that accepts credit or debit cards: restaurants, retail shops, salons, auto repair, medical offices, e-commerce — the list goes on." },
                { q: "How do I track my referrals?", a: "Your affiliate dashboard shows real-time stats on clicks, signups, conversions, and earnings. You'll also get email notifications for key events." },
                { q: "What about cookie-based tracking?", a: "We use 30-day cookie-based attribution. When someone clicks your link, a cookie is saved for 30 days. Even if they return later without your link, the referral is still tracked to you." },
              ].map((faq, i) => (
                <Card key={i}>
                  <CardContent className="p-5">
                    <h3 className="font-semibold text-foreground mb-2">{faq.q}</h3>
                    <p className="text-sm text-muted-foreground">{faq.a}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-primary/5 py-16">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <Handshake className="w-12 h-12 text-primary mx-auto mb-4" />
            <h2 className="text-2xl md:text-3xl font-display font-bold text-foreground mb-3">
              Ready to Start Earning?
            </h2>
            <p className="text-muted-foreground mb-6 max-w-xl mx-auto">
              Join hundreds of affiliates already earning commissions with Liberty Bancard. It takes 30 seconds to sign up and you can start sharing your link immediately.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button size="lg" className="gap-2" onClick={() => { setView("signup"); window.scrollTo({ top: 0, behavior: "smooth" }); }} data-testid="button-cta-join">
                <UserPlus className="w-5 h-5" /> Join the Affiliate Program
              </Button>
              <Button size="lg" variant="outline" className="gap-2" onClick={() => { setView("login"); window.scrollTo({ top: 0, behavior: "smooth" }); }} data-testid="button-cta-login">
                <LogIn className="w-5 h-5" /> Affiliate Login
              </Button>
              <Link href="/partner-login" data-testid="link-partner-portal-login">
                <Button size="lg" variant="ghost" className="gap-2">
                  <Handshake className="w-5 h-5" /> Partner Portal Login
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
