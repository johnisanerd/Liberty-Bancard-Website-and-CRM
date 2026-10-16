import { useEffect, useState } from "react";
import { getCsrfToken } from "@/lib/queryClient";
import { trackStatementUploadStarted, trackStatementUploadFailed, trackBookingCtaClick } from "@/lib/tracking";
import { useFormAbandonment } from "@/hooks/use-form-abandonment";
import { SEO, getServiceSchema } from "@/components/SEO";
import { useLocation, Link } from "wouter";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import {
  FreeStatementReviewIntro,
  FreeStatementReviewSubmitGuidance,
  FreeStatementReviewDetails,
} from "@/components/FreeStatementReviewExplainer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { PewcCheckbox } from "@/components/PewcCheckbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useScrollReveal } from "@/hooks/use-scroll-reveal";
import { trackStatementUploadCompleted, trackFormSubmission } from "@/lib/tracking";
import { CALENDAR_URL, PHONE_TEL, PHONE_NUMBER } from "@/lib/constants";
import { trackConversion, trackPhoneCallClick } from "@/lib/analytics";
import { getStoredUTMParams } from "@/lib/utm";
import {
  FileSearch,
  ShieldCheck,
  Clock,
  Lock,
  Calendar,
  Loader2,
  CheckCircle2,
  Sparkles,
  AlertCircle,
  Phone,
  Monitor,
  Upload,
  ChevronRight,
  DollarSign,
  TrendingDown,
  Zap,
} from "lucide-react";

const uploadSchema = z.object({
  businessName: z.string().min(1, "Business name is required"),
  contactName: z.string().min(1, "Your name is required"),
  email: z.string().email("Valid email is required"),
  mobile: z.string().min(10, "Valid mobile number is required"),
  vertical: z.string().min(1, "Please select an industry"),
  fileName: z.string().optional(),
  currentProvider: z.string().optional(),
  interestedIn0Percent: z.boolean().default(false),
  needTerminal: z.boolean().default(false),
  notes: z.string().optional(),
  pewcConsent: z.boolean().optional().default(false),
});

type UploadFormData = z.infer<typeof uploadSchema>;

const WHAT_WE_REVIEW = [
  { label: "Your actual effective rate", note: "vs. what you were quoted" },
  { label: "Every fixed monthly fee", note: "PCI, batch, statement & service fees" },
  { label: "Interchange downgrades", note: "where certain cards cost you extra" },
  { label: "Your processor's markup", note: "what they earn above interchange" },
];

