/** URL authority shared by C1 and later workspace owners. Metadata does not
 * authorize rendering; mounted wrappers retain their existing role guards. */
export const financialViews = ["revenue", "forecasting", "terminal-roi"] as const;
// C4-owned nested extensions. They are separate from outer Reporting.tab and
// Financial.financialTab; existing six legacy report values do not change.
export const revenueViews = ["dashboard","by-partner","reconcile","history","payouts"] as const;
export const revenueFilterKeys=["revenueQuery","revenueParentContactId","revenuePeriod"] as const;
export function preserveRevenueFilters(search:string,params:URLSearchParams){
  for(const key of revenueFilterKeys){
    params.delete(key);
    for(const value of new URLSearchParams(search).getAll(key))params.append(key,value);
  }
  return params;
}
export type RevenueFilterState={query:string;parentContactId:number|null;period:string;issues:SelectionIssue[]};
/** C4 extension through C1; invalid scope never authorizes a broader read. */
export function revenueFilterState(search:string):RevenueFilterState {
  const input=new URLSearchParams(search),issues:SelectionIssue[]=[];
  function scalar(key:string,fallback:string,validate:(v:string)=>boolean){
    const values=[...new Set(input.getAll(key))];
    if(!values.length)return fallback;
    const kind=values.length>1?"conflict":!validate(values[0])?"invalid":null;
    if(kind){issues.push({key,kind,reason:`${key}: ${kind} filter. No broader population is fetched.`});return fallback;}
    return values[0];
  }
  const parent=scalar("revenueParentContactId","",v=>!!parseLocalEntityId("contactId",v)&&Number(v)<=2147483647);
  return {query:scalar("revenueQuery","",v=>v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v)),
    parentContactId:parent?Number(parent):null,
    period:scalar("revenuePeriod","all",v=>v==="all"||/^\d{4}-(0[1-9]|1[0-2])$/.test(v)),issues};
}
export function revenueFilterUrl(search:string,hash:string,filter:Omit<RevenueFilterState,"issues">){
  const params=safeParams(search,[...safeContextKeys,"revenueView"]);
  params.set("tab","financial");params.set("financialTab","revenue");
  if(filter.query)params.set("revenueQuery",filter.query);
  if(filter.parentContactId!=null)params.set("revenueParentContactId",String(filter.parentContactId));
  if(filter.period!=="all")params.set("revenuePeriod",filter.period);
  if(revenueFilterState(params.toString()).issues.length)throw new Error("Invalid revenue filter selection");
  return destinationUrl("/dashboard/reporting",params,hash);
}
export const underwritingViews = ["queue","approved","config"] as const;
export const onboardingViews = ["overview", "board"] as const;
export const applicationStatuses = ["all","submitted","under_review","approved","declined","draft"] as const;
export const boardingStatuses = ["all","submitted","under_review","more_info_needed","approved","declined"] as const;
export const outreachViews = ["campaigns","ab-testing","messages"] as const;
export const leaderboardMetrics = ["deals","revenue","proposals","calls","responseRate","closeRate","contacts"] as const;
export const leaderboardPeriods = ["week","month","quarter","all"] as const;
/** Route-owned retained selectors, using C1's duplicate/context authority. */
export function retainedSelection<T extends string>(search:string,key:string,allowed:readonly T[],fallback:T,legacyKey?:string) {
  const input=new URLSearchParams(search);
  if(legacyKey)for(const value of input.getAll(legacyKey))input.append(key,value);
  return selectValue(input,key,allowed,fallback);
}
/** C5 route-owned selectors. Each key is registered once here and in the C1 generator's query policy. */
export const trainingViews = ["docs", "practice", "coaching"] as const;
export const knowledgeAdminViews = ["sources", "unanswered", "feedback"] as const;
export const integrationsViews = ["ghl-workflows", "sending-identities", "processor-adapters", "linkedin", "zerobounce"] as const;
/** Proposed Administration area key (Section 5). `tab` stays the retained child selector. */
export const adminAreas = ["users-access", "integrations", "operational-controls", "data-audit", "release-readiness"] as const;
export const adminTabs = ["users", "permissions", "audit-log", "consent", "pci", "agents", "integrations", "ghl", "info-flow", "gate-result", "automations"] as const;
export const adminAreaTabs: Record<typeof adminAreas[number], readonly typeof adminTabs[number][]> = {
  "users-access": ["users", "agents", "permissions"],
  "integrations": ["integrations", "ghl", "info-flow"],
  "operational-controls": ["automations"],
  "data-audit": ["audit-log", "consent"],
  "release-readiness": ["pci", "gate-result"],
};
/** Resources destinations in display order. `managerOnly` mirrors each route's own allowedRoles. */
export const resourcesDestinations = [
  { label: "Knowledge Base", href: "/dashboard/knowledge-base", managerOnly: false },
  { label: "Training", href: "/dashboard/training", managerOnly: false },
  { label: "Playbooks", href: "/dashboard/playbooks", managerOnly: false },
  { label: "Collateral", href: "/assets", managerOnly: false },
  { label: "Content", href: "/dashboard/content-hub", managerOnly: true },
  { label: "Knowledge Admin", href: "/dashboard/knowledge-admin", managerOnly: true },
] as const;
export const c5RouteKeys: Record<string, readonly string[]> = {
  "/dashboard/training": ["tab"],
  "/dashboard/knowledge-admin": ["tab"],
  "/dashboard/settings/integrations": ["integrationsView"],
  "/dashboard/admin-hub": ["area", "tab", "integrationsView"],
};
export type AdminRole = "admin" | "manager" | "other";
const adminPermittedTabs: Record<AdminRole, readonly typeof adminTabs[number][]> = {
  admin: adminTabs,
  manager: ["consent", "pci", "agents", "integrations", "ghl"],
  other: ["consent", "pci"],
};
export function adminPermittedFor(role: string | undefined): readonly typeof adminTabs[number][] {
  return adminPermittedTabs[role === "admin" ? "admin" : role === "manager" ? "manager" : "other"];
}
/** Administration selection: legacy `tab` is the child; `area` is the proposed group key. The child
 * wins when both are present; an area alone selects its first permitted child; a forbidden, invalid
 * or conflicting value falls back to the first permitted child and says so. */
