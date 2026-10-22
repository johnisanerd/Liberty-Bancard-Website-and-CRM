import { ReactNode, useState, useMemo, useEffect, useCallback } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { peopleHubState } from "@/lib/crm-destination-state";
import { useIsMobile } from "@/hooks/use-mobile";
import Forbidden from "@/pages/Forbidden";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { countUnreadSessions } from "@/lib/chatNotifications";
import logoBlue from "@assets/logo-blue.png";
import logoWhite from "@assets/logo-white.png";
import UniversalSearch from "@/components/UniversalSearch";
import { InternalSidebarChat } from "@/components/InternalSidebarChat";
import { DashboardDataAgent } from "@/components/DashboardDataAgent";
import { EmailComposer } from "@/components/EmailComposer";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TourProvider } from "@/components/tour/TourProvider";
import { useTour } from "@/components/tour/TourContext";
import {
  LayoutDashboard,
  Users,
  Ticket,
  MessageSquare,
  MessageCircle,
  LogOut,
  TrendingUp,
  Package,
  ClipboardList,
  Bell,
  PhoneCall,
  FileCheck,
  Rocket,
  Zap,
  FileQuestion,
  ListChecks,
  Settings,
  BarChart3,
  BookOpen,
  Target,
  Upload,
  Send,
  Mail,
  PieChart,
  GitBranch,
  Repeat,
  Brain,
  ListOrdered,
  Megaphone,
  Sparkles,
  FileSearch,
  FileBarChart,
  Trophy,
  DollarSign,
  UserPlus,
  HeartPulse,
  Handshake,
  Star,
  ShieldCheck,
  HelpCircle,
  UserCog,
  Calendar,
  CalendarDays,
  Bot,
  Mailbox,
  Rocket as RocketIcon,
  Activity,
  Search as SearchIcon,
  Workflow,
  GraduationCap,
  Link2,
  ShieldAlert,
  CreditCard,
  ArrowRightLeft,
  Inbox,
  FolderOpen,
  X,
  ShieldOff,
  FileText,
  Code2,
  Monitor,
  Database,
  FlaskConical,
  LineChart,
  ChevronDown,
  ChevronRight,
  Wrench,
  Eye,
  EyeOff,
  Briefcase,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { activeSidebarId, employeeSidebarFor, type SidebarIconKey } from "@/lib/employee-sidebar";
import { PageHeadingOwnerProvider, usePageHeadingClaimed } from "@/components/ui/page-header";
import { EmployeeCrmProvider } from "@/components/crm/employee-crm-context";
import { canShowMerchantOperationsNav, MerchantOperationsLayout } from "@/components/crm/MerchantOperationsNav";

export interface DashboardLayoutProps {
  children: ReactNode;
}

// Public export — wraps DashboardLayoutInner in TourProvider so that
// the tour ? button (inside the header) can call useTour().
export function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <TourProvider>
      <PageHeadingOwnerProvider>
        <DashboardLayoutInner>{children}</DashboardLayoutInner>
      </PageHeadingOwnerProvider>
    </TourProvider>
  );
}

type UserRole = "admin" | "manager" | "agent" | "merchant";

interface MenuItem {
  icon: any;
  label: string;
  href: string;
  roles?: UserRole[];
  badgeKey?: string;
}

const DEV_MODE_KEY = "sidebar_dev_mode";

const employeeSidebarIcons: Record<SidebarIconKey, any> = {
  today: LayoutDashboard, records: Users, pipeline: TrendingUp, inbox: Inbox, work: ClipboardList,
  merchant: Briefcase, prospecting: Target, campaigns: Megaphone, reports: BarChart3,
  administration: UserCog, resources: BookOpen,
};

