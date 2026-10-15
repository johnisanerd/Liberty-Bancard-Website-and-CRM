import assert from "node:assert/strict";
import { QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { queryClient } from "@/lib/queryClient";

const jsdomModule = await import(["js", "dom"].join("")) as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: any };
};
const dom = new jsdomModule.JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: dom.window.CustomEvent });
Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: dom.window.MouseEvent });
Object.defineProperty(globalThis, "KeyboardEvent", { configurable: true, value: dom.window.KeyboardEvent });
Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: dom.window.MutationObserver });
Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ContactLinkCoveragePanel } = await import("./ContactLinkCoveragePanel");
const container = document.getElementById("root");
assert.ok(container);
const root = createRoot(container);

const candidateIds = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
];
const cursor = {
  createdAt: "2025-02-03T04:05:06.000Z",
  id: candidateIds[0],
};
const categoryCounts = {
  STRICT_AUTO_ELIGIBLE: 2,
  ALREADY_VERIFIED: 2,
  RECOVERABLE_IDENTITY: 2,
  NEEDS_BUSINESS_DISCOVERY: 2,
  REVIEW: 2,
  OUT_OF_SCOPE: 2,
  SUPPRESSED: 2,
  UNUSABLE: 2,
};
let status = {
  runId: "coverage-run-1",
  status: "ready",
  watermark: 154418,
  cursor: 0,
  total: 154418,
  processed: 16,
  counts: { ...categoryCounts },
  reasonCounts: { filing_identifier_missing: 4 },
  complete: false,
};
let stepCount = 0;
let releaseFirstStep: () => void = () => { throw new Error("First page has not started"); };
let signalFirstStepStarted: (() => void) | null = null;
const firstStepStarted = new Promise<void>((resolve) => { signalFirstStepStarted = resolve; });
const requests: Array<{ url: URL; method: string; body?: unknown; csrf?: string }> = [];
let acceptedReviewPayload: unknown = null;