export function adminSelectorState(search: string, role: string | undefined) {
  const params = new URLSearchParams(search);
  const permitted = adminPermittedFor(role);
  const fallback = permitted[0];
  const tabSel = selectValue(params, "tab", adminTabs, fallback, permitted);
  const issues = [...tabSel.issues];
  let tab = tabSel.value;
  if (params.has("area")) {
    const areaSel = selectValue(params, "area", adminAreas, adminAreaForTab(fallback));
    issues.push(...areaSel.issues);
    if (!areaSel.issues.length) {
      if (!params.has("tab")) {
        const first = adminAreaTabs[areaSel.value].find(t => permitted.includes(t));
        if (first) tab = first;
        else issues.push({ key: "area", kind: "forbidden", reason: `area: forbidden selection. Showing ${adminAreaForTab(fallback)}.` });
      } else if (!tabSel.issues.length && adminAreaForTab(tab) !== areaSel.value) {
        issues.push({ key: "area", kind: "conflict", reason: `area: does not contain ${tab}. Showing ${tab}.` });
      }
    }
  }
  return { tab, area: adminAreaForTab(tab), issues, permitted };
}
export function adminAreaForTab(tab: typeof adminTabs[number]): typeof adminAreas[number] {
  return adminAreas.find(area => (adminAreaTabs[area] as readonly string[]).includes(tab)) ?? "users-access";
}
export function retainedSelectionUrl<T extends string>(path:string,search:string,hash:string,key:string,
  allowed:readonly T[],value:T,legacyKey?:string,resetPaging=true) {
  if(!allowed.includes(value))throw new Error(`Invalid ${key} selection`);
  const routeKeys=path==="/dashboard/reporting"
    ? ["tab","outreachView","financialTab","revenueView",...revenueFilterKeys]
    : path==="/dashboard/leaderboard"?["metric","period"]
    : ["/dashboard/boarding","/dashboard/merchant-applications"].includes(path)?["status"]
    : c5RouteKeys[path] ? [...c5RouteKeys[path]]
    : [];
  if(!routeKeys.includes(key))throw new Error(`Unregistered route selector: ${key}`);
  const params=safeParams(search,[...safeContextKeys,...routeKeys,...(!resetPaging?["page","offset","cursor"]:[])]);
  if(legacyKey && legacyKey!==key)params.delete(legacyKey);
  params.set(key,value);
  if(path==="/dashboard/reporting")params.set("tab","outreach-analytics");
  return destinationUrl(path,params,hash);
}
export function outreachAliasUrl(search:string,hash:string) {
  const params=safeParams(search,safeContextKeys);
  // Preserve invalid/conflicting child values for explicit destination rejection.
  for(const value of new URLSearchParams(search).getAll("outreachView"))params.append("outreachView",value);
  params.set("tab","outreach-analytics");
  return destinationUrl("/dashboard/reporting",params,hash);
}
export const supportViews = ["tickets", "rfis", "review-queue"] as const;
/** C4 extension: nested Review Queue status is distinct from Support's tab. */
export const reviewQueueViews = ["pending","approved","all"] as const;
/** C4 extension: story status is distinct from Merchant Success's outer tab. */
export const testimonialViews=["pending","approved","rejected","all"] as const;
/** C4 extension: RFI status is distinct from Support's outer tab. */
export const rfiViews=["all","Open","In Progress","Waiting on Merchant","Responded","Closed"] as const;
export function rfiUrl(search:string,hash:string,value?:typeof rfiViews[number],closeSelected=false){
  const params=new URLSearchParams(c4WorkspaceUrl("/dashboard/support-hub",search,"",
    "tab",supportViews,"tickets","rfis").split("?")[1]||"");
  if(value!==undefined)params.set("rfiView",value);
  if(closeSelected)params.delete("id");
  return destinationUrl("/dashboard/support-hub",params,hash);
}
export function testimonialAliasUrl(search:string,hash=""){
  return c4WorkspaceUrl("/dashboard/merchant-success",search,hash,"tab",merchantSuccessViews,"reviews","testimonials");
}
export function testimonialUrl(search:string,hash:string,value:typeof testimonialViews[number]){
  const params=new URLSearchParams(c4WorkspaceUrl("/dashboard/merchant-success",search,"",
    "testimonialView",testimonialViews,"pending",value).split("?")[1]||"");
  params.set("tab","testimonials");
  return destinationUrl("/dashboard/merchant-success",params,hash);
}
export function reviewQueueUrl(search:string,hash:string,value:typeof reviewQueueViews[number]){
  const params=new URLSearchParams(c4WorkspaceUrl("/dashboard/support-hub",search,"","reviewView",reviewQueueViews,"pending",value).split("?")[1]||"");
  params.set("tab","review-queue");
  return destinationUrl("/dashboard/support-hub",params,hash);
}
export const merchantRiskViews = ["chargebacks", "health"] as const;
export const merchantHealthViews = ["alerts", "churn-risk", "nps", "signal-settings"] as const;
export function merchantHealthUrl(search: string, hash: string, value: typeof merchantHealthViews[number]) {
  const params = new URLSearchParams(c4WorkspaceUrl("/dashboard/merchant-risk", search, "", "healthView",
    merchantHealthViews, "alerts", value).split("?")[1]);
  params.set("tab", "health");
  return destinationUrl("/dashboard/merchant-risk", params, hash);
}
export function merchantHealthAliasUrl(search: string, hash: string) {
  const params = safeParams(search, safeContextKeys);
  params.set("tab", "health");
  for (const value of new URLSearchParams(search).getAll("healthView")) params.append("healthView", value);
  return destinationUrl("/dashboard/merchant-risk", params, hash);
}
export const merchantSuccessViews = ["reviews", "testimonials", "nps", "retention"] as const;
export const operatorViews = [
  "command-center", "lifecycle", "conversion", "stuck-leads", "lead-queue-health",
  "stage-health", "vertical-coverage", "statement-upload", "a-lead-queue", "sdr",
  "recent-sends", "send-monitoring", "silent-sequences", "pipeline-silence-thresholds",
  "bounce-failure", "comm-health", "ai-health", "ai-activity", "ai-learning-center",
  "low-confidence", "subject-audit", "content-organic", "ghl-connection",
  "sync-conflicts", "ghl-invalid-contacts", "serper-control", "webhook-events",
  "registry-import", "ghl-deferred-queue", "save-cases", "score-all",
  "new-lead-enroll", "kpis", "readiness", "job-health", "queue-metrics",
  "worker-intervals", "worker-heartbeats", "deleted-records", "outbound-preflight",
  "queue-holds", "data-health", "system-audit", "launch-readiness",
  "data-quality", "deliverability-settings",
] as const;
export type SelectionIssue = { key: string; kind: "conflict" | "invalid" | "forbidden"; reason: string };
export type Selection<T extends string> = { value: T; issues: SelectionIssue[] };

