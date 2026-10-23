import { useState, useEffect, useMemo, useRef } from "react";
import { useParams } from "wouter";
import { SEO } from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, CheckCircle, ArrowRight, UploadCloud, Calculator,
  FileText, Star, DollarSign, TrendingDown, ArrowLeft,
} from "lucide-react";

interface OrgBranding {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

type ViewMode = "landing" | "get-started" | "upload" | "calculator" | "success";

const INDUSTRIES = [
  { value: "restaurant", label: "Restaurant / Food Service", avgRate: 3.2 },
  { value: "retail", label: "Retail / Brick & Mortar", avgRate: 2.9 },
  { value: "healthcare", label: "Healthcare / Medical", avgRate: 3.1 },
  { value: "salon", label: "Salon / Spa / Beauty", avgRate: 3.3 },
  { value: "auto", label: "Auto Repair / Automotive", avgRate: 3.4 },
  { value: "professional", label: "Professional Services", avgRate: 3.5 },
  { value: "ecommerce", label: "E-Commerce / Online", avgRate: 3.6 },
  { value: "construction", label: "Construction / Trades", avgRate: 3.4 },
  { value: "other", label: "Other", avgRate: 3.2 },
];

const LIBERTY_RATE = 1.95;

export default function PartnerBrandedPage() {
  const { slug } = useParams<{ slug: string }>();
  const { toast } = useToast();

  const [org, setOrg] = useState<OrgBranding | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [view, setView] = useState<ViewMode>("landing");
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    companyName: "",
    monthlyVolume: "",
  });
  // Idempotency key for statement upload: generated once per mount, reused on retry, rotated on success.
  const [uploadIdempotencyKey, setUploadIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  // Calculator state
  const [calcVolume, setCalcVolume] = useState("");
  const [calcRate, setCalcRate] = useState("");
  const [calcTicket, setCalcTicket] = useState("");
  const [calcIndustry, setCalcIndustry] = useState("restaurant");

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/partner-org/${slug}/branding`)
      .then(r => { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then(data => { setOrg(data); setLoading(false); })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [slug]);

  const primaryColor = org?.primaryColor || "#2563eb";

  const savings = useMemo(() => {
    const volume = parseFloat(calcVolume) || 0;
    const rate = parseFloat(calcRate) || 0;
    const ticket = parseFloat(calcTicket) || 0;
    if (volume === 0) return null;
    const industryData = INDUSTRIES.find(i => i.value === calcIndustry) || INDUSTRIES[0];
    const effectiveRate = rate > 0 ? rate : industryData.avgRate;
    if (effectiveRate <= LIBERTY_RATE) return null;
    const currentFees = Math.round(volume * effectiveRate / 100);
    const libertyFees = Math.round(volume * LIBERTY_RATE / 100);
    const monthly = currentFees - libertyFees;
    const txns = ticket > 0 ? Math.round(volume / ticket) : null;
    return { currentFees, libertyFees, monthly, annual: monthly * 12, effectiveRate, txns };
  }, [calcVolume, calcRate, calcTicket, calcIndustry]);

  // One key per attempt; kept across network errors so a retry is a replay, rotated after any server answer.
  const submissionKey = useRef<string | null>(null);
  const handleSubmit = async () => {
    if (!form.firstName || !form.email || !form.phone) {
      toast({ title: "Please fill in the required fields", variant: "destructive" });
      return;
    }
    submissionKey.current ??= crypto.randomUUID();
    setSubmitting(true);
    try {
      const res = await fetch("/api/contacts/public", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": submissionKey.current },
        body: JSON.stringify({
          ...form,
          utmSource: "partner_portal",
          utmMedium: "white_label",
          utmCampaign: slug,
          partnerOrgId: org?.id,
          tags: ["partner_portal", `partner_${slug}`],
          status: "New",
        }),
      });
      submissionKey.current = null;
      if (res.ok) {
        setView("success");
      } else {
        const data = await res.json();
        toast({ title: data.message || "Submission failed", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error — please try again", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !form.email) {
      toast({ title: "Please enter your email before uploading", variant: "destructive" });
      return;
    }
    if (submitting) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("email", form.email);
    fd.append("partnerOrgId", String(org?.id || ""));
    fd.append("partnerSlug", slug || "");
    setSubmitting(true);
    try {
      const res = await fetch("/api/statements/upload", {
        method: "POST",
        headers: { "Idempotency-Key": uploadIdempotencyKey },
        body: fd,
      });
      if (res.ok) {
        setView("success");
        // Rotate key after success so next upload is a new logical operation
        setUploadIdempotencyKey(crypto.randomUUID());
        toast({ title: "Statement uploaded! We'll prepare your savings analysis." });
      } else {
        toast({ title: "Upload failed — please try again", variant: "destructive" });
        // Keep same key on error so retry is deduplicated
      }
    } catch {
      toast({ title: "Upload failed — please try again", variant: "destructive" });
      // Keep same key on error so retry is deduplicated
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (notFound || !org) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center px-4">
        <h1 className="text-2xl font-bold mb-3">Partner Portal Not Found</h1>
        <p className="text-gray-500 mb-6">This partner portal doesn't exist or is no longer active.</p>
        <a href="/" className="text-blue-600 underline">Return to Liberty Bancard</a>
      </div>
    );
  }

  const brandedBtn = `inline-flex items-center justify-center gap-2 rounded-md px-5 py-2.5 font-semibold text-white transition-all hover:opacity-90 active:opacity-80`;

  return (
    <div className="min-h-screen bg-gray-50">
      <SEO
        title={`${org.name} — Free Merchant Savings Analysis`}
        description={`Save 20–40% on credit card processing fees. Get your free analysis through ${org.name} powered by Liberty Bancard.`}
        path={`/partner/${slug}`}
        noindex={true}
      />

      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {org.logoUrl ? (
              <img src={org.logoUrl} alt={org.name} className="h-9 w-auto object-contain" />
            ) : (
              <div
                className="h-9 px-4 flex items-center rounded-md font-bold text-white text-sm"
                style={{ backgroundColor: primaryColor }}
              >
                {org.name}
              </div>
            )}
            <span className="text-xs text-gray-400 hidden sm:block">powered by Liberty Bancard</span>
          </div>
          <button
            className={brandedBtn}
            style={{ backgroundColor: primaryColor }}
            onClick={() => setView("get-started")}
            data-testid="button-header-get-started"
          >
            Get My Free Analysis
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 sm:py-16">
        {view === "success" && (
          <div className="text-center py-20">
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h1 className="text-3xl font-bold text-gray-900 mb-3">You're all set!</h1>
            <p className="text-lg text-gray-600 max-w-md mx-auto">
              We've received your information and will prepare your personalized savings analysis within 24 hours.
            </p>
            <p className="text-sm text-gray-400 mt-4">Powered by Liberty Bancard</p>
          </div>
        )}

        {view === "landing" && (
          <>
            {/* Hero */}
            <div className="text-center mb-12">
              <div
                className="inline-block px-3 py-1 rounded-full text-xs font-semibold text-white mb-4"
                style={{ backgroundColor: primaryColor }}
                data-testid="badge-partner-name"
              >
                {org.name} Partner Portal
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-5 leading-tight">
                Stop Overpaying on<br />Credit Card Processing
              </h1>
              <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-8">
                Most businesses save 20–40% when they switch. Get your free, no-obligation savings analysis in minutes.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <button
                  className={`${brandedBtn} text-base px-7 py-3`}
                  style={{ backgroundColor: primaryColor }}
                  onClick={() => setView("get-started")}
                  data-testid="button-hero-get-started"
                >
                  Get My Free Analysis <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-md border-2 border-gray-300 px-7 py-3 font-semibold text-gray-700 hover:border-gray-400 transition-all text-base"
                  onClick={() => setView("calculator")}
                  data-testid="button-hero-calculator"
                >
                  <Calculator className="w-4 h-4" /> Savings Calculator
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-md border-2 border-gray-300 px-7 py-3 font-semibold text-gray-700 hover:border-gray-400 transition-all text-base"
                  onClick={() => setView("upload")}
                  data-testid="button-hero-upload"
                >
                  <UploadCloud className="w-4 h-4" /> Upload Statement
                </button>
              </div>
            </div>

            {/* Social proof */}
            <div className="flex justify-center gap-1 mb-10">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="w-5 h-5 fill-yellow-400 text-yellow-400" />
              ))}
              <span className="text-sm text-gray-500 ml-2">Trusted by 2,000+ merchants nationwide</span>
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-14">
              {[
                { icon: Calculator, title: "Instant Savings Estimate", desc: "Enter your volume and current rate — see your savings in seconds.", action: () => setView("calculator"), cta: "Try Calculator" },
                { icon: FileText, title: "Statement Review", desc: "Upload your current processor statement and we'll find every hidden fee.", action: () => setView("upload"), cta: "Upload Statement" },
                { icon: CheckCircle, title: "Zero Risk to Switch", desc: "No early termination risk. We handle the transition so your business never skips a beat.", action: () => setView("get-started"), cta: "Get Started" },
              ].map(({ icon: Icon, title, desc, action, cta }) => (
                <Card key={title} className="border-0 shadow-sm">
                  <CardContent className="p-6">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center mb-4"
                      style={{ backgroundColor: `${primaryColor}20` }}
                    >
                      <Icon className="w-5 h-5" style={{ color: primaryColor }} />
                    </div>
                    <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
                    <p className="text-sm text-gray-500 mb-4">{desc}</p>
                    <button
                      onClick={action}
                      className="text-sm font-semibold underline"
                      style={{ color: primaryColor }}
                    >
                      {cta} →
                    </button>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* CTA row */}
            <div
              className="rounded-2xl p-8 text-center text-white"
              style={{ backgroundColor: primaryColor }}
            >
              <h2 className="text-2xl font-bold mb-3">Ready to see your savings?</h2>
              <p className="mb-6 opacity-90">Takes under 2 minutes. No commitment required.</p>
              <button
                className="bg-white font-semibold px-7 py-3 rounded-md hover:bg-gray-50 transition-all"
                style={{ color: primaryColor }}
                onClick={() => setView("get-started")}
                data-testid="button-cta-get-started"
              >
                Start My Free Analysis
              </button>
            </div>
          </>
        )}

        {/* ── Savings Calculator ──────────────────────────────────────────────── */}
        {view === "calculator" && (
          <div className="max-w-3xl mx-auto">
            <button
              className="text-sm text-gray-500 hover:text-gray-700 mb-6 flex items-center gap-1"
              onClick={() => setView("landing")}
              data-testid="button-calculator-back"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <div className="text-center mb-8">
              <div
                className="inline-block px-3 py-1 rounded-full text-xs font-semibold text-white mb-3"
                style={{ backgroundColor: primaryColor }}
              >
                {org.name}
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Savings Calculator</h2>
              <p className="text-gray-500 text-sm">Enter your processing details to see how much you could save.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Input card */}
              <Card className="border-0 shadow-sm">
                <CardContent className="p-6 space-y-5">
                  <h3 className="font-semibold text-gray-900">Your Processing Details</h3>

                  <div className="space-y-2">
                    <Label htmlFor="calc-volume">Monthly Card Volume ($)</Label>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        id="calc-volume"
                        type="number"
                        inputMode="decimal"
                        placeholder="e.g. 25,000"
                        value={calcVolume}
                        onChange={e => setCalcVolume(e.target.value)}
                        className="pl-9"
                        data-testid="input-calc-volume"
                      />
                    </div>
                    <p className="text-xs text-gray-400">Total credit/debit card sales per month</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="calc-ticket">Average Ticket Size ($) <span className="text-gray-400">(optional)</span></Label>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        id="calc-ticket"
                        type="number"
                        inputMode="decimal"
                        placeholder="e.g. 45"
                        value={calcTicket}
                        onChange={e => setCalcTicket(e.target.value)}
                        className="pl-9"
                        data-testid="input-calc-ticket"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="calc-rate">Current Effective Rate (%) <span className="text-gray-400">(optional)</span></Label>
                    <Input
                      id="calc-rate"
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      placeholder="e.g. 3.2"
                      value={calcRate}
                      onChange={e => setCalcRate(e.target.value)}
                      data-testid="input-calc-rate"
                    />
                    <p className="text-xs text-gray-400">Leave blank to use your industry average</p>
                  </div>

                  <div className="space-y-2">
                    <Label>Industry</Label>
                    <Select value={calcIndustry} onValueChange={setCalcIndustry}>
                      <SelectTrigger data-testid="select-calc-industry">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INDUSTRIES.map(ind => (
                          <SelectItem key={ind.value} value={ind.value}>
                            {ind.label} (avg {ind.avgRate}%)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              {/* Results card */}
              <div className="space-y-5">
                {savings ? (
                  <>
                    <Card className="border-0 shadow-sm" style={{ borderTop: `3px solid ${primaryColor}` }}>
                      <CardContent className="p-6 space-y-4">
                        <h3 className="font-semibold text-gray-900">Your Estimated Savings</h3>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="bg-gray-50 rounded-lg p-4">
                            <p className="text-xs text-gray-500 mb-1">Current Monthly Fees</p>
                            <p className="text-2xl font-bold text-gray-900">${savings.currentFees.toLocaleString()}</p>
                            <p className="text-xs text-gray-400">at {savings.effectiveRate}%</p>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-4">
                            <p className="text-xs text-gray-500 mb-1">With Liberty Bancard*</p>
                            <p className="text-2xl font-bold text-green-600">${savings.libertyFees.toLocaleString()}</p>
                            <p className="text-xs text-gray-400">at ~{LIBERTY_RATE}%</p>
                          </div>
                        </div>
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center" data-testid="result-savings-summary">
                          <div className="flex items-center justify-center gap-2 mb-1">
                            <TrendingDown className="w-4 h-4 text-green-600" />
                            <p className="text-sm font-semibold text-green-700">Estimated Monthly Savings</p>
                          </div>
                          <p className="text-3xl font-bold text-green-600" data-testid="text-calc-monthly-savings">
                            ${savings.monthly.toLocaleString()}
                          </p>
                          <p className="text-sm font-semibold text-green-600/80 mt-1" data-testid="text-calc-annual-savings">
                            ${savings.annual.toLocaleString()} per year
                          </p>
                          {savings.txns && (
                            <p className="text-xs text-gray-400 mt-2">~{savings.txns.toLocaleString()} transactions/month</p>
                          )}
                        </div>
                        <p className="text-[10px] text-gray-400 leading-relaxed">
                          *Illustrative estimate. Actual rates depend on card mix, transaction types, and underwriting. No savings claims without a statement review.
                        </p>
                      </CardContent>
                    </Card>

                    <button
                      className={`${brandedBtn} w-full py-3`}
                      style={{ backgroundColor: primaryColor }}
                      onClick={() => setView("get-started")}
                      data-testid="button-calc-cta"
                    >
                      Get My Exact Savings Analysis <ArrowRight className="w-4 h-4" />
                    </button>
                    <button
                      className="w-full text-sm text-gray-500 underline hover:text-gray-700 text-center"
                      onClick={() => setView("upload")}
                      data-testid="button-calc-upload"
                    >
                      Or upload your statement for an exact breakdown
                    </button>
                  </>
                ) : (
                  <Card className="border-0 shadow-sm h-full" data-testid="card-calc-empty">
                    <CardContent className="p-8 text-center flex flex-col items-center justify-center h-full min-h-[280px]">
                      <div
                        className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
                        style={{ backgroundColor: `${primaryColor}15` }}
                      >
                        <Calculator className="w-7 h-7" style={{ color: primaryColor }} />
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">Enter Your Details</h3>
                      <p className="text-sm text-gray-500">
                        Fill in your monthly card volume to see how much you could save with Liberty Bancard's interchange-plus pricing.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Get Started Form ─────────────────────────────────────────────────── */}
        {view === "get-started" && (
          <div className="max-w-lg mx-auto">
            <button
              className="text-sm text-gray-500 hover:text-gray-700 mb-6 flex items-center gap-1"
              onClick={() => setView("landing")}
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <Card className="border-0 shadow-lg">
              <CardContent className="p-8">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                  style={{ backgroundColor: `${primaryColor}20` }}
                >
                  <FileText className="w-6 h-6" style={{ color: primaryColor }} />
                </div>
                <h2 className="text-2xl font-bold text-gray-900 mb-1">Get Your Free Analysis</h2>
                <p className="text-gray-500 text-sm mb-6">Fill in your info and we'll prepare a personalized savings report.</p>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="firstName">First Name *</Label>
                      <Input
                        id="firstName"
                        value={form.firstName}
                        onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                        placeholder="Jane"
                        data-testid="input-first-name"
                      />
                    </div>
                    <div>
                      <Label htmlFor="lastName">Last Name</Label>
                      <Input
                        id="lastName"
                        value={form.lastName}
                        onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                        placeholder="Smith"
                        data-testid="input-last-name"
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="email">Email *</Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="jane@mybusiness.com"
                      data-testid="input-email"
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone *</Label>
                    <Input
                      id="phone"
                      type="tel"
                      value={form.phone}
                      onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                      placeholder="(555) 000-0000"
                      data-testid="input-phone"
                    />
                  </div>
                  <div>
                    <Label htmlFor="companyName">Business Name</Label>
                    <Input
                      id="companyName"
                      value={form.companyName}
                      onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
                      placeholder="My Business LLC"
                      data-testid="input-company"
                    />
                  </div>
                  <div>
                    <Label htmlFor="monthlyVolume">Monthly Processing Volume (estimate)</Label>
                    <Input
                      id="monthlyVolume"
                      value={form.monthlyVolume}
                      onChange={e => setForm(f => ({ ...f, monthlyVolume: e.target.value }))}
                      placeholder="e.g. $25,000"
                      data-testid="input-volume"
                    />
                  </div>
                  <button
                    className={`${brandedBtn} w-full mt-2 py-3`}
                    style={{ backgroundColor: primaryColor }}
                    onClick={handleSubmit}
                    disabled={submitting}
                    data-testid="button-submit-form"
                  >
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Get My Free Analysis <ArrowRight className="w-4 h-4" /></>}
                  </button>
                  <p className="text-xs text-center text-gray-400">No commitment. No spam. We'll contact you within 24 hours.</p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Upload Statement ─────────────────────────────────────────────────── */}
        {view === "upload" && (
          <div className="max-w-lg mx-auto">
            <button
              className="text-sm text-gray-500 hover:text-gray-700 mb-6 flex items-center gap-1"
              onClick={() => setView("landing")}
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <Card className="border-0 shadow-lg">
              <CardContent className="p-8">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                  style={{ backgroundColor: `${primaryColor}20` }}
                >
                  <UploadCloud className="w-6 h-6" style={{ color: primaryColor }} />
                </div>
                <h2 className="text-2xl font-bold text-gray-900 mb-1">Upload Your Statement</h2>
                <p className="text-gray-500 text-sm mb-6">Upload your current processing statement and we'll identify every fee and savings opportunity.</p>

                <div className="space-y-4">
                  <div>
                    <Label htmlFor="upload-email">Your Email *</Label>
                    <Input
                      id="upload-email"
                      type="email"
                      value={form.email}
                      onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="jane@mybusiness.com"
                      data-testid="input-upload-email"
                    />
                  </div>
                  <div>
                    <Label htmlFor="upload-phone">Phone (optional)</Label>
                    <Input
                      id="upload-phone"
                      type="tel"
                      value={form.phone}
                      onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                      placeholder="(555) 000-0000"
                      data-testid="input-upload-phone"
                    />
                  </div>

                  <label
                    className="block border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-gray-400 transition-all"
                    htmlFor="statement-upload"
                    style={{ borderColor: form.email ? primaryColor : undefined }}
                    data-testid="label-upload-area"
                  >
                    <UploadCloud className="w-8 h-8 mx-auto mb-3 text-gray-400" />
                    <p className="text-sm font-medium text-gray-700">Click to upload your statement</p>
                    <p className="text-xs text-gray-400 mt-1">PDF, PNG, JPG — up to 10MB</p>
                    <input
                      id="statement-upload"
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg"
                      className="sr-only"
                      onChange={handleUpload}
                      disabled={submitting}
                      data-testid="input-file-upload"
                    />
                  </label>

                  {submitting && (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Uploading...
                    </div>
                  )}

                  <p className="text-xs text-center text-gray-400">We treat your statement as confidential. Reviewed by certified analysts only.</p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 mt-16 py-8 text-center text-xs text-gray-400">
        <p>
          {org.name} is a partner of{" "}
          <a href="https://libertybancard.com" className="underline hover:text-gray-600">Liberty Bancard</a>.
          All payment processing services provided by Liberty Bancard.
        </p>
        <div className="flex justify-center gap-4 mt-3">
          <a href="/privacy-policy" className="hover:text-gray-600">Privacy Policy</a>
          <a href="/terms" className="hover:text-gray-600">Terms of Service</a>
          <a href="/support" className="hover:text-gray-600">Contact Support</a>
        </div>
      </footer>
    </div>
  );
}
