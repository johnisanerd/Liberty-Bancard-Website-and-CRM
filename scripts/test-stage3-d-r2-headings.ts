import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const jsdomModule = await import(["js", "dom"].join("")) as { JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: any } };
const dom = new jsdomModule.JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "MutationObserver", "Node", "Element"])
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

const { PageHeadingOwnerProvider, ShellPageTitle, PageTitle, PageHeadingLevel } = await import("../client/src/components/ui/page-header");
const { PageHeader, CrmPageHeader } = await import("../client/src/components/crm/CrmPresentation");
const { ErrorBoundary } = await import("../client/src/components/ErrorBoundary");
const h = React.createElement;
let checks = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks++; console.log(`✓ ${label}`); };

// Every DOM mutation batch is sampled; one mounted shell must never show two h1s, and never zero once mounted.
const samples: Array<{ n: number; text: string[] }> = [];
const sample = () => { const hs = [...document.querySelectorAll("h1")].map(e => e.textContent ?? ""); samples.push({ n: hs.length, text: hs }); };
new dom.window.MutationObserver(sample).observe(document.body, { childList: true, subtree: true, characterData: true });
const h1s = () => [...document.querySelectorAll("h1")].map(e => e.textContent);
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const crash = () => { throw new Error("page render failure"); };

function Shell({ label, children }: { label: string; children?: React.ReactNode }) {
  return h(PageHeadingOwnerProvider, null,
    h("header", null, h(ShellPageTitle, { label })),
    h("main", null, children));
}
const root = createRoot(document.getElementById("root")!);
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); await settle(); };
const mark = () => samples.length;
const since = (m: number) => samples.slice(m);

// Loading: the shell owns the only h1 until a page claims it.
await render(h(Shell, { label: "Contacts" }));
check(JSON.stringify(h1s()) === JSON.stringify(["Contacts"]), "Loading with no page yields exactly one h1: the shell title");

// A page mounts and takes ownership; the shell title becomes plain text.
let m = mark();
await render(h(Shell, { label: "Contacts" }, h(PageTitle, null, "People")));
check(JSON.stringify(h1s()) === JSON.stringify(["People"]), "A mounted page owns the single h1");
check(document.querySelector('[data-testid="text-page-title"]')?.tagName === "DIV" && document.querySelector('[data-testid="text-page-title"]')?.textContent === "Contacts", "The shell keeps its title text, without a heading role");
check(since(m).every(s => s.n === 1), "No sampled state during shell → page hand-off has zero or two h1s");

// Tab or route change between pages: ownership passes without a gap or overlap.
m = mark();
await render(h(Shell, { label: "Contacts" }, h(PageHeader, { title: "Campaigns" })));
check(JSON.stringify(h1s()) === JSON.stringify(["Campaigns"]) && since(m).every(s => s.n === 1), "Switching page headers never shows zero or two h1s");
m = mark();
await render(h(Shell, { label: "Contacts" }, h(React.Fragment, { key: "tab-2" }, h(PageTitle, null, "Sequences"))));
check(JSON.stringify(h1s()) === JSON.stringify(["Sequences"]) && since(m).every(s => s.n === 1), "Re-keying the page for a tab change keeps one h1");

// Hub: the hub heading is the h1; embedded children render h2, and ordinary section headings are untouched.
await render(h(Shell, { label: "Contacts" }, h(React.Fragment, null,
  h(PageTitle, null, "Lead Operations Center"),
  h(PageHeadingLevel, { level: 2 }, h("div", null, h(PageTitle, null, "Data Quality"), h(PageHeader, { title: "Sources" }), h(CrmPageHeader, { title: "Reports" }), h("h2", null, "Local section"), h("h3", null, "Detail"))))));
check(JSON.stringify(h1s()) === JSON.stringify(["Lead Operations Center"]), "A hub owns the h1 while embedded children do not claim it");
check([...document.querySelectorAll("h2")].map(e => e.textContent).join("|") === "Data Quality|Sources|Reports|Local section" && document.querySelectorAll("h3").length === 1,
  "Embedded titles are h2 and unrelated section headings are not suppressed");

// Page unmounts: the shell becomes the h1 again.
m = mark();
await render(h(Shell, { label: "Contacts" }));
check(JSON.stringify(h1s()) === JSON.stringify(["Contacts"]) && since(m).every(s => s.n === 1), "Unmounting the page returns the single h1 to the shell");

// Error inside the shell: boundary fallback is the page heading.
m = mark();
const originalError = console.error; console.error = () => {};
await render(h(Shell, { label: "Contacts" }, h(ErrorBoundary, null, h(function Boom() { return crash(); }))));
console.error = originalError;
check(JSON.stringify(h1s()) === JSON.stringify(["Something went wrong"]), "A crashed page shows one h1: the error title");
check(document.querySelector('[data-testid="text-page-title"]')?.tagName === "DIV" && since(m).every(s => s.n === 1), "The shell yields to the error heading without an overlap");

// Error outside the shell (whole route failed, e.g. chunk failure): the fallback still provides the single h1.
await render(h(React.Fragment, null));
console.error = () => {};
await render(h(ErrorBoundary, null, h(function Boom2() { return crash(); })));
console.error = originalError;
check(JSON.stringify(h1s()) === JSON.stringify(["Something went wrong"]), "A route-level failure with no shell still has exactly one h1");

// The boundary is not stuck: after remount of a healthy page the single h1 is that page.
await render(h(Shell, { label: "Contacts" }, h(PageTitle, null, "People")));
check(JSON.stringify(h1s()) === JSON.stringify(["People"]), "A healthy page after an error owns the single h1");
check(samples.every(s => s.n <= 1), `No DOM batch across ${samples.length} samples ever contained two h1s`);
console.log(`PASS Stage 3 D-R2 heading ownership (mounted): ${checks} checks`);
root.unmount();
process.exit(0);