export function selectValue<T extends string>(params: URLSearchParams, key: string,
  allowed: readonly T[], fallback: T, permitted: readonly T[] = allowed): Selection<T> {
  const values = [...new Set(params.getAll(key))];
  if (!values.length) return { value: fallback, issues: [] };
  const kind = values.length > 1 ? "conflict"
    : !allowed.includes(values[0] as T) ? "invalid"
    : !permitted.includes(values[0] as T) ? "forbidden" : null;
  if (kind) return { value: fallback, issues: [{ key, kind,
    reason: `${key}: ${kind} selection. Showing ${fallback}.` }] };
  return { value: values[0] as T, issues: [] };
}

/** D05 hub tabs. Each hub's `tab` is one registered selector decoded by hubTabState (duplicate, invalid and forbidden values
 * fall back to the first permitted tab and say so) and changed with typedTabUrl (history push, registered context kept). */
export const hubTabs = {
  ghlIntegration: ["settings", "workflow-ids", "sequence-guide"],
  content: ["content", "blog", "linkedin", "blaze"],
  playbooks: ["marketing", "growth"],
  sdr: ["sdr", "chatbot"],
  deliverability: ["email-health", "inbox-health"],
} as const;
export function hubTabState<T extends string>(search: string, allowed: readonly T[], permitted: readonly T[]): Selection<T> {
  return selectValue(new URLSearchParams(search), "tab", allowed, permitted[0], permitted);
}