// ─── DAILY WORK ────────────────────────────────────────────────────────────────
const dailyWorkItems: MenuItem[] = [
  // Admin/Manager
  { icon: LayoutDashboard, label: "Overview",             href: "/dashboard",                    roles: ["admin", "manager"] },
  { icon: Users,           label: "Contacts & Leads",     href: "/dashboard/contacts-leads",     roles: ["admin", "manager"] },
  { icon: TrendingUp,      label: "Pipeline",             href: "/dashboard/pipeline",           roles: ["admin", "manager"] },
  { icon: Inbox,           label: "Messages & Inbox",     href: "/dashboard/comms-hub",          roles: ["admin", "manager"], badgeKey: "smsUnread" },
  { icon: ClipboardList,   label: "Tasks & Appointments", href: "/dashboard/tasks-appointments", roles: ["admin", "manager"], badgeKey: "overdueTaskCount" },
  { icon: Brain,           label: "AI Advisor",           href: "/dashboard/chat",               roles: ["admin", "manager"] },
  // Agent
  { icon: Star,            label: "My Day",               href: "/dashboard/my-day",             roles: ["agent"] },
  { icon: Rocket,          label: "Ready for Outreach",   href: "/dashboard/outreach-queue",     roles: ["agent"], badgeKey: "outreachQueueCount" },
  { icon: Briefcase,       label: "My Portfolio",         href: "/dashboard/portfolio",          roles: ["agent"] },
  { icon: Users,           label: "My Contacts",          href: "/dashboard/contacts",           roles: ["agent"] },
  { icon: Target,          label: "My Leads",             href: "/dashboard/my-leads",           roles: ["agent"] },
  { icon: TrendingUp,      label: "My Pipeline",          href: "/dashboard/pipeline",           roles: ["agent"] },
  { icon: Inbox,           label: "Messages & Inbox",     href: "/dashboard/comms-hub",          roles: ["agent"], badgeKey: "smsUnread" },
  { icon: ClipboardList,   label: "Tasks & Appointments", href: "/dashboard/tasks-appointments", roles: ["agent"], badgeKey: "overdueTaskCount" },
  { icon: Brain,           label: "AI Advisor",           href: "/dashboard/chat",               roles: ["agent"] },
  { icon: DollarSign,      label: "My Earnings",          href: "/dashboard/my-earnings",        roles: ["agent"] },
];

// toolsItems reserved for future per-role tool links
const toolsItems: MenuItem[] = [];

// ─── MERCHANT OPS ─────────────────────────────────────────────────────────────
const merchantOpsItems: MenuItem[] = [
  { icon: ShieldCheck,   label: "My Portal",        href: "/dashboard/merchant-portal",       roles: ["merchant"] },
  { icon: Briefcase,     label: "Portfolio",         href: "/dashboard/portfolio",             roles: ["admin", "manager"] },
  { icon: ClipboardList, label: "Applications",      href: "/dashboard/merchant-applications", roles: ["admin", "manager"], badgeKey: "pendingApplications" },
  { icon: FileBarChart,  label: "Statement Reviews", href: "/dashboard/statement-review",      roles: ["admin", "manager"] },
  { icon: FolderOpen,    label: "Documents",         href: "/dashboard/document-vault",        roles: ["admin", "manager"] },
  { icon: ShieldCheck,   label: "Underwriting",      href: "/dashboard/underwriting",          roles: ["admin", "manager"] },
  // Onboarding + Onboarding Kickoff consolidated into a single entry;
  // the Onboarding page header has a direct "Onboarding Kickoff" button.
  { icon: Package,       label: "Onboarding",        href: "/dashboard/onboarding",            roles: ["admin", "manager"] },
  { icon: ShieldAlert,   label: "Merchant Risk",     href: "/dashboard/merchant-risk",         roles: ["admin", "manager"] },
  { icon: Send,          label: "Boarding",          href: "/dashboard/boarding",              roles: ["admin", "manager"] },
];

// ─── OUTBOUND ─────────────────────────────────────────────────────────────────
// Command / Campaigns / Sequences / Prospects / Analytics all live under OutboundCenter tabs.
// Sunbiz Lead Gen and Outreach Command are accessible within OutboundCenter's Command tab.
const outboundItems: MenuItem[] = [
  { icon: GitBranch, label: "Canonical Enrichment", href: "/dashboard/canonical-enrichment", roles: ["admin", "manager"] },
  { icon: Database, label: "Lead Ops Center",    href: "/dashboard/lead-ops",        roles: ["admin", "manager"] },
  { icon: Rocket,   label: "Ready for Outreach", href: "/dashboard/outreach-queue",  roles: ["admin", "manager"], badgeKey: "outreachQueueCount" },
  { icon: Zap,      label: "Outreach",            href: "/dashboard/outbound-center", roles: ["admin", "manager"] },
  { icon: Upload,   label: "Lead Imports",        href: "/dashboard/lead-imports",    roles: ["admin", "manager"] },
];

// ─── REPORTS & SETTINGS ───────────────────────────────────────────────────────
// Financial Hub is accessible as the "Financial" tab within ReportingHub.
// Agent Management, Integrations, and GHL Integration are tabs within AdminHub (Settings).
// Referral Program and Partner Orgs moved to the collapsible Partners section below.
const reportsSettingsItems: MenuItem[] = [
  { icon: BarChart3,  label: "Reports",    href: "/dashboard/reporting",   roles: ["admin", "manager"] },
  { icon: Trophy,     label: "Leaderboard", href: "/dashboard/leaderboard", roles: ["admin", "manager", "agent"] },
  { icon: Settings,   label: "Settings",   href: "/dashboard/admin-hub",   roles: ["admin", "manager"] },
];

// ─── PARTNERS (collapsible) ────────────────────────────────────────────────────
const partnersItems: MenuItem[] = [
  { icon: Handshake, label: "Referral Program", href: "/dashboard/referral-program",      roles: ["admin", "manager"] },
  { icon: Link2,     label: "Partner Orgs",     href: "/dashboard/partner-orgs",          roles: ["admin"] },
];

