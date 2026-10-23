import { useRef, useState } from "react";
import { Link } from "wouter";
import { SEO } from "@/components/SEO";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { PublicHero } from "@/components/public/PublicHero";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { trackConversion } from "@/lib/analytics";
import {
  Users, DollarSign, TrendingUp, CheckCircle, ArrowRight, Briefcase,
  BookOpen, BarChart3, Shield, Handshake, Calculator, Copy,
  FileText, Download, Award, Star, Building2, UserCheck,
  ChevronRight, Zap, Clock, HeartHandshake, PhoneCall,
} from "lucide-react";

const whoIsItFor = [
  {
    icon: Building2,
    title: "Independent Sales Organizations (ISOs)",
    desc: "Already selling merchant services or payment solutions? Add Liberty Bancard to your portfolio and earn residuals on every account you bring.",
  },
  {
    icon: BookOpen,
    title: "CPAs & Bookkeepers",
    desc: "Your clients trust you with their financials. Help them reduce processing costs and earn recurring income for every merchant you refer.",
  },
  {
    icon: Briefcase,
    title: "Business Consultants",
    desc: "You advise businesses on operations and profitability. Payment processing savings are low-hanging fruit — and residuals are passive income.",
  },
  {
    icon: UserCheck,
    title: "Financial Advisors",
    desc: "Your clients run businesses. A free statement review is a high-value touchpoint that builds loyalty and generates income for you.",
  },
  {
    icon: Handshake,
    title: "Referral Partners",
    desc: "Know business owners who accept credit cards? You don't need payments expertise — just the introduction. We handle the rest.",
  },
  {
    icon: HeartHandshake,
    title: "Association & Chamber Leaders",
    desc: "Offer members access to preferential processing rates and earn residuals on every member that joins our program.",
  },
];

const programSteps = [
  { num: "01", title: "Apply", desc: "Complete the partner application. Our team reviews it and follows up with next steps." },
  { num: "02", title: "Get Your Referral Link & Code", desc: "Your unique tracking link automatically attributes every merchant you refer, so you get credit every time." },
  { num: "03", title: "Refer Merchants", desc: "Share your link, co-branded materials, or make direct introductions. Our team handles the sales process and statement review." },
  { num: "04", title: "Earn Residuals", desc: "When merchants activate, you earn a share of the processing revenue — every month, for the life of the account." },
];

const commissionStructure = [
  {
    tier: "Referral Partner",
    type: "referral",
    description: "Casual or occasional referrers",
    earn: "Flat bonus per activated merchant",
    example: "$200–$500 per merchant",
    badge: "Entry Level",
    badgeColor: "secondary" as const,
  },
  {
    tier: "ISO / Active Partner",
    type: "iso",
    description: "High-volume or dedicated referral partners",
    earn: "Residual revenue share",
    example: "30–50% of net processing revenue",
    badge: "Most Popular",
    badgeColor: "default" as const,
  },
  {
    tier: "White-Label / Strategic",
    type: "white-label",
    description: "Associations, platforms, or volume ISOs",
    earn: "Custom residual structure",
    example: "Negotiated individually",
    badge: "Enterprise",
    badgeColor: "outline" as const,
  },
];

const partnerBenefits = [
  { icon: BarChart3, title: "Real-Time Partner Dashboard", desc: "Track your referred merchants, commissions earned, and deal pipeline from a dedicated partner portal." },
  { icon: FileText, title: "Co-Branded Collateral", desc: "Pre-built one-pagers, comparison sheets, and digital assets ready to share — branded with your name or company." },
  { icon: PhoneCall, title: "Dedicated Partner Rep", desc: "You get a named Liberty Bancard contact who knows your business and handles your merchant escalations." },
  { icon: BookOpen, title: "Partner Training", desc: "Sales playbooks, objection handlers, and product training so you can speak to merchants with confidence." },
  { icon: Shield, title: "Compliance Support", desc: "We handle all underwriting, compliance, and card brand requirements. You just make the introduction." },
  { icon: Clock, title: "Monthly Residual Payments", desc: "Commissions are calculated at month-end and paid promptly via your preferred method." },
];

const isoFaqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How much can I earn as a Liberty Bancard ISO or referral partner?",
      acceptedAnswer: { "@type": "Answer", text: "Referral partners earn $200–$500 flat bonuses per activated merchant. ISO and active partners earn 30–50% of net monthly processing revenue for the life of each account. White-label and strategic partners have custom residual structures negotiated individually." },
    },
    {
      "@type": "Question",
      name: "Who qualifies for the Liberty Bancard partner program?",
      acceptedAnswer: { "@type": "Answer", text: "The program is designed for ISOs, CPAs, bookkeepers, business consultants, financial advisors, referral partners, and association and chamber leaders. You don't need payments expertise — just the introduction to a business owner who accepts credit cards." },
    },
    {
      "@type": "Question",
      name: "How does the referral tracking work?",
      acceptedAnswer: { "@type": "Answer", text: "Every partner receives a unique referral link and code. When a merchant applies through your link, they are automatically attributed to your account. You can track leads, deal status, and commissions from your partner portal in real time." },
    },
    {
      "@type": "Question",
      name: "When and how do partners get paid?",
      acceptedAnswer: { "@type": "Answer", text: "Commissions are calculated at month-end and paid within 15 business days of the close of each processing month. Residuals continue monthly for the life of each active merchant account." },
    },
    {
      "@type": "Question",
      name: "How long does the approval process take?",
      acceptedAnswer: { "@type": "Answer", text: "Our team reviews each partner application. After approval, your referral link and partner portal access are activated for your account." },
    },
  ],
};

const isoServiceJsonLd = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Liberty Bancard ISO & Referral Partner Program",
  description: "Earn 30–50% residual income for every merchant you refer to Liberty Bancard. Designed for ISOs, CPAs, bookkeepers, consultants, and financial advisors. Free to join, no volume minimums.",
  provider: { "@type": "Organization", name: "Liberty Bancard", url: "https://libertybancard.com" },
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free to join. No upfront cost. Residuals paid monthly." },
};