export const safeContextKeys = ["contactId", "companyId", "businessId", "dealId", "sourceId", "from"] as const;
const contextIdKinds = { contactId: "integer", companyId: "integer", businessId: "integer", dealId: "integer", sourceId: "integer" } as const;
export type LocalEntityId = { kind: keyof typeof contextIdKinds; value: string };
export function parseLocalEntityId(kind: LocalEntityId["kind"], value: string): LocalEntityId | null {
  const valid = /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  return valid ? { kind, value } : null;
}
/** Preserve only registered context, never resolve IDs by display name. */
export function safeParams(search: string, keys: readonly string[]): URLSearchParams {
  const input = new URLSearchParams(search), out = new URLSearchParams();
  for (const key of keys) {
    const values = [...new Set(input.getAll(key))];
    if (values.length !== 1) continue;
    if (key in contextIdKinds && !parseLocalEntityId(key as LocalEntityId["kind"], values[0])) continue;
    if (key === "from" && !/^\/dashboard(?:\/[a-z0-9/-]*)?$/.test(values[0])) continue;
    out.set(key, values[0]);
  }
  return out;
}
export function safeFragment(hash: string): string {
  return /^#[a-z][a-z0-9_-]{0,63}$/i.test(hash) ? hash : "";
}
export function destinationUrl(path: string, params: URLSearchParams, hash = ""): string {
  return path + (params.size ? `?${params.toString()}` : "") + safeFragment(hash);
}

/** Typed C4 child selection. Only registered entity context crosses a view
 * change; arbitrary query state is never promoted into navigation authority. */
export function c4WorkspaceSelection<T extends string>(
  search: string,
  key: string,
  allowed: readonly T[],
  fallback: T,
) {
  return selectValue(new URLSearchParams(search), key, allowed, fallback);
}

export function c4WorkspaceUrl<T extends string>(
  path: string,
  search: string,
  hash: string,
  key: string,
  allowed: readonly T[],
  fallback: T,
  value: T,
) {
  if (!allowed.includes(value)) throw new Error(`Invalid ${key} selection`);
  if (!allowed.includes(fallback)) throw new Error(`Invalid ${key} fallback`);
  const params = safeParams(search, safeContextKeys);
  if (path === "/dashboard/merchant-risk" && key === "tab" && value === "health") {
    const input = new URLSearchParams(search);
    for (const child of input.getAll("healthView")) params.append("healthView", child);
  }
  if(path==="/dashboard/support-hub"&&key==="tab"&&value==="review-queue"){
    for(const child of new URLSearchParams(search).getAll("reviewView"))params.append("reviewView",child);
  }
  if(path==="/dashboard/support-hub"&&key==="tab"&&value==="rfis"){
    for(const child of new URLSearchParams(search).getAll("rfiView"))params.append("rfiView",child);
    // Existing selected-record context uses generic id. Keep it only for
    // this typed destination, never in the global contact/deal allowlist.
    // Preserve invalid/conflicting inputs for the selected reader's denial.
    for(const id of new URLSearchParams(search).getAll("id"))params.append("id",id);
  }
  if(path==="/dashboard/merchant-success"&&key==="tab"&&value==="testimonials"){
    for(const child of new URLSearchParams(search).getAll("testimonialView"))params.append("testimonialView",child);
  }
  params.set(key, value);
  return destinationUrl(path, params, hash);
}

/** Typed tab/area change inside one destination. Only registered entity context (contact, company, business, deal,
 * source ID and a valid `from`) and the explicitly named selection keys survive; arbitrary or stale query state does
 * not. The caller pushes the result so Back/Forward restore the previous selection. */
export function typedTabUrl(path: string, search: string, hash: string, selection: Record<string, string | null>): string {
  const params = safeParams(search, safeContextKeys);
  for (const [key, value] of Object.entries(selection)) if (value !== null) params.set(key, value);
  return destinationUrl(path, params, hash);
}

