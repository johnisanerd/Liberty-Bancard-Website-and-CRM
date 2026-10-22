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
check(/PageHeadingOwnerProvider/.test(layout) && /usePageHeadingClaimed/.test(layout), "Shell title is the fallback h1 and yields to a claiming page");
check(/useLayoutEffect/.test(header) && /level !== 1/.test(header), "Only level-1 headings register a claim");
const rawH1 = walk("client/src/pages/dashboard").filter(f => f.endsWith(".tsx")).filter(f => /<h1[\s>]/.test(read(f)));
check(rawH1.length === 0, `No raw <h1> remains in dashboard pages (${rawH1.join(", ") || "none"})`);
check(!/<h1[\s>]/.test(read("client/src/pages/queue-holds.tsx")), "Queue Holds heading uses PageTitle");
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
check(/coreRef/.test(contact) && /protectedScope\(user\)/.test(contact) && /contact-section-loading/.test(contact), "Contact core is retained only for the same actor and contact");
check(/today-next-actions/.test(read("client/src/pages/dashboard/Overview.tsx")), "Today has a Next actions worklist");
const people = read("client/src/pages/dashboard/Contacts.tsx");
check(/people-selected-filters/.test(people) && /people-quick-filters/.test(people), "People has selected chips and a filter drawer");
check(/is-current-group/.test(read("client/src/components/crm/MerchantOperationsNav.tsx")), "Merchant Operations emphasizes the current group");
check(isValidReturnUrl("people", "/dashboard/contacts?emailHealth=valid&page=2"), "Return context accepts a filtered People URL");
check(!isValidReturnUrl("people", "https://evil.example/dashboard/contacts") && !isValidReturnUrl("people", "//evil.example") && !isValidReturnUrl("people", "/dashboard/admin-hub"),
  "Return context rejects other origins and destinations");
check(/Back to Resources/.test(read("client/src/pages/AssetPage.tsx")) && /public library/.test(read("client/src/components/dashboard/ResourcesNav.tsx")), "Collateral is labelled as a public handoff with an authenticated return");
check(!/crm-theme|crm-page/.test(read("client/src/pages/AssetPage.tsx")), "Public assets carry no employee CSS");
console.log(`PASS Stage 3 D-R2 contracts: ${checks} checks`);
