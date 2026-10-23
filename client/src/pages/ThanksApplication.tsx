import { useEffect, useState } from "react";
import { SEO } from "@/components/SEO";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { CheckCircle, FileCheck, Phone, Mail, Calendar, User } from "lucide-react";
import { trackCalendarBooking, trackThankYouPageView } from "@/lib/tracking";
import { trackPhoneCallClick } from "@/lib/analytics";
import { CALENDAR_URL } from "@/lib/constants";

export default function ThanksApplication() {
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [esignStatus, setEsignStatus] = useState<string | null>(null);
  const [contactEmail, setContactEmail] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | null>(null);

  useEffect(() => {
    trackThankYouPageView("merchant_application");
    try {
      const raw = sessionStorage.getItem("lb_app_confirmation");
      if (raw) {
        const data = JSON.parse(raw);
        setApplicationId(data.applicationId || null);
        setEsignStatus(data.esignStatus || null);
        setContactEmail(data.email || null);
        setBusinessName(data.businessName || null);
        setOwnerName(data.ownerName || null);
      }
    } catch {
    }
  }, []);

  // A receipt exists only when this browser session just finalized an
  // application (the confirmation is written after the server accepted it).
  // A context-free visit must not claim that anything was submitted or sent.
  const hasReceipt = Boolean(applicationId);

  const nextSteps = [
    {
      step: 1,
      title: "Sign your Merchant Processing Agreement",
      description: esignStatus === "sent"
        ? `A signature request was sent to ${contactEmail || "the email on your application"}. Check your inbox and spam folder and complete the e-signature.`
        : `We have not confirmed that an agreement was sent yet. Our team will follow up using the email on your application. If you do not hear from us, contact support below.`,
      urgent: true,
    },
    {
      step: 2,
      title: "Application review and underwriting",
      description: "Our underwriting team reviews your application and may contact you for additional information.",
      urgent: false,
    },
    {
      step: 3,
      title: "Account setup and equipment",
      description: "After approval, we assign your Merchant ID (MID), configure your gateway, and arrange any equipment you requested.",
      urgent: false,
    },
    {
      step: 4,
      title: "Go live",
      description: "Processing begins once your account is set up and you run your first transaction.",
      urgent: false,
    },
  ];

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <SEO title="Application Received" description="Confirmation page for a Liberty Bancard merchant application." path="/thanks/application" noindex />
      <Navbar />
      <main className="flex-grow pt-28">
        <section
          className="relative overflow-hidden"
          data-testid="section-thanks-application-hero"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-[hsl(222,47%,11%)] via-[hsl(222,47%,15%)] to-[hsl(221,83%,25%)]" />
          <div className="glow-blob w-64 h-64 bg-emerald-500 top-10 right-1/4" />
          <div className="relative max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-5">
              <CheckCircle className="w-8 h-8 text-emerald-400" />
            </div>
            <h1
              className="text-3xl md:text-4xl font-display font-bold text-white mb-3"
              data-testid="text-thanks-application-heading"
            >
              {hasReceipt ? "Application received" : "No recent application to show"}
            </h1>
            {!hasReceipt && (
              <p className="text-white/70 max-w-md mx-auto" data-testid="text-thanks-application-no-context">
                This page shows a receipt right after you submit an application in this browser. Nothing has been submitted from this visit.
              </p>
            )}
            {applicationId && (
              <p className="text-white/70 mb-2" data-testid="text-thanks-application-id">
                Reference #<span className="font-semibold text-white">{applicationId}</span>
              </p>
            )}
            {(businessName || ownerName) && (
              <p className="text-white/60 text-sm" data-testid="text-thanks-application-name">
                {businessName && <span>{businessName}</span>}
                {businessName && ownerName && " · "}
                {ownerName && <span>{ownerName}</span>}
              </p>
            )}
          </div>
        </section>

        <section className="bg-muted/30 py-12" data-testid="section-thanks-application-esign">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
            {hasReceipt && esignStatus === "sent" && (
              <Card className="border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20" data-testid="card-esign-sent">
                <CardContent className="p-6 flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center shrink-0">
                    <Mail className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-foreground mb-1" data-testid="text-esign-sent-heading">
                      E-Signature Request Sent
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Your Merchant Processing Agreement was emailed to{" "}
                      <span className="font-medium text-foreground">{contactEmail}</span>.{" "}
                      Please check your inbox (and spam folder) and complete the signature as soon as possible to avoid delays.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {hasReceipt && esignStatus !== "sent" && (
              <Card className="border-primary/20 bg-primary/5" data-testid="card-esign-pending">
                <CardContent className="p-6 flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <FileCheck className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-foreground mb-1" data-testid="text-esign-pending-heading">
                      Agreement not sent yet
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Your application was received. We have not confirmed that an agreement email went to{" "}
                      <span className="font-medium text-foreground">{contactEmail || "the email on your application"}</span>.{" "}
                      Our team will follow up; contact support below if you do not hear from us.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {!hasReceipt && (
              <Card data-testid="card-no-receipt">
                <CardContent className="p-6 sm:p-8 space-y-4">
                  <h2 className="text-xl font-display font-bold text-foreground">Start or resume an application</h2>
                  <p className="text-sm text-muted-foreground">
                    If you began an application earlier, you can continue it. If you already submitted one, contact us with the business name and we will look it up.
                  </p>
                  <Link href="/merchant-application">
                    <Button size="sm" data-testid="link-thanks-application-start">Go to the application</Button>
                  </Link>
                </CardContent>
              </Card>
            )}

            {hasReceipt && (
            <Card data-testid="card-next-steps">
              <CardContent className="p-6 sm:p-8">
                <h2
                  className="text-xl font-display font-bold text-foreground mb-6"
                  data-testid="text-next-steps-heading"
                >
                  What Happens Next
                </h2>
                <div className="space-y-5">
                  {nextSteps.map((item) => {
                    return (
                      <div
                        key={item.step}
                        className="flex items-start gap-4"
                        data-testid={`next-step-${item.step}`}
                      >
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                          item.urgent
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}>
                          <span className="text-xs font-bold">{item.step}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <p className="text-sm font-semibold text-foreground">{item.title}</p>
                          </div>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {item.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
            )}

            <Card data-testid="card-contact-info">
              <CardContent className="p-6">
                <h2 className="text-base font-semibold text-foreground mb-4" data-testid="text-contact-info-heading">
                  Have Questions? We're Here.
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <a href="tel:9542668214" className="flex items-center gap-3 group" data-testid="link-contact-phone" onClick={() => trackPhoneCallClick({ sourcePage: "/thanks-application" })}>
                    <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                      <Phone className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Call or Text</p>
                      <p className="text-sm font-medium text-foreground">954-266-8214</p>
                    </div>
                  </a>
                  <a href="mailto:support@libertybancard.com" className="flex items-center gap-3 group" data-testid="link-contact-email">
                    <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                      <Mail className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Email</p>
                      <p className="text-sm font-medium text-foreground">support@libertybancard.com</p>
                    </div>
                  </a>
                </div>
                <div className="mt-4 pt-4 border-t flex flex-col sm:flex-row gap-3">
                  <a
                    href={CALENDAR_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackCalendarBooking("thanks_application")}
                    data-testid="link-thanks-application-book-call"
                  >
                    <Button size="sm" className="gap-2 w-full sm:w-auto">
                      <Calendar className="w-4 h-4" />
                      Book a call
                    </Button>
                  </a>
                  <Link href="/dashboard/merchant-portal">
                    <Button size="sm" variant="outline" className="gap-2 w-full sm:w-auto" data-testid="link-thanks-application-portal">
                      <User className="w-4 h-4" />
                      Go to Merchant Portal
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground text-center" data-testid="text-thanks-disclaimer">
              Liberty Bancard is a registered ISO. All applications are subject to underwriting approval. 
              Eligibility, underwriting, card brand rules, and applicable laws apply.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