export function financialState(search: string) {
  const params = new URLSearchParams(search);
  // Explicit child wins even when a legacy tab also names another valid child.
  return params.has("financialTab")
    ? selectValue(params, "financialTab", financialViews, "revenue")
    : selectValue(params, "tab", [...financialViews, "financial"] as const, "revenue");
}
export function financialUrl(search: string, hash = "", child?: typeof financialViews[number]) {
  const state = financialState(search);
  const params = safeParams(search, [...safeContextKeys,...revenueFilterKeys]);
  // Keep malformed/conflicting scoped filters through alias replacement so the
  // consumer can deny that read instead of silently broadening to All.
  preserveRevenueFilters(search,params);
  params.set("tab", "financial");
  params.set("financialTab", child ?? (state.value === "financial" ? "revenue" : state.value));
  if(params.get("financialTab")==="revenue" && new URLSearchParams(search).has("revenueView"))
    params.set("revenueView",selectValue(new URLSearchParams(search),"revenueView",revenueViews,"dashboard").value);
  // Persist a machine-readable invalid/conflict reason across alias replacement.
  if (state.issues.length) params.set("selectionIssue", state.issues[0].kind);
  return destinationUrl("/dashboard/reporting", params, hash);
}
export function systemState(search: string, isAdmin: boolean) {
  const params = new URLSearchParams(search);
  const allowed = ["monitor", "readiness", "seo", "incidents"] as const;
  const tab = selectValue(params, "tab", allowed, "readiness",
    isAdmin ? allowed : ["readiness", "seo"]);
  const view = selectValue(params, "view", operatorViews, "command-center");
  return { tab: tab.value, view: view.value, issues: [...tab.issues, ...view.issues] };
}
export function systemUrl(search: string, hash = "", tab = "monitor", view?: typeof operatorViews[number]) {
  const params = safeParams(search, safeContextKeys);
  params.set("tab", tab);
  if (tab === "monitor") {
    const state = selectValue(new URLSearchParams(search), "view", operatorViews, "command-center");
    params.set("view", view ?? state.value);
    if (state.issues.length) params.set("selectionIssue", state.issues[0].kind);
  }
  return destinationUrl("/dashboard/system-health", params, hash);
}
export function operatorAliasUrl(search: string, hash = "") {
  const params = new URLSearchParams(search);
  // Historical /operator?tab=child is a child selector, not a parent tab.
  if (!params.has("view") && params.has("tab")) {
    for (const v of params.getAll("tab")) params.append("view", v);
  }
  return systemUrl(params.toString(), hash);
}
export function selectionMessage(search: string): string | null {
  const issue = new URLSearchParams(search).get("selectionIssue");
  return ["conflict", "invalid", "forbidden"].includes(issue ?? "")
    ? `The requested selection was ${issue}. A permitted default is shown.` : null;
}
export function peopleHubState(search: string) {
  return selectValue(new URLSearchParams(search),"tab",["people","leads","prospect-staging"] as const,"people");
}

// Published, source-matching contracts only. C2/C3 own actual adoption.
export const contactSections = ["overview","deals","tickets","tasks","notes","documents",
  "live-processing","chargebacks","activity","call-logs","call-assist","relationships",
  "locations","history","comments","churn-risk","delivery-log","comm-timeline",
  "comm-health","offer-intelligence","company-intelligence","sales-prep",
  "onboarding-stages","rfis","nps"] as const;
export const leadOpsSections = ["businesses","prospects","imports","staging","sources",
  "census","intelligence","quality","pipeline","sfp","provider-results","pilot","health"] as const;
export const stagingSections = ["master-leads","promotion-review"] as const;
export const canonicalSections = ["pipeline","backlog","records","imports","exceptions","health"] as const;
export type CanonicalSection = typeof canonicalSections[number];

// ---- C3 additive destination codec -------------------------------------------------
// Five Prospecting areas and four Campaigns areas group the existing leaf selectors.
// The 13 Lead Ops keys, both staging selectors and the six outbound selectors stay valid
// compatibility inputs; there is no second parser.
export const prospectingAreas = ["inventory","sources-imports","enrichment","qualification-staging","program-health"] as const;
export type ProspectingArea = typeof prospectingAreas[number];
/** "canonical" is a grouped entrance to the standalone Canonical Enrichment views, not a 14th retained Lead Ops key. */
export const leadOpsGroupedTabs = [...leadOpsSections, "canonical"] as const;
export type LeadOpsGroupedTab = typeof leadOpsGroupedTabs[number];
export const prospectingAreaTabs: Record<ProspectingArea, readonly LeadOpsGroupedTab[]> = {
  inventory: ["businesses"],
  "sources-imports": ["prospects","sources","imports","census"],
  enrichment: ["intelligence","provider-results","canonical"],
  "qualification-staging": ["staging","quality","pipeline","sfp"],
  "program-health": ["health","pilot"],
};
export function prospectingAreaForTab(tab: string): ProspectingArea {
  return prospectingAreas.find(area => (prospectingAreaTabs[area] as readonly string[]).includes(tab)) ?? "inventory";
}

/** The six outbound selectors (OutboundCenter `tab`) are retained as compatibility inputs. */
export const outboundSelectors = ["command","campaigns","sequences","governance","prospects","analytics"] as const;
export type OutboundSelector = typeof outboundSelectors[number];
export const campaignAreas = ["manage","audience","delivery","results"] as const;
export type CampaignArea = typeof campaignAreas[number];
export const campaignAreaTabs: Record<CampaignArea, readonly OutboundSelector[]> = {
  manage: ["campaigns","sequences"],
  audience: ["prospects"],
  delivery: ["command","governance"],
  results: ["analytics"],
};
export function campaignAreaForTab(tab: string): CampaignArea {
  return campaignAreas.find(area => (campaignAreaTabs[area] as readonly string[]).includes(tab)) ?? "manage";
}
/** Outbound selector from a URL. Invalid or duplicate values fall back to Command with an issue. */
export function outboundSelectorState(search: string) {
  return selectValue(new URLSearchParams(search), "tab", outboundSelectors, "command");
}

/** Canonical view selection. Grouped hosts read `canonicalView`; the standalone page reads the
 * compatibility `view` parameter. A standalone `canonicalView` is also accepted so a grouped link
 * pasted onto the standalone route still lands on the same child. Contradictory values are
 * discarded with an issue, never silently picked. */
