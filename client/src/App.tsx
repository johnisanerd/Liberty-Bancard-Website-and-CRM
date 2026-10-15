import React, { Suspense, lazy, useEffect, useState } from "react";
import { Switch, Route, Redirect, useLocation, useSearch } from "wouter";
import { queryClient } from "./lib/queryClient";
import { financialUrl, operatorAliasUrl, merchantHealthAliasUrl,c4WorkspaceUrl,supportViews,testimonialAliasUrl,rfiUrl,outreachAliasUrl } from "@/lib/crm-destination-state";
import { actorIdentity, protectedScope } from "@/lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { HelmetProvider } from 'react-helmet-async';
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { StickyMobileCTA } from "@/components/StickyMobileCTA";
import { PublicThemeShell } from "@/components/PublicThemeShell";
import { CookieConsent } from "@/components/CookieConsent";
// ChatWidget replaced by GHL chat widget (index.html)
import { trackPageView } from "@/lib/tracking";
import { captureUTMParams } from "@/lib/utm";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { DashboardLayout } from "@/pages/DashboardLayout";

// ─── Auth / Identity ──────────────────────────────────────────────────────────
const Login = lazy(() => import("@/pages/Login"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const VerifyEmail = lazy(() => import("@/pages/VerifyEmail"));
const ActivatePortal = lazy(() => import("@/pages/ActivatePortal"));
const ActivateRepAccount = lazy(() => import("@/pages/ActivateRepAccount"));

// ─── Public Marketing Pages ───────────────────────────────────────────────────
const Home = lazy(() => import("@/pages/Home"));
const GetStarted = lazy(() => import("@/pages/GetStarted"));
const UploadStatement = lazy(() => import("@/pages/UploadStatement"));
const MerchantStatementUpload = lazy(() => import("@/pages/MerchantStatementUpload"));
const ZeroPercent = lazy(() => import("@/pages/ZeroPercent"));
const BeatSquareStripe = lazy(() => import("@/pages/BeatSquareStripe"));
const AboutContact = lazy(() => import("@/pages/AboutContact"));
const Estimate = lazy(() => import("@/pages/Estimate"));
const Support = lazy(() => import("@/pages/Support"));
const WhyLiberty = lazy(() => import("@/pages/WhyLiberty"));
const CaseStudies = lazy(() => import("@/pages/CaseStudies"));
const Testimonials = lazy(() => import("@/pages/Testimonials"));
const TestimonialsSubmit = lazy(() => import("@/pages/TestimonialsSubmit"));
const Integrations = lazy(() => import("@/pages/Integrations"));
const FAQ = lazy(() => import("@/pages/FAQ"));
const AffiliateProgram = lazy(() => import("@/pages/AffiliateProgram"));
const ISOPartnerProgram = lazy(() => import("@/pages/ISOPartnerProgram"));
const PartnerCPA = lazy(() => import("@/pages/PartnerCPA"));
const PartnerBookkeeper = lazy(() => import("@/pages/PartnerBookkeeper"));
const PartnerInsurance = lazy(() => import("@/pages/PartnerInsurance"));
const SavingsCalculator = lazy(() => import("@/pages/SavingsCalculator"));
const RateComparison = lazy(() => import("@/pages/RateComparison"));
const FreeAnalysis = lazy(() => import("@/pages/FreeAnalysis"));
const FreeAnalysisGuaranteed = lazy(() => import("@/pages/FreeAnalysisGuaranteed"));
const SalesToolsHub = lazy(() => import("@/pages/SalesToolsHub"));
const CompareVs = lazy(() => import("@/pages/CompareVs"));
const AreasServed = lazy(() => import("@/pages/AreasServed"));
const AssetPage = lazy(() => import("@/pages/AssetPage"));

// ─── Legal / Compliance Pages ─────────────────────────────────────────────────
const PrivacyPolicy = lazy(() => import("@/pages/PrivacyPolicy"));
const Terms = lazy(() => import("@/pages/Terms"));
const CookiePolicy = lazy(() => import("@/pages/CookiePolicy"));
const AdvertisingDisclosure = lazy(() => import("@/pages/AdvertisingDisclosure"));
const AccessibilityStatement = lazy(() => import("@/pages/AccessibilityStatement"));
const SmsTerms = lazy(() => import("@/pages/SmsTerms"));
const ESignConsent = lazy(() => import("@/pages/ESignConsent"));
const SurchargingDisclosure = lazy(() => import("@/pages/SurchargingDisclosure"));
const MerchantPolicies = lazy(() => import("@/pages/MerchantPolicies"));
const RegulatoryNotices = lazy(() => import("@/pages/RegulatoryNotices"));
const SecurityCompliance = lazy(() => import("@/pages/SecurityCompliance"));
const DoNotSell = lazy(() => import("@/pages/DoNotSell"));
const DataProcessingAgreement = lazy(() => import("@/pages/DataProcessingAgreement"));
const ResponsibleAI = lazy(() => import("@/pages/ResponsibleAI"));
const TestimonialsDisclosure = lazy(() => import("@/pages/TestimonialsDisclosure"));
const LawEnforcementGuidelines = lazy(() => import("@/pages/LawEnforcementGuidelines"));
const DisputeResolution = lazy(() => import("@/pages/DisputeResolution"));
const DataRetention = lazy(() => import("@/pages/DataRetention"));
const TCPAConsent = lazy(() => import("@/pages/TCPAConsent"));
const RefundPolicy = lazy(() => import("@/pages/RefundPolicy"));
const CaliforniaPrivacy = lazy(() => import("@/pages/CaliforniaPrivacy"));
const ADACompliance = lazy(() => import("@/pages/ADACompliance"));

// ─── Conversion / Thank-You Pages ─────────────────────────────────────────────
const ThanksStatement = lazy(() => import("@/pages/ThanksStatement"));
const ThanksEstimate = lazy(() => import("@/pages/ThanksEstimate"));
const ThanksCall = lazy(() => import("@/pages/ThanksCall"));
const ThanksSupport = lazy(() => import("@/pages/ThanksSupport"));
const ThanksApplication = lazy(() => import("@/pages/ThanksApplication"));
const ProposalViewer = lazy(() => import("@/pages/ProposalViewer"));
const CoBrandedProposalViewer = lazy(() => import("@/pages/CoBrandedProposalViewer"));
const SavingsPage = lazy(() => import("@/pages/SavingsPage"));

// ─── Merchant / Partner Public Pages ──────────────────────────────────────────
const MerchantApplication = lazy(() => import("@/pages/MerchantApplication"));
const NpsSurvey = lazy(() => import("@/pages/NpsSurvey"));
const PartnerPortal = lazy(() => import("@/pages/PartnerPortal"));
const PartnerLogin = lazy(() => import("@/pages/PartnerLogin"));
const PartnerBrandedPage = lazy(() => import("@/pages/PartnerBrandedPage"));
const PartnerOrgDashboard = lazy(() => import("@/pages/PartnerOrgDashboard"));

// ─── Content Pages ────────────────────────────────────────────────────────────
const FreeSmartTerminal = lazy(() => import("@/pages/FreeSmartTerminal"));
const Blog = lazy(() => import("@/pages/Blog"));
const BlogPost = lazy(() => import("@/pages/BlogPost"));
const AuthorPage = lazy(() => import("@/pages/AuthorPage"));
const HelpCenter = lazy(() => import("@/pages/HelpCenter"));
const HelpArticle = lazy(() => import("@/pages/HelpArticle"));
const IndustryPage = lazy(() => import("@/pages/IndustryPage"));
const LocationIndustryPage = lazy(() => import("@/pages/LocationIndustryPage"));
const TerminalShop = lazy(() => import("@/pages/TerminalShop"));

// ─── Sales Tools (hidden) ─────────────────────────────────────────────────────
const CostQuiz = lazy(() => import("@/pages/sales/CostQuiz"));
const SalesOnePager = lazy(() => import("@/pages/sales/SalesOnePager"));
const AgentCalculator = lazy(() => import("@/pages/sales/AgentCalculator"));

// ─── Mobile PWA ───────────────────────────────────────────────────────────────
const MobileApp = lazy(() => import("@/pages/mobile/MobileApp"));

// ─── Misc ─────────────────────────────────────────────────────────────────────
const NotFound = lazy(() => import("@/pages/not-found"));
const Forbidden = lazy(() => import("@/pages/Forbidden"));

// ─── Dashboard Pages ──────────────────────────────────────────────────────────
const Overview = lazy(() => import("@/pages/dashboard/Overview"));
const CompanyDetail = lazy(() => import("@/pages/dashboard/CompanyDetail"));
const Contacts = lazy(() => import("@/pages/dashboard/Contacts"));
const Leads = lazy(() => import("@/pages/dashboard/Leads"));
const Chat = lazy(() => import("@/pages/dashboard/Chat"));
const ConversationAI = lazy(() => import("@/pages/dashboard/ConversationAI"));
const Pipeline = lazy(() => import("@/pages/dashboard/Pipeline"));
const Onboarding = lazy(() => import("@/pages/dashboard/Onboarding"));
const Tickets = lazy(() => import("@/pages/dashboard/Tickets"));
const Tasks = lazy(() => import("@/pages/dashboard/Tasks"));
const Notifications = lazy(() => import("@/pages/dashboard/Notifications"));
const CallOutcome = lazy(() => import("@/pages/dashboard/CallOutcome"));
const ReviewComplete = lazy(() => import("@/pages/dashboard/ReviewComplete"));
const OnboardingKickoff = lazy(() => import("@/pages/dashboard/OnboardingKickoff"));
const Workflows = lazy(() => import("@/pages/dashboard/Workflows"));
const RFIs = lazy(() => import("@/pages/dashboard/RFIs"));
const ReviewQueuePage = lazy(() => import("@/pages/dashboard/ReviewQueue"));
const CaseStudyIntake = lazy(() => import("@/pages/dashboard/CaseStudyIntake"));
const Automation = lazy(() => import("@/pages/dashboard/Automation"));
const Prospects = lazy(() => import("@/pages/dashboard/Prospects"));
const ProspectImport = lazy(() => import("@/pages/dashboard/ProspectImport"));
const Campaigns = lazy(() => import("@/pages/dashboard/Campaigns"));
const ContactDetail = lazy(() => import("@/pages/dashboard/ContactDetail"));
const StageRules = lazy(() => import("@/pages/dashboard/StageRules"));
const Sequences = lazy(() => import("@/pages/dashboard/Sequences"));
const LeadGenCleaner = lazy(() => import("@/pages/dashboard/LeadGenCleaner"));
const LeadIntelligence = lazy(() => import("@/pages/dashboard/LeadIntelligence"));
const StatementReview = lazy(() => import("@/pages/dashboard/StatementReview"));
const LeadCommandCenter = lazy(() => import("@/pages/dashboard/LeadCommandCenter"));
const LeadImports = lazy(() => import("@/pages/dashboard/LeadImports"));
const MasterLeadDatabase = lazy(() => import("@/pages/dashboard/MasterLeadDatabase"));
const MerchantPortal = lazy(() => import("@/pages/dashboard/MerchantPortal"));
const MerchantApplicationsList = lazy(() => import("@/pages/dashboard/MerchantApplicationsList"));
const BoardingTracker = lazy(() => import("@/pages/dashboard/BoardingTracker"));
const AgentManagement = lazy(() => import("@/pages/dashboard/AgentManagement"));
const MerchantHealth = lazy(() => import("@/pages/dashboard/MerchantHealth"));
const Chargebacks = lazy(() => import("@/pages/dashboard/Chargebacks"));
const ReferralProgram = lazy(() => import("@/pages/dashboard/ReferralProgram"));
const KnowledgeBase = lazy(() => import("@/pages/dashboard/KnowledgeBase"));
const KnowledgeAdmin = lazy(() => import("@/pages/dashboard/KnowledgeAdmin"));
const ResidualRevenue = lazy(() => import("@/pages/dashboard/ResidualRevenue"));
const ConsentAudit = lazy(() => import("@/pages/dashboard/ConsentAudit"));
const UserManagement = lazy(() => import("@/pages/dashboard/UserManagement"));
const Permissions = lazy(() => import("@/pages/dashboard/Permissions"));
const SecuritySettings = lazy(() => import("@/pages/dashboard/SecuritySettings"));
const Calendar = lazy(() => import("@/pages/dashboard/Calendar"));
const Forecasting = lazy(() => import("@/pages/dashboard/Forecasting"));
const PciAssessment = lazy(() => import("@/pages/dashboard/PciAssessment"));
const DataRequests = lazy(() => import("@/pages/dashboard/DataRequests"));
const AuditLogs = lazy(() => import("@/pages/dashboard/AuditLogs"));
const SdrDashboard = lazy(() => import("@/pages/dashboard/SdrDashboard"));
const SmsInbox = lazy(() => import("@/pages/dashboard/SmsInbox"));
const BinLookup = lazy(() => import("@/pages/dashboard/BinLookup"));
const RoundRobinAdmin = lazy(() => import("@/pages/dashboard/RoundRobinAdmin"));
const InboxHealth = lazy(() => import("@/pages/dashboard/InboxHealth"));
const SettingsIntegrations = lazy(() => import("@/pages/dashboard/SettingsIntegrations"));
const ActivationPanel = lazy(() => import("@/pages/dashboard/ActivationPanel"));
const OperatorDashboard = lazy(() => import("@/pages/dashboard/OperatorDashboard"));
const SeoHealth = lazy(() => import("@/pages/dashboard/SeoHealth"));
const Training = lazy(() => import("@/pages/dashboard/Training"));
const Leaderboard = lazy(() => import("@/pages/dashboard/Leaderboard"));
const TerminalROI = lazy(() => import("@/pages/dashboard/TerminalROI"));
const SalesRepHome = lazy(() => import("@/pages/dashboard/SalesRepHome"));
const LiveChatDashboard = lazy(() => import("@/pages/dashboard/LiveChat"));
const DocumentVault = lazy(() => import("@/pages/dashboard/DocumentVault"));
// VirtualTerminal removed — feature decommissioned (#1473)
const PartnerOrgs = lazy(() => import("@/pages/dashboard/PartnerOrgs"));
const PartnerReferralPipeline = lazy(() => import("@/pages/dashboard/PartnerReferralPipeline"));
const PartnerPortalAdmin = lazy(() => import("@/pages/dashboard/PartnerPortalAdmin"));
const CoBrandedProposals = lazy(() => import("@/pages/dashboard/CoBrandedProposals"));
const WidgetGenerator = lazy(() => import("@/pages/dashboard/WidgetGenerator"));
const PartnerEmbedWidget = lazy(() => import("@/pages/PartnerEmbedWidget"));
const UnderwritingPage = lazy(() => import("@/pages/dashboard/Underwriting"));
const SystemReadiness = lazy(() => import("@/pages/dashboard/SystemReadiness"));
const EmailHealth = lazy(() => import("@/pages/dashboard/EmailHealth"));
const SystemAudit = lazy(() => import("@/pages/dashboard/SystemAudit"));
const ContactCensus = lazy(() => import("@/pages/dashboard/ContactCensus"));
const QueueHoldsPage = lazy(() => import("@/pages/queue-holds"));
const LeadOpsCenter = lazy(() => import("@/pages/dashboard/LeadOpsCenter"));
const BusinessDetailPage = lazy(() => import("@/pages/dashboard/LeadOps/BusinessDetailPage").then(m => ({ default: m.BusinessDetailPage })));
const OutreachQueue = lazy(() => import("@/pages/dashboard/OutreachQueue"));
const ExecutiveDashboard = lazy(() => import("@/pages/dashboard/Executive"));
const LaunchReadiness = lazy(() => import("@/pages/dashboard/LaunchReadiness"));
const OutboundReadiness = lazy(() => import("@/pages/dashboard/OutboundReadiness"));
const OutboundPreflight = lazy(() => import("@/pages/dashboard/OutboundPreflight"));
const DataHealth = lazy(() => import("@/pages/dashboard/DataHealth"));
const DataQuality = lazy(() => import("@/pages/dashboard/DataQuality"));
const BlockedContacts = lazy(() => import("@/pages/dashboard/BlockedContacts"));
const DeliverabilitySettings = lazy(() => import("@/pages/dashboard/DeliverabilitySettings"));
const ArbitrationLog = lazy(() => import("@/pages/dashboard/ArbitrationLog"));
const GhlConflicts = lazy(() => import("@/pages/dashboard/GhlConflicts"));
const SetupWizard = lazy(() => import("@/pages/dashboard/SetupWizard"));
const MyEarnings = lazy(() => import("@/pages/dashboard/MyEarnings"));

// ─── Unified CRM Console Pages ─────────────────────────────────────────────────
const ContactsAndLeads = lazy(() => import("@/pages/dashboard/ContactsAndLeads"));
const TasksAppointments = lazy(() => import("@/pages/dashboard/TasksAppointments"));
const OutboundCenter = lazy(() => import("@/pages/dashboard/OutboundCenter"));

// ─── Dashboard Hub Pages ───────────────────────────────────────────────────────
const OnboardingHub = lazy(() => import("@/pages/dashboard/OnboardingHub"));
const OutreachHub = lazy(() => import("@/pages/dashboard/OutreachHub"));
const GhlIntegrationHub = lazy(() => import("@/pages/dashboard/GhlIntegrationHub"));
const PlaybooksHub = lazy(() => import("@/pages/dashboard/PlaybooksHub"));
const ContentHub = lazy(() => import("@/pages/dashboard/ContentHub"));
const ReportingHub = lazy(() => import("@/pages/dashboard/ReportingHub"));
const MerchantSuccessHub = lazy(() => import("@/pages/dashboard/MerchantSuccessHub"));
const MerchantPortfolio = lazy(() => import("@/pages/dashboard/MerchantPortfolio"));
const SupportHub = lazy(() => import("@/pages/dashboard/SupportHub"));
const CommsHub = lazy(() => import("@/pages/dashboard/CommsHub"));
const SDRHub = lazy(() => import("@/pages/dashboard/SDRHub"));
const DeliverabilityHub = lazy(() => import("@/pages/dashboard/DeliverabilityHub"));
const FinancialHub = lazy(() => import("@/pages/dashboard/FinancialHub"));
const SystemHealthHub = lazy(() => import("@/pages/dashboard/SystemHealthHub"));
const AdminHub = lazy(() => import("@/pages/dashboard/AdminHub"));
const AutomationRegistry = lazy(() => import("@/pages/dashboard/AutomationRegistry"));
const NbaPriorityPage = lazy(() => import("@/pages/dashboard/NbaPriorityPage"));
const MerchantRiskHub = lazy(() => import("@/pages/dashboard/MerchantRiskHub"));
const SequenceReport = lazy(() => import("@/pages/dashboard/SequenceReport"));
const AcquisitionHub = lazy(() => import("@/pages/dashboard/AcquisitionHub"));
const IdentityCrosswalk = lazy(() => import("@/pages/dashboard/IdentityCrosswalk"));
const CanonicalEnrichment = lazy(() => import("@/pages/dashboard/CanonicalEnrichment"));

const Executive = lazy(() => import("@/pages/dashboard/Executive"));
function AgentRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !user) {
      setLocation("/login");
    }
    if (!isLoading && user && user.role !== "agent") {
      setLocation("/dashboard");
    }
  }, [isLoading, user, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user || user.role !== "agent") return null;

  return (
    <DashboardLayout key={`${actorIdentity(user)}:${protectedScope(user).generation}`}>
      <Component />
    </DashboardLayout>
  );
}

function PartnerProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/partner-login" />;
  }

  if ((user as any).role !== "partner" && (user as any).role !== "admin") {
    return <Redirect to="/dashboard" />;
  }

  return <Component />;
}

function ProtectedRoute({ component: Component, allowedRoles }: { component: React.ComponentType; allowedRoles?: string[] }) {
  const { user, isLoading } = useAuth();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user?.role === "agent" && location === "/dashboard") {
      setLocation("/dashboard/my-day");
    }
  }, [isLoading, user, location, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  if ((user as any).role === "partner") {
    return <Redirect to="/partner-portal" />;
  }

  // Merchants only have access to the merchant portal — redirect them there
  // whenever they land on the generic dashboard root or any CRM-only page.
  if ((user as any).role === "merchant" && location !== "/dashboard/merchant-portal") {
    return <Redirect to="/dashboard/merchant-portal" />;
  }

  if (user.role === "agent" && location === "/dashboard") return null;

  if (allowedRoles && !allowedRoles.includes(user.role as string)) {
    if (/^\/dashboard\/(?:contacts(?:\/[^/]+)?|contacts-leads)$/.test(location))
      return <Forbidden />;
    return <Redirect to="/dashboard" />;
  }

  return (
    <DashboardLayout key={`${actorIdentity(user)}:${protectedScope(user).generation}`}>
      <Component key={`${location}:${actorIdentity(user)}`} />
    </DashboardLayout>
  );
}

