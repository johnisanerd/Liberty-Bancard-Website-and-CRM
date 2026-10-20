/** Stage 3 C5 Pass 2: resource/action honesty and URL-addressable selectors. Deterministic; no network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  retainedSelection, retainedSelectionUrl, trainingViews, knowledgeAdminViews, integrationsViews,
  adminAreas, adminTabs, adminAreaTabs, adminAreaForTab, adminSelectorState, adminPermittedFor, resourcesDestinations,
} from "../client/src/lib/crm-destination-state";
import { decodeJsonResponse, isRecord } from "../client/src/lib/decode-json-response";
import { readerState } from "../client/src/lib/reader-state";

const read = (p: string) => fs.readFileSync(p, "utf8");

// ── Shared codec: every C5 child selector round-trips and rejects invalid/conflicting input.
const selectors: Array<[string, string, readonly string[], string]> = [
  ["/dashboard/training", "tab", trainingViews, "docs"],
  ["/dashboard/knowledge-admin", "tab", knowledgeAdminViews, "sources"],
  ["/dashboard/settings/integrations", "integrationsView", integrationsViews, "ghl-workflows"],
  ["/dashboard/admin-hub", "integrationsView", integrationsViews, "ghl-workflows"],
  ["/dashboard/admin-hub", "area", adminAreas, "users-access"],
  ["/dashboard/admin-hub", "tab", adminTabs, "users"],
];
for (const [path, key, allowed, fallback] of selectors) {
  for (const value of allowed) {
    const url = new URL(retainedSelectionUrl(path, "", "", key, allowed, value), "http://x.test");
    assert.equal(url.pathname, path);
    assert.equal(retainedSelection(url.search, key, allowed, fallback).value, value, `${path} ${key}=${value}`);
    assert.equal(retainedSelection(url.search, key, allowed, fallback).issues.length, 0);
  }
  assert.equal(retainedSelection(`?${key}=nope`, key, allowed, fallback).issues.length, 1, `${path} invalid ${key}`);
  assert.equal(retainedSelection(`?${key}=nope`, key, allowed, fallback).value, fallback);
  const conflict = retainedSelection(`?${key}=${allowed[0]}&${key}=${allowed[allowed.length - 1]}`, key, allowed, fallback);
  assert.equal(conflict.issues.length, 1, `${path} conflicting ${key}`);
}
// Selecting a child keeps the sibling registered selectors and drops unregistered keys.
const kept = new URL(retainedSelectionUrl("/dashboard/admin-hub", "?area=integrations&tab=integrations&evil=1&integrationsView=zerobounce",
  "", "integrationsView", integrationsViews, "linkedin"), "http://x.test");
assert.equal(kept.searchParams.get("area"), "integrations");
assert.equal(kept.searchParams.get("tab"), "integrations");
assert.equal(kept.searchParams.get("integrationsView"), "linkedin");
assert.equal(kept.searchParams.get("evil"), null);
// The Administration areas partition the eleven existing selectors exactly once each.
const grouped = Object.values(adminAreaTabs).flat();
assert.equal(grouped.length, adminTabs.length);
assert.deepEqual([...grouped].sort(), [...adminTabs].sort());
for (const tab of adminTabs) assert.ok(adminAreas.includes(adminAreaForTab(tab)));
assert.equal(adminTabs.length, 11);

// ── Administration: every legacy tab still resolves per role; area is additive.
for (const tab of adminTabs) {
  const r = adminSelectorState(`?tab=${tab}`, "admin");
  assert.equal(r.tab, tab); assert.equal(r.issues.length, 0); assert.equal(r.area, adminAreaForTab(tab));
}
assert.equal(adminSelectorState("", "admin").tab, "users");
assert.equal(adminSelectorState("?area=data-audit", "admin").tab, "audit-log");
assert.equal(adminSelectorState("?area=integrations&tab=ghl", "admin").tab, "ghl");
assert.equal(adminSelectorState("?area=users-access&tab=ghl", "admin").issues[0].kind, "conflict");
assert.equal(adminSelectorState("?area=bogus", "admin").issues[0].kind, "invalid");
const mgr = adminSelectorState("?tab=users", "manager");
assert.equal(mgr.tab, "consent"); assert.equal(mgr.issues[0].kind, "forbidden"); // forbidden never grants access
assert.deepEqual([...adminPermittedFor("manager")].sort(), ["agents", "consent", "ghl", "integrations", "pci"]);
assert.equal(adminSelectorState("?area=operational-controls", "manager").issues[0].kind, "forbidden");
assert.deepEqual([...adminPermittedFor("agent")], ["consent", "pci"]);
assert.equal(adminSelectorState("?tab=gate-result", undefined).tab, "consent");
assert.equal(resourcesDestinations.length, 6);

// ── JSON receipts come from the decoded body, never from the Response object.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isReceipt = (v: unknown): v is { sources: number } => isRecord(v) && Number.isFinite(v.sources);
assert.deepEqual(await decodeJsonResponse(json({ sources: 3 }), isReceipt, "Re-index"), { sources: 3 });
await assert.rejects(decodeJsonResponse(json({ other: 1 }), isReceipt, "Re-index"), /expected fields/);
await assert.rejects(decodeJsonResponse(new Response("not json"), isReceipt, "Re-index"), /could not be read/);
assert.equal((new Response("{}") as any).sources, undefined, "a Response never carries receipt fields");

// ── Reader states keep failure, loading and stale distinct from empty.
assert.equal(readerState({ isLoading: true, isError: false, data: undefined }), "loading");
assert.equal(readerState({ isLoading: false, isError: true, data: undefined }), "unavailable");
assert.equal(readerState({ isLoading: false, isError: true, data: [] }), "stale");
assert.equal(readerState({ isLoading: false, isError: false, data: [] }), "ready");

// ── Source contracts for the repaired surfaces.
const ka = read("client/src/pages/dashboard/KnowledgeAdmin.tsx");
assert.ok(!/defaultValue="sources"/.test(ka) && ka.includes("useC4RetainedSelection"), "Knowledge Admin tabs bound to URL");
assert.ok(ka.includes("decodeJsonResponse(res, isReindexReceipt") && !/data: any\) => \{[^}]*data\.sources/.test(ka));
for (const label of ["Title", "Audience", "Content"]) assert.match(ka, new RegExp(`htmlFor=\\{\\w+\\} className="text-sm font-medium">${label}`), `${label} label is programmatic`);
assert.ok(ka.includes('className="crm-prose-editor mt-1"') && !ka.includes("font-mono text-xs"), "editor uses prose style, not mono");
assert.ok(/archiveMutation[\s\S]*?onError/.test(ka) && /resolveMutation[\s\S]*?onError/.test(ka), "archive/resolve failures are reported");
const css = read("client/src/styles/crm-theme.css");
assert.match(css, /textarea\.crm-prose-editor[\s\S]*?min-height:\s*200px/);
assert.match(css, /textarea\.crm-prose-editor[\s\S]*?font-size:\s*14px[\s\S]*?line-height:\s*20px/);
assert.match(css, /max-width:\s*767px\)\s*\{\s*\.crm-theme textarea\.crm-prose-editor[\s\S]*?font-size:\s*16px/);

const si = read("client/src/pages/dashboard/SettingsIntegrations.tsx");
assert.ok(!si.includes('Tabs defaultValue="ghl-workflows"') && si.includes('"integrationsView"'));
assert.ok(si.includes("decodeJsonResponse(res, isSeedReceipt") && !si.includes("data?.created"), "seed receipt decoded");
assert.ok(/user\?\.role !== "admin"[\s\S]{0,200}text-sending-identities-readonly/.test(si), "managers get a read-only sending-identities state before any request");
assert.ok(si.includes("canEdit={isAdminUser}") && si.includes("canToggleAutoRun"), "manager-visible write controls are gated");
const tr = read("client/src/pages/dashboard/Training.tsx");
assert.ok(!tr.includes('<Tabs defaultValue="docs"') && tr.includes('"/dashboard/training"'));

for (const file of ["KnowledgeBase", "ContentEditor", "SocialComposer", "BlogGenerator", "BlazeIntegration"]) {
  const src = read(`client/src/pages/dashboard/${file}.tsx`);
  assert.ok(src.includes("readerState"), `${file} distinguishes unavailable from empty`);
}
assert.ok(read("client/src/pages/dashboard/KnowledgeBase.tsx").includes('articlesState === "unavailable"'), "failed article read is not an empty library");
const blaze = read("client/src/pages/dashboard/BlazeIntegration.tsx");
assert.ok(blaze.includes("Status unavailable"), "Blaze never derives Not Connected from a failed read");

const hub = read("client/src/pages/dashboard/AdminHub.tsx");
for (const area of ["Users & Access", "Integrations", "Operational Controls", "Data & Audit", "Release Readiness"]) assert.ok(hub.includes(`"${area}"`), area);
assert.ok(hub.includes("lazy(() => import") && !/^import \w+ from "\.\/(UserManagement|AuditLogs)"/m.test(hub), "children are lazy-mounted");
assert.ok(hub.includes("CrmAreaNav") && hub.includes("CrmPageHeader"), "uses shipped C1 components");
for (const f of ["KnowledgeBase", "Training", "KnowledgeAdmin", "PlaybooksHub", "ContentHub"]) assert.ok(read(`client/src/pages/dashboard/${f}.tsx`).includes("<ResourcesNav"), `${f} has Resources navigation`);

// Passive summary: read-only, no mutations, no stepping effect, no polling.
const summary = read("client/src/components/dashboard/GhlInboundSyncSummary.tsx");
assert.ok(!/useMutation|apiRequest|POST|PATCH|useEffect/.test(summary.replace(/\/\*\*[\s\S]*?\*\//, "")), "summary has no write or continuation path");
assert.ok(summary.includes("refetchInterval: false"));
console.log("Stage 3 C5 resources: PASS");