export function canonicalViewState(search: string, grouped: boolean) {
  const params = new URLSearchParams(search);
  const primary = grouped ? "canonicalView" : "view";
  const secondary = grouped ? "view" : "canonicalView";
  const first = selectValue(params, primary, canonicalSections, "pipeline");
  if (!params.has(secondary)) return { view: first.value, issues: first.issues };
  const second = selectValue(params, secondary, canonicalSections, "pipeline");
  if (!params.has(primary)) return { view: second.value, issues: second.issues };
  // Both names present: they must agree and each must be individually valid, otherwise discard both.
  if (first.issues.length || second.issues.length || first.value !== second.value) {
    return { view: "pipeline" as CanonicalSection, issues: [...first.issues, ...second.issues,
      { key: primary, kind: "conflict" as const, reason: `${primary}/${secondary}: conflicting selections. Showing pipeline.` }] };
  }
  return { view: first.value, issues: [] };
}
export function buildCanonicalViewHref(href: string, view: CanonicalSection, grouped: boolean) {
  if (!canonicalSections.includes(view)) throw new Error("Invalid canonical view");
  const url = new URL(href, "https://crm.invalid");
  const params = new URLSearchParams(url.search);
  params.delete("view"); params.delete("canonicalView");
  params.set(grouped ? "canonicalView" : "view", view);
  if (grouped) params.set("tab", "canonical");
  return destinationUrl(url.pathname, params, url.hash);
}
export function recordSectionState(search: string, permitted: readonly typeof contactSections[number][] = contactSections) {
  return selectValue(new URLSearchParams(search),"section",contactSections,
    permitted.includes("overview") ? "overview" : permitted[0],permitted);
}

export const contactAreas = ["overview", "sales-work", "conversations", "lifecycle", "service-performance"] as const;
export type ContactArea = typeof contactAreas[number];
export type ContactSection = typeof contactSections[number];
export const contactAreaSections: Record<ContactArea, readonly ContactSection[]> = {
  overview: ["overview", "relationships", "locations", "company-intelligence"],
  "sales-work": ["deals", "tasks", "call-logs", "call-assist", "offer-intelligence", "sales-prep"],
  conversations: ["comm-timeline", "comm-health", "delivery-log", "notes", "comments"],
  lifecycle: ["documents", "onboarding-stages", "rfis"],
  "service-performance": ["tickets", "live-processing", "chargebacks", "churn-risk", "nps"],
};
export function contactSectionArea(section: ContactSection): ContactArea | null {
  return contactAreas.find(area => contactAreaSections[area].includes(section)) ?? null;
}
/** Decode before mounting child readers. A zero-capability record has no fallback
 * child, rather than accidentally mounting Overview with undefined authority. */
export function contactWorkspaceState(search: string, permitted: readonly ContactSection[] = contactSections) {
  const params = new URLSearchParams(search), issues: SelectionIssue[] = [];
  const allowed = permitted.filter(section => contactSectionArea(section) !== null);
  const fallback = allowed.includes("overview") ? "overview" : allowed[0] ?? null;
  let section: ContactSection | null = fallback;
  let drawer: "activity" | "history" | null = null;
  const read = (key: string, values: readonly string[]) => {
    const all = [...new Set(params.getAll(key))];
    if (!all.length) return null;
    const kind = all.length > 1 ? "conflict" : !values.includes(all[0]) ? "invalid" : null;
    if (kind) { issues.push({key, kind, reason:`The requested ${key} is ${kind}.`}); return null; }
    return all[0];
  };
  const areaInput = read("area", contactAreas);
  const sectionInput = read("section", contactSections);
  const legacy = read("tab", contactSections);
  const drawerInput = read("drawer", ["activity", "history"]);
  if (sectionInput && legacy && sectionInput !== legacy && legacy !== drawerInput) {
    issues.push({key:"tab", kind:"conflict", reason:"Legacy and canonical section selections disagree."});
  }
  const chosen = sectionInput ?? legacy;
  if (chosen === "activity" || chosen === "history") drawer = chosen;
  else if (chosen) section = chosen as ContactSection;
  else if (areaInput) section = contactAreaSections[areaInput as ContactArea].find(s => allowed.includes(s)) ?? null;
  if (drawerInput) {
    if (drawer && drawer !== drawerInput) issues.push({key:"drawer",kind:"conflict",reason:"Drawer selections disagree."});
    drawer = drawerInput as typeof drawer;
  }
  if (section && !allowed.includes(section)) {
    issues.push({key:"section",kind:"forbidden",reason:"This record does not permit the requested section."});
    section = fallback;
  }
  if (drawer && !permitted.includes(drawer)) {
    issues.push({key:"drawer",kind:"forbidden",reason:"This record does not permit the requested drawer."});
    drawer = null;
  }
  if (areaInput && section && contactSectionArea(section) !== areaInput) {
    issues.push({key:"area",kind:"conflict",reason:"The section does not belong to the requested area."});
  }
  if (issues.some(i => i.kind === "conflict" || i.kind === "invalid")) {
    section = fallback; drawer = null;
  }
  if (!allowed.length) {
    issues.push({key:"section",kind:"forbidden",reason:"No record sections are available for this context."});
    drawer = null;
  }
  return {area:section ? contactSectionArea(section) : null, section, drawer, issues, permittedSections:allowed};
}
function workspaceContextKeys() {
  return [...peopleQueryKeys, "id", "taskId", "month", "timezone", "channel", "filter", "thread", "source"] as const;
}
/** Preserve registered context and hash; callers push user choices, replace only
 * alias/invalid canonicalization. Source/thread strings remain opaque namespaces. */
