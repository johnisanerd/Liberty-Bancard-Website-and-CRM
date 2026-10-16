import { useState, useMemo, useEffect, useRef } from "react";
import { SEO, getLocalBusinessSchema, getWebSiteSchema } from "@/components/SEO";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { useScrollReveal } from "@/hooks/use-scroll-reveal";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { FSR_HOME_LINK_TEXT } from "@shared/free-statement-review-content";
import { CALENDAR_URL, PHONE_TEL, PHONE_NUMBER } from "@/lib/constants";
import { trackBookingCtaClick, trackStatementUploadCtaClick } from "@/lib/tracking";
import { trackPhoneCallClick } from "@/lib/analytics";
import { apiRequest } from "@/lib/queryClient";
import { SITE_STATS } from "@/lib/site-content";
import { useToast } from "@/hooks/use-toast";
import { PewcCheckbox } from "@/components/PewcCheckbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  FileText,
  CreditCard,
  ShieldCheck,
  Headphones,
  Scale,
  ArrowRight,
  CheckCircle2,
  Upload,
  Calculator,
  Stethoscope,
  Car,
  UtensilsCrossed,
  Wrench,
  Store,
  Star,
  Quote,
  Clock,
  DollarSign,
  Users,
  BadgeCheck,
  Phone,
  Building,
  HandshakeIcon,
  Banknote,
  Loader2,
  CheckCircle,
  Calendar,
  TrendingUp,
} from "lucide-react";
import logoBlue from "@assets/logo-blue.png";
import teamCollab from "@assets/images/team-collab.png";
import imgCloverFlex3 from "@assets/images/terminal-clover-flex-3.png";
import imgCloverMini3 from "@assets/images/terminal-clover-mini-3.png";
import imgCloverStationDuo from "@assets/images/terminal-clover-station-duo.png";
import imgPaxA920 from "@assets/images/terminal-pax-a920.png";
import dashboardPreview from "@assets/images/dashboard-preview.png";

function useCountUp(end: number, duration: number = 2000, suffix: string = "", divisor: number = 1, decimals: number = 0) {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          setStarted(true);
        }
      },
      { threshold: 0.3 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    const steps = 60;
    const increment = end / steps;
    let current = 0;
    const interval = setInterval(() => {
      current += increment;
      if (current >= end) {
        setCount(end);
        clearInterval(interval);
      } else {
        setCount(Math.floor(current));
      }
    }, duration / steps);
    return () => clearInterval(interval);
  }, [started, end, duration]);

  const formatted = divisor !== 1
    ? (count / divisor).toFixed(decimals)
    : decimals > 0
      ? count.toFixed(decimals)
      : count.toLocaleString();
  return { ref, display: `${formatted}${suffix}` };
}

const INDUSTRY_BENCHMARKS: Record<string, { low: number; mid: number; high: number; label: string }> = {
  restaurant: { low: 1.8, mid: 2.5, high: 3.2, label: "Restaurants" },
  retail: { low: 1.6, mid: 2.3, high: 3.0, label: "Retail" },
  medical: { low: 2.0, mid: 2.8, high: 3.5, label: "Medical/Dental" },
  automotive: { low: 2.2, mid: 3.0, high: 3.8, label: "Automotive" },
  services: { low: 2.4, mid: 3.2, high: 4.0, label: "Home Services" },
  ecommerce: { low: 2.5, mid: 3.3, high: 4.2, label: "E-Commerce" },
};

