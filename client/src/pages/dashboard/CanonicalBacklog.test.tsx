import assert from "node:assert/strict";
import { QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const jsdomModule = await import(["js", "dom"].join("")) as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: any };
};
const dom = new jsdomModule.JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/", pretendToBeVisual: true,
});
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "MutationObserver", "Node", "Element"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] });
}
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;
for (const name of ["location", "history", "addEventListener", "removeEventListener", "dispatchEvent"]) Object.defineProperty(globalThis, name, { configurable: true, value: typeof dom.window[name] === "function" ? dom.window[name].bind(dom.window) : dom.window[name] });

const { CanonicalBacklog } = await import("./CanonicalBacklog");
const { QueryClient } = await import("@tanstack/react-query");
const { getQueryFn } = await import("@/lib/queryClient");

// Mutable server behaviour per scenario. Every request is recorded so hidden-view polling and
// unintended mutations (anything but GET) are visible to the assertions.
let releaseMode: "revoked" | "expired" | "open" | "none" | "fail" | "denied" = "fail";
const requests: Array<{ method: string; path: string }> = [];
const rec = (id: string, extra: any = {}) => ({ releaseId: id, releasedAt: "2026-10-10T00:00:00Z", admissionClosesAt: "2026-10-11T00:00:00Z",
  journeyExpiresAt: "2026-10-24T00:00:00Z", admissionClosedAt: null, journeyEndedAt: null, revokedAt: null, enrollmentIds: [1], ...extra });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(String(input), "http://localhost");
  requests.push({ method: (init.method ?? "GET").toUpperCase(), path: url.pathname });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/canonical-enrichment/backlog") return json({ message: "enrichment backlog is unavailable; nothing was counted" }, 503);
  if (url.pathname === "/api/canonical-enrichment/launch-inventory") return json({ message: "inventory down" }, 503);
  if (url.pathname === "/api/canonical-enrichment/release") {
    if (releaseMode === "fail") return json({ message: "boom" }, 500);
    if (releaseMode === "denied") return json({ message: "Forbidden" }, 403);
    const base = { releases: [], journeys: {}, holds: {}, heldEnrollments: [], capacity: null,
      policy: { maxRecipientsPerRelease: 500, maxAdmissionWindowHours: 72, journeyDays: 14 } };
    if (releaseMode === "none") return json({ ...base, latest: null, admissionOpen: false, live: false });
    if (releaseMode === "open") return json({ ...base, latest: rec("r1"), admissionOpen: true, live: true });
    if (releaseMode === "expired") return json({ ...base, latest: rec("r1"), admissionOpen: false, live: false });
    return json({ ...base, latest: rec("r1", { revokedAt: "2026-10-12T00:00:00Z" }), admissionOpen: false, live: false });
  }
  if (url.pathname === "/api/canonical-enrichment/release/preview") return json({ snapshotHash: "h1", size: 2, dailyCapacityRemaining: 30, qualifiedPrimaryRecipients: 2, continuations: 0, notes: [] });
  if (url.pathname === "/api/canonical-enrichment/release/execute") return json({ replayed: true, releaseId: "r1" });
  return json({}, 404);
}) as any;

const text = () => document.body.textContent ?? "";
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) { if (check()) return; await act(async () => { await new Promise(r => setTimeout(r, 10)); }); }
  throw new Error(`Timed out: ${label}; ${text().slice(0, 600)}`);
}
const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) as any } } });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(<QueryClientProvider client={client}><CanonicalBacklog isAdmin /></QueryClientProvider>); });
  return root;
}

// 1. Backlog and inventory both failed: both are explicit unavailable states, neither is a zero, and the
//    independent release reader still renders (here as a failure with Retry, not as "no release").
let root = await mount();
await waitFor(() => !!byTest("backlog-unavailable") && !!byTest("launch-inventory-unavailable"), "independent unavailable states");
assert.ok(text().includes("nothing was counted"), "server error text is surfaced");
await waitFor(() => !!byTest("release-error"), "release read failure shown on its own");
assert.ok(!byTest("release-state-none"), "a failed release read is never shown as 'no release'");
assert.ok(![...document.querySelectorAll("button")].some(b => /Preview|Revoke/.test(b.textContent ?? "")), "release mutations are absent until authoritative state loads");
const retries = [...document.querySelectorAll("button")].filter(b => b.textContent?.trim() === "Retry");
assert.ok(retries.length >= 1, "release has its own Retry");
await act(async () => root.unmount());

