import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const jsdomModule = await import(["js", "dom"].join("")) as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: any };
};
const dom = new jsdomModule.JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/dashboard/lead-imports", pretendToBeVisual: true,
});
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "Node", "Element", "File", "FormData", "DataTransfer", "HTMLInputElement", "HTMLSelectElement", "SVGElement", "DocumentFragment", "Text", "CustomEvent", "PointerEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] });
}
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
for (const name of ["location", "history", "addEventListener", "removeEventListener", "dispatchEvent"]) Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as any)[name].bind?.(dom.window) ?? (dom.window as any)[name] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const { parseCsvHeader, describeHeader } = await import("./LeadImports");
assert.deepEqual(parseCsvHeader('Name,"Phone, main",Email\nx,y,z'), ["Name", "Phone, main", "Email"], "quoted header cells are respected");
assert.equal(parseCsvHeader(""), null, "an empty file has no header");
assert.equal(describeHeader("Telephone"), "Phone");
assert.equal(describeHeader("rating"), "Kept only in the original row", "unmapped columns are not claimed as mapped");

const requests: Array<{ method: string; path: string }> = [];
let uploadBody: FormData | null = null;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(String(input), "http://localhost");
  const method = String(init?.method ?? "GET").toUpperCase();
  requests.push({ method, path: url.pathname });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/auth/user") return json({ id: "u1", role: "admin", email: "a@example.test" });
  if (url.pathname === "/api/csv-imports") return json([]);
  if (url.pathname === "/api/csv-imports/stats") return json({ totalImports: 0, totalRowsProcessed: 0, totalRecordsImported: 0, totalDuplicatesSkipped: 0, totalSkippedRows: 0, totalAlreadyExists: 0, totalInvalidRows: 0, totalErrors: 0, totalDealsCreated: 0, verticalBreakdown: {} });
  if (url.pathname === "/api/prospect-lists") return json([]);
  if (url.pathname === "/api/leads/import-csv" && method === "POST") { uploadBody = init.body as FormData; return json({ status: "processing", totalRows: 2 }, 202); }
  return json({}, 404);
}) as any;

const { default: LeadImports } = await import("./LeadImports");
const text = () => document.body.textContent ?? "";
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  throw new Error(`Timed out: ${label}; ${text().slice(0, 600)}`);
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const root = createRoot(document.getElementById("root")!);
await act(async () => {
  root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LeadImports /></QueryClientProvider>);
});
await waitFor(() => !!q("import-steps"), "page mounted");
assert.equal(q("import-step-choose")?.getAttribute("data-state"), "current");
assert.ok(q("button-import-continue") && (q("button-import-continue") as HTMLButtonElement).disabled, "Continue is disabled with no file or source");
assert.equal(q("button-import-csv"), null, "Upload is not offered before review");

// Choose a CSV; the browser sends nothing yet.
const input = q("input-csv-file") as HTMLInputElement;
const file = new dom.window.File(["Name,Telephone,Rating\nA,1,5\n"], "sheet.csv", { type: "text/csv" });
Object.defineProperty(input, "files", { configurable: true, value: [file] });
await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
assert.ok(text().includes("Select the lead source to continue."), "file without source explains why Continue is blocked");
assert.ok((q("button-import-continue") as HTMLButtonElement).disabled);
assert.equal(requests.filter(r => r.method === "POST").length, 0, "choosing a file never uploads");

// Choose a source through the real select (keyboard open, then option).
const trigger = q("select-lead-source") as HTMLElement;
await act(async () => { trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
await waitFor(() => document.querySelectorAll('[role="option"]').length > 0, "source options");
await act(async () => { (document.querySelectorAll('[role="option"]')[0] as HTMLElement).click(); });
await waitFor(() => !(q("button-import-continue") as HTMLButtonElement).disabled, "Continue enabled with file and source");

// Review step: detected columns, honest wording, and Back preserves the file.
await act(async () => { q("button-import-continue")!.click(); });
await waitFor(() => !!q("import-review-step"), "review step");
assert.equal(q("import-step-review")?.getAttribute("data-state"), "current");
await waitFor(() => (q("import-column-preview")?.textContent ?? "").includes("Phone"), "header preview");
assert.ok((q("import-column-preview")?.textContent ?? "").includes("Kept only in the original row"), "unmapped column is labelled as such");
assert.ok(text().includes("header-only preview"));
assert.equal(requests.filter(r => r.method === "POST").length, 0, "review never uploads");
await act(async () => { q("button-import-back")!.click(); });
assert.ok(q("text-selected-filename")?.textContent === "sheet.csv", "Back keeps the chosen file");
await act(async () => { q("button-import-continue")!.click(); });

// Upload: exactly one POST with the original file and source; result says accepted is not complete.
await act(async () => { q("button-import-csv")!.click(); });
await waitFor(() => !!q("import-result-step"), "result step");
assert.equal(requests.filter(r => r.method === "POST" && r.path === "/api/leads/import-csv").length, 1, "one upload request");
assert.ok(uploadBody && (uploadBody as FormData).get("file") instanceof dom.window.File && (uploadBody as FormData).get("leadSource"), "file and source were sent");
assert.ok((q("import-result-step")?.textContent ?? "").includes("accepted") && (q("import-result-step")?.textContent ?? "").includes("Accepted is not completed"), "accepted is not completed");
assert.equal(q("import-step-result")?.getAttribute("data-state"), "current");
await act(async () => { q("button-import-another")!.click(); });
assert.equal(q("import-step-choose")?.getAttribute("data-state"), "current", "Start another import returns to step one");

console.log("LEAD_IMPORTS_WIZARD_UI_PASS");
process.exit(0);