function getRateGrade(rate: number): { label: string; color: string; bg: string; message: string } {
  if (rate <= 2.0) return { label: "Competitive", color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800", message: "Your rate looks competitive. Upload your statement to confirm there are no hidden fees inflating your cost." };
  if (rate <= 2.8) return { label: "Average", color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800", message: "Most merchants in this range have room to reduce. A statement review will show exactly where." };
  if (rate <= 3.5) return { label: "Above Average", color: "text-orange-600 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800", message: "You're likely overpaying. Statement reviews at this level typically reveal specific cost drivers you can address." };
  return { label: "Needs Review", color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800", message: "Your effective rate is significantly above average. A statement review is strongly recommended to identify what's driving your cost." };
}

export default function Home() {
  const [monthlyVolume, setMonthlyVolume] = useState("");
  const [totalFees, setTotalFees] = useState("");
  const [selectedIndustry, setSelectedIndustry] = useState("restaurant");
  const [cbName, setCbName] = useState("");
  const [cbPhone, setCbPhone] = useState("");
  const [cbBestTime, setCbBestTime] = useState("Morning");
  const [cbSubmitting, setCbSubmitting] = useState(false);
  const [cbSubmitted, setCbSubmitted] = useState(false);
  const [cbPewcConsent, setCbPewcConsent] = useState(false);
  const { toast } = useToast();

  const containerRef = useScrollReveal();
  const yearsStat = SITE_STATS.find((stat) => stat.id === "years_in_business")!;
  const merchantsStat = SITE_STATS.find((stat) => stat.id === "merchants_served")!;
  const volumeStat = SITE_STATS.find((stat) => stat.id === "processing_volume_annual_m")!;
  const stat1 = useCountUp(yearsStat.countUpEnd, 2000, "+");
  const stat2 = useCountUp(merchantsStat.countUpEnd, 2000, "+");
  const stat3 = useCountUp(volumeStat.countUpEnd, 2000, "B+", 1000, 1);

  const cbIdempotencyKeyRef = useRef<string | null>(null);

  const handleCallbackSubmit = async () => {
    if (!cbName.trim() || !cbPhone.trim()) return;
    setCbSubmitting(true);
    try {
      cbIdempotencyKeyRef.current ??= crypto.randomUUID();
      await apiRequest("POST", "/api/public/callback", {
        name: cbName, phone: cbPhone, bestTime: cbBestTime, pewcConsent: cbPewcConsent,
      }, { "Idempotency-Key": cbIdempotencyKeyRef.current });
      setCbSubmitted(true);
      cbIdempotencyKeyRef.current = null;
    } catch (error: any) {
      toast({
        title: "Something went wrong",
        description: error.message || `Please try again or call us at ${PHONE_NUMBER}.`,
        variant: "destructive",
      });
    } finally {
      setCbSubmitting(false);
    }
  };

  const volume = parseFloat(monthlyVolume.replace(/[,$]/g, "")) || 0;
  const fees = parseFloat(totalFees.replace(/[,$]/g, "")) || 0;
  const effectiveRate = volume > 0 ? ((fees / volume) * 100) : null;
  const rateGrade = effectiveRate !== null ? getRateGrade(effectiveRate) : null;
  const benchmark = INDUSTRY_BENCHMARKS[selectedIndustry];

  const annualOverpay = useMemo(() => {
    if (!effectiveRate || effectiveRate <= 2.0) return null;
    const potentialSavings = volume * ((effectiveRate - 2.0) / 100) * 12;
    return Math.round(potentialSavings);
  }, [effectiveRate, volume]);

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <SEO title="Merchant Payment Processing | Liberty Bancard" description="Liberty Bancard — credit card processing and merchant services for South Florida businesses. Transparent rates, free statement review, no hidden fees." path="/" keywords="payment processing, merchant services, credit card processing, statement review, interchange plus pricing, wholesale rates" structuredData={[getLocalBusinessSchema(), getWebSiteSchema()]} />
      <Navbar />

      <main className="marketing-surface flex-grow pt-[72px] md:pt-24 dock-clearance-main md:pb-0" ref={containerRef}>

        {/* SECTION: Hero — Statement Intelligence editorial split */}
        <section className="marketing-surface relative overflow-hidden bg-background border-b border-border bg-dots" data-testid="section-hero">
          <div aria-hidden="true" className="glow-blob glow-blob-2 absolute -top-20 -right-10 w-96 h-96 bg-accent" />
          <div aria-hidden="true" className="glow-blob glow-blob-3 absolute bottom-0 -left-10 w-64 h-64 bg-accent" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-12 lg:py-24">
            <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-10 lg:gap-16 items-center">
              {/* Left column — message + CTAs */}
              <div className="pt-2 md:pt-5">
                <div className="si-load si-load-1 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm mb-4" data-testid="text-hero-badge">
                  <BadgeCheck className="w-3.5 h-3.5 text-accent" />
                  South Florida Merchant Services
                </div>
                <h1 className="si-load si-load-2 text-[28px] sm:text-3xl md:text-4xl lg:text-[4.25rem] leading-tight md:leading-[1.04] font-bold text-foreground mb-4 max-w-[20ch]" data-testid="text-hero-heading">
                  <span className="text-accent">Credit Card Processing</span> Without the Rate Games
                </h1>
                <p className="si-load si-load-3 text-base sm:text-lg text-muted-foreground leading-relaxed mb-5 max-w-xl" data-testid="text-hero-subheadline">
                  Upload a recent processing statement and we'll show your effective rate, markup, monthly fees, and hidden charges — before you switch.
                </p>
                {/* Mobile-only savings hook */}
                <div className="si-load si-load-3b lg:hidden flex items-center gap-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl px-4 py-3 mb-5">
                  <TrendingUp className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400 leading-snug">Most merchants save $600–$3,200/year after a review</p>
                    <p className="text-xs text-emerald-600/70 dark:text-emerald-500/70 mt-0.5">Actual savings depend on your volume and current rates.</p>
                  </div>
                </div>
                {/* Compact "What we review" proof card — mobile primary, desktop secondary */}
                <div className="si-load si-load-3b mb-5 rounded-xl border border-border bg-card shadow-sm overflow-hidden" data-testid="card-what-we-review">
                  <div className="px-4 py-2.5 border-b border-border/60 bg-muted/30">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">What we review</p>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0 px-4 py-3">
                    {["Effective rate", "Markup", "Monthly fees", "Downgrades & add-ons"].map((item, i) => (
                      <span key={i} className="flex items-center gap-1.5 py-1 text-[13px] font-medium text-foreground">
                        <CheckCircle2 className="w-3 h-3 text-accent shrink-0" />
                        {item}
                      </span>
                    ))}
                  </div>
                  <div className="px-4 py-2 border-t border-border/60 bg-muted/20">
                    <p className="text-xs text-muted-foreground">PDF or photo is enough. Account numbers can be redacted.</p>
                  </div>
                </div>
                <div className="si-load si-load-4 flex flex-col sm:flex-row gap-3 flex-wrap" data-testid="hero-cta-block">
                  <Button asChild size="lg" className="gap-2 w-full sm:w-auto h-12 sm:h-auto text-base sm:text-sm font-bold cta-pulse" data-testid="link-hero-upload" onClick={() => trackStatementUploadCtaClick({ page: "/", ctaLabel: "Upload My Statement — Free", ctaLocation: "hero" })}>
                    <Link href="/upload-statement">
                      <Upload className="w-4 h-4 shrink-0" />
                      Upload My Statement — Free
                    </Link>
                  </Button>
                  <a href={CALENDAR_URL} target="_blank" rel="noopener noreferrer" data-testid="link-hero-book" onClick={() => trackBookingCtaClick({ page: "/", ctaLabel: "Book a 15-Minute Review", ctaLocation: "hero" })}>
                    <Button size="lg" variant="outline" className="gap-2 w-full sm:w-auto h-12 sm:h-auto border-border">
                      <Calendar className="w-4 h-4 shrink-0" />
                      Book a 15-Minute Review
                    </Button>
                  </a>
                </div>
                <p className="si-load si-load-4 text-xs text-muted-foreground mt-2 max-w-sm" data-testid="text-hero-microcopy">
                  Upload a PDF or photo. Takes 30 seconds. You can redact account numbers — totals and fee lines are enough.
                </p>
                <div className="si-load si-load-4 flex flex-wrap items-center gap-x-4 gap-y-2 mt-3">
                  {(["5,000+ Merchants", "Same-Day Review", "FL-Based Team"] as const).map((item) => (
                    <span key={item} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <BadgeCheck className="w-3.5 h-3.5 text-accent shrink-0" />
                      {item}
                    </span>
                  ))}
                </div>
                <div className="si-load si-load-5 flex flex-wrap items-center gap-x-5 gap-y-2 mt-2">
                  <a href={PHONE_TEL} aria-label="Call Liberty Bancard" className="text-sm font-medium text-foreground hover:text-primary flex items-center gap-1.5 transition-colors" data-testid="link-hero-phone" onClick={() => trackPhoneCallClick({ sourcePage: "/" })}>
                    <Phone className="w-4 h-4 text-primary" />
                    Call {PHONE_NUMBER}
                  </a>
                  <Link href="/beat-square-stripe" className="hidden lg:inline-flex text-xs text-muted-foreground hover:text-foreground items-center gap-1.5 transition-colors" data-testid="link-hero-compare">
                    Compare My Current Setup
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
                {/* Mobile: compact proof/trust row — replaces the detached phone row gap */}
                <div className="si-load si-load-6 lg:hidden flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-4 pt-4 border-t border-border">
                  {["Free statement review", "No processor login needed", "Florida-based"].map((item, i) => (
                    <span key={i} className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <BadgeCheck className="w-3 h-3 text-accent shrink-0" />
                      {item}
                    </span>
                  ))}
                </div>
                {/* Desktop: compact in-hero trust row */}
                <div className="si-load si-load-6 hidden lg:flex flex-wrap items-center gap-x-4 gap-y-2 mt-8 pt-6 border-t border-border">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="text-hero-trust-1"><BadgeCheck className="w-3.5 h-3.5 text-accent" /> Payment processing</span>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="text-hero-trust-2"><FileText className="w-3.5 h-3.5 text-accent" /> Line-item breakdown</span>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="text-hero-trust-3"><Headphones className="w-3.5 h-3.5 text-accent" /> Real human support</span>
                </div>
                {/* Compliance fine print — relocated from navbar strip */}
                <p className="hidden lg:block text-xs leading-relaxed text-muted-foreground mt-4 max-w-md" data-testid="text-hero-compliance">
                  Eligibility, underwriting, card brand rules, and applicable laws apply. No savings claims without statement review.
                </p>
              </div>

              {/* Right column — layered Statement Intelligence audit module */}
              <div className="relative hidden lg:flex items-center justify-center lg:justify-end" data-testid="hero-visual">
                {/* navy authority panel behind the report */}
                <div className="pointer-events-none absolute -right-2 -top-4 hidden lg:block h-[88%] w-[78%] rounded-xl bg-primary" aria-hidden="true" />
                <div className="pointer-events-none absolute right-4 top-2 hidden lg:block h-2 w-24 bg-accent rounded-full" aria-hidden="true" />
                <div className="si-load si-load-3 relative w-full max-w-md rounded-xl border border-border bg-card shadow-elevated overflow-hidden float-vertical">
                  {/* report header */}
                  <div className="flex items-center justify-between gap-3 bg-primary px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 items-center justify-center rounded bg-accent/20">
                        <FileText className="w-4 h-4 text-sky-300" />
                      </div>
                      <div className="leading-tight">
                        <div className="text-sm font-semibold text-white">Statement Fee Audit</div>
                        <div className="num text-[10px] text-white/55 tracking-wide">REF · LB-0000 · SAMPLE</div>
                      </div>
                    </div>
                    <span className="audit-stamp bg-card" data-testid="badge-illustrative">Illustrative</span>
                  </div>
                  {/* findings ledger */}
                  <div className="px-5">
                    {[
                      { label: "Effective rate", value: "3.47%", chip: "Above benchmark", tone: "negative" },
                      { label: "Monthly fixed fees", value: "$127/mo", chip: "Recurring", tone: "negative" },
                      { label: "Downgrades / card mix", value: "23%", chip: "Reducible", tone: "negative" },
                      { label: "Add-on fees (PCI, batch)", value: "$38/mo", chip: "Itemized", tone: "negative" },
                      { label: "Funding timeline", value: "Next-day*", chip: "Eligibility", tone: "neutral" },
                      { label: "Savings opportunity", value: "Identified", chip: "On review", tone: "positive" },
                    ].map((row, i) => (
                      <div key={i} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-2.5 border-b border-border/70 last:border-0" data-testid={`row-statement-${i}`}>
                        <span className="text-[13px] text-foreground/80 min-w-0 flex-1">{row.label}</span>
                        <div className="flex items-center gap-2">
                          <span className={`report-chip report-chip-${row.tone === "negative" ? "negative" : row.tone === "positive" ? "positive" : "neutral"}`}>{row.chip}</span>
                          <span className={`num text-sm font-semibold whitespace-nowrap ${row.tone === "negative" ? "text-stat-negative" : row.tone === "positive" ? "text-stat-positive" : "text-foreground"}`}>{row.value}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* report footer */}
                  <div className="border-t border-border bg-muted/40 px-5 py-3">
                    <p className="text-[10px] leading-relaxed text-muted-foreground">Actual findings require statement review. *Funding timing subject to eligibility, underwriting, and card brand rules.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION: Mobile-only sample review — lg:hidden */}
        <div className="lg:hidden section-warm py-8" data-testid="section-sample-review-mobile">
          <div className="max-w-md mx-auto px-4">
            <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground text-center mb-4">Example statement review</p>
            <div className="relative w-full rounded-xl border border-border bg-card shadow-sm overflow-hidden" data-testid="card-statement-audit-mobile">
              {/* report header */}
              <div className="flex items-center justify-between gap-3 bg-primary px-5 py-3.5">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded bg-accent/20">
                    <FileText className="w-4 h-4 text-sky-300" />
                  </div>
                  <div className="leading-tight">
                    <div className="text-sm font-semibold text-white">Statement Fee Audit</div>
                    <div className="num text-[10px] text-white/55 tracking-wide">REF · LB-0000 · SAMPLE</div>
                  </div>
                </div>
                <span className="audit-stamp bg-card" data-testid="badge-illustrative-mobile">Illustrative</span>
              </div>
              {/* findings ledger */}
              <div className="px-5">
                {[
                  { label: "Effective rate", value: "3.47%", chip: "Above benchmark", tone: "negative", testId: "text-statement-audit-mobile-effective-rate" },
                  { label: "Monthly fixed fees", value: "$127/mo", chip: "Recurring", tone: "negative", testId: "text-statement-audit-mobile-fixed-fees" },
                  { label: "Downgrades / card mix", value: "23%", chip: "Reducible", tone: "negative" },
                  { label: "Add-on fees (PCI, batch)", value: "$38/mo", chip: "Itemized", tone: "negative" },
                  { label: "Funding timeline", value: "Next-day*", chip: "Eligibility", tone: "neutral" },
                  { label: "Savings opportunity", value: "Identified", chip: "On review", tone: "positive" },
                ].map((row, i) => (
                  <div key={i} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-2.5 border-b border-border/70 last:border-0" data-testid={row.testId ?? `row-statement-mobile-${i}`}>
                    <span className="text-[13px] text-foreground/80 min-w-0 flex-1">{row.label}</span>
                    <div className="flex items-center gap-2">
                      <span className={`report-chip report-chip-${row.tone === "negative" ? "negative" : row.tone === "positive" ? "positive" : "neutral"}`}>{row.chip}</span>
                      <span className={`num text-sm font-semibold whitespace-nowrap ${row.tone === "negative" ? "text-stat-negative" : row.tone === "positive" ? "text-stat-positive" : "text-foreground"}`}>{row.value}</span>
                    </div>
                  </div>
                ))}
              </div>
              {/* report footer */}
              <div className="border-t border-border bg-muted/40 px-5 py-3">
                <p className="text-[10px] leading-relaxed text-muted-foreground">Actual findings require statement review. *Funding timing subject to eligibility, underwriting, and card brand rules.</p>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground mt-3 text-center" data-testid="text-hero-compliance-mobile">
              Eligibility, underwriting, card brand rules, and applicable laws apply. No savings claims without statement review.
            </p>
          </div>
        </div>

        {/* SECTION: Trust strip (merged) */}
        <div className="bg-background border-b border-border py-6" data-testid="section-trust-badges">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3" data-testid="trust-badge-years">
                <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <Building className="w-5 h-5 text-primary" />
                </div>
                <div className="flex flex-col gap-0">
                  <span className="text-sm font-bold text-foreground">FL-Based</span>
                  <span className="text-xs font-semibold text-foreground">South Florida Team</span>
                  <span className="text-xs text-muted-foreground">Local reps, real conversations</span>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3" data-testid="trust-badge-processing">
                <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <CreditCard className="w-5 h-5 text-primary" />
                </div>
                <div className="flex flex-col gap-0">
                  <span className="text-sm font-bold text-foreground">Card Processing</span>
                  <span className="text-xs font-semibold text-foreground">Visa · Mastercard · Amex</span>
                  <span className="text-xs text-muted-foreground">Discover · all major cards</span>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3" data-testid="trust-badge-volume">
                <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <Scale className="w-5 h-5 text-primary" />
                </div>
                <div className="flex flex-col gap-0">
                  <span className="text-sm font-bold text-foreground">I+P</span>
                  <span className="text-xs font-semibold text-foreground">Interchange-Plus Pricing</span>
                  <span className="text-xs text-muted-foreground">Transparent, line-item billing</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 3: Pain Points */}
        <section className="section-warm py-14" data-testid="section-pain">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="reveal max-w-2xl mx-auto text-center mb-10">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-3" data-testid="text-pain-heading">
                Sound Familiar?
              </h2>
              <p className="text-sm text-muted-foreground">The four patterns that show up most on the statements we review.</p>
            </div>
            <div className="reveal grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { icon: TrendingUp, chip: "Rate Mismatch", text: "You were quoted 1.5% — but your statement shows 3%+ all-in." },
                { icon: DollarSign, chip: "Fee Creep", text: "Monthly fees keep climbing and nobody explains why." },
                { icon: Clock, chip: "Funding Uncertainty", text: "Deposits land whenever, so cash flow is a guessing game." },
                { icon: Phone, chip: "Support Gap", text: "You call support and reach a call center, not an answer." },
              ].map((item, i) => (
                <div key={i} className="group rounded-lg border border-border bg-card p-4 shadow-card hover-elevate" data-testid={`card-pain-${i}`}>
                  <div className="flex items-center gap-2 mb-2.5">
                    <item.icon className="w-4 h-4 text-stat-negative shrink-0" />
                    <span className="report-chip report-chip-negative">{item.chip}</span>
                  </div>
                  <p className="text-sm text-foreground leading-relaxed">{item.text}</p>
                </div>
              ))}
            </div>
            <p className="text-center text-muted-foreground mt-8 text-sm" data-testid="text-pain-resolution">
              If any of this sounds right, your statement will tell us exactly what's going on.
            </p>
          </div>
        </section>

        {/* SECTION 3.5: By the Numbers — light report ledger */}
        <section className="reveal section-navy relative overflow-hidden py-16 md:py-20" data-testid="section-stats">
          <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" aria-hidden="true" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-center gap-2 mb-2">
              <span className="num text-xs font-semibold uppercase tracking-[0.18em] text-sky-300">Liberty Bancard</span>
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-white text-center mb-10 md:mb-12" data-testid="text-stats-heading">
              By the Numbers
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6">
              <div ref={stat1.ref} className="rounded-lg border border-white/15 bg-white/10 p-6 backdrop-blur-sm" data-testid="stat-years">
                <div className="num text-6xl md:text-7xl font-bold text-white mb-2 tracking-tight">{stat1.display}</div>
                <div className="text-sm font-semibold text-white">{yearsStat.label}</div>
                <div className="text-xs text-white/65 mt-1">{yearsStat.sublabel}</div>
              </div>
              <div ref={stat2.ref} className="rounded-lg border border-white/15 bg-white/10 p-6 backdrop-blur-sm" data-testid="stat-merchants">
                <div className="num text-6xl md:text-7xl font-bold text-white mb-2 tracking-tight">{stat2.display}</div>
                <div className="text-sm font-semibold text-white">{merchantsStat.label}</div>
                <div className="text-xs text-white/65 mt-1">{merchantsStat.sublabel}</div>
              </div>
              <div ref={stat3.ref} className="rounded-lg border border-white/15 bg-white/10 p-6 backdrop-blur-sm" data-testid="stat-fees">
                <div className="num text-6xl md:text-7xl font-bold text-white mb-2 tracking-tight">${stat3.display}</div>
                <div className="text-sm font-semibold text-white">{volumeStat.label}</div>
                <div className="text-xs text-white/65 mt-1">{volumeStat.sublabel}</div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 4: What You Get */}
        <div className="section-warm py-12 md:py-20" data-testid="section-what-you-get">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            {/* Mobile: compact summary — replaces the 6-row card + Yours to Keep card */}
            <div className="md:hidden" data-testid="section-review-includes-mobile">
              <div className="accent-rule pt-4 mb-5">
                <span className="num text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">The Deliverable</span>
                <h2 className="text-2xl font-display font-bold text-foreground mb-2 mt-1">
                  What Your Liberty Review Includes
                </h2>
                <p className="text-muted-foreground text-sm">Not a quote. A clear breakdown of what you're paying — fee drivers, downgrades, true effective rate, and 2–3 options to compare.</p>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-5">
                {["True effective rate","Fee driver map","Downgrade review","Monthly add-ons","Funding timeline","Options summary"].map((item, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-foreground">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    {item}
                  </div>
                ))}
              </div>
              <Link href="/upload-statement" data-testid="link-what-you-get-upload-mobile">
                <Button className="gap-2 w-full" onClick={() => trackStatementUploadCtaClick({ page: "/", ctaLabel: "Get My Free Analysis", ctaLocation: "what-you-get-mobile" })}>
                  <Upload className="w-4 h-4" />
                  Get My Free Analysis
                </Button>
              </Link>
              <p className="text-xs text-muted-foreground mt-2 text-center">Yours to keep either way. No obligation. *Eligibility, underwriting, card brand rules, and applicable laws apply.</p>
            </div>
            {/* Desktop: full two-column layout */}
            <div className="hidden md:grid lg:grid-cols-[1.1fr_0.9fr] gap-10 lg:gap-12 items-start">
              <div className="reveal accent-rule pt-5">
                <span className="num text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">The Deliverable</span>
                <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4 mt-2" data-testid="text-what-you-get-heading">
                  What Your Liberty Review Includes
                </h2>
                <p className="text-muted-foreground mb-7">Not a quote. Not a pitch. A clear breakdown of what you're paying and why.</p>
                <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-5 py-3">
                    <span className="text-sm font-semibold text-foreground">Review Contents</span>
                    <span className="num text-[10px] uppercase tracking-[0.16em] text-muted-foreground">6 sections</span>
                  </div>
                  <ul className="divide-y divide-border/70">
                    {[
                      { chip: "Effective Rate", title: "Your true effective rate", desc: "Total fees divided by total volume — the one number that tells the truth." },
                      { chip: "Fee Drivers", title: "Fee driver map", desc: "Card mix, downgrades, monthly add-ons, batch fees, PCI charges — all of it." },
                      { chip: "Downgrades", title: "Downgrade review", desc: "Where transactions slip to higher-cost categories, and why." },
                      { chip: "Add-Ons", title: "Monthly add-on breakdown", desc: "Recurring line items, itemized and explained." },
                      { chip: "Funding", title: "Funding timeline*", desc: "When your money hits your account and what affects timing." },
                      { chip: "Options", title: "Options summary", desc: "2–3 clear options with real, apples-to-apples math." },
                    ].map((item, i) => (
                      <li key={i} className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-3 px-5 py-3.5" data-testid={`what-you-get-bullet-${i}`}>
                        <span className="report-chip report-chip-neutral w-fit sm:mt-0.5 sm:shrink-0 sm:w-[92px] sm:justify-center">{item.chip}</span>
                        <div className="min-w-0">
                          <span className="text-foreground font-medium text-sm">{item.title}</span>
                          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{item.desc}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="reveal reveal-delay-2 lg:sticky lg:top-32">
                <Card className="border-2 border-primary/20 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 bg-primary px-5 py-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-sky-300" />
                      <span className="text-sm font-semibold text-white">Yours to Keep</span>
                    </div>
                    <span className="audit-stamp bg-card">No obligation</span>
                  </div>
                  <CardContent className="p-6 text-center">
                    <h3 className="text-xl font-display font-bold text-foreground mb-2" data-testid="text-keep-breakdown">You Keep the Breakdown</h3>
                    <p className="text-muted-foreground text-sm mb-6">Even if you don't switch. Zero obligation. It's yours — use it to negotiate with your current processor if you want.</p>
                    <Link href="/upload-statement" data-testid="link-what-you-get-upload">
                      <Button className="w-full gap-2" onClick={() => trackStatementUploadCtaClick({ page: "/", ctaLabel: "Get My Free Analysis", ctaLocation: "what-you-get" })}>
                        <Upload className="w-4 h-4" />
                        Get My Free Analysis
                      </Button>
                    </Link>
                    <p className="text-xs text-muted-foreground mt-3">*Eligibility, underwriting, card brand rules, and applicable laws apply.</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 5: How The Liberty Analysis Works (+ onboarding timeline) */}
        <section className="bg-background py-12 md:py-20" data-testid="section-how-it-works">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-2">
              <span className="inline-flex items-center gap-1.5 bg-primary/10 text-primary text-xs font-semibold px-3 py-1 rounded-md uppercase tracking-wider mb-3">Phase 1 · Analysis</span>
            </div>
            <h2 className="reveal text-4xl md:text-5xl font-display font-bold text-foreground text-center mb-4" data-testid="text-how-heading">
              How The Liberty Analysis Works
            </h2>
            <p className="text-center text-muted-foreground mb-8 max-w-xl mx-auto">Three clear steps. Most reviews finish the same business day. You keep the results no matter what.</p>
            {/* Mobile: compact 3-row process list */}
            <div className="md:hidden rounded-lg border border-border overflow-hidden mb-0" data-testid="section-how-it-works-mobile">
              {[
                { step: "1", title: "Upload Your Statement", desc: "PDF or photo — 30 seconds. Redact account numbers if you want." },
                { step: "2", title: "We Run The Liberty Analysis", desc: "Same business day, we review every fee and calculate your true effective rate." },
                { step: "3", title: "You Get 2–3 Clear Options", desc: "Real math, no pressure. Keep the full breakdown either way." },
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0 bg-card" data-testid={`step-mobile-${item.step}`}>
                  <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold num shrink-0 mt-0.5">
                    {item.step}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground leading-snug mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
              <div className="px-4 py-3 bg-card border-t border-border">
                <Link href="/upload-statement" data-testid="link-how-it-works-cta-mobile">
                  <Button className="gap-2 w-full">
                    <Upload className="w-4 h-4" />
                    Start My Liberty Analysis
                  </Button>
                </Link>
              </div>
            </div>
            {/* Desktop: 3-step numbered circle grid */}
            <div className="reveal relative hidden md:grid md:grid-cols-3 gap-8">
              <div className="hidden md:block absolute top-7 left-[16.66%] right-[16.66%] h-0.5 bg-gradient-to-r from-border via-accent/40 to-border" aria-hidden="true" />
              {[
                { step: "1", icon: Upload, title: "Upload Your Statement", desc: "PDF or photo. 30 seconds. Redact account numbers if you want — we only need totals and fee lines.", cta: "Start Your Liberty Analysis", href: "/upload-statement" },
                { step: "2", icon: Calculator, title: "We Run The Liberty Analysis", desc: "Usually the same business day, we review every fee, markup, and cost driver line by line and calculate your true effective rate.", cta: null, href: null },
                { step: "3", icon: FileText, title: "You Get 2–3 Clear Options", desc: "Real math, no pressure. Compare options side by side. Keep the full breakdown either way.", cta: null, href: null },
              ].map((item, i) => (
                <div key={i} className="relative" data-testid={`step-${item.step}`}>
                  <div className="text-center">
                    <div className="w-14 h-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-4 text-xl font-bold num relative z-10 ring-4 ring-background">
                      {item.step}
                    </div>
                    <h3 className="text-lg font-display font-bold text-foreground mb-2">{item.title}</h3>
                    <p className="text-sm text-muted-foreground mb-4">{item.desc}</p>
                    {item.cta && item.href && (
                      <Link href={item.href}>
                        <Button variant="outline" className="gap-2">
                          {item.cta}
                          <ArrowRight className="w-4 h-4" />
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-8 text-center text-sm" data-testid="link-how-it-works-what-we-check-wrapper">
              <Link
                href="/upload-statement"
                className="text-primary underline underline-offset-4 hover:no-underline"
                data-testid="link-how-it-works-what-we-check"
              >
                {FSR_HOME_LINK_TEXT}
              </Link>
            </p>

            {/* Contained onboarding timeline — secondary report card — desktop only */}
            <div className="hidden md:block mt-14 max-w-5xl mx-auto">
              <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-5 py-3">
                  <h3 className="text-sm font-semibold text-foreground" data-testid="text-timeline-heading">
                    What Happens After You Say Yes
                  </h3>
                  <span className="num text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Phase 2 · Onboarding</span>
                </div>
                <div className="p-6 sm:p-8">
                  <div className="relative">
                    <div className="hidden md:block absolute top-4 left-[10%] right-[10%] h-0.5 bg-gradient-to-r from-border via-accent/40 to-border" aria-hidden="true" />
                    <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-5 gap-y-4 sm:gap-y-7 gap-x-3">
                      {[
                        { day: "Day 0", title: "Upload", desc: "Statement in, review begins" },
                        { day: "Day 1", title: "Review", desc: "Line-item breakdown delivered" },
                        { day: "Day 1–2", title: "Decision", desc: "You review options, ask questions" },
                        { day: "Day 2–3", title: "Setup", desc: "Terminal shipped, account configured" },
                        { day: "Day 3–5", title: "Live", desc: "Processing live, first batch settles" },
                      ].map((step, i) => (
                        <div key={i} className="relative" data-testid={`timeline-step-${i}`}>
                          {/* Mobile: horizontal row layout */}
                          <div className="flex items-start gap-3 sm:hidden">
                            <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold num shrink-0 ring-2 ring-card">
                              {i + 1}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                                <span className="num text-[11px] font-semibold text-accent tracking-wide">{step.day}</span>
                                <span className="text-sm font-semibold text-foreground">{step.title}</span>
                              </div>
                              <span className="text-xs text-muted-foreground leading-snug">{step.desc}</span>
                            </div>
                          </div>
                          {/* Desktop: centered column layout */}
                          <div className="hidden sm:flex flex-col items-center text-center">
                            <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold num mb-3 relative z-10 ring-4 ring-card">
                              {i + 1}
                            </div>
                            <span className="num text-[11px] font-semibold text-accent mb-1 tracking-wide">{step.day}</span>
                            <span className="text-sm font-semibold text-foreground mb-0.5">{step.title}</span>
                            <span className="text-xs text-muted-foreground leading-snug">{step.desc}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="border-t border-border bg-muted/30 px-5 py-3 text-[10px] leading-relaxed text-muted-foreground">
                  *Timeline is illustrative. Actual timelines depend on underwriting, equipment availability, and merchant response time. Eligibility, underwriting, card brand rules, and applicable laws apply.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 6: Enhanced Rate Calculator */}
        {/* Mobile fallback for Rate Calculator — links to /estimate */}
        <div className="md:hidden section-warm py-10" data-testid="section-calculator-mobile-link">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent mb-2">Quick Estimate</p>
            <h2 className="font-display text-2xl font-bold text-foreground mb-3">
              Run the 60-Second Rate Check
            </h2>
            <p className="text-muted-foreground text-sm mb-5 max-w-xs mx-auto">
              Enter your volume and fees to estimate your effective rate before uploading a statement.
            </p>
            <Button asChild variant="outline" className="gap-2" data-testid="link-calculator-mobile-estimate">
              <Link href="/estimate">
                <Calculator className="w-4 h-4" />
                Open Rate Check
              </Link>
            </Button>
          </div>
        </div>

        <section className="hidden md:block section-warm py-12 md:py-20" data-testid="section-calculator">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
              <div className="reveal">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center">
                    <Calculator className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground" data-testid="text-calculator-heading">
                      60-Second Rate Check
                    </h2>
                  </div>
                </div>
                <p className="text-muted-foreground mb-8" data-testid="text-calculator-desc">
                  Enter your numbers from last month's statement. We'll calculate your effective rate and show you where you stand.
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block" htmlFor="monthly-volume">
                      Monthly Processing Volume ($)
                    </label>
                    <Input
                      id="monthly-volume"
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 50,000"
                      value={monthlyVolume}
                      onChange={(e) => setMonthlyVolume(e.target.value)}
                      data-testid="input-monthly-volume"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block" htmlFor="total-fees">
                      Total Processing Fees ($)
                    </label>
                    <Input
                      id="total-fees"
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 1,500"
                      value={totalFees}
                      onChange={(e) => setTotalFees(e.target.value)}
                      data-testid="input-total-fees"
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">
                      Your Industry
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {Object.entries(INDUSTRY_BENCHMARKS).map(([key, val]) => (
                        <button
                          key={key}
                          onClick={() => setSelectedIndustry(key)}
                          className={`text-xs font-medium py-2 px-3 rounded-md border transition-colors ${
                            selectedIndustry === key
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background text-muted-foreground border-border hover:border-primary/50"
                          }`}
                          data-testid={`button-industry-${key}`}
                        >
                          {val.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="lg:sticky lg:top-32">
                {effectiveRate !== null ? (
                  <div className="space-y-4" data-testid="display-calculator-results">
                    <Card className={`border-2 ${rateGrade?.bg}`}>
                      <CardContent className="p-6">
                        <div className="text-center mb-4">
                          <div className="text-sm text-muted-foreground mb-1">Your Effective Rate</div>
                          <div className={`num text-5xl font-bold ${rateGrade?.color}`} data-testid="display-effective-rate">
                            {effectiveRate.toFixed(2)}%
                          </div>
                          <div className={`text-sm font-semibold mt-1 ${rateGrade?.color}`} data-testid="display-rate-grade">
                            {rateGrade?.label}
                          </div>
                        </div>

                        <p className="text-sm text-muted-foreground text-center mb-4" data-testid="display-rate-message">
                          {rateGrade?.message}
                        </p>

                        {annualOverpay && annualOverpay > 500 && (
                          <div className="bg-background/80 rounded-md p-3 text-center mb-4" data-testid="display-annual-impact">
                            <div className="text-xs text-muted-foreground">Estimated annual impact*</div>
                            <div className="text-2xl font-bold text-foreground">${annualOverpay.toLocaleString()}</div>
                            <div className="text-[10px] text-muted-foreground mt-1">*Illustrative estimate only. Actual results require statement review.</div>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="p-4">
                        <div className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider">{benchmark.label} Benchmarks</div>
                        <div className="relative h-3 bg-muted rounded-full mb-2 overflow-visible">
                          <div className="absolute left-0 h-full bg-emerald-400/40 rounded-l-full" style={{ width: `${(benchmark.low / 5) * 100}%` }} />
                          <div className="absolute h-full bg-amber-400/40" style={{ left: `${(benchmark.low / 5) * 100}%`, width: `${((benchmark.mid - benchmark.low) / 5) * 100}%` }} />
                          <div className="absolute h-full bg-red-400/40 rounded-r-full" style={{ left: `${(benchmark.mid / 5) * 100}%`, width: `${((5 - benchmark.mid) / 5) * 100}%` }} />
                          {effectiveRate <= 5 && (
                            <div
                              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-foreground border-2 border-background shadow-lg"
                              style={{ left: `${Math.min((effectiveRate / 5) * 100, 98)}%`, transform: 'translate(-50%, -50%)' }}
                              data-testid="display-rate-marker"
                            />
                          )}
                        </div>
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>{benchmark.low}% (low)</span>
                          <span>{benchmark.mid}% (avg)</span>
                          <span>{benchmark.high}%+ (high)</span>
                        </div>
                      </CardContent>
                    </Card>

                    <Link href="/upload-statement" data-testid="link-calculator-upload">
                      <Button className="w-full gap-2" size="lg">
                        Get My Exact Line-Item Breakdown
                        <ArrowRight className="w-4 h-4" />
                      </Button>
                    </Link>
                    <p className="text-xs text-muted-foreground text-center">
                      This calculator provides an estimate only. Upload your statement for a precise, line-item analysis. Eligibility, underwriting, card brand rules, and applicable laws apply.
                    </p>
                  </div>
                ) : (
                  <Card className="border border-border overflow-hidden">
                    <div className="accent-rule flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-5 py-3">
                      <span className="text-sm font-semibold text-foreground">Estimate Preview</span>
                      <span className="audit-stamp bg-card">Awaiting input</span>
                    </div>
                    <CardContent className="p-8 text-center">
                      <Calculator className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                      <h3 className="text-lg font-display font-semibold text-foreground mb-2" data-testid="text-calculator-empty">Run a 60-second effective-rate check</h3>
                      <p className="text-sm text-muted-foreground">
                        Plug in your monthly volume and total fees from your last statement. We'll instantly estimate your effective rate and compare it against your industry benchmark — no upload required.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 7: Choose Your Path */}
        <section className="bg-background border-y border-border md:border-0 md:bg-primary md:text-primary-foreground md:relative md:overflow-hidden py-12 md:py-16" data-testid="section-choose-path">
          <div className="hidden md:block absolute top-0 left-0 right-0 h-[3px] bg-accent" aria-hidden="true" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="reveal text-4xl md:text-5xl font-display font-bold text-foreground md:text-white text-center mb-4" data-testid="text-choose-path-heading">
              Choose Your Path to Zero Processing Fees
            </h2>
            <p className="text-center text-muted-foreground md:text-white/70 mb-12 max-w-xl mx-auto">Two programs can eliminate your processor fees entirely. Or, if you'd rather keep one price for all customers, Interchange Plus delivers maximum transparency at a lower rate.</p>
            {/* Mobile: Accordion — Upload-focused, collapsed by default except Wholesale */}
            <Accordion type="single" collapsible defaultValue="wholesale" className="md:hidden rounded-lg border border-border overflow-hidden" data-testid="accordion-choose-path">
              <AccordionItem value="cash-discount" className="border-b border-border last:border-0" data-testid="card-cash-discount-mobile">
                <AccordionTrigger className="px-4 py-3 hover:no-underline [&>svg]:shrink-0">
                  <div className="text-left mr-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="bg-emerald-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded">All 50 States</span>
                    </div>
                    <div className="font-display font-semibold text-foreground">Cash Discount</div>
                    <div className="text-xs text-muted-foreground font-normal mt-0.5">Stop absorbing card fees — your revenue stays the same no matter how customers pay</div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4">
                  <p className="text-sm text-muted-foreground mb-4">Your cash price is your posted price. Processing cost is covered automatically — it never comes out of your revenue. Legal in all 50 states with proper signage and receipts.*</p>
                  <Link href="/0-percent-processing" data-testid="link-cash-discount-cta-mobile">
                    <Button className="gap-2 w-full">Get My Savings Analysis <ArrowRight className="w-4 h-4" /></Button>
                  </Link>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="surcharging" className="border-b border-border last:border-0" data-testid="card-surcharging-mobile">
                <AccordionTrigger className="px-4 py-3 hover:no-underline [&>svg]:shrink-0">
                  <div className="text-left mr-2">
                    <div className="font-display font-semibold text-foreground">Pass Card Fees to Customers</div>
                    <div className="text-xs text-muted-foreground font-normal mt-0.5">A clearly disclosed fee on eligible credit card sales — we verify your state before recommending this</div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4">
                  <p className="text-sm text-muted-foreground mb-4">A disclosed fee appears on eligible credit card transactions at checkout. We handle state eligibility checks, card-brand notices, compliant receipts, and signage.*</p>
                  <Link href="/0-percent-processing" data-testid="link-surcharging-cta-mobile">
                    <Button variant="outline" className="gap-2 w-full">Get My Savings Analysis <ArrowRight className="w-4 h-4" /></Button>
                  </Link>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="interchange-plus" className="border-b border-border last:border-0" data-testid="card-interchange-plus-mobile">
                <AccordionTrigger className="px-4 py-3 hover:no-underline [&>svg]:shrink-0">
                  <div className="text-left mr-2">
                    <div className="font-display font-semibold text-foreground">Interchange Plus</div>
                    <div className="text-xs text-muted-foreground font-normal mt-0.5">Keep one price for all customers — pay the actual card-network rate + a small visible markup</div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4">
                  <p className="text-sm text-muted-foreground mb-4">No bundled tiers. No mystery fees. You see every penny of markup on every transaction — and we'll show you how your current rate compares before you decide.*</p>
                  <Link href="/compare-rates" data-testid="link-interchange-cta-mobile">
                    <Button variant="outline" className="gap-2 w-full">Get My Rate Comparison <ArrowRight className="w-4 h-4" /></Button>
                  </Link>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {/* Desktop: three-column Card grid — unchanged */}
            <div className="reveal hidden md:grid md:grid-cols-3 gap-6 items-stretch">
              <Card className="relative overflow-visible h-full flex flex-col border-emerald-500/40 shadow-card-hover" data-testid="card-cash-discount">
                <div className="absolute -top-3 left-4">
                  <span className="bg-emerald-600 text-white text-xs font-semibold px-3 py-1 rounded-md">Widest Availability</span>
                </div>
                <CardHeader className="gap-1">
                  <span className="report-chip report-chip-neutral w-fit">Pay $0 in card fees · All 50 states</span>
                  <CardTitle className="text-lg">Cash Discount</CardTitle>
                  <CardDescription>Your cash price is your posted price. Processing cost is covered automatically — your revenue stays the same regardless of payment method.</CardDescription>
                </CardHeader>
                <CardContent className="flex-1">
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Legal in all 50 states</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Compliant signage + receipts provided</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Staff script included</li>
                  </ul>
                  <div className="mt-4 rounded-md border border-border bg-card px-3 py-2">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">Your processing cost</div>
                    <div className="num text-sm font-semibold text-emerald-600">Eliminated, when eligible*</div>
                  </div>
                </CardContent>
                <CardFooter>
                  <Link href="/0-percent-processing" data-testid="link-cash-discount-cta">
                    <Button className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600">
                      Get My Savings Analysis
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </CardFooter>
              </Card>

              <Card className="relative overflow-visible h-full flex flex-col border-sky-500/30" data-testid="card-surcharging">
                <div className="absolute -top-3 left-4">
                  <span className="bg-sky-600 text-white text-xs font-semibold px-3 py-1 rounded-md">Most States</span>
                </div>
                <CardHeader className="gap-1">
                  <span className="report-chip report-chip-neutral w-fit">Pass card fees to customers · B2B &amp; high ticket</span>
                  <CardTitle className="text-lg">Compliant Surcharging</CardTitle>
                  <CardDescription>A clearly disclosed fee appears on eligible credit card sales at checkout. State law and card brand rules govern where this applies — we verify before setup.</CardDescription>
                </CardHeader>
                <CardContent className="flex-1">
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Required card-brand notices handled for you</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> State eligibility confirmed before enrollment</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Compliant receipts + checkout disclosures</li>
                  </ul>
                  <div className="mt-4 rounded-md border border-border bg-card px-3 py-2">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">Your processing cost</div>
                    <div className="num text-sm font-semibold text-sky-600">$0 out of your revenue*</div>
                  </div>
                </CardContent>
                <CardFooter>
                  <Link href="/0-percent-processing" data-testid="link-surcharging-cta">
                    <Button variant="outline" className="gap-2 border-sky-500/50 text-sky-700 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-950/20">
                      Get My Savings Analysis
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </CardFooter>
              </Card>

              <Card className="h-full flex flex-col" data-testid="card-interchange-plus">
                <CardHeader className="gap-1">
                  <span className="report-chip report-chip-neutral w-fit">Full rate transparency — no hidden markup</span>
                  <CardTitle className="text-lg">Interchange Plus</CardTitle>
                  <CardDescription>Pay the actual card-network cost plus a small transparent markup. You see every penny — no bundled tiers, no guessing what you're actually paying.</CardDescription>
                </CardHeader>
                <CardContent className="flex-1">
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Real interchange passthrough — no tiers</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Full statement transparency on every charge</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> Compare your current effective rate for free</li>
                  </ul>
                  <div className="mt-4 rounded-md border border-border bg-card px-3 py-2">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">Illustrative structure</div>
                    <div className="num text-sm font-semibold text-foreground">Interchange + 0.25%<span className="font-normal text-muted-foreground"> / transaction*</span></div>
                  </div>
                </CardContent>
                <CardFooter>
                  <Link href="/compare-rates" data-testid="link-interchange-cta">
                    <Button variant="outline" className="gap-2">
                      Get My Rate Comparison
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </CardFooter>
              </Card>
            </div>
            <p className="text-center text-xs text-muted-foreground md:text-white/60 mt-6" data-testid="text-choose-path-footnote">
              *Eligibility, underwriting, card brand rules, and applicable laws apply. No savings claims without statement review.
            </p>
          </div>
        </section>

        {/* SECTION 8: Vertical Credibility */}
        <section className="section-warm py-12 md:py-20" data-testid="section-verticals">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="reveal text-center mb-12">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4" data-testid="text-verticals-heading">
                Built for Operators Who Run Real Businesses
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">South Florida roots. Nationwide reach. We know the cost pressures in your industry.</p>
            </div>
            {/* Mobile: flat compact icon list — no accordion, no expanded content */}
            <div className="md:hidden rounded-lg border border-border overflow-hidden mb-6" data-testid="accordion-verticals">
              {[
                { icon: UtensilsCrossed, title: "Restaurants", bestFor: "Tip-adjust + weekend volume" },
                { icon: Stethoscope, title: "Medical / Dental / Medspa", bestFor: "Front-desk speed + clean deposits" },
                { icon: Car, title: "Automotive", bestFor: "High-ticket + chargeback safety" },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 bg-card" data-testid={`vertical-mobile-${i}`}>
                  <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-display font-semibold text-foreground text-sm">{item.title}</div>
                    <div className="text-xs text-muted-foreground">Best For: {item.bestFor}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: three-column grid — unchanged */}
            <div className="reveal hidden lg:grid lg:grid-cols-3 gap-6 mb-6">
              {[
                { icon: UtensilsCrossed, title: "Restaurants", bestFor: "Tip-adjust + weekend volume", points: ["Fast tip-adjusted checkout that won't freeze on a Friday night", "Weekend support when your team actually needs it"] },
                { icon: Stethoscope, title: "Medical / Dental / Medspa", bestFor: "Front-desk speed + clean deposits", points: ["Predictable deposit clarity for the front desk", "HIPAA-aware workflows and fewer billing headaches"] },
                { icon: Car, title: "Automotive", bestFor: "High-ticket + chargeback safety", points: ["High-ticket transaction handling with predictable funding", "Chargeback prevention built into the workflow"] },
              ].map((item, i) => (
                <Card key={i} className="hover-elevate" data-testid={`card-vertical-featured-${i}`}>
                  <CardContent className="p-6">
                    <span className="report-chip report-chip-neutral">Best For: {item.bestFor}</span>
                    <div className="flex items-center gap-3 mt-4 mb-4">
                      <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                        <item.icon className="w-6 h-6 text-primary" />
                      </div>
                      <h3 className="text-lg font-display font-semibold text-foreground">{item.title}</h3>
                    </div>
                    <ul className="space-y-2">
                      {item.points.map((point, j) => (
                        <li key={j} className="text-sm text-muted-foreground flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                          {point}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
            {/* Secondary compact cards — desktop only */}
            <div className="hidden md:grid md:grid-cols-3 gap-4">
              {[
                { icon: Wrench, title: "Home Services", bestFor: "On-the-job mobile acceptance" },
                { icon: Store, title: "Retail", bestFor: "Fast lines + contactless" },
                { icon: Users, title: "Other Industries", bestFor: "Every vertical — the math is the math" },
              ].map((item, i) => (
                <Card key={i} className="hover-elevate" data-testid={`card-vertical-secondary-${i}`}>
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <item.icon className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-sm font-display font-semibold text-foreground">{item.title}</h3>
                      <p className="text-xs text-muted-foreground">Best For: {item.bestFor}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* SECTION 8.5: Why Liberty - Differentiators */}
        <div className="bg-background border-b border-border py-12 md:py-20" data-testid="section-why-liberty">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="reveal text-center mb-8">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4" data-testid="text-why-liberty-heading">
                Why Merchants Switch to Liberty
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">The differences you feel every day, not just on paper.</p>
            </div>

            {/* Mobile: compact rate teaser — replaces full rate-comparison card */}
            <div className="md:hidden mb-8 rounded-lg border border-primary/20 bg-background p-5" data-testid="section-why-liberty-mobile">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <DollarSign className="w-4 h-4 text-primary" />
                </div>
                <span className="text-sm font-display font-semibold text-foreground">What Do Most Merchants Pay?</span>
              </div>
              <p className="text-sm text-muted-foreground mb-3 leading-relaxed">
                On interchange-plus pricing, most merchants pay <strong className="num text-foreground">1.7%–2.3%</strong> all-in — vs. <strong className="num text-foreground">2.6%–3.5%+</strong> on flat-rate plans like Square or Stripe.
              </p>
              <Link href="/beat-square-stripe" className="inline-flex items-center gap-1.5 text-primary text-sm font-medium hover:underline" data-testid="link-rate-transparency-compare-mobile">
                See full processor comparison <ArrowRight className="w-3.5 h-3.5" />
              </Link>
              <p className="text-[10px] text-muted-foreground mt-2">*Illustrative. Actual rate depends on your card mix and volume. No savings claims without a statement review.</p>
            </div>
            {/* Desktop: full rate transparency card */}
            {/* Rate Transparency Callout */}
            <div className="hidden md:block reveal mb-12" data-testid="section-rate-transparency">
              <div className="max-w-3xl mx-auto bg-background border-2 border-primary/20 rounded-lg p-6 md:p-8">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <DollarSign className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <div className="accent-rule pt-3 mb-2 flex items-center justify-between gap-3">
                      <h3 className="text-lg font-display font-bold text-foreground" data-testid="text-rate-transparency-heading">
                        What Do Most Merchants Actually Pay?
                      </h3>
                      <span className="audit-stamp shrink-0">Illustrative</span>
                    </div>
                    <p className="text-muted-foreground text-sm mb-4 leading-relaxed">
                      On interchange-plus pricing, most merchants end up paying between <strong className="num text-foreground">1.7%–2.3%</strong> all-in — depending on their card mix and volume. That compares to <strong className="num text-foreground">2.6%–3.5%+</strong> on flat-rate plans like Square or Stripe.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                      {[
                        { label: "Restaurant (card-present)", range: "1.80–2.20%", note: "High debit, fast turns" },
                        { label: "Retail (mixed cards)", range: "1.75–2.15%", note: "Debit + credit mix" },
                        { label: "Services / B2B", range: "2.00–2.60%", note: "More rewards + keyed" },
                      ].map((item, i) => (
                        <div key={i} className="rounded-md border border-primary/15 bg-card p-3 text-center shadow-sm" data-testid={`text-rate-range-${i}`}>
                          <span className="report-chip report-chip-neutral mx-auto mb-2">{item.label}</span>
                          <div className="num text-lg font-display font-bold text-primary">{item.range}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">{item.note}</div>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      *Typical effective rate ranges for interchange-plus pricing. Actual rate depends on your card mix, transaction types, and volume — upload a statement for your exact number. No savings claims without a statement review.
                    </p>
                    <Link href="/beat-square-stripe" className="inline-flex items-center gap-1.5 text-primary text-sm font-medium mt-3 hover:underline" data-testid="link-rate-transparency-compare">
                      See full processor comparison <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </div>
              </div>
            </div>
            {/* Mobile: compact icon list — replaces 4 large padded cards */}
            <div className="md:hidden grid grid-cols-1 gap-3 mb-2">
              {[
                { icon: FileText, title: "Statement-Based Pricing", desc: "Priced off your actual statement — see exactly what changes." },
                { icon: Headphones, title: "Direct Human Support", desc: "A real person picks up the phone. No ticket queues." },
                { icon: Banknote, title: "Next-Day Funding*", desc: "Funds hit your account the next business day for qualifying merchants." },
                { icon: HandshakeIcon, title: "Month-to-Month Terms", desc: "No long-term lock-in. We earn your business every month." },
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3" data-testid={`card-why-liberty-mobile-${i}`}>
                  <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <item.icon className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground leading-snug mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop: full 4-column card grid */}
            <div className="hidden md:grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {[
                { icon: FileText, title: "Statement-Based Pricing", desc: "We price off your actual statement, not a generic quote. You see exactly what changes and why." },
                { icon: Headphones, title: "Direct Human Support", desc: "A real person picks up the phone. No ticket queues, no chatbots, no 3-day wait." },
                { icon: Banknote, title: "Next-Day Funding*", desc: "For qualifying merchants, funds hit your account the next business day. Cash flow you can count on." },
                { icon: HandshakeIcon, title: "Month-to-Month Terms", desc: "We earn your business every month. Standard processing terms apply — no long-term lock-in, no pressure." },
              ].map((item, i) => (
                <Card key={i} className="bg-primary/5 border-primary/15" data-testid={`card-why-liberty-${i}`}>
                  <CardContent className="p-6">
                    <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center mb-4">
                      <item.icon className="w-6 h-6 text-primary" />
                    </div>
                    <h3 className="font-display font-bold text-lg text-foreground mb-2">{item.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="text-center text-xs text-muted-foreground mt-6" data-testid="text-why-liberty-footnote">
              *Eligibility, underwriting, card brand rules, and applicable laws apply.
            </p>
          </div>
        </div>


        {/* SECTION 9: Social Proof / Reviews */}
        <section className="section-warm py-12 md:py-20" data-testid="section-reviews">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="reveal text-4xl md:text-5xl font-display font-bold text-foreground text-center mb-4" data-testid="text-reviews-heading">
              What Merchants Say After Their First Review
            </h2>
            <p className="text-center text-muted-foreground mb-12 max-w-xl mx-auto">Real business owners. Specific outcomes. Florida-based merchants you can relate to.</p>
            {/* Mobile: single strong testimonial */}
            <div className="md:hidden mb-6" data-testid="card-review-mobile-primary">
              <Card>
                <CardContent className="p-6 flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, j) => (
                        <Star key={j} className="w-5 h-5 fill-amber-400 text-amber-400" />
                      ))}
                    </div>
                    <span className="text-xs font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">0% program</span>
                  </div>
                  <Quote className="w-10 h-10 text-primary/15 mb-3" />
                  <p className="text-sm text-foreground mb-3 leading-relaxed">We uploaded our statement, and Liberty showed us exactly where our fees were coming from. We switched programs and our monthly processing cost dropped meaningfully. I wish I'd done it two years earlier.</p>
                  <p className="text-[10px] text-muted-foreground mb-4 leading-relaxed">* Individual outcomes vary. Based on documented statement review and merchant setup.</p>
                  <div className="flex items-center gap-3 pt-4 border-t border-border">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">M</div>
                    <div>
                      <div className="text-sm font-semibold text-foreground">Maria R.</div>
                      <div className="text-xs text-muted-foreground">Restaurant Owner · South Miami, FL</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Desktop: full three-column review grid */}
            <div className="reveal hidden md:grid md:grid-cols-3 gap-6 mb-10">
              {[
                {
                  quote: "We uploaded our statement and Liberty showed us exactly where our fees were coming from. We switched programs and our processing cost dropped meaningfully — I wish I'd done it two years earlier.",
                  name: "Maria R.",
                  role: "Restaurant Owner",
                  city: "South Miami, FL",
                  stars: 5,
                  highlight: "0% program",
                },
                {
                  quote: "Liberty Bancard pulled our statement apart line by line and found $127 a month in fees we never agreed to — PCI non-compliance charges, a regulatory fee, and a statement fee that appeared out of nowhere. The switch cleaned it all up.",
                  name: "Tony M.",
                  role: "Auto Repair Shop Owner",
                  city: "Broward County, FL",
                  stars: 5,
                  highlight: "Statement review",
                },
                {
                  quote: "We thought Stripe was our only option. Liberty Bancard showed us the exact markup we were paying on top of interchange and switched us to interchange-plus. We're saving meaningfully each month without touching our website.",
                  name: "David K.",
                  role: "Retail Store Owner",
                  city: "Boca Raton, FL",
                  stars: 5,
                  highlight: "Switched from Stripe",
                },
              ].map((review, i) => (
                <Card key={i} data-testid={`card-review-${i}`}>
                  <CardContent className="p-6 flex flex-col h-full">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex gap-0.5">
                        {Array.from({ length: review.stars }).map((_, j) => (
                          <Star key={j} className="w-5 h-5 fill-amber-400 text-amber-400" />
                        ))}
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full" data-testid={`text-review-highlight-${i}`}>{review.highlight}</span>
                    </div>
                    <Quote className="w-10 h-10 text-primary/15 mb-3" />
                    <p className="text-sm text-foreground mb-5 leading-relaxed flex-grow" data-testid={`text-review-quote-${i}`}>{review.quote}</p>
                    <div className="flex items-center gap-3 pt-4 border-t border-border">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                        {review.name.charAt(0)}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-foreground" data-testid={`text-review-name-${i}`}>{review.name}</div>
                        <div className="text-xs text-muted-foreground" data-testid={`text-review-role-${i}`}>{review.role} · {review.city}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            {/* Mobile: compact outcome CTA */}
            <div className="md:hidden mb-6 text-center">
              <Link href="/case-studies" data-testid="link-reviews-case-studies-mobile">
                <Button variant="outline" className="gap-2 w-full">
                  See documented case studies <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
            </div>
            {/* Desktop: documented outcome strip */}
            <div className="reveal hidden md:grid md:grid-cols-3 gap-4 mb-10" data-testid="grid-outcomes-strip">
              {[
                { type: "Full-Service Restaurant", solution: "Cash Discount Program", result: "$4,200/yr", href: "/case-studies#restaurant-square" },
                { type: "Multi-Location Retail", solution: "Interchange Plus", result: "$3,800/yr", href: "/case-studies#retail-stripe" },
                { type: "Medical Practice", solution: "Interchange Plus + Level 2", result: "$6,100/yr", href: "/case-studies#healthcare-bank" },
              ].map((o, i) => (
                <Link key={i} href={o.href} className="block hover-elevate rounded-lg" data-testid={`link-outcome-detail-${i}`}>
                  <div className="h-full rounded-lg border border-border bg-card p-4 shadow-card">
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <span className="text-xs font-semibold text-foreground" data-testid={`text-outcome-type-${i}`}>{o.type}</span>
                      <span className="num text-lg font-display font-bold text-emerald-600 dark:text-emerald-400" data-testid={`text-outcome-result-${i}`}>{o.result}</span>
                    </div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">{o.solution}</div>
                  </div>
                </Link>
              ))}
            </div>
            <p className="text-center text-xs text-muted-foreground mb-6">Documented case-study results. Individual outcomes vary by card mix, volume, and program eligibility.</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link href="/case-studies" data-testid="link-reviews-case-studies">
                <Button variant="outline" className="gap-2">
                  See the full breakdown in our case studies
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <Link href="/testimonials" data-testid="link-video-testimonials-all">
                <Button variant="ghost" className="gap-2">
                  Watch merchant stories
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* SECTION 10: Trust / Risk Reversal — sharp navy block */}
        <div className="reveal relative overflow-hidden bg-primary py-12 md:py-20" data-testid="section-risk-reversal">
          <img src={teamCollab} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full object-cover opacity-[0.15] mix-blend-luminosity" loading="lazy" width="1408" height="792" />
          <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" aria-hidden="true" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="max-w-3xl mx-auto text-center">
              <ShieldCheck className="w-14 h-14 text-sky-300 mx-auto mb-6" />
              <h2 className="text-4xl md:text-5xl font-bold text-white mb-6" data-testid="text-risk-reversal-heading">
                Proof First. Pressure Never.
              </h2>
              <p className="text-lg text-white/80 leading-relaxed mb-4" data-testid="text-risk-reversal-body-1">
                We don't ask you to sign anything to get a statement review. We don't lock you into a contract to see your numbers. And if we can't find a meaningful improvement, we'll tell you.
              </p>
              <p className="text-white/70 leading-relaxed mb-8" data-testid="text-risk-reversal-body-2">
                You keep the line-item breakdown either way. Use it to negotiate with your current processor, share it with your accountant, or just understand what you're paying for the first time.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mb-8">
                {[
                  { icon: FileText, label: "No contract required" },
                  { icon: ShieldCheck, label: "Keep the breakdown" },
                  { icon: Scale, label: "Zero obligation" },
                  { icon: HandshakeIcon, label: "Cancel anytime, no fee" },
                ].map((item, i) => (
                  <div key={i} className="flex flex-col items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-5" data-testid={`trust-signal-${i}`}>
                    <div className="w-11 h-11 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center">
                      <item.icon className="w-5 h-5 text-sky-300" />
                    </div>
                    <span className="text-sm font-medium text-white">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>


        {/* SECTION 11: FAQ */}
        <div className="section-warm py-12 md:py-20" data-testid="section-faq">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="reveal max-w-3xl mx-auto">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-8" data-testid="text-faq-heading">
                Common Questions
              </h2>
              <Accordion type="single" collapsible className="w-full" data-testid="accordion-faq">
                <AccordionItem value="q1" data-testid="faq-item-0">
                  <AccordionTrigger data-testid="faq-trigger-0">Do I have to switch processors to get the breakdown?</AccordionTrigger>
                  <AccordionContent data-testid="faq-content-0">
                    No. The statement review is how we prove your real cost. You keep the breakdown either way - no strings attached. Many merchants use it to have a more informed conversation with their current processor.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="q2" data-testid="faq-item-1">
                  <AccordionTrigger data-testid="faq-trigger-1">Is my statement secure?</AccordionTrigger>
                  <AccordionContent data-testid="faq-content-1">
                    Yes. Upload a PDF or photo. Redact account numbers if you want - totals and fee lines are all we need. We never store full card numbers, SSNs, or bank account numbers.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="q3" data-testid="faq-item-2">
                  <AccordionTrigger data-testid="faq-trigger-2">How fast do I get results?</AccordionTrigger>
                  <AccordionContent data-testid="faq-content-2">
                    Most reviews are completed during business hours the same day. If you need priority turnaround,{" "}
                    <a href={CALENDAR_URL} target="_blank" rel="noopener noreferrer" className="underline font-medium">book a 10-minute call</a>{" "}
                    and let us know your timeline.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="q4" data-testid="faq-item-3">
                  <AccordionTrigger data-testid="faq-trigger-3">What if I don't have my statement handy?</AccordionTrigger>
                  <AccordionContent data-testid="faq-content-3">
                    Use our <a href="/estimate" className="text-primary font-medium underline">Quick Estimate tool</a> to get a rough effective rate right now. For the complete picture with line-item detail, upload a statement when you have it.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="q5" data-testid="faq-item-4">
                  <AccordionTrigger data-testid="faq-trigger-4">I'm on Square or Stripe. Can you still help?</AccordionTrigger>
                  <AccordionContent data-testid="faq-content-4">
                    Absolutely. We'll compare apples-to-apples using your actual numbers. Many businesses processing over $10k/month find that flat-rate pricing costs significantly more than interchange-plus. <a href="/beat-square-stripe" className="text-primary font-medium underline">See the comparison</a>.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="q6" data-testid="faq-item-5">
                  <AccordionTrigger data-testid="faq-trigger-5">Is "0% processing" actually legal?</AccordionTrigger>
                  <AccordionContent data-testid="faq-content-5">
                    "0%" programs have rules. We only recommend compliant cash discount or surcharging programs where permitted by law and appropriate for your business model. We handle disclosures, receipt formatting, and staff scripts. <a href="/0-percent-processing" className="text-primary font-medium underline">Learn more</a>.
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </div>
        </div>

        {/* Compare by Processor — crawlable internal link row */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 border-t border-border" data-testid="section-compare-links">
          <p className="text-sm text-muted-foreground mb-3 font-medium">Compare by processor:</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/compare/square" className="text-primary hover:underline" data-testid="link-compare-square">Liberty vs Square</Link>
            <Link href="/compare/stripe" className="text-primary hover:underline" data-testid="link-compare-stripe">Liberty vs Stripe</Link>
            <Link href="/compare/clover" className="text-primary hover:underline" data-testid="link-compare-clover">Liberty vs Clover</Link>
            <Link href="/compare/toast" className="text-primary hover:underline" data-testid="link-compare-toast">Liberty vs Toast</Link>
            <Link href="/compare/paypal" className="text-primary hover:underline" data-testid="link-compare-paypal">Liberty vs PayPal</Link>
          </div>
        </div>

        {/* SECTION 11.5: Quick Callback Form */}
        <div className="section-warm py-12 md:py-20 pb-safe-mobile" data-testid="section-callback">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="reveal grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
              <div>
                <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4" data-testid="text-callback-heading">
                  Rather Talk It Through?
                </h2>
                <p className="text-muted-foreground mb-6 leading-relaxed">
                  Drop your number. A real person calls you back — no call center, no script, no pitch.
                </p>
                <div className="space-y-3 mb-6">
                  {[
                    "10 minutes or less",
                    "Real person, not a call center",
                    "No obligation, no follow-up pressure",
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm text-foreground">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                      {item}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Or call us directly: <a href={PHONE_TEL} className="text-primary font-medium" data-testid="link-callback-phone" onClick={() => trackPhoneCallClick({ sourcePage: "/" })}>{PHONE_NUMBER}</a>
                </p>
              </div>
              <div>
                {cbSubmitted ? (
                  <Card className="border-2 border-emerald-200 dark:border-emerald-800">
                    <CardContent className="p-8 text-center">
                      <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
                      <h3 className="text-xl font-display font-bold text-foreground mb-2" data-testid="text-callback-success">We'll Call You Back</h3>
                      <p className="text-muted-foreground text-sm">A Liberty advisor will reach out during your preferred window. No pressure, just answers.</p>
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="p-6 space-y-4">
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block" htmlFor="cb-name">Your Name</label>
                        <Input id="cb-name" placeholder="First and Last" value={cbName} onChange={(e) => setCbName(e.target.value)} data-testid="input-callback-name" />
                      </div>
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block" htmlFor="cb-phone">Phone Number</label>
                        <Input id="cb-phone" type="tel" placeholder="(555) 123-4567" value={cbPhone} onChange={(e) => setCbPhone(e.target.value)} data-testid="input-callback-phone" />
                      </div>
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">Best Time to Call</label>
                        <div className="grid grid-cols-3 gap-2">
                          {["Morning", "Afternoon", "Evening"].map((time) => (
                            <Button
                              key={time}
                              variant={cbBestTime === time ? "default" : "outline"}
                              size="sm"
                              onClick={() => setCbBestTime(time)}
                              className="toggle-elevate"
                              data-testid={`button-callback-time-${time.toLowerCase()}`}
                            >
                              {time}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <PewcCheckbox
                        checked={cbPewcConsent}
                        onCheckedChange={setCbPewcConsent}
                        id="cb-pewc-consent"
                      />
                      <Button className="w-full gap-2" onClick={handleCallbackSubmit} disabled={cbSubmitting || !cbName.trim() || !cbPhone.trim()} data-testid="button-callback-submit">
                        {cbSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
                        Request a Callback
                      </Button>
                      <p className="text-xs text-muted-foreground text-center">
                        By submitting, you agree to be contacted by Liberty Bancard. Consent is not required for service.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </div>
        </div>


        {/* SECTION 12: Final CTA — sharp navy block */}
        <section className="reveal relative overflow-hidden bg-primary pt-14 pb-20 md:py-24" data-testid="section-final-cta">
          <div className="absolute top-0 left-0 right-0 h-[3px] bg-accent" aria-hidden="true" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
              <div>
                <span className="num text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/90">Liberty Statement Review</span>
                <h2 className="text-4xl md:text-5xl font-bold text-white mb-4 mt-3" data-testid="text-final-cta-heading">
                  Your Statement Tells the Truth. Let's Read It Together.
                </h2>
                <p className="text-white/70 mb-6 max-w-xl">
                  30 seconds to upload. Most reviews finish the same business day. You keep the breakdown no matter what.
                </p>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/75">
                  <span className="inline-flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-sky-300" /> No obligation</span>
                  <span className="inline-flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-sky-300" /> No contract to see your numbers</span>
                  <span className="inline-flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-sky-300" /> Yours to keep</span>
                </div>
              </div>
              <div className="rounded-xl border border-white/15 bg-white/5 backdrop-blur-sm p-6 sm:p-8">
                <div className="flex items-center justify-between gap-3 mb-5">
                  <span className="text-sm font-semibold text-white">Start your review</span>
                  <span className="audit-stamp bg-white/10 text-sky-200 border-white/20">Free</span>
                </div>
                <div className="flex flex-col gap-3">
                  <Button asChild size="lg" className="w-full gap-2 bg-accent hover:bg-accent border-accent text-white" data-testid="link-final-upload" onClick={() => trackStatementUploadCtaClick({ page: "/", ctaLabel: "Get My Free Analysis", ctaLocation: "final-cta" })}>
                    <Link href="/upload-statement">
                      <Upload className="w-4 h-4" />
                      Get My Free Analysis
                      <ArrowRight className="w-4 h-4" />
                    </Link>
                  </Button>
                  <Button asChild size="lg" variant="outline" className="w-full gap-2 bg-transparent border-white/30 text-white hover:bg-white/10" data-testid="link-final-quiz">
                    <Link href="/get-started">
                      Take the 60-Second Quiz
                      <ArrowRight className="w-4 h-4" />
                    </Link>
                  </Button>
                </div>
                <p className="text-xs text-white/50 mt-5" data-testid="text-final-cta-microcopy">
                  Eligibility, underwriting, card brand rules, and applicable laws apply.
                </p>
              </div>
            </div>
          </div>
        </section>

      </main>

      <Footer />
    </div>
  );
}