// 2. Each authoritative release state is named distinctly.
for (const [mode, testId, snippet] of [
  ["none", "release-state-none", "No release has been made"],
  ["open", "release-state-open", "Release open"],
  ["expired", "release-state-expired", "Release expired"],
  ["revoked", "release-state-revoked", "Release revoked"],
] as const) {
  releaseMode = mode;
  root = await mount();
  await waitFor(() => !!byTest(testId), `state ${mode}`);
  assert.ok(byTest(testId)!.textContent!.includes(snippet), `${mode} copy`);
  await act(async () => root.unmount());
}

// 3. Denied is distinct from unavailable and offers no Retry.
releaseMode = "denied";
root = await mount();
await waitFor(() => !!byTest("release-denied"), "denied state");
assert.ok(!byTest("release-error"), "denied is not the unavailable state");
assert.ok(!byTest("release-denied")!.textContent!.includes("Retry"), "denied has no Retry");
await act(async () => root.unmount());

assert.ok(requests.every(r => r.method === "GET"), "viewing never issues a mutation");

// 4. A repeated release request is answered with the release it already created: the panel names that
//    persistently and never presents it as a new release.
requests.length = 0;
releaseMode = "none";
root = await mount();
await waitFor(() => !!byTest("release-state-none"), "none state before preview");
const buttonByText = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;
await act(async () => { buttonByText("Preview")!.click(); });
await waitFor(() => !!buttonByText("Release 2 recipients"), "preview enables release");
assert.ok(!byTest("release-replayed"), "no replay notice before executing");
await act(async () => { buttonByText("Release 2 recipients")!.click(); });
await waitFor(() => !!byTest("release-replayed"), "replay state after execute");
assert.ok(byTest("release-replayed")!.textContent!.includes("No new release was created"), "replay copy");
assert.ok(requests.some(r => r.method === "POST" && r.path.endsWith("/release/execute")), "execute was requested");
await act(async () => root.unmount());

// 5. Last requested pass: current, older (missing/malformed counters), null staged and finite zero values.
{
  const { ProcessPanel } = await import("./CanonicalBacklog");
  const base = { schemaVersion: 2, scope: "local_only", maxRows: 100, timeBudgetSeconds: 60, startedAt: "2026-10-10T00:00:00Z", finishedAt: "2026-10-10T00:05:00Z",
    preparationPasses: 1, prepared: 0, providerTicks: "skipped_local_only" };
  const render = async (last: any) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const r = createRoot(document.getElementById("root")!);
    await act(async () => { r.render(<QueryClientProvider client={client}><ProcessPanel isAdmin last={last} /></QueryClientProvider>); });
    const out = byTest("backlog-last-run")?.textContent ?? "";
    await act(async () => r.unmount());
    return out;
  };
  const current = await render({ ...base, staged: { examined: 12, pages: 1, created: 3, linkedExisting: 4, alreadyLinked: 0, held: 2, failed: 0 } });
  assert.ok(current.includes("12 examined") && current.includes("7 linked") && current.includes("2 held") && current.includes("0 failed") && !current.includes("NaN"), `current run: ${current}`);
  const older = await render({ ...base, schemaVersion: undefined, staged: { examined: 12, created: 3, linkedExisting: 4, failed: 0 }, prepared: null });
  assert.ok(older.includes("Unavailable for this older run held") && !older.includes("NaN"), `older run: ${older}`);
  assert.ok(older.includes("12 examined") && older.includes("0 failed"), "valid older counters still shown, including a real zero");
  const malformed = await render({ ...base, staged: { examined: "x", created: Infinity, linkedExisting: null, held: -1, failed: NaN }, preparationPasses: null });
  assert.ok(!malformed.includes("NaN") && !malformed.includes("Infinity") && malformed.includes("Unavailable for this older run"), `malformed run: ${malformed}`);
  assert.ok(!/ 0 held/.test(malformed), "an unreadable counter is never shown as zero");
  const notStaged = await render({ ...base, staged: null });
  assert.ok(notStaged.includes("Staged emails were not processed in that pass."), "null staged means not processed");
}
console.log("CANONICAL_BACKLOG_UI_PASS");
process.exit(0);