const reviewItemSchema = z.object({
  candidateId: z.string().uuid(),
  contactId: z.number().int().positive(),
  businessId: z.number().int().positive(),
  decision: z.enum(["verified", "missing", "conflicted", "legacy_unknown", "rejected"]),
  expectedRevision: z.number().int().nonnegative(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceSourceEventId: z.number().int().positive().optional(),
}).strict();
const reviewBatchSchema = z.object({
  items: z.array(reviewItemSchema).min(1).max(500),
}).strict();

function jsonResponse(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

function candidate(candidateId: string, contactId: number, businessId: number) {
  return {
    candidateId,
    contactId,
    businessId,
    evidenceSourceEventIds: [902],
    evidence: {
      contactCompanyName: "Cypress Garden Supply",
      contactWebsiteDomain: "cypress-garden.example",
      contactPhoneLast4: "0188",
      contactAddressMatched: true,
      business: {
        canonicalName: "Cypress Garden Supply LLC",
        websiteDomain: "cypress-garden.example",
        recordClass: "canonical",
      },
      sourceLinks: [{
        sourceLinkId: "retained-link-5",
        sourceSystem: "sunbiz",
        sourceType: "sunbiz_entity",
        stableKey: "FL-2025-005",
        sourceEntityId: 505,
        sunbizName: "Cypress Garden Supply LLC",
        sunbizDba: "Cypress Outdoor",
        sunbizFilingNumber: "FL-2025-005",
        sunbizAddress: "42 Grove Avenue",
        sunbizCity: "Tampa",
        sunbizState: "FL",
        sunbizEntitySource: "retained Sunbiz filing",
      }],
      sourceEvents: [{ eventId: 902, sourceCategory: "business_registry", sourceType: "filing_reference" }],
      ...(contactId === 104 ? {
        rawSunbizCandidates: [{
          sourceEntityId: 505,
          filingNumber: "FL-2025-005",
          entityName: "Cypress Garden Supply LLC",
          dba: "Cypress Outdoor",
          canonicalSourceLinkMaterialized: false,
        }],
      } : {}),
      matchedSignals: [{ kind: "filing_identifier", matched: true, detail: "Retained filing identifier matches the canonical source link." }],
    },
    conflicts: [{ code: "untrusted_or_inconsistent_business_projection", projectedBusinessId: 0 }],
    reasons: ["filing_identifier_match"],
    expectedRevision: 3,
    snapshotHash: "a".repeat(64),
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input), "http://localhost");
  const method = (init.method ?? "GET").toUpperCase();
  const parsedBody = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const headers = new Headers(init.headers);
  requests.push({ url, method, body: parsedBody, csrf: headers.get("x-csrf-token") ?? undefined });
  if (method === "POST" && url.pathname.startsWith("/api/admin/contact-link-coverage")
      && headers.get("x-csrf-token") !== "test-csrf-token") {
    return jsonResponse({ message: "CSRF missing" }, 403);
  }

  if (method === "GET" && url.pathname.endsWith("/status")) return jsonResponse(status);
  if (method === "GET" && url.pathname.endsWith("/candidates")) {
    assert.equal(url.searchParams.get("limit"), "25");
    const afterCreatedAt = url.searchParams.get("afterCreatedAt");
    const afterId = url.searchParams.get("afterId");
    assert.equal(Boolean(afterCreatedAt), Boolean(afterId), "both keyset cursor fields must be sent together");
    if (afterCreatedAt && afterId) {
      assert.equal(afterCreatedAt, cursor.createdAt);
      assert.equal(afterId, cursor.id);
      return jsonResponse({ candidates: [candidate(candidateIds[1], 104, 204)], nextCursor: null, limit: 25 });
    }
    return jsonResponse({ candidates: [candidate(candidateIds[0], 103, 203)], nextCursor: cursor, limit: 25 });
  }
  if (method === "POST" && url.pathname.endsWith("/resume")) {
    status = { ...status, status: "running" };
    return jsonResponse(status);
  }
  if (method === "POST" && url.pathname.endsWith("/step")) {
    stepCount += 1;
    if (stepCount === 1) {
      signalFirstStepStarted?.();
      await new Promise<void>((resolve) => { releaseFirstStep = resolve; });
      status = { ...status, status: "ready", processed: 25, cursor: 25 };
    } else {
      status = { ...status, status: "completed", complete: true, processed: status.total, cursor: status.watermark };
    }
    return jsonResponse(status);
  }
  if (method === "POST" && url.pathname.endsWith("/pause")) {
    status = { ...status, status: "paused" };
    return jsonResponse(status);
  }
  if (method === "POST" && url.pathname.endsWith("/review-batch")) {
    const parsed = reviewBatchSchema.safeParse(parsedBody);
    if (!parsed.success) return jsonResponse({ message: "Invalid strict review payload" }, 400);
    assert.ok(parsed.data.items.length <= 25, "client review batches stay within one 25-row page");
    assert.equal("decisions" in (parsedBody as object), false);
    assert.equal("decisionKey" in parsed.data.items[0], false);
    acceptedReviewPayload = parsed.data;
    const item = parsed.data.items[0];
    return jsonResponse({
      outcomes: [{ contactId: item.contactId, businessId: item.businessId, decisionId: "decision-5", revision: 4, status: "applied" }],
      applied: 1,
      replayed: 0,
      rejected: 0,
    });
  }
  if (method === "POST" && url.pathname.endsWith("/source-recovery/preview")) {
    const items = (parsedBody as any)?.items ?? [];
    assert.equal(items.length, 1);
    return jsonResponse({
      denominator: items.length,
      results: items.map((identity: any) => ({
        identity,
        status: "READY",
        reasonCodes: [],
        snapshotHash: "c".repeat(64),
        source: { entityName: "Cypress Garden Supply LLC", dba: "Cypress Outdoor" },
        canonicalBusiness: { businessId: identity.businessId, canonicalName: "Cypress Garden Supply LLC" },
      })),
    });
  }
  if (method === "POST" && url.pathname.endsWith("/source-recovery/apply")) {
    const items = (parsedBody as any)?.items ?? [];
    assert.equal(items.length, 1);
    assert.equal(items[0].expectedSnapshotHash, "c".repeat(64));
    return jsonResponse({
      denominator: items.length,
      results: items.map((item: any) => ({
        identity: {
          candidateId: item.candidateId,
          contactId: item.contactId,
          businessId: item.businessId,
          sourceEntityId: item.sourceEntityId,
          filingNumber: item.filingNumber,
        },
        status: "MATERIALIZED",
        reasonCodes: ["canonical_sunbiz_source_link_materialized"],
        sourceLinkId: "source-link-test",
        snapshotHash: item.expectedSnapshotHash,
      })),
    });
  }
  return jsonResponse({ message: `Unexpected mock request ${method} ${url.pathname}` }, 404);
};

function visibleText(text: string): boolean {
  return document.body.textContent?.includes(text) ?? false;
}

async function waitFor(assertion: () => boolean, description: string, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${description}; rendered text: ${document.body.textContent}; requests: ${JSON.stringify(requests.map(({ url, method }) => `${method} ${url.pathname}${url.search}`))}`);
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent?.includes(label));
  assert.ok(button, `expected button containing "${label}"`);
  return button as HTMLButtonElement;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function changeSelect(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

try {
  document.cookie = "csrf_token=test-csrf-token; path=/";
  await act(async () => {
    queryClient.setQueryData(["/api/auth/user"], { id: "agent-test", role: "agent" });
    root.render(
      <QueryClientProvider client={queryClient}>
        <ContactLinkCoveragePanel />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => visibleText("available to admins only"), "non-admin contact-link census access message");
  assert.equal([...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Start full-pool census")), false);

  await act(async () => {
    queryClient.setQueryData(["/api/auth/user"], { id: "admin-test", role: "admin" });
  });
  await waitFor(() => visibleText("ready") && visibleText("Cypress Garden Supply"), "ready census and candidate render");
  assert.ok(visibleText("154,418"), "full-pool denominator is visible");
  assert.ok(visibleText("16 processed contacts of 154,418 contacts in the census pool"), "classified buckets identify their processed denominator separately from the full contact pool");
  for (const bucket of [
    "STRICT_AUTO_ELIGIBLE", "ALREADY_VERIFIED", "RECOVERABLE_IDENTITY", "NEEDS_BUSINESS_DISCOVERY",
    "REVIEW", "OUT_OF_SCOPE", "SUPPRESSED", "UNUSABLE",
  ]) {
    assert.ok(document.querySelector(`[data-testid="coverage-bucket-${bucket}"]`), `${bucket} bucket is rendered`);
  }
  assert.equal(document.querySelector('[data-testid="coverage-bucket-REJECTED"]'), null, "legacy bucket is not rendered");
  assert.ok(visibleText("never as invalid solely for lacking a candidate"), "missing candidates are not described as invalid");
  assert.ok(visibleText("Sunbiz Dba"), "retained DBA provenance is rendered");
  assert.ok(visibleText("42 Grove Avenue"), "retained filing address is rendered");
  assert.ok(visibleText("Tampa"), "retained filing locality is rendered");
  assert.ok(visibleText("902"), "source event reference is rendered");
  assert.ok(visibleText("•••-•••-0188"), "phone reference is privacy masked");

  await click(findButton("Resume + auto-process pages"));
  await firstStepStarted;
  await waitFor(() => visibleText("running"), "running state while a census page is in flight");
  await click(findButton("Pause census"));
  releaseFirstStep();
  await waitFor(() => visibleText("paused"), "paused state after the bounded page completes");

  await click(findButton("Resume + auto-process pages"));
  await waitFor(() => visibleText("completed"), "completed state after resumed census");
  assert.equal(status.complete, true);

  await click(findButton("Next page"));
  await waitFor(() => requests.some((request) =>
    request.method === "GET"
      && request.url.pathname.endsWith("/candidates")
      && request.url.searchParams.get("afterCreatedAt") === cursor.createdAt
      && request.url.searchParams.get("afterId") === cursor.id), "candidate cursor object request");
  await waitFor(() => visibleText("Contact #104"), "second keyset candidate page");

  const checkbox = document.querySelector(`[aria-label="Select contact 104 for review"]`);
  assert.ok(checkbox);
  await click(checkbox);
  const decision = document.getElementById(`decision-${candidateIds[1]}`);
  const evidence = document.getElementById(`evidence-${candidateIds[1]}`);
  assert.ok(decision);
  assert.ok(evidence);
  assert.ok(visibleText("Bounded raw-to-canonical source recovery"));
  assert.ok(visibleText("applies the system link policy automatically"));
  assert.ok(visibleText("Only the normal independent Human Review queue"));
  assert.ok(visibleText("Cypress Outdoor"), "retained source DBA appears in bounded recovery UI");
  await click(document.querySelector('[aria-label="Select raw Sunbiz filing FL-2025-005 for source recovery"]')!);
  await click(findButton("Preview 1 selected raw identities"));
  await waitFor(() => visibleText("READY"), "actual rendered source-recovery preview state");
  assert.ok(requests.some((request) => request.method === "POST" && request.url.pathname.endsWith("/source-recovery/preview")));
  await click(findButton("Apply 1 exact-snapshot preview"));
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), "source recovery confirmation dialog");
  await click(findButton("Apply 1 audited source link"));
  await waitFor(() => visibleText("Apply result: MATERIALIZED"), "source link materialization result");
  const recoveryPreviewRequest = requests.find((request) => request.method === "POST" && request.url.pathname.endsWith("/source-recovery/preview"));
  const recoveryApplyRequest = requests.find((request) => request.method === "POST" && request.url.pathname.endsWith("/source-recovery/apply"));
  assert.ok(recoveryPreviewRequest);
  assert.equal((recoveryPreviewRequest.body as any).items[0].sourceEntityId, 505);
  assert.equal((recoveryPreviewRequest.body as any).items[0].filingNumber, "FL-2025-005");
  assert.ok(recoveryApplyRequest);
  assert.equal(recoveryApplyRequest.csrf, "test-csrf-token", "rendered source-recovery apply carries the cookie-matched CSRF header");
  assert.equal((recoveryApplyRequest.body as any).items[0].expectedSnapshotHash, "c".repeat(64));
  await changeSelect(decision as HTMLSelectElement, "verified");
  await changeSelect(evidence as HTMLSelectElement, "902");
  await click(findButton("Submit 1 review"));
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), "review confirmation dialog");
  const confirmation = findButton("Submit 1 decisions");
  await click(confirmation);
  await waitFor(() => Boolean(acceptedReviewPayload), "strict backend review payload acceptance");
  assert.ok(requests.some((request) => request.method === "POST"), "a rendered handler issued the authenticated mutation request");
  // The fetch mock rejects missing CSRF headers; successful route simulation
  // proves the rendered mutation carried the cookie-matched token.
  const renderedMutations = requests.filter((request) => request.method === "POST");
  assert.equal(renderedMutations.length, 8);
  assert.ok(renderedMutations.every((request) => request.csrf === "test-csrf-token"), "all rendered mutations use the cookie-matched CSRF token");
  await waitFor(() => visibleText("Result: applied"), "server per-item review outcome");

  const payload = acceptedReviewPayload as z.infer<typeof reviewBatchSchema>;
  assert.deepEqual(Object.keys(payload), ["items"]);
  assert.equal(payload.items[0].candidateId, candidateIds[1]);
  assert.equal(payload.items[0].decision, "verified");
  assert.equal(payload.items[0].evidenceSourceEventId, 902);
  assert.equal(payload.items[0].expectedRevision, 3);
  assert.equal(payload.items[0].snapshotHash, "a".repeat(64));
  console.log("contact-link-coverage panel render/API contract tests passed");
} finally {
  await act(async () => root.unmount());
  queryClient.clear();
  globalThis.fetch = originalFetch;
  dom.window.close();
}