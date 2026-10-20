/**
 * Stage 3 C3 destination codec and source contracts (deterministic-static).
 * Pure codec checks plus source assertions; no DB, server, browser or provider I/O.
 * This does NOT prove mounted behavior, request/readback or role handling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  leadOpsSections, stagingSections, canonicalSections, prospectingAreas, prospectingAreaTabs, prospectingAreaForTab,
  leadOpsGroupedTabs, outboundSelectors, campaignAreas, campaignAreaTabs, campaignAreaForTab,
  outboundSelectorState, canonicalViewState, buildCanonicalViewHref,
} from "../client/src/lib/crm-destination-state";

let assertions = 0;
const ok = (cond: unknown, message: string) => { assert.ok(cond, message); assertions++; };
const eq = <T>(a: T, b: T, message: string) => { assert.deepEqual(a, b, message); assertions++; };

// Denominators: 13 retained Lead Ops keys, 2 staging selectors, 6 canonical views, 6 outbound selectors, 5 + 4 areas.
eq(leadOpsSections.length, 13, "13 Lead Ops keys retained");
eq(stagingSections.length, 2, "2 staging selectors");
eq(canonicalSections.length, 6, "6 canonical views");
eq(outboundSelectors.length, 6, "6 outbound selectors");
eq(prospectingAreas.length, 5, "5 Prospecting areas");
eq(campaignAreas.length, 4, "4 Campaigns areas");
eq(leadOpsGroupedTabs.length, 14, "13 keys plus the grouped canonical entrance");

// Every retained leaf belongs to exactly one area; the grouped entrance sits in Enrichment.
for (const tab of leadOpsGroupedTabs) {
  const owners = prospectingAreas.filter(a => (prospectingAreaTabs[a] as readonly string[]).includes(tab));
  eq(owners.length, 1, `Lead Ops ${tab} has exactly one area`);
  eq(prospectingAreaForTab(tab), owners[0], `Lead Ops ${tab} area lookup`);
}
eq(prospectingAreaForTab("prospects"), "sources-imports", "Source Prospects sits in Sources & Imports");
eq(prospectingAreaForTab("businesses"), "inventory", "canonical businesses are Inventory");
eq(prospectingAreaForTab("canonical"), "enrichment", "grouped canonical in Enrichment");
eq(prospectingAreaForTab("pilot"), "program-health", "pilot history under Program Health");
eq(prospectingAreaForTab("nonsense"), "inventory", "unknown tab falls back to Inventory");
for (const tab of outboundSelectors) {
  const owners = campaignAreas.filter(a => (campaignAreaTabs[a] as readonly string[]).includes(tab));
  eq(owners.length, 1, `outbound ${tab} has exactly one area`);
  eq(campaignAreaForTab(tab), owners[0], `outbound ${tab} area lookup`);
}
eq(campaignAreaForTab("analytics"), "results", "analytics belongs to Results");
eq(campaignAreaForTab("prospects"), "audience", "re-engagement belongs to Audience");

// Outbound selector: valid, invalid, duplicate.
for (const tab of outboundSelectors) eq(outboundSelectorState(`tab=${tab}`).value, tab, `outbound ${tab} round trip`);
eq(outboundSelectorState("").value, "command", "default outbound selector");
ok(outboundSelectorState("tab=bogus").issues.length > 0, "invalid outbound tab reports an issue");
ok(outboundSelectorState("tab=sequences&tab=campaigns").issues.length > 0, "duplicate outbound tab reports an issue");

// Canonical views: grouped uses canonicalView, standalone uses view; both round trip and tolerate the other name.
for (const view of canonicalSections) {
  for (const grouped of [true, false]) {
    const href = buildCanonicalViewHref(grouped ? "/dashboard/lead-ops?tab=canonical&x=1#h" : "/dashboard/canonical-enrichment?x=1#h", view, grouped);
    const search = href.split("#")[0].split("?")[1] ?? "";
    const state = canonicalViewState(search, grouped);
    eq(state.view, view, `canonical ${view} grouped=${grouped} round trip`);
    eq(state.issues.length, 0, `canonical ${view} grouped=${grouped} has no issues`);
    ok(href.includes("x=1"), "unrelated query preserved");
    ok(href.endsWith("#h"), "hash preserved");
    ok(grouped ? !/[?&]view=/.test(href) && /canonicalView=/.test(href) : !/canonicalView=/.test(href) && /[?&]view=/.test(href), "only the host's parameter is written");
  }
}
eq(canonicalViewState("view=backlog", true).view, "backlog", "grouped accepts standalone view adapter");
eq(canonicalViewState("canonicalView=health", false).view, "health", "standalone accepts grouped parameter");
ok(canonicalViewState("canonicalView=bogus", true).issues.length > 0, "invalid canonicalView reports an issue");
ok(canonicalViewState("canonicalView=records&canonicalView=health", true).issues.length > 0, "duplicate canonicalView reports an issue");
for (const grouped of [true, false]) {
  const a = grouped ? "canonicalView" : "view", b = grouped ? "view" : "canonicalView";
  const conflict = canonicalViewState(`${a}=records&${b}=health`, grouped);
  eq(conflict.view, "pipeline", `conflicting ${a}/${b} discarded (grouped=${grouped})`);
  ok(conflict.issues.length > 0, "conflicting selectors report an issue");
  const agree = canonicalViewState(`${a}=records&${b}=records`, grouped);
  eq(agree.view, "records", "agreeing selectors accepted"); eq(agree.issues.length, 0, "agreeing selectors have no issue");
  ok(canonicalViewState(`${a}=records&${b}=bogus`, grouped).issues.length > 0, "one invalid selector reports an issue");
}
assert.throws(() => buildCanonicalViewHref("/x", "nope" as any, true)); assertions++;

// ---- Source contracts --------------------------------------------------------------------
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const seq = read("client/src/pages/dashboard/Sequences.tsx");
ok(!/\btotalSteps\s*:/.test(seq.slice(seq.indexOf("createMutation"), seq.indexOf("createMutation") + 4000)), "Sequence create does not send server-owned totalSteps");
const campaignsRoute = read("server/routes/campaigns.ts");
ok(campaignsRoute.includes(".strict()"), "strict sequence schemas remain");
const backlog = read("client/src/pages/dashboard/CanonicalBacklog.tsx");
ok(!/refetchInterval/.test(backlog), "Canonical Backlog has no automatic polling");
ok(/Idempotency-Key/.test(backlog), "Release keeps its Idempotency-Key");
const enrichment = read("client/src/pages/dashboard/CanonicalEnrichment.tsx");
ok(/Vertical unresolved/.test(enrichment) && /Excluded from vertical scope/.test(enrichment), "vertical classification is not labelled as affiliation");
const lead = read("client/src/pages/dashboard/LeadOpsCenter.tsx");
ok(/<CrmAreaNav/.test(lead), "Lead Ops mounts area navigation");
ok(!/refetchInterval/.test(lead.slice(lead.indexOf("export default function LeadOpsCenter"), lead.indexOf("export default function LeadOpsCenter") + 12000)), "Lead Ops parent queries do not poll");
const outbound = read("client/src/pages/dashboard/OutboundCenter.tsx");
ok(/outboundSelectorState/.test(outbound) && !/replace:\s*true/.test(outbound), "Outbound selection uses the codec and pushes history");
const status = read("server/routes/imports.ts");
ok(/\/api\/outreach\/status", isAuthenticated, requireRole\("admin", "manager", "agent"\)/.test(status), "aggregate status route denies merchants/partners before queries");
ok(/commEventsUnavailable/.test(status), "failed event query is flagged, not zero");
const campaigns = read("client/src/pages/dashboard/Campaigns.tsx");
ok(/SFP_CONTACT_VERTICAL_IDS/.test(campaigns) && !/"Restaurant", "Retail"/.test(campaigns), "Campaign audience reads the current taxonomy");
const contact = read("client/src/pages/dashboard/ContactDetail.tsx");
ok(/zb-history-unavailable/.test(contact), "failed validation-history read says unavailable");
const prospects = read("client/src/pages/dashboard/Prospects.tsx");
ok(!/limit=500/.test(prospects), "Source Prospects does not request a fixed 500-row cap");
const toolbar = read("client/src/components/crm/CrmPresentation.tsx");
ok(!/id="crm-worklist-search"/.test(toolbar), "WorklistToolbar search id is unique per instance");

const ledger = read("client/src/pages/dashboard/UploadLedger.tsx");
ok(/useCrmQuery/.test(ledger) && /useCrmInfiniteQuery/.test(ledger) && !/\buseQuery\b|\buseInfiniteQuery\b/.test(ledger), "UploadLedger uses the protected actor-aware query hooks");
ok(/\{ signal \}/.test(ledger) && /fetch\(url, \{ credentials: "include", signal \}\)/.test(ledger), "UploadLedger reads carry the cancellation signal");
ok(/ledgerExecution/.test(ledger) && /ledgerFilter/.test(ledger), "UploadLedger selection is URL state");
for (const state of ["none", "open", "admission_closed", "expired", "revoked"]) ok(backlog.includes(`release-state-${state}`) || backlog.includes("`release-state-${state}`") && backlog.includes(`${state}:`), `Release panel names the ${state} state`);
ok(/release-denied/.test(backlog) && /release-error/.test(backlog), "Release panel separates denied from unavailable");
ok(/replayed/.test(backlog), "Release panel names replayed commands");
const dealsStorage = read("server/storage/sunbiz.ts");
ok(/open_sales_production/.test(dealsStorage) && /pipeline = 'sales' AND record_class = 'production'/.test(dealsStorage), "Open sales deal metric uses the conversion authority's definition");
const outreachCmd = read("client/src/pages/dashboard/OutreachCommand.tsx");
ok(/card-open-deals/.test(outreachCmd) && /ScopedMetricStrip/.test(outreachCmd), "Outreach Command has an open-deal card inside ScopedMetricStrip");
const bizDetail = read("client/src/pages/dashboard/LeadOps/BusinessDetailPage.tsx");
ok(/xl:grid-cols-\[minmax\(0,1fr\)_320px\]/.test(bizDetail) && /business-detail-rail/.test(bizDetail), "Business detail uses the main plus 320px rail layout");
ok(/bq/.test(lead) && /replaceState/.test(lead), "Inventory list context is kept in the address for Back");
for (const file of ["Prospects", "Campaigns", "LeadImports"]) {
  const src = read(`client/src/pages/dashboard/${file}.tsx`);
  ok(!/\buseQuery</.test(src) && /useCrmQuery/.test(src), `${file} reads use the protected actor-aware query hook`);
}
const imports = read("client/src/pages/dashboard/LeadImports.tsx");
ok(/button-import-continue/.test(imports) && /import-review-step/.test(imports) && /import-result-step/.test(imports), "Lead Imports has choose, review and result steps");
ok(/Accepted is not complete/.test(imports) || /Accepted is not completed/.test(imports), "Lead Imports result says accepted is not completed");
console.log(`Stage 3 C3 contracts: ${assertions} assertions passed`);
