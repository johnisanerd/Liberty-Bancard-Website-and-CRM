import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidReturnUrl } from "../client/src/lib/crm-return-context";

let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; console.log(`✓ ${label}`); };
const read = (p: string) => readFileSync(p, "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

// CRM-D06: ownership is a runtime claim, not a route list.
const layout = read("client/src/pages/DashboardLayout.tsx");
const header = read("client/src/components/ui/page-header.tsx");
check(!/isAdoptedPage/.test(layout), "DashboardLayout carries no hard-coded adopted-page list");
check(/PageHeadingOwnerProvider/.test(layout) && /ShellPageTitle/.test(layout), "Shell title is the fallback h1 and yields to a claiming page");
check(/useLayoutEffect/.test(header) && /level !== 1/.test(header), "Only level-1 headings register a claim");
const rawH1 = walk("client/src/pages/dashboard").filter(f => f.endsWith(".tsx")).filter(f => /<h1[\s>]/.test(read(f)));
check(rawH1.length === 0, `No raw <h1> remains in dashboard pages (${rawH1.join(", ") || "none"})`);
check(/CrmPageHeader/.test(read("client/src/pages/queue-holds.tsx")), "Queue Holds heading uses the shared page header");
for (const hub of ["LeadOpsCenter", "OutboundCenter", "SupportHub", "GhlIntegrationHub"])
  check(/<PageHeadingLevel level=\{2\}>/.test(read(`client/src/pages/dashboard/${hub}.tsx`)), `${hub} embeds its tab content at h2`);
check(/PageTitle level=\{embedded \? 2 : undefined\}/.test(read("client/src/pages/dashboard/CanonicalEnrichment.tsx")), "Canonical Enrichment is h2 when embedded, h1 standalone");

// CRM-D07 / D08 CSS.
const css = read("client/src/styles/crm-theme.css");
check(/textarea:not\(\.crm-prose-editor\)[^{]*\{[^}]*min-height:\s*96px/.test(css), "Ordinary CRM textarea floor is 96px");
check(/crm-prose-editor[^{]*\{[^}]*min-height:\s*200px/.test(css), "Prose editor floor is 200px");
check(/--crm-danger-text/.test(css) && /\.crm-theme \.text-destructive/.test(css), "Dark danger text uses its own token");
check(/img-sidebar-logo-dark/.test(layout) && /img-sidebar-logo-light/.test(layout), "Employee shell renders both logo variants");
check(/aria-label=\{`Select ticket #/.test(read("client/src/pages/dashboard/Tickets.tsx")), "Ticket row checkbox has an accessible name");

// CRM-D09 route and picker.
const routes = read("server/routes/contacts.ts");
const searchAt = routes.indexOf('"/api/companies/search"'), idAt = routes.indexOf('"/api/companies/:id"');
check(searchAt > 0 && idAt > searchAt, "Company search route is registered before /api/companies/:id");
check(/readCompanies\(bindWorkActor\(req\.user\)/.test(routes), "Existing company read authority is unchanged");
const hook = read("client/src/hooks/use-company-search.ts");
check(/AbortController/.test(hook) && /generation/i.test(hook), "Picker aborts and ignores superseded reads");

// UI-01, UI-03, UI-05, UI-06.
const contact = read("client/src/pages/dashboard/ContactDetail.tsx");
check(/RetainedContactCore/.test(contact) && /protectedScope\(user\)/.test(contact) && /contact-section-loading/.test(contact), "Contact core is retained only for the same actor and contact");
check(/today-next-actions/.test(read("client/src/pages/dashboard/Overview.tsx")), "Today has a Next actions worklist");
const people = read("client/src/pages/dashboard/Contacts.tsx");
check(/people-selected-filters/.test(people) && /people-quick-filters/.test(people), "People has selected chips and a filter drawer");
check(/is-current-group/.test(read("client/src/components/crm/MerchantOperationsNav.tsx")), "Merchant Operations emphasizes the current group");
check(isValidReturnUrl("people", "/dashboard/contacts?emailHealth=valid&page=2"), "Return context accepts a filtered People URL");
check(!isValidReturnUrl("people", "https://evil.example/dashboard/contacts") && !isValidReturnUrl("people", "//evil.example") && !isValidReturnUrl("people", "/dashboard/admin-hub"),
  "Return context rejects other origins and destinations");
check(/Back to Resources/.test(read("client/src/pages/AssetPage.tsx")) && /public library/.test(read("client/src/components/dashboard/ResourcesNav.tsx")), "Collateral is labelled as a public handoff with an authenticated return");
check(!/crm-theme|crm-page/.test(read("client/src/pages/AssetPage.tsx")), "Public assets carry no employee CSS");
const biz = read("client/src/pages/dashboard/LeadOps/BusinessDetailPage.tsx");
check(/readReturnUrl\("inventory"/.test(biz) && !/history\.back/.test(biz), "Business Back reads the remembered inventory URL, not browser history");
check(/rememberReturnUrl\("inventory"/.test(read("client/src/pages/dashboard/LeadOpsCenter.tsx")), "Inventory remembers its search, filters and page for Business Back");
check(isValidReturnUrl("inventory", "/dashboard/lead-ops?tab=businesses&bq=acme&boffset=50") && !isValidReturnUrl("inventory", "/dashboard/lead-ops") && !isValidReturnUrl("inventory", "https://evil.example/dashboard/lead-ops?tab=businesses"),
  "Inventory return context accepts only in-app inventory URLs");
// UI-04: destinations adopted in this change keep the shared page, header and metric contracts.
const adopted: Record<string, string[]> = {
  "CoBrandedProposals": ["CrmPage", "CrmPageHeader"], "PartnerOrgs": ["CrmPage", "CrmPageHeader"], "ArbitrationLog": ["CrmPage", "CrmPageHeader"],
  "KnowledgeAdmin": ["CrmPage", "CrmPageHeader"], "KnowledgeBase": ["CrmPage", "CrmPageHeader"], "MerchantPortfolio": ["CrmPage", "CrmPageHeader"],
  "ReferralProgram": ["CrmPage", "CrmPageHeader"], "MyEarnings": ["CrmPage", "CrmPageHeader", "ScopedMetricStrip"], "OutreachQueue": ["CrmPage", "CrmPageHeader"],
  "PartnerPortalAdmin": ["CrmPage", "ScopedMetricStrip"], "PartnerReferralPipeline": ["CrmPage", "ScopedMetricStrip"], "BoardingTracker": ["CrmPage"],
  "MerchantApplicationsList": ["CrmPage"], "DocumentVault": ["CrmPage"], "Leaderboard": ["CrmPage"],
};
for (const [name, parts] of Object.entries(adopted)) {
  const src = read(`client/src/pages/dashboard/${name}.tsx`);
  check(parts.every(part => new RegExp(`<${part}\\b`).test(src)), `${name} adopts ${parts.join(", ")}`);
}
check(!/from "@\/components\/ui\/page-header"/.test(read("client/src/components/crm/CrmPresentation.tsx").replace(/import \{ useHeadingLevel \} from "@\/components\/ui\/page-header";/, "")), "Shared page header has a single implementation (PageHeader delegates to CrmPageHeader)");
// A page that renders a shared presentation tag must import it (a missing import only fails at render time).
const unresolved: string[] = [];
for (const file of [...walk("client/src/pages"), ...walk("client/src/components")].filter(f => f.endsWith(".tsx") && !f.endsWith("CrmPresentation.tsx"))) {
  const src = read(file);
  for (const tag of ["CrmPage", "CrmPageHeader", "ScopedMetricStrip", "CrmDataState", "PageHeader", "PageTitle", "ProvenanceNote"])
    if (new RegExp(`<${tag}[\\s>/]`).test(src) && !new RegExp(`import[^;]*\\b${tag}\\b[^;]*from`, "s").test(src)) unresolved.push(`${file}:${tag}`);
}
check(unresolved.length === 0, `Every shared presentation tag in use is imported (${unresolved.join(", ") || "none missing"})`);
// UI-04 provenance: long internal provenance sits behind an expandable control; the visible summary keeps scope, freshness and the uncertainty limit.
const prov = read("client/src/components/crm/CrmPresentation.tsx");
check(/export function ProvenanceNote/.test(prov) && /<details\b/.test(prov) && /role="note"/.test(prov), "ProvenanceNote renders a visible summary plus expandable details");
const lb = read("client/src/pages/dashboard/Leaderboard.tsx");
check(/<ProvenanceNote testId="leaderboard-provenance"/.test(lb) && /not observed revenue or native receipts/.test(lb.slice(lb.indexOf("<ProvenanceNote"), lb.indexOf("</ProvenanceNote>"))) &&
  /summary=\{<>[^]*?as of[^]*?deals loaded[^]*?not observed revenue/.test(lb), "Leaderboard summary keeps period, as-of, population and the not-revenue limit visible");
check(/<ProvenanceNote testId="document-vault-provenance"[^>]*summary="[^"]*not complete relationship coverage/.test(read("client/src/pages/dashboard/DocumentVault.tsx").replace(/\n\s*/g, " ")), "Document Vault summary keeps the coverage limit visible");
check(/detail="Validation figures describe pending intents/.test(read("client/src/pages/dashboard/CanonicalEnrichment.tsx")), "Canonical Enrichment moves diagnostic provenance into expandable detail");
// D-V metric parity: the dashboard KPI endpoint is a whole-population read under the shared definitions, never a capped sample.
const stats = read("server/routes/permissions-audit.ts");
const statsBody = stats.slice(stats.indexOf('"/api/dashboard/stats"'));
check(/readPipelineAnalytics/.test(statsBody) && !/limit:\s*500/.test(statsBody), "Dashboard stats use the canonical pipeline read and no capped 500-row sample");
// D-V accessibility crawl repairs: controls that had no accessible name.
check(/function contactLinkLabel/.test(people) && !/\{contact\.firstName\} \{contact\.lastName\}<\/a>/.test(people), "People contact links fall back to company, email or id when a record has no person name");
check(/aria-label="Show archived contacts"/.test(people), "People Show Archived switch has an accessible name");
check(["Show archived deals", "Hide empty stages", "Show unassigned deals only"].every(l => read("client/src/pages/dashboard/Pipeline.tsx").includes(`aria-label="${l}"`)), "Pipeline toggles have accessible names");
check(/aria-label=\{`Email \$\{partner\.email\}`\}/.test(read("client/src/pages/dashboard/PartnerReferralPipeline.tsx")), "Partner email icon link has an accessible name");
check(/aria-label=\{`Archive source /.test(read("client/src/pages/dashboard/KnowledgeAdmin.tsx")), "Knowledge source archive icon button has an accessible name");
const ssr = read("server/routes/ssr-routes.ts");
check(/if \(getCompareHtml\(slug\)\) xml \+= `[^`]*\/compare\//.test(ssr), "Compare sitemap lists only comparison pages that exist (no sitemap URL answers 404)");
check(/INDUSTRY_SLUGS as readonly string\[\]\)\.includes\(req\.params\.slug\)\) return next\(\)/.test(ssr), "Listed industry pages without server rendering fall through to the client app instead of an empty 404");
console.log(`PASS Stage 3 D-R2 contracts: ${checks} checks`);