function LegacyOperatorRedirect() {
  const search = useSearch();
  return <Redirect to={operatorAliasUrl(search, window.location.hash)} />;
}

function LegacyFinancialRedirect() {
  const search = useSearch();
  return <Redirect to={financialUrl(search, window.location.hash)} />;
}
function LegacyMerchantHealthRedirect() {
  const search = useSearch();
  return <Redirect to={merchantHealthAliasUrl(search, window.location.hash)} />;
}
function LegacyReviewQueueRedirect(){
  const search=useSearch();
  return <Redirect to={c4WorkspaceUrl("/dashboard/support-hub",search,window.location.hash,"tab",supportViews,"tickets","review-queue")}/>;
}
function LegacyTestimonialRedirect(){
  const search=useSearch();
  return <Redirect to={testimonialAliasUrl(search,window.location.hash)}/>;
}
function LegacyRfiRedirect(){
  const search=useSearch();
  return <Redirect to={rfiUrl(search,window.location.hash)}/>;
}
function LegacyFinancialChildRedirect({ child }: { child: "revenue" | "forecasting" | "terminal-roi" }) {
  const search = useSearch();
  const params = new URLSearchParams(search);
  if (!params.has("financialTab")) params.set("financialTab", child);
  return <Redirect to={financialUrl(params.toString(), window.location.hash)} />;
}