export function buildContactWorkspaceHref(href: string, patch: {
  area?: ContactArea; section?: ContactSection; drawer?: "activity" | "history" | null;
}) {
  const url = new URL(href, "https://crm.invalid");
  const params = safeParams(url.search, workspaceContextKeys());
  const state = contactWorkspaceState(url.search);
  const section = patch.section ?? (patch.area ? contactAreaSections[patch.area][0] : state.section ?? "overview");
  const area = patch.area ?? contactSectionArea(section);
  if (!area || !contactAreaSections[area].includes(section)) throw new Error("Incompatible Contact area and section");
  params.set("area", area); params.set("section", section);
  const drawer = patch.drawer === undefined ? state.drawer : patch.drawer;
  if (drawer) params.set("drawer", drawer);
  return destinationUrl(url.pathname, params, url.hash);
}
export function workWorkspaceState(search: string) {
  const selected = selectValue(new URLSearchParams(search), "tab", ["tasks", "calendar"] as const, "tasks");
  return {tab:selected.value, value:selected.value, issues:selected.issues};
}
export function buildWorkWorkspaceHref(href: string, tab: "tasks" | "calendar") {
  const url = new URL(href, "https://crm.invalid"), params = safeParams(url.search, workspaceContextKeys());
  params.set("tab", tab);
  return destinationUrl("/dashboard/tasks-appointments", params, url.hash);
}
/** Task cohort destinations. `taskState` and `due` are registered selectors parsed at the destination; the Today actions and the
 * Tasks filters share these values and the overdue predicate, so a count and the list it opens use one definition. */
export const taskStateFilters = ["all", "pending", "in_progress", "completed", "cancelled"] as const;
export const taskDueFilters = ["all", "overdue"] as const;
export function taskCohortState(search: string) {
  const params = new URLSearchParams(search);
  const status = selectValue(params, "taskState", taskStateFilters, "all");
  const due = selectValue(params, "due", taskDueFilters, "all");
  return { status: status.value, due: due.value, issues: [...status.issues, ...due.issues] };
}
export function buildTaskCohortHref(href: string, cohort: { status: typeof taskStateFilters[number]; due: typeof taskDueFilters[number] }) {
  const url = new URL(href, "https://crm.invalid"), params = safeParams(url.search, [...workspaceContextKeys(), "tab", "taskState", "due"]);
  params.set("tab", "tasks");
  cohort.status === "all" ? params.delete("taskState") : params.set("taskState", cohort.status);
  cohort.due === "all" ? params.delete("due") : params.set("due", cohort.due);
  return destinationUrl(url.pathname, params, url.hash);
}
/** Overdue = still open (pending or in progress) with a due time before `asOf`; identical to the server's Today metric. */
export function isOverdueTask(task: { status: string | null; dueDate?: string | Date | null }, asOf: Date) {
  if (task.status !== "pending" && task.status !== "in_progress") return false;
  if (!task.dueDate) return false;
  const due = new Date(task.dueDate);
  return Number.isFinite(due.getTime()) && due.getTime() < asOf.getTime();
}
export const todayDestinations = {
  overdueTasks: "/dashboard/tasks-appointments?tab=tasks&due=overdue",
  pendingTasks: "/dashboard/tasks-appointments?tab=tasks&taskState=pending",
  newLeads7d: "/dashboard/pipeline?created=7d",
} as const;
export const inboxChannels = ["all", "email", "sms", "voicemail", "site", "ghl_chat"] as const;
export const inboxFilters = ["all", "unread", "needs_reply"] as const;
export function inboxWorkspaceState(search: string) {
  const params = new URLSearchParams(search);
  // Historical sms-inbox messages means SMS; live-chat means the first-party
  // site chat, NOT all messages or the external GHL chat source.
  const aliases: Record<string,string> = {messages:"sms", "live-chat":"site"};
  const legacy = [...new Set(params.getAll("tab"))];
  const issues: SelectionIssue[] = [];
  if (legacy.length > 1 || (legacy.length && !aliases[legacy[0]])) {
    issues.push({key:"tab",kind:legacy.length > 1 ? "conflict" : "invalid",reason:"Unrecognized legacy Inbox selection."});
  } else if (legacy.length) {
    const mapped = aliases[legacy[0]];
    if (params.has("channel") && params.getAll("channel").some(c => c !== mapped))
      issues.push({key:"channel",kind:"conflict",reason:"Legacy and canonical Inbox channels disagree."});
    else params.set("channel", mapped);
  }
  const channel = selectValue(params, "channel", inboxChannels, "all");
  const filter = selectValue(params, "filter", inboxFilters, "all");
  issues.push(...channel.issues, ...filter.issues);
  const single = (key:string) => {
    const values = [...new Set(params.getAll(key))];
    if (values.length > 1 || (values[0]?.length ?? 0) > 512 || /[\u0000-\u001f]/.test(values[0] ?? "")) {
      issues.push({key,kind:"invalid",reason:`Invalid ${key} selection.`}); return "";
    }
    return values[0] ?? "";
  };
  const searchText=single("search"), thread=single("thread");
  return {channel:issues.some(i=>i.key==="channel" || i.key==="tab")?"all" as const:channel.value,
    filter:filter.value, search:searchText, thread, issues};
}
export function buildInboxWorkspaceHref(href: string, patch: Partial<Pick<ReturnType<typeof inboxWorkspaceState>, "channel" | "filter" | "search" | "thread">>) {
  const url=new URL(href,"https://crm.invalid"),params=safeParams(url.search,workspaceContextKeys());
  params.delete("tab");
  const state={...inboxWorkspaceState(url.search),...patch};
  if (!inboxChannels.includes(state.channel) || !inboxFilters.includes(state.filter)) throw new Error("Invalid Inbox selection");
  params.set("channel",state.channel);params.set("filter",state.filter);
  for(const key of ["search","thread"] as const) { if(state[key])params.set(key,state[key]);else params.delete(key); }
  return destinationUrl(url.pathname,params,url.hash);
}
export function prospectingState(search: string) {
  const params = new URLSearchParams(search);
  return {
    tab:selectValue(params,"tab",leadOpsSections,"businesses"),
    staging:selectValue(params,"stagingView",stagingSections,"master-leads"),
    canonical:selectValue(params,"canonicalView",canonicalSections,"pipeline"),
  };
}