// ─── RESOURCES (collapsible) ───────────────────────────────────────────────────
const resourcesItems: MenuItem[] = [
  { icon: BookOpen,    label: "Playbooks",     href: "/dashboard/playbooks",    roles: ["admin", "manager", "agent"] },
  { icon: BookOpen,    label: "Collateral",    href: "/assets",                 roles: ["agent"] },
  { icon: HelpCircle,  label: "Knowledge Base", href: "/dashboard/knowledge-base" },
  { icon: GraduationCap, label: "Training",    href: "/dashboard/training",     roles: ["admin", "manager", "agent"] },
  { icon: ShieldCheck, label: "Security",      href: "/dashboard/security",     roles: ["admin", "manager", "agent", "merchant"] },
];

// ─── DEV MODE: ADVANCED TOOLS ──────────────────────────────────────────────────
// Shown only when admin dev-mode toggle is on. All routes still work when navigated directly.
const devModeLeadEngineItems: MenuItem[] = [
  { icon: Bot,        label: "SDR Hub",             href: "/dashboard/sdr-hub",             roles: ["admin", "manager"] },
  { icon: Brain,      label: "Lead Command Center", href: "/dashboard/lead-command-center", roles: ["admin", "manager"] },
  { icon: Sparkles,   label: "Lead Intelligence",   href: "/dashboard/lead-intelligence",   roles: ["admin", "manager"] },
  { icon: CreditCard, label: "Card BIN Lookup",     href: "/dashboard/bin-lookup",          roles: ["admin", "manager", "agent"] },
  { icon: PhoneCall,  label: "Call Outcome",        href: "/dashboard/call-outcome",        roles: ["admin", "manager", "agent"] },
  { icon: FileCheck,  label: "Review Complete",     href: "/dashboard/review-complete",     roles: ["admin", "manager", "agent"] },
  { icon: Target,     label: "Prospects",           href: "/dashboard/prospects",           roles: ["admin", "manager"] },
];

const devModeAutomationItems: MenuItem[] = [
  { icon: BarChart3,      label: "Automation Overview", href: "/dashboard/automation",         roles: ["admin", "manager"] },
  { icon: Zap,            label: "GHL Workflows",       href: "/dashboard/workflows",          roles: ["admin", "manager"] },
  { icon: ListOrdered,    label: "Sequences",           href: "/dashboard/sequences",          roles: ["admin", "manager"] },
  { icon: Megaphone,      label: "Campaigns",           href: "/dashboard/campaigns",          roles: ["admin", "manager"] },
  { icon: FileBarChart,   label: "Sequence Report",     href: "/dashboard/sequence-report",    roles: ["admin", "manager"] },
  { icon: GitBranch,      label: "Stage Rules",         href: "/dashboard/stage-rules",        roles: ["admin", "manager"] },
  { icon: Mail,           label: "Outbound Health",     href: "/dashboard/deliverability-hub", roles: ["admin", "manager"] },
  { icon: RocketIcon,     label: "Go-Live Controls",    href: "/dashboard/activation",         roles: ["admin", "manager"] },
  { icon: FlaskConical,   label: "Setup Wizard",        href: "/dashboard/setup-wizard",       roles: ["admin", "manager"] },
  { icon: ArrowRightLeft, label: "Round-Robin",         href: "/dashboard/round-robin",        roles: ["admin", "manager"] },
  { icon: Database,       label: "Data Requests",       href: "/dashboard/data-requests",      roles: ["admin", "manager"] },
  { icon: Activity,       label: "System Audit",        href: "/dashboard/system-audit",       roles: ["admin", "manager"] },
  { icon: Monitor,        label: "System Operations",   href: "/dashboard/system-health",      roles: ["admin", "manager"] },
];

const devModeGrowthItems: MenuItem[] = [
  { icon: UserPlus,   label: "Agent Management",   href: "/dashboard/agent-management",          roles: ["admin", "manager"] },
  { icon: Handshake,  label: "Referral Program",   href: "/dashboard/referral-program",          roles: ["admin", "manager"] },
  { icon: Link2,      label: "Partner Referrals",  href: "/dashboard/partner-referral-pipeline", roles: ["admin", "manager"] },
  { icon: HeartPulse, label: "Merchant Success",   href: "/dashboard/merchant-success",          roles: ["admin", "manager"] },
  { icon: BookOpen,   label: "Case Study Intake",  href: "/dashboard/case-study-intake",         roles: ["admin", "manager"] },
  { icon: Code2,      label: "Widget Generator",   href: "/dashboard/widget-generator",          roles: ["admin", "manager"] },
  { icon: Bot,        label: "AI Knowledge Admin", href: "/dashboard/knowledge-admin",           roles: ["admin", "manager"] },
  { icon: Ticket,     label: "Support Hub",        href: "/dashboard/support-hub",               roles: ["admin", "manager"] },
];

