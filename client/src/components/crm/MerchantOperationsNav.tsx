import type { ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  Briefcase,
  ClipboardList,
  FileText,
  FolderOpen,
  Handshake,
  Package,
  ShieldAlert,
  ShieldCheck,
  Ticket,
  HeartPulse,
} from "lucide-react";
import { destinationUrl, safeContextKeys, safeParams } from "@/lib/crm-destination-state";

type MerchantOpsRole = "admin" | "manager" | "agent" | "merchant";

const groups = [
  {
    label: "Portfolio",
    entries: [{ label: "Portfolio", href: "/dashboard/portfolio", icon: Briefcase, roles: ["admin", "manager", "agent"] as MerchantOpsRole[] }],
  },
  {
    label: "Acquisition",
    entries: [
      { label: "Applications", href: "/dashboard/merchant-applications", icon: ClipboardList, roles: ["admin", "manager", "agent"] as MerchantOpsRole[] },
      { label: "Statements", href: "/dashboard/statement-review", icon: FileText, roles: ["admin", "manager", "agent"] as MerchantOpsRole[] },
      { label: "Documents", href: "/dashboard/document-vault", icon: FolderOpen, roles: ["admin", "manager", "agent"] as MerchantOpsRole[] },
    ],
  },
  {
    label: "Delivery",
    entries: [
      { label: "Underwriting", href: "/dashboard/underwriting", icon: ShieldCheck, roles: ["admin", "manager"] as MerchantOpsRole[] },
      { label: "Boarding", href: "/dashboard/boarding", icon: Package, roles: ["admin", "manager", "agent"] as MerchantOpsRole[] },
      { label: "Onboarding", href: "/dashboard/onboarding", icon: ClipboardList, roles: ["admin", "manager"] as MerchantOpsRole[] },
      { label: "Onboarding Kickoff", href: "/dashboard/onboarding-kickoff", icon: Package, roles: ["admin", "manager"] as MerchantOpsRole[] },
    ],
  },
  {
    label: "Service",
    entries: [
      { label: "Merchant Risk", href: "/dashboard/merchant-risk", icon: ShieldAlert, roles: ["admin", "manager"] as MerchantOpsRole[] },
      { label: "Merchant Success", href: "/dashboard/merchant-success", icon: HeartPulse, roles: ["admin", "manager"] as MerchantOpsRole[] },
      { label: "Support", href: "/dashboard/support-hub", icon: Ticket, roles: ["admin", "manager"] as MerchantOpsRole[] },
    ],
  },
  {
    label: "Partners",
    entries: [
      { label: "Referral Program", href: "/dashboard/referral-program", icon: Handshake, roles: ["admin", "manager", "agent"] as MerchantOpsRole[] },
      { label: "Partner Orgs", href: "/dashboard/partner-orgs", icon: Handshake, roles: ["admin"] as MerchantOpsRole[] },
      { label: "Partner Referrals", href: "/dashboard/partner-referral-pipeline", icon: Handshake, roles: ["admin", "manager"] as MerchantOpsRole[] },
      { label: "Partner Portal Admin", href: "/dashboard/partner-portal", icon: Handshake, roles: ["admin", "manager"] as MerchantOpsRole[] },
      { label: "Co-branded Proposals", href: "/dashboard/co-branded-proposals", icon: FileText, roles: ["admin", "manager"] as MerchantOpsRole[] },
    ],
  },
] as const;

export function isMerchantOperationsPath(path: string) {
  return groups.some((group) => group.entries.some((entry) => entry.href === path));
}

export function canShowMerchantOperationsNav(role: MerchantOpsRole, path: string) {
  return groups.some((group) => group.entries.some((entry) => entry.href === path && entry.roles.includes(role)));
}

export function MerchantOperationsLayout({
  role,
  path,
  children,
}: {
  role: MerchantOpsRole;
  path: string;
  children: ReactNode;
}) {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const paramsFor = (href: string) => {
    const params = safeParams(search, safeContextKeys);
    return destinationUrl(href, params, window.location.hash);
  };
  const entries = groups.flatMap((group) =>
    group.entries.filter((entry) => entry.roles.includes(role)).map((entry) => ({ ...entry, group: group.label })),
  );
  const current = entries.find((entry) => entry.href === path);
  const groupForCurrent = current?.group ?? "Merchant Operations";

  const goTo = (href: string) => {
    if (href && entries.some((entry) => entry.href === href)) navigate(paramsFor(href));
  };

  return (
    <div className="crm-theme crm-merchant-ops-layout" data-testid="merchant-operations-workspace">
      <aside className="crm-merchant-ops-rail" aria-label="Merchant Operations navigation">
        <div className="crm-merchant-ops-rail-heading">
          <span className="crm-workspace-eyebrow">Workspace</span>
          <strong>Merchant Operations</strong>
        </div>
        {groups.map((group) => {
          const permitted = group.entries.filter((entry) => entry.roles.includes(role));
          if (!permitted.length) return null;
          const currentGroup = permitted.some((entry) => path === entry.href);
          return (
            <section key={group.label} className={`crm-merchant-ops-group${currentGroup ? " is-current-group" : ""}`} aria-label={group.label} data-current-group={currentGroup ? "true" : undefined}>
              <h2>{group.label}</h2>
              <nav>
                {permitted.map((entry) => {
                  const Icon = entry.icon;
                  const active = path === entry.href;
                  return (
                    <Link
                      key={entry.href}
                      href={paramsFor(entry.href)}
                      aria-current={active ? "page" : undefined}
                      className={`crm-merchant-ops-link${active ? " is-active" : ""}`}
                    >
                      <Icon aria-hidden="true" />
                      <span>{entry.label}</span>
                    </Link>
                  );
                })}
              </nav>
            </section>
          );
        })}
      </aside>

      <div className="crm-merchant-ops-mobile">
        <div className="crm-merchant-ops-mobile-crumb" aria-label="Current location">
          <span>Merchant Operations</span>
          <span aria-hidden="true">/</span>
          <strong>{groupForCurrent}</strong>
          {current && <><span aria-hidden="true">/</span><strong>{current.label}</strong></>}
        </div>
        <label htmlFor="merchant-operations-section">Go to section</label>
        <select
          id="merchant-operations-section"
          value={location}
          onChange={(event) => goTo(event.currentTarget.value)}
        >
          {groups.map((group) => {
            const permitted = group.entries.filter((entry) => entry.roles.includes(role));
            return permitted.length ? (
              <optgroup key={group.label} label={group.label}>
                {permitted.map((entry) => <option key={entry.href} value={entry.href}>{entry.label}</option>)}
              </optgroup>
            ) : null;
          })}
        </select>
      </div>

      <div className="crm-merchant-ops-content">{children}</div>
    </div>
  );
}