export const peopleQueryKeys = ["tab","search","sort","archived","status","recordClass","limit","offset",
  "churnRisk","noOutreach","blocked","emailHealth","assignedToMe","vertical","tag","contactedToday",
  "hasAssignee","leadSource","lifecycle","stale","recentlyUpdated","neverContacted","notContactedIn30",
  "noDeal","createdThisWeek",...safeContextKeys] as const;
/** Match the registered People parser; do not send an archived read which the
 * actor is forbidden to request. URL presets have no persistent ownerless CRUD. */
export function peopleState(search: string, privileged: boolean, assignmentFilterSupported = false) {
  const input=new URLSearchParams(search),params=safeParams(search,peopleQueryKeys),issues:SelectionIssue[]=[];
  for(const key of peopleQueryKeys){
    if(new Set(input.getAll(key)).size>1)
      issues.push({key,kind:"conflict",reason:`${key}: contradictory values were discarded.`});
  }
  const enums:Record<string,{values:readonly string[];fallback:string;permitted?:readonly string[]}>={
    limit:{values:["25","50","100"],fallback:"50"},
    sort:{values:["activity_desc","activity_asc","score_desc","alpha","name","createdAtAsc","updatedAt","leadScore"],fallback:""},
    recordClass:{values:["production","test","demo","synthetic","unknown","all"],fallback:"production"},
    churnRisk:{values:["high"],fallback:""},noOutreach:{values:["24h"],fallback:""},
    archived:{values:["true","false"],fallback:"false",permitted:privileged?["true","false"]:["false"]},
  };
  enums.assignedToMe={values:["true","false"],fallback:"false",permitted:assignmentFilterSupported?["true","false"]:["false"]};
  for(const key of ["blocked","contactedToday","hasAssignee","stale","recentlyUpdated",
    "neverContacted","notContactedIn30","noDeal","createdThisWeek"])
    enums[key]={values:["true","false"],fallback:"false"};
  for(const [key,rule] of Object.entries(enums)){
    if(!input.has(key))continue;
    const selection=selectValue(input,key,rule.values,rule.fallback,rule.permitted);
    issues.push(...selection.issues);
    if(selection.value && selection.value!=="false")params.set(key,selection.value);else params.delete(key);
  }
  if(input.has("offset")){
    const values=[...new Set(input.getAll("offset"))],value=Number(values[0]);
    if(values.length===1 && /^[0-9]+$/.test(values[0]) && Number.isSafeInteger(value)){
      const size=Number(params.get("limit")??50),offset=Math.floor(value/size)*size;
      if(offset>0)params.set("offset",String(offset));else params.delete("offset");
    }else{params.delete("offset");issues.push({key:"offset",kind:"invalid",reason:"offset: using the first page."});}
  }
  return {params,issues};
}
