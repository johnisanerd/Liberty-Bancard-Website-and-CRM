import assert from "node:assert/strict";
import { QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Isolated mounted test (jsdom + injected fetch) for the complete GHL Integration Hub -> GHL Settings
// path. It exercises real component code and the real incoming-sync card; it does not use a real
// session, handlers, GHL or a database, and it does not claim to have reproduced or explained the
// live browser stall observed in the cloud capture (cause remains unclaimed).
const jsdomModule = await import(["js", "dom"].join("")) as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: any };
};
const dom = new jsdomModule.JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/dashboard/ghl-integration?tab=settings", pretendToBeVisual: true,
});
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "MutationObserver", "Node", "Element"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] ?? (dom.window as any)[name] });
}
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;
for (const name of ["location", "history", "addEventListener", "removeEventListener", "dispatchEvent"]) Object.defineProperty(globalThis, name, { configurable: true, value: typeof dom.window[name] === "function" ? dom.window[name].bind(dom.window) : dom.window[name] });
(dom.window as any).ResizeObserver = (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
(dom.window as any).matchMedia = (globalThis as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

for (const name of ["requestAnimationFrame", "cancelAnimationFrame", "DOMException", "HTMLInputElement", "HTMLButtonElement", "SVGElement", "KeyboardEvent", "FocusEvent", "CustomEvent", "getSelection"]) {
  if (!(name in globalThis) && dom.window[name] !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: typeof dom.window[name] === "function" && !/^[A-Z]/.test(name) ? dom.window[name].bind(dom.window) : dom.window[name] });
}
const { queryClient } = await import("@/lib/queryClient");
const { default: GhlIntegrationHub } = await import("./GhlIntegrationHub");

type Scenario = "populated" | "error" | "timeout" | "ready" | "previewing" | "running";
const ENDPOINT = "/api/admin/ghl/inbound-contact-sync";
const lists = ["/api/ghl/activity", "/api/message-templates", "/api/sla-configs"];
const run = (state: string, nextAction: "scan" | "apply" | null) => ({
  runId: "run-1", state, createdAt: "2026-10-03T13:00:00Z", updatedAt: "2026-10-03T13:44:13Z",
  counts: { scanned: 10, matched: 8, wouldUpdate: 1, wouldCreate: 1, updated: 0, created: 0, conflicts: 0, skipped: 0 },
  previewHash: "h".repeat(8), nextAction, lastError: null, issues: [],
});
let scenario: Scenario = "populated";
let requests: Array<{ method: string; path: string }> = [];
function install() {
  globalThis.fetch = ((input: any, init: any = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = String(init.method ?? "GET").toUpperCase();
    requests.push({ method, path: url.pathname });
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    if (url.pathname === "/api/auth/user") return json({ id: "u1", role: "admin", email: "a@example.test" });
    if (scenario === "timeout") {
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (scenario === "error") return json({ message: "unavailable" }, 500);
    if (url.pathname === ENDPOINT) {
      const state = scenario === "ready" ? run("ready", null) : scenario === "previewing" ? run("previewing", "scan")
        : scenario === "running" ? run("running", "apply") : null;
      return json({ environment: "production", configured: true, inboundEnabled: true, outboundPaused: true, run: state });
    }
    if (url.pathname === `${ENDPOINT}/run-1/step`) return json({ run: run("complete", null) });
    if (lists.includes(url.pathname)) return json([]);
    return json({ connected: true, configured: true });
  }) as any;
}

const text = () => document.body.textContent ?? "";
const settle = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) { if (check()) return; await settle(10); }
  throw new Error(`Timed out: ${label}; ${text().slice(0, 400)}; ${JSON.stringify(requests.slice(0, 20))}`);
}
async function mount(next: Scenario) {
  scenario = next; requests = []; queryClient.clear(); install();
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(<QueryClientProvider client={queryClient}><GhlIntegrationHub /></QueryClientProvider>); });
  return root;
}
const writes = () => requests.filter(r => r.method !== "GET");

for (const next of ["populated", "error", "timeout", "ready"] as const) {
  const root = await mount(next);
  await waitFor(() => text().includes("Settings") && text().includes("Sequence Guide"), `${next}: hub tabs`);
  await waitFor(() => document.querySelector('[data-testid="text-ghl-connection-status"]') !== null || next === "timeout" || next === "error", `${next}: settings page mounted`);
  await settle(250);
  assert.deepEqual(writes(), [], `${next}: mounting GHL Settings issues no write requests`);
  assert.ok(requests.length < 60, `${next}: bounded request count (${requests.length})`);
  if (next === "ready") assert.ok(text().includes("Preview ready"), "ready incoming run renders its state");
  await act(async () => { root.unmount(); });
}

for (const next of ["previewing", "running"] as const) {
  const root = await mount(next);
  await waitFor(() => writes().length >= 1, `${next}: the existing continuation advances once`);
  await settle(300);
  const steps = writes();
  assert.equal(steps.length, 1, `${next}: exactly one bounded continuation step (${JSON.stringify(steps)})`);
  assert.equal(steps[0].path, `${ENDPOINT}/run-1/step`);
  await act(async () => { root.unmount(); });
}
console.log("GHL_SETTINGS_MOUNTED_PASS");
process.exit(0);