function LegacyOutreachRedirect() {
  const search=useSearch();
  return <Redirect to={outreachAliasUrl(search,window.location.hash)} />;
}

function LegacyProspectsRedirect() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  params.delete("tab");
  params.set("tab", "prospects");
  return <Redirect to={`/dashboard/lead-ops?${params.toString()}`} />;
}

function LegacyLeadImportsRedirect() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  params.set("tab", "imports");
  return <Redirect to={`/dashboard/lead-ops?${params.toString()}`} />;
}

function LegacyMasterLeadDatabaseRedirect() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  params.set("tab", "staging");
  params.set("stagingTab", "master-leads");
  return <Redirect to={`/dashboard/lead-ops?${params.toString()}`} />;
}

function LegacyLeadIntelligenceRedirect() {
  const { user } = useAuth();
  const search = useSearch();
  const params = new URLSearchParams(search);
  params.set("tab", "intelligence");
  // Lead Ops is admin/manager-only, but Lead Intelligence was previously open to
  // any authenticated dashboard user. Preserve that access for other roles
  // (e.g. agent) instead of bouncing them off the gated Lead Ops route (#1957).
  if (user && !["admin", "manager"].includes(user.role as string)) {
    return <LeadIntelligence />;
  }
  return <Redirect to={`/dashboard/lead-ops?${params.toString()}`} />;
}

function LegacyLeadCommandCenterRedirect() {
  const { user } = useAuth();
  // Lead Command Center previously had no role restriction. Lead Ops (its
  // consolidated replacement) is admin/manager-only, so preserve prior access
  // for other roles instead of bouncing them off the gated route (#1957).
  if (user && !["admin", "manager"].includes(user.role as string)) {
    return <LeadCommandCenter />;
  }
  return <Redirect to="/dashboard/lead-ops" />;
}

function LegacyDataQualityRedirect() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  params.set("tab", "quality");
  return <Redirect to={`/dashboard/lead-ops?${params.toString()}`} />;
}