export default function UploadStatement() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const containerRef = useScrollReveal();
  const [analysisResult, setAnalysisResult] = useState<{
    effectiveRate?: string;
    recommendedPath?: string;
    keyFindings?: string[];
    overallAssessment?: string;
    [key: string]: unknown;
  } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisVolume, setAnalysisVolume] = useState("");
  const [analysisRate, setAnalysisRate] = useState("");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [processingStep, setProcessingStep] = useState<number>(0);
  const [analysisVertical, setAnalysisVertical] = useState("");
  const [uploadSucceeded, setUploadSucceeded] = useState(false);

  const PROCESSING_STEPS = [
    "Uploading your statement…",
    "Securing your file…",
    "Creating your deal record…",
    "Queuing AI analysis…",
    "Notifying your advisor…",
    "Almost done…",
  ];

  const params = new URLSearchParams(window.location.search);
  const preTerminal = params.get("terminal") === "yes";
  const preInterest0 = params.get("interest0") === "yes";

  const { data: authUser } = useQuery<{ email?: string; firstName?: string; lastName?: string; id?: string } | null>({
    queryKey: ["/api/auth/user"],
    queryFn: async () => {
      const res = await fetch("/api/auth/user", { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
  });

  const { data: merchantProfile } = useQuery<{ businessName?: string | null; contactId?: number } | null>({
    queryKey: ["/api/merchant-profile"],
    queryFn: async () => {
      const res = await fetch("/api/merchant-profile", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!authUser,
    staleTime: 1000 * 60 * 5,
  });

  const form = useForm<UploadFormData>({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      businessName: "",
      contactName: "",
      email: "",
      mobile: "",
      vertical: "",
      fileName: "",
      currentProvider: "",
      interestedIn0Percent: preInterest0,
      needTerminal: preTerminal,
      notes: "",
      pewcConsent: false,
    },
  });

  const { isDirty: formIsDirty } = form.formState;
  useFormAbandonment("upload_statement", formIsDirty && !uploadSucceeded);

  useEffect(() => {
    if (preTerminal) form.setValue("needTerminal", true);
    if (preInterest0) form.setValue("interestedIn0Percent", true);
  }, [preTerminal, preInterest0, form]);

  useEffect(() => {
    if (authUser) {
      const fullName = [authUser.firstName, authUser.lastName].filter(Boolean).join(" ");
      if (fullName && !form.getValues("contactName")) form.setValue("contactName", fullName);
      if (authUser.email && !form.getValues("email")) form.setValue("email", authUser.email);
    }
  }, [authUser, form]);

  useEffect(() => {
    if (merchantProfile?.businessName && !form.getValues("businessName")) {
      form.setValue("businessName", merchantProfile.businessName);
    }
  }, [merchantProfile, form]);

  const ANALYSIS_VERTICALS: { label: string; slug: string }[] = [
    { label: "Medical / Med Spa", slug: "med_spa" },
    { label: "Dental", slug: "dental" },
    { label: "Auto Repair", slug: "auto_repair" },
    { label: "Salon / Beauty", slug: "salon" },
    { label: "Gym / Fitness", slug: "gym" },
    { label: "Hotel / Lodging", slug: "hotel" },
    { label: "Landscaping", slug: "landscaping" },
    { label: "Construction", slug: "construction" },
    { label: "Legal", slug: "legal" },
  ];

  const FORM_TO_ANALYSIS_SLUG: Record<string, string> = {
    "Medical/Dental/Medspa": "med_spa",
    "Automotive": "auto_repair",
  };

  const formVerticalValue = form.watch("vertical");
  useEffect(() => {
    if (formVerticalValue && !analysisVertical) {
      const mapped = FORM_TO_ANALYSIS_SLUG[formVerticalValue];
      if (mapped) setAnalysisVertical(mapped);
    }
  }, [formVerticalValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Idempotency key: generated once per logical submission, reused on retries, cleared on success.
  const [submitIdempotencyKey, setSubmitIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const submitMutation = useMutation({
    mutationFn: (data: UploadFormData) => {
      const refCode = localStorage.getItem("lb_ref_code") || undefined;
      const utmParams = getStoredUTMParams();
      const gclidFromUrl = new URLSearchParams(window.location.search).get("gclid") || utmParams.gclid;
      const formData = new FormData();
      formData.append("businessName", data.businessName);
      formData.append("contactName", data.contactName);
      formData.append("email", data.email);
      formData.append("mobile", data.mobile);
      formData.append("vertical", data.vertical);
      if (data.currentProvider) formData.append("currentProvider", data.currentProvider);
      formData.append("interestedIn0Percent", String(data.interestedIn0Percent));
      formData.append("needTerminal", String(data.needTerminal));
      if (data.notes) formData.append("notes", data.notes);
      formData.append("pewcConsent", String(data.pewcConsent));
      if (refCode) formData.append("referralCode", refCode);
      if (gclidFromUrl) formData.append("gclid", gclidFromUrl);
      Object.entries(utmParams).forEach(([key, value]) => {
        if (value) formData.append(key, String(value));
      });
      if (selectedFile) formData.append("statementFile", selectedFile);

      return new Promise<unknown>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        xhr.open("POST", "/api/public/statement-upload");
        xhr.setRequestHeader("Idempotency-Key", submitIdempotencyKey);

        setIsUploading(true);
        setUploadProgress(0);
        setProcessingStep(0);

        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        });

        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            let step = 1;
            setProcessingStep(step);
            const stepInterval = setInterval(() => {
              step += 1;
              setProcessingStep(step);
              if (step >= 6) {
                clearInterval(stepInterval);
                setIsUploading(false);
                try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
              }
            }, 650);
          } else {
            setIsUploading(false);
            let message = "Upload failed";
            try {
              const body = JSON.parse(xhr.responseText);
              message = body.message || message;
            } catch { /* ignore */ }
            reject(new Error(`${xhr.status}: ${message}`));
          }
        });

        xhr.addEventListener("error", () => {
          setIsUploading(false);
          reject(new Error("Network error — please check your connection and try again."));
        });

        xhr.addEventListener("abort", () => {
          setIsUploading(false);
          reject(new Error("Upload was cancelled."));
        });

        xhr.send(formData);
      });
    },
    onSuccess: () => {
      trackStatementUploadCompleted({ page: "/upload-statement", ctaLocation: "form" });
      trackFormSubmission("statement_upload");
      trackConversion("statement_upload");
      setUploadSucceeded(true);
      // Rotate key so a future fresh submission gets a new idempotency key
      setSubmitIdempotencyKey(crypto.randomUUID());
    },
    onError: (error: Error) => {
      setUploadProgress(0);
      const msg = error?.message || "";
      trackStatementUploadFailed({ page: "/upload-statement", errorMessage: msg });
      if (msg.startsWith("429:")) {
        setSubmitError("Too many submissions — please wait a few minutes and try again.");
      } else if (/^5\d{2}:/.test(msg)) {
        setSubmitError("Something went wrong on our end — please try again shortly.");
      } else {
        setSubmitError(msg.replace(/^\d{3}:\s*/, "") || "Please try again or call us at 954-266-8214.");
      }
      // Keep the same idempotency key so a retry of the same logical submission is deduplicated
    },
  });

  const onSubmit = (data: UploadFormData) => {
    // Guard double-click: mutation is already pending
    if (submitMutation.isPending) return;
    setSubmitError(null);
    trackStatementUploadStarted({ page: "/upload-statement", ctaLocation: "form" });
    submitMutation.mutate(data);
  };

  const handleAnalysis = async () => {
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const analysisHeaders: Record<string, string> = { "Content-Type": "application/json" };
      const csrfAnalysis = getCsrfToken();
      if (csrfAnalysis) analysisHeaders["X-CSRF-Token"] = csrfAnalysis;
      const res = await fetch("/api/ai/analyze-statement", {
        method: "POST",
        headers: analysisHeaders,
        credentials: "include",
        body: JSON.stringify({
          statementData: `Monthly volume: $${analysisVolume}, Current effective rate: ${analysisRate}%, Processor type: unknown`,
          ...(analysisVertical ? { vertical: analysisVertical } : {}),
        }),
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error("Please log in to use the AI analysis feature.");
        throw new Error("Analysis failed. Please try again.");
      }
      const data = await res.json();
      if (data?.error) {
        setAnalysisError(data.message || "The AI analysis service is temporarily unavailable. Please try again later.");
      } else {
        setAnalysisResult(data);
      }
    } catch (err: any) {
      console.error(err);
      setAnalysisError(err.message || "Analysis failed. Please try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  const verticals = [
    "Medical/Dental/Medspa",
    "Automotive",
    "Restaurant",
    "Home Services",
    "Retail",
    "Other",
  ];

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <SEO
        title="Upload Your Processing Statement"
        description="Upload your merchant processing statement for a free, no-obligation rate analysis. See exactly where your fees are going."
        path="/upload-statement"
        keywords="upload processing statement, free statement review, merchant fee analysis"
        breadcrumbs={[{ name: "Upload Statement", path: "/upload-statement" }]}
        structuredData={[getServiceSchema("Free Statement Review", "Upload your merchant processing statement for a free, no-obligation rate analysis.", "/upload-statement")]}
      />
      <Navbar />

      <main className="flex-grow pt-20 pb-20 sm:pb-0" ref={containerRef}>

        {/* ═══════════════════════════════════════════════════
            PROMO STRIP — amber offer bar
        ═══════════════════════════════════════════════════ */}
        <div className="bg-amber-500 px-4 py-2.5 text-center" data-testid="promo-strip">
          <p className="text-xs font-bold text-white tracking-wide">
            🎁 Free payment terminal this month — with approved account.{" "}
            <span className="opacity-75 font-normal">Subject to eligibility &amp; equipment terms.</span>
          </p>
        </div>

        {/* ═══════════════════════════════════════════════════
            HERO — dark navy, high-energy, branded
        ═══════════════════════════════════════════════════ */}
        <section
          className="relative bg-[#0d1b2e] px-5 pt-10 pb-12 overflow-hidden"
          data-testid="section-upload-hero"
        >
          {/* Dot grid texture */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(circle, rgba(255,255,255,0.055) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
            }}
            aria-hidden="true"
          />
          {/* Accent glow top-right */}
          <div
            className="absolute -top-16 -right-16 w-64 h-64 bg-sky-500 opacity-[0.07] rounded-full blur-3xl pointer-events-none"
            aria-hidden="true"
          />
          {/* Accent glow bottom-left */}
          <div
            className="absolute -bottom-10 -left-10 w-48 h-48 bg-indigo-500 opacity-[0.06] rounded-full blur-2xl pointer-events-none"
            aria-hidden="true"
          />

          <div className="max-w-lg mx-auto relative">

            {/* Badge */}
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/15 px-3.5 py-1.5 mb-5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="text-[11px] font-bold text-white/90 tracking-wider uppercase">
                Free Statement Review
              </span>
            </div>

            {/* Headline */}
            <h1
              className="text-[34px] sm:text-4xl font-extrabold text-white leading-[1.08] mb-4 tracking-tight"
              data-testid="text-upload-heading"
            >
              Stop overpaying<br />for card processing.
            </h1>

            {/* Subheadline */}
            <p
              className="text-[15px] text-white/65 leading-relaxed mb-5"
              data-testid="text-upload-subheadline"
            >
              Upload your statement in 30 seconds — no processor login needed. We'll show your exact rate, every hidden fee, and where your money is going.
            </p>

            {/* Savings hook */}
            <div className="flex items-start gap-3 bg-emerald-500/15 border border-emerald-400/20 rounded-xl px-4 py-3.5 mb-6">
              <div className="w-8 h-8 rounded-full bg-emerald-400/20 flex items-center justify-center shrink-0 mt-0.5">
                <TrendingDown className="w-4 h-4 text-emerald-300" />
              </div>
              <div>
                <p className="text-sm font-bold text-emerald-300 leading-snug">
                  Most merchants we review save $600–$3,200/year
                </p>
                <p className="text-[11px] text-white/40 leading-snug mt-1">
                  Based on statement reviews completed. Actual savings depend on your volume, mix, and current rates.
                </p>
              </div>
            </div>

            {/* Primary CTA — white button on navy */}
            <a href="#upload-form" className="block mb-3" data-testid="link-hero-scroll-cta">
              <button
                className="w-full h-14 bg-white text-[#0d1b2e] font-extrabold text-base rounded-2xl shadow-xl flex items-center justify-center gap-2.5 hover:bg-white/95 active:scale-[0.98] transition-all"
                type="button"
              >
                <Upload className="w-5 h-5 shrink-0" />
                Get My Free Statement Review
              </button>
            </a>

            {/* Secondary CTA — book a call */}
            <a
              href={CALENDAR_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="block mb-6"
              data-testid="link-upload-hero-book"
              onClick={() =>
                trackBookingCtaClick({
                  page: "/upload-statement",
                  ctaLabel: "Book a 10-Min Review Call",
                  ctaLocation: "hero",
                })
              }
            >
              <button
                className="w-full h-12 border border-white/20 bg-white/5 text-white font-semibold text-sm rounded-2xl flex items-center justify-center gap-2 hover:bg-white/10 transition-all"
                type="button"
              >
                <Calendar className="w-4 h-4 shrink-0" />
                Book a 10-Min Review Call
              </button>
            </a>

            {/* Trust chips */}
            <div className="flex flex-wrap gap-2 mb-8" data-testid="trust-chips">
              {[
                { icon: ShieldCheck, label: "Free" },
                { icon: Clock, label: "~30 seconds" },
                { icon: Lock, label: "Secure upload" },
                { icon: CheckCircle2, label: "No processor login" },
              ].map(({ icon: Icon, label }) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/8 border border-white/12 px-3 py-1.5 text-[11px] font-medium text-white/75"
                  data-testid={`chip-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                >
                  <Icon className="w-3 h-3 shrink-0 text-sky-400" />
                  {label}
                </span>
              ))}
            </div>

            {/* Scroll hint */}
            <div className="flex justify-center">
              <a
                href="#upload-form"
                className="flex flex-col items-center gap-1 opacity-35 hover:opacity-60 transition-opacity"
                aria-label="Scroll to form"
              >
                <span className="text-[9px] text-white uppercase tracking-widest font-semibold">
                  Send us your statement
                </span>
                <ChevronRight className="w-4 h-4 text-white rotate-90" />
              </a>
            </div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════
            WHAT WE REVEAL + FREE TERMINAL OFFER
        ═══════════════════════════════════════════════════ */}
        <section className="bg-gray-50 px-5 py-6" data-testid="section-what-we-review">
          <div className="max-w-lg mx-auto space-y-4">

            {/* What we reveal card */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="bg-[#0d1b2e] px-4 py-2.5">
                <p className="text-[10px] font-bold tracking-widest text-white/55 uppercase">
                  What we reveal in your statement
                </p>
              </div>
              <ul className="divide-y divide-gray-100">
                {WHAT_WE_REVIEW.map(({ label, note }) => (
                  <li key={label} className="flex items-start gap-3 px-4 py-3">
                    <CheckCircle2 className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{note}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="bg-sky-50 border-t border-sky-100 px-4 py-2.5">
                <p className="text-[11px] text-sky-700 font-medium leading-snug">
                  You can redact account numbers — totals and fee lines are all we need. Your statement is never sold or shared.
                </p>
              </div>
            </div>

            {/* Quick fee-comparison card */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-[10px] font-bold tracking-widest text-gray-400 uppercase">
                  Where merchants overpay (by industry avg.)
                </p>
              </div>
              <div className="divide-y divide-gray-100">
                {[
                  { label: "Restaurants", rate: "2.8–3.5%", flag: "Surcharge opp." },
                  { label: "Medical / Dental", rate: "2.5–3.2%", flag: "High fixed fees" },
                  { label: "Retail / Salon", rate: "2.2–3.0%", flag: "Downgrade risk" },
                  { label: "Auto / Services", rate: "2.8–4.0%", flag: "Keyed-in markup" },
                ].map(({ label, rate, flag }) => (
                  <div key={label} className="flex items-center justify-between px-4 py-2.5 gap-3">
                    <span className="text-sm text-gray-700 font-medium">{label}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-bold text-red-500">{rate}</span>
                      <span className="text-[10px] bg-orange-100 text-orange-700 rounded px-1.5 py-0.5 font-medium whitespace-nowrap">{flag}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="bg-gray-50 border-t border-gray-100 px-4 py-2.5">
                <p className="text-[10px] text-gray-400 leading-snug">
                  Rates shown are illustrative industry averages, not a guarantee of savings. Upload your statement for an actual analysis.
                </p>
              </div>
            </div>

            {/* Free terminal promo */}
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl px-4 py-4">
              <div className="flex items-center gap-2 mb-2">
                <Monitor className="w-4 h-4 text-amber-600 shrink-0" />
                <p className="text-sm font-bold text-amber-800">Free Terminal This Month</p>
                <span className="ml-auto text-[9px] font-bold bg-amber-200 text-amber-800 rounded px-1.5 py-0.5 uppercase tracking-wide whitespace-nowrap">
                  Limited Offer
                </span>
              </div>
              <p className="text-[12px] text-amber-700 leading-snug mb-2">
                Approved new merchant accounts may qualify for a free payment terminal — no upfront equipment cost on eligible models.
              </p>
              <p className="text-[10px] text-amber-500 leading-snug">
                Subject to eligibility, credit approval, underwriting, equipment availability, and applicable card-brand and equipment terms. Ask your rep for details.
              </p>
            </div>

          </div>
        </section>

        <FreeStatementReviewIntro />
        <FreeStatementReviewSubmitGuidance />

        {/* ═══════════════════════════════════════════════════
            MAIN FORM
        ═══════════════════════════════════════════════════ */}
        <section
          id="upload-form"
          className="bg-white px-5 pt-7 pb-10"
          data-testid="section-upload-form"
        >
          <div className="max-w-lg mx-auto">

            {uploadSucceeded ? (
              /* ── SUCCESS STATE ── */
              <div className="text-center py-12 space-y-5" data-testid="section-upload-success">
                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="h-9 w-9 text-green-500" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2" data-testid="text-success-heading">
                    Statement Received!
                  </h2>
                  <p className="text-gray-500 max-w-sm mx-auto text-sm leading-relaxed">
                    Our AI is analyzing it now. A team member will follow up with your personalized savings report — typically within 1 business day.
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                  <span data-testid="text-analyzing">Analyzing your statement…</span>
                </div>
                <Button asChild variant="outline" className="rounded-xl" data-testid="button-view-portal">
                  <Link href="/merchant-portal">View My Portal</Link>
                </Button>
              </div>
            ) : (
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="space-y-4"
                  data-testid="form-upload-statement"
                >
                  {/* Form header */}
                  <div className="mb-2">
                    <p className="text-lg font-bold text-gray-900" data-testid="text-form-title">
                      Send us your statement
                    </p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      Takes about 30 seconds. We'll do the rest.
                    </p>
                  </div>

                  {/* ── Row: Business + Name ── */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="businessName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-gray-600">Business Name</FormLabel>
                          <FormControl>
                            <Input
                              className="h-12 text-base rounded-xl border-gray-200 focus:border-sky-500 focus:ring-sky-500"
                              placeholder="Your business"
                              data-testid="input-business-name"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="contactName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-gray-600">Your Name</FormLabel>
                          <FormControl>
                            <Input
                              className="h-12 text-base rounded-xl border-gray-200 focus:border-sky-500"
                              placeholder="Full name"
                              data-testid="input-contact-name"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* ── Row: Email + Mobile ── */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-gray-600">Email</FormLabel>
                          <FormControl>
                            <Input
                              type="email"
                              className="h-12 text-base rounded-xl border-gray-200 focus:border-sky-500"
                              placeholder="you@business.com"
                              data-testid="input-email"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="mobile"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-gray-600">Mobile</FormLabel>
                          <FormControl>
                            <Input
                              type="tel"
                              className="h-12 text-base rounded-xl border-gray-200 focus:border-sky-500"
                              placeholder="(555) 123-4567"
                              data-testid="input-mobile"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* ── Industry ── */}
                  <FormField
                    control={form.control}
                    name="vertical"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-600">Industry</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger
                              className="h-12 text-base rounded-xl border-gray-200 focus:border-sky-500"
                              data-testid="select-vertical"
                            >
                              <SelectValue placeholder="Select your industry" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {verticals.map((v) => (
                              <SelectItem
                                key={v}
                                value={v}
                                data-testid={`select-item-${v.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                              >
                                {v}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* ── File Upload — styled tap target ── */}
                  <FormField
                    control={form.control}
                    name="fileName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-600">
                          Statement <span className="text-gray-400 font-normal">(PDF or photo)</span>
                        </FormLabel>
                        <FormControl>
                          <label
                            className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed cursor-pointer transition-colors min-h-[100px] px-4 py-5
                              ${selectedFile
                                ? "border-sky-400 bg-sky-50"
                                : "border-gray-200 bg-gray-50 hover:border-sky-300 hover:bg-sky-50/50"
                              }`}
                            data-testid="label-file-upload"
                          >
                            <input
                              type="file"
                              accept=".pdf,.png,.jpg,.jpeg"
                              className="sr-only"
                              data-testid="input-file"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                field.onChange(file?.name || "");
                                setSelectedFile(file || null);
                              }}
                            />
                            {selectedFile ? (
                              <>
                                <CheckCircle2 className="w-7 h-7 text-sky-500" />
                                <span className="text-sm font-semibold text-sky-700 text-center break-all">
                                  {selectedFile.name}
                                </span>
                                <span className="text-xs text-sky-500">Tap to change file</span>
                              </>
                            ) : (
                              <>
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                                  <Upload className="w-5 h-5 text-gray-500" />
                                </div>
                                <span className="text-sm font-semibold text-gray-700">
                                  Tap to upload statement
                                </span>
                                <span className="text-xs text-gray-400">PDF, JPG, PNG — up to 10 MB</span>
                              </>
                            )}
                          </label>
                        </FormControl>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <Lock className="w-3 h-3 text-gray-400 shrink-0" />
                          <span className="text-[11px] text-gray-400" data-testid="text-secure-upload">
                            Encrypted upload — your statement is never sold or shared
                          </span>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* ── Current Provider (optional) ── */}
                  <FormField
                    control={form.control}
                    name="currentProvider"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-600">
                          Current provider <span className="text-gray-400 font-normal">(optional)</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            className="h-12 text-base rounded-xl border-gray-200"
                            placeholder="e.g. Square, Stripe, Clover"
                            data-testid="input-current-provider"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* ── Optional checkboxes ── */}
                  <div className="space-y-3 py-1">
                    <FormField
                      control={form.control}
                      name="interestedIn0Percent"
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-3">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              data-testid="checkbox-interested-0-percent"
                            />
                          </FormControl>
                          <FormLabel className="text-sm font-normal text-gray-600 leading-snug cursor-pointer">
                            Interested in a compliant 0% processing program?
                          </FormLabel>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="needTerminal"
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-3">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              data-testid="checkbox-need-terminal"
                            />
                          </FormControl>
                          <FormLabel className="text-sm font-normal text-gray-600 leading-snug cursor-pointer">
                            Do you need a terminal?
                          </FormLabel>
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* ── Notes ── */}
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-600">
                          Anything you want us to focus on?{" "}
                          <span className="text-gray-400 font-normal">(optional)</span>
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            className="text-base rounded-xl border-gray-200 resize-none"
                            placeholder="Tell us what matters most to you"
                            rows={3}
                            data-testid="textarea-notes"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* ── PEWC ── */}
                  <PewcCheckbox
                    checked={form.watch("pewcConsent") ?? false}
                    onCheckedChange={(val) => form.setValue("pewcConsent", val)}
                  />

                  {/* ── Error banner ── */}
                  {submitError && (
                    <div
                      className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
                      data-testid="alert-submit-error"
                      role="alert"
                    >
                      <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                      <p className="text-sm text-red-700">{submitError}</p>
                    </div>
                  )}

                  {/* ── Upload progress ── */}
                  {isUploading && (
                    <div
                      className="space-y-3 rounded-xl bg-gray-50 border border-gray-100 px-4 py-4"
                      data-testid="upload-progress-container"
                      role="status"
                      aria-label="Upload in progress"
                    >
                      {uploadProgress < 100 && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs text-gray-500">
                            <span className="flex items-center gap-1.5">
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" />
                              {PROCESSING_STEPS[0]}
                            </span>
                            <span data-testid="text-upload-progress-percent" className="font-semibold">
                              {uploadProgress}%
                            </span>
                          </div>
                          <div
                            className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden"
                            data-testid="upload-progress-bar-track"
                          >
                            <div
                              className="h-full rounded-full bg-sky-500 transition-all duration-200"
                              style={{ width: `${uploadProgress}%` }}
                              data-testid="upload-progress-bar-fill"
                            />
                          </div>
                        </div>
                      )}
                      {uploadProgress >= 100 && (
                        <div className="space-y-1.5" data-testid="upload-processing-steps">
                          {PROCESSING_STEPS.slice(1).map((label, idx) => {
                            const stepNum = idx + 1;
                            const done = processingStep > stepNum;
                            const active = processingStep === stepNum;
                            return (
                              <div
                                key={label}
                                className={`flex items-center gap-2 text-xs transition-all duration-300 ${done ? "text-green-600" : active ? "text-sky-600 font-medium" : "text-gray-400 opacity-50"}`}
                                data-testid={`step-processing-${stepNum}`}
                              >
                                {done ? (
                                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                ) : active ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                                ) : (
                                  <span className="w-3.5 h-3.5 shrink-0 rounded-full border border-gray-300 inline-block" />
                                )}
                                {label}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ══ PRIMARY SUBMIT CTA ══ */}
                  <Button
                    type="submit"
                    className="w-full h-14 text-base font-bold rounded-2xl bg-[#0d1b2e] hover:bg-[#162840] text-white shadow-lg shadow-gray-900/20 transition-all active:scale-[0.98]"
                    disabled={submitMutation.isPending || isUploading}
                    data-testid="button-upload-submit"
                  >
                    {submitMutation.isPending || isUploading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin mr-2" />
                        {isUploading ? "Uploading…" : "Submitting…"}
                      </>
                    ) : (
                      <>
                        <Upload className="w-5 h-5 mr-2" />
                        Upload My Statement — Free
                      </>
                    )}
                  </Button>

                  {/* ── Secondary: book ── */}
                  <a
                    href={CALENDAR_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="link-upload-form-book"
                    onClick={() =>
                      trackBookingCtaClick({
                        page: "/upload-statement",
                        ctaLabel: "Book a 10-Min Review Call",
                        ctaLocation: "form",
                      })
                    }
                  >
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full h-12 rounded-2xl border-gray-200 text-gray-700 font-medium hover:bg-gray-50 hover:border-gray-300"
                    >
                      <Calendar className="w-4 h-4 mr-2 text-gray-500" />
                      Book a 10-Min Review Call
                    </Button>
                  </a>

                  {/* ── Tertiary: phone ── */}
                  <a
                    href={PHONE_TEL}
                    aria-label={`Call Liberty Bancard at ${PHONE_NUMBER}`}
                    data-testid="link-upload-hero-phone"
                    onClick={() => trackPhoneCallClick({ sourcePage: "/upload-statement" })}
                    className="flex items-center justify-center gap-2 text-sm text-gray-400 hover:text-gray-600 transition-colors py-1"
                  >
                    <Phone className="w-4 h-4" />
                    Or call {PHONE_NUMBER}
                  </a>

                  {/* Compliance microcopy */}
                  <p
                    className="text-[10px] text-gray-400 text-center leading-snug"
                    data-testid="text-compliance-microcopy"
                  >
                    Eligibility, underwriting, card brand rules, and applicable laws apply. No savings claims without statement review.
                  </p>
                </form>
              </Form>
            )}
          </div>
        </section>

        <FreeStatementReviewDetails />

        {/* ═══════════════════════════════════════════════════
            WHAT HAPPENS NEXT — 3 steps
        ═══════════════════════════════════════════════════ */}
        <section className="bg-gray-50 px-5 py-10" data-testid="section-what-happens-next">
          <div className="max-w-lg mx-auto reveal">
            <h2
              className="text-xl font-bold text-gray-900 mb-1"
              data-testid="text-what-happens-next"
            >
              What happens next
            </h2>
            <p className="text-sm text-gray-400 mb-6">Usually within 1 business day.</p>
            <div className="space-y-3">
              {[
                {
                  n: "1",
                  title: "Instant confirmation",
                  body: "We confirm receipt right away and queue AI analysis on your file.",
                  delay: "reveal-delay-1",
                },
                {
                  n: "2",
                  title: "Line-by-line fee audit",
                  body: "We calculate your effective rate and surface every cost driver — hidden fees included.",
                  delay: "reveal-delay-2",
                },
                {
                  n: "3",
                  title: "Your options, in plain math",
                  body: "We present 2–3 specific options with apples-to-apples savings estimates and no pressure.",
                  delay: "reveal-delay-3",
                },
              ].map(({ n, title, body, delay }) => (
                <div
                  key={n}
                  className={`flex items-start gap-4 bg-white rounded-2xl border border-gray-100 px-4 py-4 shadow-sm reveal ${delay}`}
                  data-testid={`card-step-${n}`}
                >
                  <div className="w-9 h-9 rounded-full bg-[#0d1b2e] text-white flex items-center justify-center text-sm font-bold shrink-0">
                    {n}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{title}</p>
                    <p className="text-sm text-gray-500 mt-0.5">{body}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="text-center mt-6 reveal reveal-delay-4">
              <a
                href={CALENDAR_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="button-book-call-next"
              >
                <Button variant="outline" className="rounded-xl gap-2 border-gray-200 text-gray-700">
                  <Calendar className="w-4 h-4" />
                  Prefer to talk? Book a Call
                </Button>
              </a>
            </div>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════
            AI QUICK ANALYSIS — power-user tool
        ═══════════════════════════════════════════════════ */}
        <section className="bg-white px-5 py-8" data-testid="section-ai-analysis">
          <div className="max-w-lg mx-auto">
            <Card data-testid="card-ai-analysis" className="rounded-2xl border-gray-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-bold text-gray-900 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-sky-500" />
                  Quick AI rate estimate
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-gray-500">
                  Don't have your statement handy? Enter your volume and rate for an instant estimate.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-gray-600">Monthly Volume ($)</Label>
                    <Input
                      className="h-11 text-base rounded-xl border-gray-200"
                      placeholder="e.g. 50000"
                      data-testid="input-analysis-volume"
                      value={analysisVolume}
                      onChange={(e) => setAnalysisVolume(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-gray-600">Effective Rate (%)</Label>
                    <Input
                      className="h-11 text-base rounded-xl border-gray-200"
                      placeholder="e.g. 3.2"
                      data-testid="input-analysis-rate"
                      value={analysisRate}
                      onChange={(e) => setAnalysisRate(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-gray-600">
                    Industry{" "}
                    <span className="text-gray-400 font-normal">(optional — unlocks tailored output)</span>
                  </Label>
                  <Select
                    value={analysisVertical || "_none"}
                    onValueChange={(v) => setAnalysisVertical(v === "_none" ? "" : v)}
                  >
                    <SelectTrigger
                      className="h-11 text-base rounded-xl border-gray-200"
                      data-testid="select-analysis-vertical"
                    >
                      <SelectValue placeholder="Select vertical for tailored analysis" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No vertical (generic analysis)</SelectItem>
                      {ANALYSIS_VERTICALS.map(({ label, slug }) => (
                        <SelectItem
                          key={slug}
                          value={slug}
                          data-testid={`select-analysis-item-${slug}`}
                        >
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  className="gap-2 rounded-xl w-full sm:w-auto"
                  onClick={handleAnalysis}
                  disabled={analyzing || !analysisVolume}
                  data-testid="button-analyze-statement"
                >
                  {analyzing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  Analyze My Rate
                </Button>
                {analysisError && (
                  <div className="text-sm text-red-600" data-testid="text-analysis-error">
                    {analysisError}
                  </div>
                )}
                {analysisResult && (
                  <div className="space-y-3 border-t pt-4" data-testid="analysis-results">
                    {(analysisResult._vertical as string | null | undefined) && (
                      <div className="flex items-center gap-2" data-testid="text-analysis-vertical">
                        <span className="text-xs text-gray-400">Vertical context applied:</span>
                        <span className="inline-flex items-center rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-700">
                          {ANALYSIS_VERTICALS.find(
                            (v) => v.slug === (analysisResult._vertical as string)
                          )?.label ?? (analysisResult._vertical as string)}
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-gray-400">Effective Rate</div>
                        <div
                          className="text-lg font-bold text-gray-900"
                          data-testid="text-effective-rate"
                        >
                          {analysisResult.effectiveRate}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-400">Recommended Program</div>
                        <div
                          className="text-lg font-bold text-gray-900"
                          data-testid="text-recommended-path"
                        >
                          {analysisResult.recommendedPath}
                        </div>
                      </div>
                    </div>
                    {analysisResult.keyFindings && (
                      <div>
                        <div className="text-sm font-medium text-gray-900 mb-2">Key Findings</div>
                        <ul className="space-y-1">
                          {(analysisResult.keyFindings as string[]).map((f, i) => (
                            <li
                              key={i}
                              className="text-sm text-gray-500 flex items-start gap-2"
                            >
                              <CheckCircle2 className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysisResult.overallAssessment && (
                      <div className="rounded-xl bg-sky-50 border border-sky-100 p-3">
                        <p className="text-sm text-sky-800">{analysisResult.overallAssessment as string}</p>
                      </div>
                    )}
                    <p className="text-[11px] text-gray-400 leading-snug">
                      This is an AI estimate, not a formal quote. Upload your actual statement for a
                      precise, line-item analysis.
                    </p>
                    <a href="#upload-form" className="block">
                      <Button size="sm" className="gap-2 rounded-xl w-full">
                        <Upload className="w-3.5 h-3.5" />
                        Upload My Actual Statement
                      </Button>
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════
            BOTTOM CTA PANEL
        ═══════════════════════════════════════════════════ */}
        <section className="bg-[#0d1b2e] px-5 py-10">
          <div className="max-w-lg mx-auto text-center space-y-4">
            <p className="text-xs font-bold tracking-widest text-white/40 uppercase">
              Ready to see your numbers?
            </p>
            <h2 className="text-2xl font-extrabold text-white leading-tight">
              Get your free statement<br />review today.
            </h2>
            <p className="text-sm text-white/55 leading-relaxed max-w-xs mx-auto">
              Upload takes 30 seconds. No processor login, no pressure, no obligation.
            </p>
            <a href="#upload-form" className="block max-w-xs mx-auto">
              <button
                className="w-full h-13 bg-white text-[#0d1b2e] font-extrabold text-base rounded-2xl py-3.5 flex items-center justify-center gap-2.5 hover:bg-white/95 active:scale-[0.98] transition-all shadow-xl"
                type="button"
              >
                <Upload className="w-5 h-5 shrink-0" />
                Upload My Statement
              </button>
            </a>
            <a
              href={PHONE_TEL}
              aria-label={`Call Liberty Bancard at ${PHONE_NUMBER}`}
              className="inline-flex items-center gap-2 text-sm text-white/45 hover:text-white/70 transition-colors"
              onClick={() => trackPhoneCallClick({ sourcePage: "/upload-statement" })}
            >
              <Phone className="w-4 h-4" />
              Or call {PHONE_NUMBER}
            </a>
            <p className="text-[10px] text-white/25 leading-snug max-w-sm mx-auto"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
              Eligibility, underwriting, card brand rules, and applicable laws apply.
            </p>
          </div>
        </section>

      </main>

      <Footer />

      {/* ═══════════════════════════════════════════════════
          STICKY BOTTOM BAR — mobile only
          (App.tsx disables StickyMobileCTA on /upload-statement)
      ═══════════════════════════════════════════════════ */}
      {!uploadSucceeded && (
        <div
          className="fixed bottom-0 left-0 right-0 z-40 sm:hidden bg-white/95 backdrop-blur-sm border-t border-gray-200 px-4 pt-3 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
          data-testid="sticky-upload-cta"
        >
          <a
            href="#upload-form"
            className="flex items-center justify-center gap-2.5 w-full bg-[#0d1b2e] text-white font-bold text-sm rounded-xl py-3 active:scale-[0.98] transition-all"
            data-testid="link-sticky-upload-statement"
          >
            <Upload className="w-4 h-4 shrink-0" />
            Upload My Statement — Free
          </a>
        </div>
      )}
    </div>
  );
}
