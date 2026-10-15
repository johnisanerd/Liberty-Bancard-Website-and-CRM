import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const jsdomModule = await import(["js", "dom"].join("")) as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: any };
};
const dom = new jsdomModule.JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/", pretendToBeVisual: true,
});
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent", "MutationObserver", "Node", "Element"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] ?? (dom.window as any)[name] });
}
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;
for (const name of ["location", "history", "addEventListener", "removeEventListener", "dispatchEvent"]) Object.defineProperty(globalThis, name, { configurable: true, value: typeof dom.window[name] === "function" ? dom.window[name].bind(dom.window) : dom.window[name] });

const { UploadLedger } = await import("./UploadLedger");

const executionId = "79356e0b-c0b0-4a2f-abe1-f5844b7c9335";
const row = (n: number, extra: any = {}) => ({
  sourceRowNumber: n, disposition: "created", reasonCode: "CANONICAL_PROVIDER_CONTACT_CREATED", rowFingerprint: "a".repeat(64),
  fulfillmentState: "CANONICAL_LOCAL_IMPORT_FULFILLED", nextAttemptAt: null, completedAt: "2026-10-01T00:00:00Z",
  originalFormat: "raw-v3", sourceCoordinate: null, companyName: `Company ${n}`, businessOnly: false,
  mailboxes: [
    { email: `a${n}@example.test`, contactId: n * 10, hasProvenance: true, businessId: 5, verifiedLink: true },
    { email: `b${n}@example.test`, contactId: n * 10 + 1, hasProvenance: true, businessId: 5, verifiedLink: true },
  ],
  unexpectedContactIds: [], receipt: { status: "current", qualificationVersion: "mailbox_business_identity_v2" }, ...extra,
});
const requests: string[] = [];
globalThis.fetch = (async (input: any) => {
  const url = new URL(String(input), "http://localhost");
  requests.push(url.pathname + url.search);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/canonical-enrichment/uploads") return json({ uploads: [{ executionId, importType: "csv_contact", fileName: null, status: "completed", startedAt: "2026-09-30T00:00:00Z", totalRows: 3, accountedRows: 3 }] });
  if (url.pathname.endsWith("/summary")) return json({ executionId, rows: 3, byDisposition: { created: 3 }, distinctContacts: 5, verifiedLinks: 4,
    receiptsCurrent: 2, receiptsStale: 1, receiptsInconsistent: 0, qualificationVersion: "mailbox_business_identity_v2", observedAt: "2026-10-15T00:00:00Z" });
  if (url.pathname.endsWith("/rows")) {
    const after = Number(url.searchParams.get("after"));
    return json(after === 0
      ? { executionId, rows: [row(1), row(2, { businessOnly: true, mailboxes: [] })], nextAfter: 2, limit: 25, filter: "all", observedAt: "x" }
      : { executionId, rows: [row(3, { receipt: { status: "stale", qualificationVersion: "old" } })], nextAfter: null, limit: 25, filter: "all", observedAt: "x" });
  }
  return new Response("{}", { status: 404 });
}) as any;

const text = () => document.body.textContent ?? "";
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  throw new Error(`Timed out: ${label}; ${text()}; ${requests.join(",")}`);
}

const root = createRoot(document.getElementById("root")!);
await act(async () => {
  root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><UploadLedger /></QueryClientProvider>);
});
await waitFor(() => text().includes("Row 2"), "first ledger page");
assert.ok(text().includes("Original rows") && text().includes("Distinct contacts") && text().includes("Verified links") && text().includes("Current receipts"),
  "rows, contacts, links and receipts are separate measures");
assert.ok(text().includes("1 stale · 0 inconsistent"), "stale/inconsistent receipts are separate");
assert.ok(text().includes("2/2 mailboxes verified") && text().includes("Business only"), "multi-mailbox and business-only rows render");
assert.ok(text().includes("a1@example.test") && text().includes("b1@example.test"), "every mailbox is listed");
assert.ok(text().includes("end of upload") === false && text().includes("more remain"));
const more = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Load next 25 rows"))!;
await act(async () => { more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
await waitFor(() => text().includes("Row 3"), "second keyset page");
assert.ok(requests.some(r => r.includes("after=2")), "next page is requested by keyset cursor");
assert.ok(text().includes("Stale receipt") || text().includes("Stale receipt".toLowerCase()) || text().includes("Stale Receipt"));
assert.ok(text().includes("end of upload"));
console.log("UPLOAD_LEDGER_UI_PASS");
await act(async () => root.unmount());
process.exit(0);