function ResidualCalculator() {
  const [merchants, setMerchants] = useState(10);
  const [avgVolume, setAvgVolume] = useState(30000);
  const [splitPercent, setSplitPercent] = useState(40);

  const estimatedMonthlyNetBps = 0.0030;
  const monthlyResidual = merchants * avgVolume * estimatedMonthlyNetBps * (splitPercent / 100);
  const annualResidual = monthlyResidual * 12;

  return (
    <div className="bg-primary/5 border border-primary/20 rounded-2xl p-6 md:p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Calculator className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="text-lg font-bold text-foreground">Partner Income Estimator</h3>
          <p className="text-sm text-muted-foreground">Estimate your monthly residual income</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        <div>
          <label htmlFor="partner-input-calc-merchants" className="block text-sm font-medium text-foreground mb-2">
            Number of Merchants
          </label>
          <Input className="min-h-11" id="partner-input-calc-merchants"
            type="number"
            min={1}
            max={500}
            value={merchants}
            onChange={e => setMerchants(Math.max(1, Number(e.target.value)))}
            data-testid="input-calc-merchants"
          />
          <p className="text-xs text-muted-foreground mt-1">How many merchant accounts you refer</p>
        </div>
        <div>
          <label htmlFor="partner-input-calc-volume" className="block text-sm font-medium text-foreground mb-2">
            Avg Monthly Volume ($)
          </label>
          <Input className="min-h-11" id="partner-input-calc-volume"
            type="number"
            min={1000}
            max={500000}
            step={1000}
            value={avgVolume}
            onChange={e => setAvgVolume(Math.max(1000, Number(e.target.value)))}
            data-testid="input-calc-volume"
          />
          <p className="text-xs text-muted-foreground mt-1">Per merchant, average monthly card sales</p>
        </div>
        <div>
          <label htmlFor="partner-select-calc-split" className="block text-sm font-medium text-foreground mb-2">
            Your Revenue Share (%)
          </label>
          <Select value={String(splitPercent)} onValueChange={v => setSplitPercent(Number(v))}>
            <SelectTrigger className="min-h-11" id="partner-select-calc-split" data-testid="select-calc-split">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10% — Referral Partner</SelectItem>
              <SelectItem value="20">20% — Active Partner</SelectItem>
              <SelectItem value="30">30% — ISO Partner</SelectItem>
              <SelectItem value="40">40% — ISO Partner+</SelectItem>
              <SelectItem value="50">50% — Senior ISO</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Based on your partner tier</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-background rounded-xl border border-border p-5 text-center">
          <p className="text-sm text-muted-foreground mb-1">Estimated Monthly Residual</p>
          <p className="text-3xl font-bold text-primary" data-testid="text-calc-monthly">
            ${monthlyResidual.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-muted-foreground mt-1">per month</p>
        </div>
        <div className="bg-background rounded-xl border border-border p-5 text-center">
          <p className="text-sm text-muted-foreground mb-1">Estimated Annual Residual</p>
          <p className="text-3xl font-bold text-green-600" data-testid="text-calc-annual">
            ${annualResidual.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-muted-foreground mt-1">per year</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-4 text-center">
        Estimates based on ~30 bps net processing revenue. Actual results vary by merchant mix, volume, and partner tier. Contact us for a personalized income projection.
      </p>
    </div>
  );
}

type FormView = "form" | "success";

export default function ISOPartnerProgram() {
  const { toast } = useToast();
  const [view, setView] = useState<FormView>("form");
  const [submitting, setSubmitting] = useState(false);
  const applyKey = useRef<string | null>(null);
  const [affiliateCode, setAffiliateCode] = useState("");
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    companyName: "",
    numberOfClients: "",
    referralType: "",
    password: "",
  });

  const handleSubmit = async () => {
    if (!form.firstName || !form.email || !form.phone || !form.referralType) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return;
    }
    if (!form.password || form.password.length < 6) {
      toast({ title: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }
    applyKey.current ??= crypto.randomUUID();
    setSubmitting(true);
    try {
      const res = await fetch("/api/partner-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": applyKey.current },
        body: JSON.stringify(form),
      });
      applyKey.current = null;
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.message || "Submission failed", variant: "destructive" });
        return;
      }
      trackConversion("iso_partner_apply", {
        referral_type: form.referralType,
        company: form.companyName,
      });
      setAffiliateCode(data.affiliateCode || "");
      setView("success");
    } catch {
      toast({ title: "Network error — please try again", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const referralLink = affiliateCode ? `${window.location.origin}?ref=${affiliateCode}` : "";

  const copyLink = () => {
    if (referralLink) {
      navigator.clipboard.writeText(referralLink);
      toast({ title: "Referral link copied!" });
    }
  };

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <SEO
        title="ISO & Partner Program — Earn Residuals | Liberty Bancard"
        description="Join the Liberty Bancard ISO and partner program. Earn 30–50% residual income for every merchant you refer. Designed for ISOs, CPAs, bookkeepers, consultants, and financial advisors."
        path="/partners"
        keywords="ISO partner program, referral partner program, merchant services residuals, payment processing partner, CPA referral income"
        structuredData={[isoFaqJsonLd, isoServiceJsonLd]}
      />
      <Navbar />
      <main className="marketing-surface flex-grow pt-28">

        {/* Hero */}
        <PublicHero
          headline="Earn Residual Income for Every Merchant You Refer"
          subheadline="Liberty Bancard's partner program is built for professionals who work with business owners — ISOs, CPAs, bookkeepers, consultants, and financial advisors. Refer merchants, earn residuals, and get paid every month for the life of the account."
          primaryCta={{ label: "Apply as a Partner", href: "#apply" }}
          secondaryCta={{ label: "Estimate My Income", href: "#calculator", icon: <Calculator className="w-4 h-4 shrink-0" /> }}
          tertiaryLinks={[{ label: "Partner Login", href: "/partner-portal" }]}
          badge={
            <Badge variant="outline" className="text-primary border-primary/30 bg-primary/5">
              ISO & Partner Program
            </Badge>
          }
          trustBadges={["Free to join", "No volume minimums", "Monthly residual payments", "Dedicated partner rep"]}
          data-testid="section-iso-hero"
        />

        {/* Who Is This For */}
        <section className="py-16 md:py-20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4">
                Who This Program Is For
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                This is not a casual affiliate program. It's a professional ISO and referral network for people who work closely with business owners and want recurring income for every merchant they refer.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {whoIsItFor.map((item) => {
                const Icon = item.icon;
                return (
                  <Card key={item.title} className="border-border/50 hover:border-primary/30 transition-colors">
                    <CardContent className="p-6">
                      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                        <Icon className="w-5 h-5 text-primary" />
                      </div>
                      <h3 className="font-semibold text-foreground mb-2">{item.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="py-16 md:py-20 bg-muted/30 border-y border-border/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4">
                How the Partner Program Works
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Four simple steps from application to residual income.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {programSteps.map((step) => (
                <div key={step.num} className="text-center">
                  <div className="w-14 h-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-bold mx-auto mb-4">
                    {step.num}
                  </div>
                  <h3 className="font-semibold text-foreground mb-2">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Commission Structure */}
        <section className="py-16 md:py-20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4">
                Commission & Residual Structure
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                We offer multiple partner tiers based on your volume and engagement. Serious ISO partners can earn 30–50% of net processing revenue — every month, for the life of the account.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              {commissionStructure.map((tier) => (
                <Card
                  key={tier.tier}
                  className={`border ${tier.type === "iso" ? "border-primary shadow-lg" : "border-border/50"}`}
                  data-testid={`card-tier-${tier.type}`}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base font-bold text-foreground">{tier.tier}</CardTitle>
                      <Badge variant={tier.badgeColor}>{tier.badge}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{tier.description}</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">How You Earn</p>
                      <p className="text-sm font-medium text-foreground">{tier.earn}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Typical Range</p>
                      <p className="text-sm font-semibold text-primary">{tier.example}</p>
                    </div>
                    <div className="pt-2">
                      <a href="#apply">
                        <Button
                          size="sm"
                          variant={tier.type === "iso" ? "default" : "outline"}
                          className="w-full gap-2"
                        >
                          Apply as this partner type <ChevronRight className="w-3.5 h-3.5" />
                        </Button>
                      </a>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="bg-muted/40 border border-border/40 rounded-xl p-5">
              <div className="flex items-start gap-3">
                <Star className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-foreground mb-1">ISO Revenue Share Example</p>
                  <p className="text-sm text-muted-foreground">
                    A portfolio of 20 merchants processing $30,000/month each = $600,000 total monthly volume. At ~30 bps net revenue and 40% partner split, that's <span className="font-semibold text-foreground">~$720/month in passive residuals</span> — $8,640/year — with no ongoing work required after onboarding.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* What Partners Get */}
        <section className="py-16 md:py-20 bg-muted/30 border-y border-border/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4">
                What Partners Receive
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                We invest in our partners. You get everything you need to refer merchants confidently and close deals efficiently.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {partnerBenefits.map((benefit) => {
                const Icon = benefit.icon;
                return (
                  <div key={benefit.title} className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-foreground mb-1">{benefit.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{benefit.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Calculator */}
        {/* scroll-mt-20 offsets the fixed navbar height so the section heading isn't obscured */}
        <section className="py-16 md:py-20 scroll-mt-20" id="calculator">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-10">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4">
                Estimate Your Monthly Residual Income
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Adjust the sliders to see how your income scales with your merchant portfolio.
              </p>
            </div>
            <ResidualCalculator />
          </div>
        </section>

        {/* Partner Application Form */}
        {/* scroll-mt-20 offsets the fixed navbar height so the section heading isn't obscured */}
        <section className="py-16 md:py-20 bg-muted/30 border-t border-border/30 scroll-mt-20" id="apply">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
            {view === "success" ? (
              <div className="text-center py-8">
                <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-6">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <h2 className="text-2xl font-display font-bold text-foreground mb-3">Application received</h2>
                <p className="text-muted-foreground mb-6">
                  Thank you for applying. Our team will review your application and follow up using the email you provided. Portal access depends on that review.
                </p>
                {affiliateCode && (
                  <div className="bg-background border border-border rounded-xl p-5 mb-6 text-left">
                    <p className="text-sm text-muted-foreground mb-1">Your Referral Link</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-sm font-mono text-foreground truncate">{referralLink}</code>
                      <Button size="sm" variant="outline" onClick={copyLink} className="shrink-0 gap-1.5" data-testid="button-copy-link-success">
                        <Copy className="w-3.5 h-3.5" /> Copy
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">Share this link with business owners. Every merchant who signs up through it will be attributed to you.</p>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  <Link href="/partner-portal">
                    <Button size="lg" className="gap-2 w-full sm:w-auto" data-testid="button-go-to-portal">
                      Go to Partner Portal <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="text-center mb-8">
                  <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-3">
                    Become a Partner
                  </h2>
                  <p className="text-muted-foreground">
                    Fill out the form below. Our team reviews each application and follows up.
                  </p>
                </div>
                <Card>
                  <CardContent className="p-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="partner-input-first-name" className="block text-sm font-medium text-foreground mb-1.5">
                          First Name <span className="text-red-500">*</span>
                        </label>
                        <Input className="min-h-11" id="partner-input-first-name"
                          value={form.firstName}
                          onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                          placeholder="Jane"
                          autoComplete="given-name" data-testid="input-first-name"
                        />
                      </div>
                      <div>
                        <label htmlFor="partner-input-last-name" className="block text-sm font-medium text-foreground mb-1.5">Last Name</label>
                        <Input className="min-h-11" id="partner-input-last-name"
                          value={form.lastName}
                          onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                          placeholder="Smith"
                          autoComplete="family-name" data-testid="input-last-name"
                        />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="partner-input-company" className="block text-sm font-medium text-foreground mb-1.5">
                        Company Name
                      </label>
                      <Input className="min-h-11" id="partner-input-company"
                        value={form.companyName}
                        onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
                        placeholder="Smith Financial Group"
                        autoComplete="organization" data-testid="input-company"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="partner-input-email" className="block text-sm font-medium text-foreground mb-1.5">
                          Email <span className="text-red-500">*</span>
                        </label>
                        <Input className="min-h-11" id="partner-input-email"
                          type="email"
                          value={form.email}
                          onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                          placeholder="jane@example.com"
                          autoComplete="email" data-testid="input-email"
                        />
                      </div>
                      <div>
                        <label htmlFor="partner-input-phone" className="block text-sm font-medium text-foreground mb-1.5">
                          Phone <span className="text-red-500">*</span>
                        </label>
                        <Input className="min-h-11" id="partner-input-phone"
                          type="tel"
                          value={form.phone}
                          onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                          placeholder="(555) 000-0000"
                          autoComplete="tel" data-testid="input-phone"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="partner-select-clients" className="block text-sm font-medium text-foreground mb-1.5">
                          Number of Business Clients
                        </label>
                        <Select value={form.numberOfClients} onValueChange={v => setForm(f => ({ ...f, numberOfClients: v }))}>
                          <SelectTrigger className="min-h-11" id="partner-select-clients" data-testid="select-clients">
                            <SelectValue placeholder="Select range" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1-10">1–10 clients</SelectItem>
                            <SelectItem value="11-25">11–25 clients</SelectItem>
                            <SelectItem value="26-50">26–50 clients</SelectItem>
                            <SelectItem value="51-100">51–100 clients</SelectItem>
                            <SelectItem value="100+">100+ clients</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label htmlFor="partner-select-partner-type" className="block text-sm font-medium text-foreground mb-1.5">
                          Partner Type <span className="text-red-500">*</span>
                        </label>
                        <Select value={form.referralType} onValueChange={v => setForm(f => ({ ...f, referralType: v }))}>
                          <SelectTrigger className="min-h-11" id="partner-select-partner-type" data-testid="select-partner-type">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="iso">ISO / Merchant Services</SelectItem>
                            <SelectItem value="referral">Referral Partner</SelectItem>
                            <SelectItem value="cpa">CPA / Accountant</SelectItem>
                            <SelectItem value="bookkeeper">Bookkeeper</SelectItem>
                            <SelectItem value="consultant">Business Consultant</SelectItem>
                            <SelectItem value="white-label">White-Label / Strategic</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div>
                      <label htmlFor="partner-input-password" className="block text-sm font-medium text-foreground mb-1.5">
                        Create Password <span className="text-red-500">*</span>
                      </label>
                      <Input className="min-h-11" id="partner-input-password"
                        type="password"
                        value={form.password}
                        onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                        placeholder="Minimum 6 characters"
                        autoComplete="new-password" data-testid="input-password"
                      />
                      <p className="text-xs text-muted-foreground mt-1">Used to access your partner dashboard after approval.</p>
                    </div>
                    <Button
                      className="w-full gap-2 mt-2"
                      size="lg"
                      onClick={handleSubmit}
                      disabled={submitting}
                      data-testid="button-submit-application"
                    >
                      {submitting ? "Submitting..." : "Submit Partner Application"}
                      {!submitting && <ArrowRight className="w-4 h-4" />}
                    </Button>
                    <p className="text-xs text-muted-foreground text-center">
                      Already have an account?{" "}
                      <Link href="/partner-portal" className="text-primary hover:underline" data-testid="link-partner-login">
                        Log in to your partner portal
                      </Link>
                    </p>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </section>

        {/* Partner by Profession */}
        <section className="py-16 md:py-20 border-t border-border/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-10">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4">
                Partner by Profession
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                We've built dedicated resources for the three most common non-ISO referrer types. If one of these fits your background, you'll find tailored copy, FAQs, and income estimates built specifically for you.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Link href="/partners/cpa">
                <div className="group border border-border/50 hover:border-primary/40 hover:shadow-md rounded-2xl p-7 transition-all cursor-pointer bg-background" data-testid="card-profession-cpa">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/15 transition-colors">
                    <BookOpen className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-display font-bold text-lg text-foreground mb-2">CPAs & Accountants</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    You already review your clients' financials. Processing fees are often the largest overlooked cost. Refer clients, earn 30% lifetime residuals — no sales effort required.
                  </p>
                  <div className="flex items-center gap-1.5 text-primary text-sm font-medium">
                    Learn more <ChevronRight className="w-4 h-4" />
                  </div>
                </div>
              </Link>

              <Link href="/partners/bookkeeper">
                <div className="group border border-border/50 hover:border-primary/40 hover:shadow-md rounded-2xl p-7 transition-all cursor-pointer bg-background" data-testid="card-profession-bookkeeper">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/15 transition-colors">
                    <FileText className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-display font-bold text-lg text-foreground mb-2">Bookkeepers</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    You reconcile their statements every month — you see the fees firsthand. You're the most trusted advisor in the room. Turn that into recurring income.
                  </p>
                  <div className="flex items-center gap-1.5 text-primary text-sm font-medium">
                    Learn more <ChevronRight className="w-4 h-4" />
                  </div>
                </div>
              </Link>

              <Link href="/partners/insurance">
                <div className="group border border-border/50 hover:border-primary/40 hover:shadow-md rounded-2xl p-7 transition-all cursor-pointer bg-background" data-testid="card-profession-insurance">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/15 transition-colors">
                    <Shield className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-display font-bold text-lg text-foreground mb-2">Business Insurance Agents</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    You talk to every small business. Cash discount programs eliminate processing fees for your clients — a natural conversation starter that earns you 30% monthly residuals.
                  </p>
                  <div className="flex items-center gap-1.5 text-primary text-sm font-medium">
                    Learn more <ChevronRight className="w-4 h-4" />
                  </div>
                </div>
              </Link>
            </div>
          </div>
        </section>

        {/* CTA Banner */}
        <section className="py-12 bg-primary text-primary-foreground">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <Award className="w-10 h-10 mx-auto mb-4 opacity-80" />
            <h2 className="text-4xl md:text-5xl font-display font-bold mb-3">
              Ready to Start Earning Residuals?
            </h2>
            <p className="text-primary-foreground/80 mb-6 max-w-xl mx-auto">
              Join Liberty Bancard's ISO and partner network. Apply today. Our team reviews every application and contacts you at the email you provide.
            </p>
            <a href="#apply">
              <Button
                size="lg"
                variant="secondary"
                className="gap-2"
                data-testid="button-cta-apply"
              >
                Apply to become a partner <ArrowRight className="w-4 h-4" />
              </Button>
            </a>
          </div>
        </section>

      </main>
      <Footer />
    </div>
  );
}