const devModeSystemItems: MenuItem[] = [
  { icon: Workflow,   label: "GHL Integration",  href: "/dashboard/ghl-integration",      roles: ["admin", "manager"] },
  { icon: FileText,   label: "Content Hub",      href: "/dashboard/content-hub",          roles: ["admin", "manager"] },
  { icon: UserCog,    label: "Admin Hub",        href: "/dashboard/admin-hub",            roles: ["admin", "manager"] },
  { icon: Database,   label: "Data Requests",    href: "/dashboard/data-requests",        roles: ["admin", "manager"] },
  { icon: Settings,   label: "Integrations",     href: "/dashboard/settings/integrations", roles: ["admin", "manager"] },
  { icon: UserPlus,   label: "Agent Management", href: "/dashboard/agent-management",     roles: ["admin", "manager"] },
];

function filterByRole(items: MenuItem[], role: UserRole): MenuItem[] {
  return items.filter((item) => !item.roles || item.roles.includes(role));
}

const TWO_FA_BANNER_KEY = "2fa_banner_dismissed";

function GhlAlertBanner({ role }: { role: UserRole }) {
  const isPrivileged = role === "admin" || role === "manager";
  const [dismissed, setDismissed] = useState(false);

  const { data } = useQuery<{ connected: boolean; status: "ok" | "expired" | "unconfigured"; error?: string; locationName?: string }>({
    queryKey: ["/api/admin/ghl-health"],
    enabled: isPrivileged && !dismissed,
    refetchInterval: 60_000,
    retry: false,
    staleTime: 25_000,
  });

  if (!isPrivileged || dismissed || !data || data.status === "ok") return null;

  const isUnconfigured = data.status === "unconfigured";

  return (
    <div
      data-testid="banner-ghl-alert"
      className="flex items-start gap-3 px-4 py-3 text-sm bg-red-50 dark:bg-red-950 text-red-900 dark:text-red-100 border-b border-red-200 dark:border-red-800"
      role="alert"
    >
      <Workflow className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
      <span className="flex-1">
        {isUnconfigured ? (
          <>
            <strong>GHL not configured.</strong>{" "}
            Set <code className="text-xs bg-red-100 dark:bg-red-900 px-1 rounded">GHL_PRIVATE_INTEGRATION_TOKEN</code> and{" "}
            <code className="text-xs bg-red-100 dark:bg-red-900 px-1 rounded">GHL_LOCATION_ID</code> in Replit Secrets to enable sync.
          </>
        ) : (
          <>
            <strong>GHL token expired or rejected.</strong>{" "}
            {data.error && <span className="opacity-80">{data.error}. </span>}
            To fix: go to{" "}
            <a
              href="https://app.gohighlevel.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold hover:opacity-80"
              data-testid="link-ghl-ext-regen"
            >
              app.gohighlevel.com
            </a>
            {" "}→ Settings → Private Integrations → regenerate token → update{" "}
            <code className="text-xs bg-red-100 dark:bg-red-900 px-1 rounded">GHL_PRIVATE_INTEGRATION_TOKEN</code>.
          </>
        )}
      </span>
      <Link
        href="/dashboard/ghl-integration"
        data-testid="link-ghl-banner-fix"
        className="underline underline-offset-2 font-semibold text-red-800 dark:text-red-200 hover:opacity-80 whitespace-nowrap shrink-0"
      >
        GHL Settings
      </Link>
      <button
        onClick={() => setDismissed(true)}
        data-testid="button-ghl-banner-dismiss"
        aria-label="Dismiss GHL alert until next page load"
        className="ml-1 p-0.5 rounded hover:opacity-70 shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function TwoFaBanner({ role }: { role: UserRole }) {
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined" && localStorage.getItem(TWO_FA_BANNER_KEY) === "true"
  );

  const handleDismiss = () => {
    localStorage.setItem(TWO_FA_BANNER_KEY, "true");
    setDismissed(true);
  };

  if (dismissed) return null;

  const isAdmin = role === "admin";

  return (
    <div
      data-testid="banner-2fa-enrollment"
      className={
        isAdmin
          ? "flex items-center gap-3 px-4 py-3 text-sm font-medium bg-destructive text-destructive-foreground"
          : "flex items-center gap-3 px-4 py-2.5 text-sm bg-amber-50 dark:bg-amber-950 text-amber-900 dark:text-amber-100 border-b border-amber-200 dark:border-amber-800"
      }
    >
      <ShieldOff className="w-4 h-4 shrink-0" />
      <span className="flex-1">
        {isAdmin
          ? "Security warning: Your admin account does not have two-factor authentication enabled. Enable 2FA immediately to protect your account."
          : "Protect your account by enabling two-factor authentication (2FA)."}
      </span>
      <Link
        href="/dashboard/security"
        data-testid="link-2fa-banner-setup"
        className={
          isAdmin
            ? "underline underline-offset-2 font-semibold hover:opacity-80 whitespace-nowrap"
            : "underline underline-offset-2 font-semibold text-amber-800 dark:text-amber-200 hover:opacity-80 whitespace-nowrap"
        }
      >
        Set up 2FA
      </Link>
      <button
        onClick={handleDismiss}
        data-testid="button-2fa-banner-dismiss"
        aria-label="Dismiss 2FA banner"
        className="ml-1 p-0.5 rounded hover:opacity-70 shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

const MOBILE_REDIRECT_KEY = "desktop_preferred";

// Inner component — lives inside TourProvider so it can call useTour().
function DashboardLayoutInner({ children }: DashboardLayoutProps) {
  const { openTour } = useTour();
  const [location, setLocation] = useLocation();
  const isMobile = useIsMobile();
  const mobileDesktopOptOut = typeof window !== "undefined" && localStorage.getItem("prefer_desktop") === "true";
  const { logout, user } = useAuth();

  // Redirect mobile browsers to the native mobile shell unless the user
  // has explicitly opted into desktop view.
  useEffect(() => {
    const optedOut = localStorage.getItem("prefer_desktop") === "true";
    if (isMobile && !optedOut) setLocation("/mobile");
  }, [isMobile, setLocation]);
  const [emailOpen, setEmailOpen] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [partnersOpen, setPartnersOpen] = useState(false);
  const role = (user?.role as UserRole) || "merchant";
  const isEmployeeCrm = ["admin", "manager", "agent"].includes(role)
    && location.startsWith("/dashboard")
    && !location.startsWith("/dashboard/merchant-portal")
    && !location.startsWith("/dashboard/mobile")
    && (!isMobile || mobileDesktopOptOut);
  const isContactRecordRoute = /^\/dashboard\/contacts\/[^/]+/.test(location);
  const adoptedSearch=useSearch();
  const isPeopleRoute = location === "/dashboard/contacts" || (location === "/dashboard/contacts-leads"
    && peopleHubState(adoptedSearch).value==="people");
  // The shell title is the fallback page heading. Any mounted page or hub that renders its own level-1 heading
  // claims ownership (see PageTitle / PageHeader / CrmPageHeader), and the shell then shows plain text.
  const pageHeadingClaimed = usePageHeadingClaimed();

  // Admin dev-mode toggle — persisted in localStorage; off by default
  const [devMode, setDevMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(DEV_MODE_KEY) === "true";
  });
  const isPrivileged = role === "admin" || role === "manager";

  const toggleDevMode = useCallback(() => {
    setDevMode((prev) => {
      const next = !prev;
      localStorage.setItem(DEV_MODE_KEY, String(next));
      return next;
    });
  }, []);

  // #348 — Online/offline status indicator
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const { data: smsUnreadData } = useQuery<{ count: number }>({
    queryKey: ["/api/sms-inbox/unread-count"],
    refetchInterval: 60000,
    enabled: ["admin", "manager", "agent"].includes(role),
  });
  const smsUnreadCount = smsUnreadData?.count || 0;

  const { data: pendingAppsData } = useQuery<{ count: number }>({
    queryKey: ["/api/merchant-applications/pending-count"],
    refetchInterval: 60000,
    enabled: ["admin", "manager"].includes(role),
  });
  const pendingApplicationsCount = pendingAppsData?.count || 0;

  const { data: notifCountData } = useQuery<{ unread: number }>({
    queryKey: ["/api/notifications/count"],
    refetchInterval: 30000,
    enabled: ["admin", "manager", "agent"].includes(role),
  });
  const notificationsUnreadCount = notifCountData?.unread || 0;

  const { data: liveChatSessions = [] } = useQuery<Array<{ id: number; lastMessageAt: string; status: string }>>({
    queryKey: ["/api/live-chat/sessions", "active"],
    queryFn: async () => {
      const res = await fetch("/api/live-chat/sessions?status=active", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 8000,
    enabled: ["admin", "manager", "agent"].includes(role),
  });

  const [liveChatUnreadCount, setLiveChatUnreadCount] = useState(0);
  useEffect(() => {
    setLiveChatUnreadCount(countUnreadSessions(liveChatSessions));
  }, [liveChatSessions]);

  // #385 — Overdue task badge in sidebar
  const { data: overdueTasksData } = useQuery<{ count: number }>({
    queryKey: ["/api/tasks/overdue-count"],
    refetchInterval: 60000,
    enabled: ["admin", "manager", "agent"].includes(role),
  });
  const overdueTaskCount = overdueTasksData?.count || 0;

  // #1493 — Ready-for-Outreach queue badge
  const { data: outreachQueueData } = useQuery<{ count: number }>({
    queryKey: ["/api/outreach-queue/count"],
    refetchInterval: 120000,
    enabled: ["admin", "manager", "agent"].includes(role),
  });
  const outreachQueueCount = outreachQueueData?.count || 0;

  // #487 — Update page title with unread count (after counts are declared)
  useEffect(() => {
    const total = (notificationsUnreadCount || 0) + (smsUnreadCount || 0);
    document.title = total > 0 ? `(${total}) Liberty Bancard` : "Liberty Bancard";
  }, [notificationsUnreadCount, smsUnreadCount]);

  const badges: Record<string, number> = {
    smsUnread: smsUnreadCount,
    notificationsUnread: notificationsUnreadCount,
    liveChatUnread: liveChatUnreadCount,
    pendingApplications: pendingApplicationsCount,
    overdueTaskCount,
    outreachQueueCount,
  };

  // #207 — Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // "/" — focus universal search (skip when typing in an input/textarea)
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName ?? "")) {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('[data-testid="universal-search-input"]');
        searchInput?.focus();
      }
      // "n" — open new contact dialog from anywhere (#242)
      if (e.key === "n" && !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName ?? "")) {
        e.preventDefault();
        const addBtn = document.querySelector<HTMLButtonElement>('[data-testid="button-add-contact-trigger"]');
        addBtn?.click();
      }
      // "g c" sequence — go to contacts
      if (e.key === "g" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName ?? "")) {
        const next = (e2: KeyboardEvent) => {
          if (e2.key === "c") setLocation("/dashboard/contacts");
          if (e2.key === "p") setLocation("/dashboard/pipeline");
          if (e2.key === "h") setLocation("/dashboard");
          document.removeEventListener("keydown", next);
        };
        document.addEventListener("keydown", next, { once: true });
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setLocation]);

  // Agent virtual terminal — only if user has permission
  const filteredAgentTools = useMemo(() => {
    if (role !== "agent") return [];
    const perms: string[] = user?.permissions ?? [];
    return perms.includes("virtual_terminal") ? toolsItems : [];
  }, [role, user]);

  // All sidebar items flat list for header label lookup
  const allItems = useMemo(() => [
    ...dailyWorkItems, ...toolsItems, ...merchantOpsItems, ...outboundItems,
    ...reportsSettingsItems, ...partnersItems, ...resourcesItems,
    ...devModeLeadEngineItems, ...devModeAutomationItems,
    ...devModeGrowthItems, ...devModeSystemItems,
  ], []);

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  // Find label for the current route
  const currentLabel = allItems.find((i) => i.href === location)?.label || "Dashboard";

  const renderGroup = (label: string, items: MenuItem[]) => {
    const filtered = filterByRole(items, role);
    if (filtered.length === 0) return null;
    return (
      <SidebarGroup>
        <SidebarGroupLabel>{label}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {filtered.map((item) => {
              const Icon = item.icon;
              const isActive = location === item.href ||
                (item.href !== "/dashboard" && location.startsWith(item.href + "?"));
              const badgeCount = item.badgeKey ? (badges[item.badgeKey] || 0) : 0;
              return (
                <SidebarMenuItem key={item.href + item.label}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    data-testid={`link-sidebar-${item.label.toLowerCase().replace(/[\s&/]+/g, "-")}`}
                  >
                    <Link href={item.href}>
                      <Icon className="w-4 h-4" />
                      <span className="flex-1">{item.label}</span>
                      {badgeCount > 0 && (
                        <span
                          className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground"
                          data-testid={`badge-sidebar-${item.badgeKey}`}
                        >
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  };

  // Partners group — collapsible (Referral Program + Partner Orgs)
  const renderPartnersGroup = () => {
    const filtered = filterByRole(partnersItems, role);
    if (filtered.length === 0) return null;
    return (
      <SidebarGroup>
        <button
          onClick={() => setPartnersOpen((o) => !o)}
          className="flex items-center w-full px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={partnersOpen}
          data-testid="button-sidebar-partners-toggle"
        >
          <span className="flex-1 text-left">Partners</span>
          {partnersOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {partnersOpen && (
          <SidebarGroupContent>
            <SidebarMenu>
              {filtered.map((item) => {
                const Icon = item.icon;
                const isActive = location === item.href;
                return (
                  <SidebarMenuItem key={item.href + item.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`link-sidebar-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <Link href={item.href}>
                        <Icon className="w-4 h-4" />
                        <span className="flex-1">{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        )}
      </SidebarGroup>
    );
  };

  // Resources group — collapsible
  const renderResourcesGroup = () => {
    const filtered = filterByRole(resourcesItems, role);
    if (filtered.length === 0) return null;
    return (
      <SidebarGroup>
        <button
          onClick={() => setResourcesOpen((o) => !o)}
          className="flex items-center w-full px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={resourcesOpen}
          data-testid="button-sidebar-resources-toggle"
        >
          <span className="flex-1 text-left">Resources</span>
          {resourcesOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {resourcesOpen && (
          <SidebarGroupContent>
            <SidebarMenu>
              {filtered.map((item) => {
                const Icon = item.icon;
                const isActive = location === item.href;
                return (
                  <SidebarMenuItem key={item.href + item.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`link-sidebar-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <Link href={item.href}>
                        <Icon className="w-4 h-4" />
                        <span className="flex-1">{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        )}
      </SidebarGroup>
    );
  };

  // Final employee shell: eleven destinations in fixed order, filtered by role.
  const isEmployeeRole = role === "admin" || role === "manager" || role === "agent";
  const renderEmployeeNav = () => {
    const items = employeeSidebarFor(role);
    const activeId = activeSidebarId(role, location);
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu aria-label="Employee navigation" data-testid="nav-employee-sidebar">
            {items.map(({ entry, href }) => {
              const Icon = employeeSidebarIcons[entry.icon];
              const badgeCount = entry.badgeKey ? (badges[entry.badgeKey] || 0) : 0;
              const isActive = activeId === entry.id;
              return (
                <SidebarMenuItem key={entry.id}>
                  <SidebarMenuButton asChild isActive={isActive} data-testid={`link-sidebar-${entry.id}`}>
                    <Link href={href} aria-current={isActive ? "page" : undefined}>
                      <Icon className="w-4 h-4" />
                      <span className="flex-1">{entry.label}</span>
                      {badgeCount > 0 && (
                        <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground"
                          data-testid={`badge-sidebar-${entry.badgeKey}`} aria-label={`${badgeCount} need attention`}>
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  };

  // Agent daily work includes their VT if permitted
  const agentDailyWork = useMemo(
    () => [...filterByRole(dailyWorkItems, role), ...filteredAgentTools],
    [role, filteredAgentTools]
  );

  return (
    <EmployeeCrmProvider enabled={isEmployeeCrm}>
    <SidebarProvider style={style as React.CSSProperties}>
      <div className={`flex h-screen w-full${isEmployeeCrm ? " crm-theme" : ""}`}>
        <Sidebar>
          <SidebarHeader className="p-4 border-b">
            <Link href="/" data-testid="link-sidebar-logo">
              {isEmployeeCrm ? (
                <>
                  {/* Approved inverse wordmark for the dark employee sidebar; the navy one disappears on navy. */}
                  <img src={logoBlue} alt="Liberty Bancard" className="h-8 w-auto dark:hidden" data-testid="img-sidebar-logo-light" />
                  <img src={logoWhite} alt="Liberty Bancard" className="hidden h-8 w-auto dark:block" data-testid="img-sidebar-logo-dark" />
                </>
              ) : (
                <img src={logoBlue} alt="Liberty Bancard" className="h-8 w-auto" />
              )}
            </Link>
          </SidebarHeader>

          <SidebarContent>
            {isEmployeeRole ? renderEmployeeNav() : (
              <>
                {renderGroup("MERCHANT OPS", merchantOpsItems)}
                {renderResourcesGroup()}
              </>
            )}

            {/* Legacy and advanced entrances stay reachable behind the Dev Mode toggle (nothing is deleted). */}
            {isPrivileged && devMode && (
              <>
                {renderGroup("LEGACY: DAILY WORK", dailyWorkItems)}
                {renderGroup("LEGACY: MERCHANT OPS", merchantOpsItems)}
                {renderGroup("LEGACY: OUTBOUND", outboundItems)}
                {renderGroup("LEGACY: REPORTS", reportsSettingsItems)}
                {renderPartnersGroup()}
                {renderResourcesGroup()}
                {renderGroup("LEAD ENGINE", devModeLeadEngineItems)}
                {renderGroup("AUTOMATION", devModeAutomationItems)}
                {renderGroup("GROWTH & PARTNERS", devModeGrowthItems)}
                {renderGroup("SYSTEM", devModeSystemItems)}
              </>
            )}
          </SidebarContent>

          <SidebarFooter className="p-4 border-t">
            <div className="flex items-center gap-3 px-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                {user?.firstName?.[0] || "U"}
              </div>
              <div className="overflow-hidden flex-1">
                <div className="text-sm font-medium truncate" data-testid="text-user-name">
                  {user?.firstName} {user?.lastName}
                </div>
                <div className="text-xs text-muted-foreground truncate" data-testid="text-user-email">
                  {user?.email}
                </div>
              </div>
            </div>

            {/* Admin dev-mode toggle — reveals all legacy/technical pages in sidebar */}
            {isPrivileged && (
              <div className="px-2 mb-2">
                <button
                  onClick={toggleDevMode}
                  data-testid="button-sidebar-dev-mode"
                  title={devMode ? "Dev mode on — showing all pages. Click to hide advanced items." : "Dev mode off — click to show all pages including legacy tools."}
                  className={`flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors ${
                    devMode
                      ? "bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-900"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  <Wrench className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 text-left">{devMode ? "Dev Mode: On" : "Dev Mode"}</span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${devMode ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
                </button>
              </div>
            )}

            <SidebarMenu>
              {isEmployeeRole && (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild data-testid="link-sidebar-ai-advisor">
                      <Link href="/dashboard/chat"><Brain className="w-4 h-4" /><span>AI Advisor</span></Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {role === "agent" && (
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild data-testid="link-sidebar-my-leads">
                        <Link href="/dashboard/my-leads"><Target className="w-4 h-4" /><span>My Leads</span></Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild data-testid="link-sidebar-security">
                      <Link href="/dashboard/security"><ShieldCheck className="w-4 h-4" /><span>Account security</span></Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </>
              )}
              {["admin", "manager", "agent"].includes(role) && (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={openTour} data-testid="button-sidebar-replay-tour">
                    <HelpCircle className="w-4 h-4" />
                    <span>Replay Tour</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => logout()} data-testid="button-logout">
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="h-14 bg-background border-b flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6 sticky top-0 z-50">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <SidebarTrigger data-testid="button-sidebar-toggle" className="shrink-0" />
              {pageHeadingClaimed ? (
                <div className="font-display font-semibold text-base sm:text-lg truncate" data-testid="text-page-title" aria-label={currentLabel}>
                  {currentLabel}
                </div>
              ) : (
                <h1 className="font-display font-semibold text-base sm:text-lg truncate" data-testid="text-page-title">
                  {currentLabel}
                </h1>
              )}
            </div>
            <div className="flex items-center gap-1 sm:gap-2 min-w-0">
              <div className="min-w-0">
                <UniversalSearch />
              </div>
              <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                {/* #348 — Online/offline badge */}
                {!isOnline && (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-destructive font-medium shrink-0"
                    data-testid="badge-offline"
                    title="You are offline"
                  >
                    <WifiOff className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Offline</span>
                  </span>
                )}
                <Link
                  href="/dashboard/notifications"
                  className="relative inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-accent hover:text-accent-foreground h-9 w-9"
                  aria-label={`Notifications (${notificationsUnreadCount} unread)`}
                  data-testid="button-topbar-notifications"
                >
                  <Bell className="w-4 h-4" />
                  {notificationsUnreadCount > 0 && (
                    <span
                      className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground"
                      data-testid="badge-topbar-notifications"
                    >
                      {notificationsUnreadCount > 99 ? "99+" : notificationsUnreadCount}
                    </span>
                  )}
                </Link>
                <ThemeToggle />
                {["admin", "manager", "agent"].includes(role) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={openTour}
                    aria-label="Open onboarding tour"
                    title="Help — replay onboarding tour"
                    data-testid="button-tour-help"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </Button>
                )}
                <Button size="icon" variant="ghost" onClick={() => setEmailOpen(true)} aria-label="Compose email" data-testid="button-compose-email">
                  <Mail className="w-4 h-4" />
                </Button>
                {["admin", "manager", "agent"].includes(role) && (
                  <Button
                    size="icon"
                    variant={aiChatOpen ? "default" : "ghost"}
                    onClick={() => setAiChatOpen(o => !o)}
                    aria-label="Toggle AI Assistant"
                    data-testid="button-ai-assistant-toggle"
                  >
                    <Bot className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          </header>
          <EmailComposer open={emailOpen} onClose={() => setEmailOpen(false)} />
          {user && !user.totpEnabled && (
            <TwoFaBanner role={role} />
          )}
          <GhlAlertBanner role={role} />
          <div className="flex flex-1 overflow-hidden min-h-0">
            <main className={`flex-1 overflow-y-auto overflow-x-hidden max-w-7xl mx-auto w-full${isContactRecordRoute || isPeopleRoute || location === "/dashboard/reporting" ? "" : " p-3 sm:p-6"}`} data-testid="dashboard-main">
              <ErrorBoundary key={location}>
                {canShowMerchantOperationsNav(role, location) ? (
                  <MerchantOperationsLayout role={role} path={location}>{children}</MerchantOperationsLayout>
                ) : children}
              </ErrorBoundary>
            </main>
            {aiChatOpen && (
              <InternalSidebarChat
                collapsed={false}
                onToggle={() => setAiChatOpen(false)}
              />
            )}
          </div>
          {/* Floating data & reporting AI assistant — bottom-right, dashboard-only */}
          <DashboardDataAgent />
        </div>
      </div>
    </SidebarProvider>
    </EmployeeCrmProvider>
  );
}