function Router() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/signup"><Redirect to="/login" /></Route>
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/verify-email" component={VerifyEmail} />
        <Route path="/activate-portal" component={ActivatePortal} />
        <Route path="/activate-rep" component={ActivateRepAccount} />
        <Route path="/" component={Home} />
        <Route path="/get-started" component={GetStarted} />
        <Route path="/upload-statement" component={UploadStatement} />
        <Route path="/statement-upload/:token" component={MerchantStatementUpload} />
        <Route path="/0-percent-processing" component={ZeroPercent} />
        <Route path="/beat-square-stripe" component={BeatSquareStripe} />
        <Route path="/free-smart-terminal" component={FreeSmartTerminal} />
        <Route path="/about-contact" component={AboutContact} />
        <Route path="/contact" component={AboutContact} />
        {/* /contact is kept as a redirect alias for external links pointing to /contact */}
        <Route path="/estimate" component={Estimate} />
        <Route path="/support" component={Support} />
        <Route path="/privacy-policy" component={PrivacyPolicy} />
        <Route path="/terms" component={Terms} />
        <Route path="/cookie-policy" component={CookiePolicy} />
        <Route path="/advertising-disclosure" component={AdvertisingDisclosure} />
        <Route path="/accessibility" component={AccessibilityStatement} />
        <Route path="/sms-terms" component={SmsTerms} />
        <Route path="/esign-consent" component={ESignConsent} />
        <Route path="/surcharging-disclosure" component={SurchargingDisclosure} />
        <Route path="/merchant-policies" component={MerchantPolicies} />
        <Route path="/regulatory-notices" component={RegulatoryNotices} />
        <Route path="/security-compliance" component={SecurityCompliance} />
        <Route path="/do-not-sell" component={DoNotSell} />
        <Route path="/data-processing-agreement" component={DataProcessingAgreement} />
        <Route path="/responsible-ai" component={ResponsibleAI} />
        <Route path="/testimonials-disclosure" component={TestimonialsDisclosure} />
        <Route path="/law-enforcement" component={LawEnforcementGuidelines} />
        <Route path="/dispute-resolution" component={DisputeResolution} />
        <Route path="/data-retention" component={DataRetention} />
        <Route path="/tcpa-consent" component={TCPAConsent} />
        <Route path="/refund-policy" component={RefundPolicy} />
        <Route path="/california-privacy" component={CaliforniaPrivacy} />
        <Route path="/ada-compliance" component={ADACompliance} />
        <Route path="/thanks-statement" component={ThanksStatement} />
        <Route path="/proposal/:token" component={ProposalViewer} />
        <Route path="/co-branded-proposal/:token" component={CoBrandedProposalViewer} />
        <Route path="/savings/:token" component={SavingsPage} />
        <Route path="/thanks-estimate" component={ThanksEstimate} />
        <Route path="/thanks-call" component={ThanksCall} />
        <Route path="/thanks-support" component={ThanksSupport} />
        <Route path="/thanks/application" component={ThanksApplication} />
        {/* /thanks-application is 301-redirected server-side to /thanks/application (Task #178) */}
        <Route path="/merchant-application" component={MerchantApplication} />
        <Route path="/equipment">
          <Redirect to="/shop" />
        </Route>
        <Route path="/shop" component={TerminalShop} />
        <Route path="/savings-calculator" component={SavingsCalculator} />
        <Route path="/compare-rates" component={RateComparison} />
        <Route path="/compare/:competitor" component={CompareVs} />
        <Route path="/why-liberty-bancard" component={WhyLiberty} />
        <Route path="/case-studies" component={CaseStudies} />
        <Route path="/testimonials/submit" component={TestimonialsSubmit} />
        <Route path="/testimonials" component={Testimonials} />
        <Route path="/integrations" component={Integrations} />
        <Route path="/faq" component={FAQ} />
        <Route path="/affiliate" component={AffiliateProgram} />
        <Route path="/partners/cpa" component={PartnerCPA} />
        <Route path="/partners/bookkeeper" component={PartnerBookkeeper} />
        <Route path="/partners/insurance" component={PartnerInsurance} />
        <Route path="/partners" component={ISOPartnerProgram} />
        <Route path="/partner-portal">
          <PartnerProtectedRoute component={PartnerPortal} />
        </Route>
        <Route path="/partner-login" component={PartnerLogin} />
        <Route path="/dashboard/partner">
          <PartnerProtectedRoute component={PartnerPortal} />
        </Route>
        <Route path="/partner/:slug" component={PartnerBrandedPage} />
        <Route path="/partner-org/:slug" component={PartnerOrgDashboard} />
        <Route path="/blog/:slug" component={BlogPost} />
        <Route path="/blog" component={Blog} />
        <Route path="/authors/:slug" component={AuthorPage} />
        <Route path="/help/:category/:slug" component={HelpArticle} />
        <Route path="/help/:category" component={HelpArticle} />
        <Route path="/help" component={HelpCenter} />

        {/* Mobile PWA for Field Sales Reps */}
        <Route path="/mobile/login" component={MobileApp} />
        <Route path="/mobile/contacts/:id" component={MobileApp} />
        <Route path="/mobile/contacts" component={MobileApp} />
        <Route path="/mobile/pipeline" component={MobileApp} />
        <Route path="/mobile/tasks" component={MobileApp} />
        <Route path="/mobile/inbox" component={MobileApp} />
        <Route path="/mobile/more" component={MobileApp} />
        <Route path="/mobile/sequences" component={MobileApp} />
        <Route path="/mobile/outreach" component={MobileApp} />
        <Route path="/mobile/field-day" component={MobileApp} />
        <Route path="/mobile/profile" component={MobileApp} />
        <Route path="/mobile" component={MobileApp} />

        {/* Compatibility redirects — /dashboard/mobile/* was never a valid route */}
        <Route path="/dashboard/mobile/contacts/:id">
          {(params) => { window.location.replace(`/mobile/contacts/${params.id}`); return null; }}
        </Route>
        <Route path="/dashboard/mobile/pipeline">
          {() => { window.location.replace("/mobile/pipeline"); return null; }}
        </Route>
        <Route path="/dashboard/mobile/tasks">
          {() => { window.location.replace("/mobile/tasks"); return null; }}
        </Route>
        <Route path="/dashboard/mobile">
          {() => { window.location.replace("/mobile"); return null; }}
        </Route>

        {/* Sales Tools Hub */}
        <Route path="/sales-tools" component={SalesToolsHub} />

        {/* Free Analysis Landing Page */}
        <Route path="/free-analysis" component={FreeAnalysis} />

        {/* Guarantee Landing Page */}
        <Route path="/free-analysis-guaranteed" component={FreeAnalysisGuaranteed} />

        {/* Sales Landing Pages (hidden, noindex) */}
        <Route path="/quiz/processing-cost" component={CostQuiz} />
        <Route path="/sales/agent-calculator" component={AgentCalculator} />
        <Route path="/sales/:slug" component={SalesOnePager} />

        {/* Industry Pages */}
        <Route path="/industries/:slug" component={IndustryPage} />

        {/* Areas Served Hub */}
        <Route path="/areas-served" component={AreasServed} />

        {/* Location × Industry Pages */}
        <Route path="/locations/:city/:industry" component={LocationIndustryPage} />

        {/* Asset Library & Packet Routes */}
        <Route path="/assets/:a/:b" component={AssetPage} />
        <Route path="/assets/:a" component={AssetPage} />
        <Route path="/assets" component={AssetPage} />
        <Route path="/packet/:a/:b" component={AssetPage} />
        <Route path="/packet/:a" component={AssetPage} />

        {/* NPS Survey (public token-based) */}
        <Route path="/nps/:token" component={NpsSurvey} />

        {/* Dashboard Routes */}
        <Route path="/dashboard">
          <ProtectedRoute component={Overview} />
        </Route>
        <Route path="/dashboard/companies/:id">
          <ProtectedRoute component={CompanyDetail} />
        </Route>
        <Route path="/dashboard/contacts/:id">
          <ProtectedRoute component={ContactDetail} allowedRoles={["admin", "manager", "agent"]} />
        </Route>
        <Route path="/dashboard/contacts">
          <ProtectedRoute component={Contacts} allowedRoles={["admin", "manager", "agent"]} />
        </Route>
        <Route path="/dashboard/my-leads">
          <AgentRoute component={Leads} />
        </Route>
        <Route path="/dashboard/chat">
          <ProtectedRoute component={Chat} />
        </Route>
        <Route path="/dashboard/pipeline">
          <ProtectedRoute component={Pipeline} />
        </Route>
        <Route path="/dashboard/onboarding">
          <ProtectedRoute component={OnboardingHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/tickets">
          <Redirect to="/dashboard/support-hub?tab=tickets" />
        </Route>
        <Route path="/dashboard/tasks">
          <Redirect to="/dashboard/tasks-appointments?tab=tasks" />
        </Route>
        <Route path="/dashboard/notifications">
          <ProtectedRoute component={Notifications} />
        </Route>
        <Route path="/dashboard/call-outcome">
          <ProtectedRoute component={CallOutcome} />
        </Route>
        <Route path="/dashboard/review-complete">
          <ProtectedRoute component={ReviewComplete} />
        </Route>
        <Route path="/dashboard/review-requests">
          <Redirect to="/dashboard/merchant-success?tab=reviews" />
        </Route>
        <Route path="/dashboard/testimonial-submissions">
          <LegacyTestimonialRedirect />
        </Route>
        <Route path="/dashboard/onboarding-kickoff">
          <ProtectedRoute component={OnboardingKickoff} />
        </Route>
        <Route path="/dashboard/workflows">
          <ProtectedRoute component={Workflows} />
        </Route>
        <Route path="/dashboard/rfis">
          <LegacyRfiRedirect />
        </Route>
        <Route path="/dashboard/review-queue">
          <LegacyReviewQueueRedirect />
        </Route>
        <Route path="/dashboard/case-study-intake">
          <ProtectedRoute component={CaseStudyIntake} />
        </Route>
        <Route path="/dashboard/ghl-settings">
          <Redirect to="/dashboard/ghl-integration?tab=settings" />
        </Route>
        <Route path="/dashboard/ghl-workflows">
          <Redirect to="/dashboard/ghl-integration?tab=workflow-ids" />
        </Route>
        <Route path="/dashboard/automation">
          <ProtectedRoute component={Automation} />
        </Route>
        {/* ─── Unified CRM Console Routes ───────────────────────────────── */}
        <Route path="/dashboard/contacts-leads">
          <ProtectedRoute component={ContactsAndLeads} allowedRoles={["admin", "manager", "agent"]} />
        </Route>
        <Route path="/dashboard/tasks-appointments">
          <ProtectedRoute component={TasksAppointments} />
        </Route>
        <Route path="/dashboard/outbound-center">
          <ProtectedRoute component={OutboundCenter} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/canonical-enrichment">
          <ProtectedRoute component={CanonicalEnrichment} allowedRoles={["admin", "manager"]} />
        </Route>
        {/* Legacy routes redirect to unified views with correct tab */}
        <Route path="/dashboard/prospects">
          <ProtectedRoute component={LegacyProspectsRedirect} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/prospects/import">
          <ProtectedRoute component={ProspectImport} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/lead-imports">
          <ProtectedRoute component={LegacyLeadImportsRedirect} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/master-lead-database">
          <ProtectedRoute component={LegacyMasterLeadDatabaseRedirect} allowedRoles={["admin"]} />
        </Route>
        <Route path="/dashboard/campaigns">
          <Redirect to="/dashboard/outbound-center?tab=campaigns" />
        </Route>
        <Route path="/dashboard/outreach-analytics">
          <LegacyOutreachRedirect />
        </Route>
        <Route path="/dashboard/reporting">
          <ProtectedRoute component={ReportingHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/acquisition-hub">
          <Redirect to="/dashboard/outbound-center?tab=analytics" />
        </Route>
        <Route path="/dashboard/win-loss">
          <Redirect to="/dashboard/reporting?tab=win-loss" />
        </Route>
        <Route path="/dashboard/stage-rules">
          <ProtectedRoute component={StageRules} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/sequences">
          <Redirect to="/dashboard/outbound-center?tab=sequences" />
        </Route>
        <Route path="/dashboard/lead-gen">
          <ProtectedRoute component={LeadGenCleaner} />
        </Route>
        <Route path="/dashboard/lead-intelligence">
          <ProtectedRoute component={LegacyLeadIntelligenceRedirect} />
        </Route>
        <Route path="/dashboard/statement-review">
          <ProtectedRoute component={StatementReview} />
        </Route>
        <Route path="/dashboard/outreach">
          <Redirect to="/dashboard/outbound-center?tab=command" />
        </Route>
        <Route path="/dashboard/outreach-command">
          <Redirect to="/dashboard/outbound-center?tab=command" />
        </Route>
        <Route path="/dashboard/lead-engine">
          {/* lead-engine previously pointed at the unrestricted lead-intelligence
              route; preserve that role compatibility via the same role-aware
              redirect instead of bouncing non-admin/manager roles off Lead Ops (#1957). */}
          <ProtectedRoute component={LegacyLeadIntelligenceRedirect} />
        </Route>
        <Route path="/dashboard/lead-command-center">
          <ProtectedRoute component={LegacyLeadCommandCenterRedirect} />
        </Route>
        <Route path="/dashboard/blaze">
          <Redirect to="/dashboard/content-hub?tab=blaze" />
        </Route>
        <Route path="/dashboard/merchant-applications">
          <ProtectedRoute component={MerchantApplicationsList} />
        </Route>
        <Route path="/dashboard/boarding">
          <ProtectedRoute component={BoardingTracker} />
        </Route>
        <Route path="/dashboard/onboarding-board">
          <Redirect to="/dashboard/onboarding?tab=board" />
        </Route>
        <Route path="/dashboard/merchant-portal">
          <ProtectedRoute component={MerchantPortal} />
        </Route>
        <Route path="/dashboard/merchant-health">
          <LegacyMerchantHealthRedirect />
        </Route>
        <Route path="/dashboard/chargebacks">
          <Redirect to="/dashboard/merchant-risk?tab=chargebacks" />
        </Route>
        <Route path="/dashboard/nps">
          <Redirect to="/dashboard/merchant-success?tab=nps" />
        </Route>
        <Route path="/dashboard/retention-campaigns">
          <Redirect to="/dashboard/merchant-success?tab=retention" />
        </Route>
        <Route path="/dashboard/agent-management">
          <ProtectedRoute component={AgentManagement} />
        </Route>
        <Route path="/dashboard/my-earnings">
          <ProtectedRoute component={MyEarnings} allowedRoles={["agent"]} />
        </Route>
        <Route path="/dashboard/residual-revenue">
          <LegacyFinancialChildRedirect child="revenue" />
        </Route>
        <Route path="/dashboard/referral-program">
          <ProtectedRoute component={ReferralProgram} />
        </Route>
        <Route path="/dashboard/partner-referral-pipeline">
          <ProtectedRoute component={PartnerReferralPipeline} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/partner-portal">
          <ProtectedRoute component={PartnerPortalAdmin} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/partner-orgs">
          <ProtectedRoute component={PartnerOrgs} allowedRoles={["admin"]} />
        </Route>
        <Route path="/dashboard/co-branded-proposals">
          <ProtectedRoute component={CoBrandedProposals} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/knowledge-base">
          <ProtectedRoute component={KnowledgeBase} />
        </Route>
        <Route path="/dashboard/knowledge-admin">
          <ProtectedRoute component={KnowledgeAdmin} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/consent-audit">
          <Redirect to="/dashboard/admin-hub?tab=consent" />
        </Route>
        <Route path="/dashboard/calendar">
          <Redirect to="/dashboard/tasks-appointments?tab=calendar" />
        </Route>
        <Route path="/dashboard/user-management">
          <Redirect to="/dashboard/admin-hub?tab=users" />
        </Route>
        <Route path="/dashboard/permissions">
          <Redirect to="/dashboard/admin-hub?tab=permissions" />
        </Route>
        <Route path="/dashboard/security">
          <ProtectedRoute component={SecuritySettings} />
        </Route>
        <Route path="/dashboard/settings/integrations">
          <ProtectedRoute component={SettingsIntegrations} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/settings/arbitration">
          <ProtectedRoute component={ArbitrationLog} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/forecasting">
          <LegacyFinancialChildRedirect child="forecasting" />
        </Route>
        <Route path="/dashboard/pci-assessment">
          <Redirect to="/dashboard/admin-hub?tab=pci" />
        </Route>
        <Route path="/dashboard/data-requests">
          <ProtectedRoute component={DataRequests} />
        </Route>
        <Route path="/dashboard/audit-logs">
          <Redirect to="/dashboard/admin-hub?tab=audit-log" />
        </Route>
        <Route path="/dashboard/blog-generator">
          <Redirect to="/dashboard/content-hub?tab=blog" />
        </Route>
        <Route path="/dashboard/content">
          <Redirect to="/dashboard/content-hub?tab=content" />
        </Route>
        <Route path="/dashboard/social">
          <Redirect to="/dashboard/content-hub?tab=linkedin" />
        </Route>
        <Route path="/dashboard/sdr">
          <Redirect to="/dashboard/sdr-hub?tab=sdr" />
        </Route>
        <Route path="/dashboard/sms-inbox">
          <Redirect to="/dashboard/comms-hub?tab=messages" />
        </Route>
        <Route path="/dashboard/bin-lookup">
          <ProtectedRoute component={BinLookup} />
        </Route>
        <Route path="/dashboard/round-robin">
          <ProtectedRoute component={RoundRobinAdmin} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/inbox-health">
          <Redirect to="/dashboard/deliverability-hub?tab=inbox-health" />
        </Route>
        <Route path="/dashboard/email-health">
          <Redirect to="/dashboard/deliverability-hub?tab=email-health" />
        </Route>
        <Route path="/dashboard/activation">
          <ProtectedRoute component={ActivationPanel} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/setup-wizard">
          <ProtectedRoute component={SetupWizard} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/operator">
          <LegacyOperatorRedirect />
        </Route>
        <Route path="/dashboard/seo-health">
          <Redirect to="/dashboard/system-health?tab=seo" />
        </Route>
        <Route path="/dashboard/system-readiness">
          <Redirect to="/dashboard/system-health?tab=readiness" />
        </Route>
        <Route path="/dashboard/training">
          <ProtectedRoute component={Training} />
        </Route>
        <Route path="/dashboard/leaderboard">
          <ProtectedRoute component={Leaderboard} />
        </Route>
        <Route path="/dashboard/terminal-roi">
          <LegacyFinancialChildRedirect child="terminal-roi" />
        </Route>
        <Route path="/dashboard/my-day">
          <AgentRoute component={SalesRepHome} />
        </Route>
        <Route path="/dashboard/live-chat">
          <Redirect to="/dashboard/comms-hub?tab=live-chat" />
        </Route>
        <Route path="/dashboard/document-vault">
          <ProtectedRoute component={DocumentVault} />
        </Route>
        <Route path="/dashboard/virtual-terminal">
          <Redirect to="/dashboard" />
        </Route>
        <Route path="/dashboard/ghl-sequence-guide">
          <Redirect to="/dashboard/ghl-integration?tab=sequence-guide" />
        </Route>
        <Route path="/dashboard/marketing-playbook">
          <Redirect to="/dashboard/playbooks?tab=marketing" />
        </Route>
        <Route path="/dashboard/growth-playbook">
          <Redirect to="/dashboard/playbooks?tab=growth" />
        </Route>
        <Route path="/dashboard/growth-kpi">
          <Redirect to="/dashboard/reporting?tab=growth" />
        </Route>
        <Route path="/dashboard/widget-generator">
          <ProtectedRoute component={WidgetGenerator} allowedRoles={["admin", "manager"]} />
        </Route>

        <Route path="/partners/embed-widget" component={PartnerEmbedWidget} />

        <Route path="/dashboard/cold-leads">
          <Redirect to="/dashboard/outbound-center?tab=prospects" />
        </Route>

        <Route path="/dashboard/underwriting">
          <ProtectedRoute component={UnderwritingPage} allowedRoles={["admin", "manager"]} />
        </Route>

        <Route path="/dashboard/conversation-ai">
          <Redirect to="/dashboard/sdr-hub?tab=chatbot" />
        </Route>

        {/* ─── Hub Routes ───────────────────────────────────────────────────── */}
        {/* outreach-hub retired — redirect to the unified OutboundCenter */}
        <Route path="/dashboard/outreach-hub">
          <Redirect to="/dashboard/outbound-center" />
        </Route>
        <Route path="/dashboard/ghl-integration">
          <ProtectedRoute component={GhlIntegrationHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/playbooks">
          <ProtectedRoute component={PlaybooksHub} />
        </Route>
        <Route path="/dashboard/content-hub">
          <ProtectedRoute component={ContentHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/merchant-success">
          <ProtectedRoute component={MerchantSuccessHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/portfolio">
          <ProtectedRoute component={MerchantPortfolio} />
        </Route>
        <Route path="/dashboard/support-hub">
          <ProtectedRoute component={SupportHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/comms-hub">
          <ProtectedRoute component={CommsHub} />
        </Route>
        <Route path="/dashboard/sdr-hub">
          <ProtectedRoute component={SDRHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/deliverability-hub">
          <ProtectedRoute component={DeliverabilityHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/financial-hub">
          <ProtectedRoute component={LegacyFinancialRedirect} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/system-health">
          <ProtectedRoute component={SystemHealthHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/admin-hub">
          <ProtectedRoute component={AdminHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/automation-registry">
          <ProtectedRoute component={AutomationRegistry} allowedRoles={["admin"]} />
        </Route>
        <Route path="/dashboard/nba">
          <ProtectedRoute component={NbaPriorityPage} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/merchant-risk">
          <ProtectedRoute component={MerchantRiskHub} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/launch-readiness">
          <ProtectedRoute component={LaunchReadiness} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/outbound-readiness">
          <ProtectedRoute component={OutboundReadiness} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/outbound-preflight">
          <ProtectedRoute component={OutboundPreflight} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/data-health">
          <ProtectedRoute component={DataHealth} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/data-quality">
          <ProtectedRoute component={LegacyDataQualityRedirect} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/blocked-contacts">
          <ProtectedRoute component={BlockedContacts} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/deliverability-settings">
          <ProtectedRoute component={DeliverabilitySettings} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/ghl-conflicts">
          <ProtectedRoute component={GhlConflicts} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/information-flow">
          <Redirect to="/dashboard/admin-hub?tab=info-flow" />
        </Route>
        <Route path="/dashboard/contact-census">
          <ProtectedRoute component={ContactCensus} allowedRoles={["admin"]} />
        </Route>
        <Route path="/dashboard/system-audit">
          <ProtectedRoute component={SystemAudit} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/queue-holds">
          <ProtectedRoute component={QueueHoldsPage} allowedRoles={["admin"]} />
        </Route>
        <Route path="/dashboard/lead-ops/business/:id">
          <ProtectedRoute component={BusinessDetailPage} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/lead-ops">
          <ProtectedRoute component={LeadOpsCenter} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/identity-crosswalk">
          <ProtectedRoute component={IdentityCrosswalk} allowedRoles={["admin"]} />
        </Route>
        <Route path="/dashboard/outreach-queue">
          <ProtectedRoute component={OutreachQueue} allowedRoles={["admin", "manager", "agent"]} />
        </Route>
        <Route path="/dashboard/executive">
          <ProtectedRoute component={ExecutiveDashboard} allowedRoles={["admin", "manager"]} />
        </Route>
        <Route path="/dashboard/sequence-report">
          <ProtectedRoute component={SequenceReport} allowedRoles={["admin", "manager"]} />
        </Route>
        {/* ─── Alias Redirects (legacy deep-links) ─────────────────────────── */}
        <Route path="/dashboard/ghl-workflow-ids">
          <Redirect to="/dashboard/ghl-integration?tab=workflow-ids" />
        </Route>
        <Route path="/dashboard/social-composer">
          <Redirect to="/dashboard/content-hub?tab=linkedin" />
        </Route>
        <Route path="/dashboard/blaze-integration">
          <Redirect to="/dashboard/content-hub?tab=blaze" />
        </Route>

        <Route path="/dashboard/forbidden" component={Forbidden} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function useReferralTracking() {
  const [location] = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref) {
      localStorage.setItem("lb_ref_code", ref);
      // CSRF_EXEMPT: PUBLIC_FLOW — affiliate click tracking; no session auth required
      fetch("/api/affiliate/track-click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: ref }),
      }).catch(() => {});
      fetch(`/api/partner/track/${encodeURIComponent(ref)}`).catch(() => {});
    }
  }, [location]);
}

function usePageTracking() {
  const [location] = useLocation();
  useEffect(() => {
    captureUTMParams();
    trackPageView(location);
  }, [location]);
}

/**
 * Routes that must NOT receive the .marketing-theme shell (P0-2).
 * Tokenised portals, auth, dashboard, mobile CRM, and thanks pages
 * must use the app's own token context, not the brand-light marketing overrides.
 */
const NON_MARKETING_PREFIXES = [
  "/dashboard",
  "/mobile",
  "/proposal/",
  "/co-branded-proposal/",
  "/savings/",       // tokenised savings page — not /savings-calculator
  "/statement-upload/",
  "/activate-portal",
  "/activate-rep",
  "/partner-portal",
  "/partner-login",
  "/merchant-application",
  "/nps/",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/thanks/",
];

function isMarketingRoute(loc: string): boolean {
  return !NON_MARKETING_PREFIXES.some((p) =>
    p.endsWith("/")
      ? loc.startsWith(p) || loc === p.slice(0, -1)
      : loc === p || loc.startsWith(p + "/")
  );
}

function PublicLayout() {
  const [location] = useLocation();
  useReferralTracking();
  usePageTracking();
  const isDashboard = location.startsWith("/dashboard");
  const isThanksPage = location.startsWith("/thanks");
  const isAuthPage = location === "/login" || location === "/forgot-password" || location === "/reset-password" || location === "/verify-email";
  const isMobile = location.startsWith("/mobile");
  const isUploadStatement = location.startsWith("/upload-statement");
  const isMarketing = isMarketingRoute(location);

  const inner = (
    <>
      <ErrorBoundary key={location}>
        <Router />
      </ErrorBoundary>
      {!isDashboard && !isThanksPage && !isAuthPage && !isMobile && !isUploadStatement && <StickyMobileCTA />}
      {!isDashboard && !isAuthPage && !isMobile && <CookieConsent />}
      {/* GHL chat widget loaded via index.html script tag */}
    </>
  );

  return isMarketing ? <PublicThemeShell>{inner}</PublicThemeShell> : inner;
}

function App() {
  return (
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <ErrorBoundary>
              <PublicLayout />
            </ErrorBoundary>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </HelmetProvider>
  );
}

export default App;
