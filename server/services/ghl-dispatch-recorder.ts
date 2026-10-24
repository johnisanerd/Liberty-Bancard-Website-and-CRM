/**
 * Per-operation provider dispatch evidence for GHL contact projection.
 *
 * Both GHL transports (ghl.ts and ghl-sync.ts) call `markGhlDispatch` at the
 * single point immediately before the final HTTP request. The projection
 * executor wraps one projection in `withGhlDispatchRecorder` so it can tell
 * - a local deferral (no I/O happened; the failure budget is untouched),
 * - a provider attempt that returned a classified result, and
 * - an ambiguous outcome (request may have been processed; response lost).
 *
 * The recorder can carry durable hooks. `begin` runs BEFORE every provider mutation (including each transport retry):
 * it is the final dispatch fence (claim, unexpired lease, generation, export eligibility) and appends the durable
 * operation row; if it refuses or fails, no request is sent. `settle` records the observed outcome.
 *
 * Only method, a coarse operation class, an outcome and (for creates) the identity actually sent are stored. No
 * tokens, no payload bodies.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type GhlOperationClass =
  | "contact_create"
  | "contact_update"
  | "contact_tags"
  | "contact_permissions"
  | "contact_read"
  | "other";

export type GhlDispatchOutcome = "pending" | "ok" | "http_error" | "ambiguous";

export interface GhlDispatchRecord {
  operationId: string;
  method: string;
  operation: GhlOperationClass;
  outcome: GhlDispatchOutcome;
  httpStatus: number | null;
}

export interface GhlDispatchMeta {
  identity?: { email?: string | null; phone?: string | null } | null;
}

export interface GhlDispatchHooks {
  /** Throws (or rejects) to forbid the request; nothing is sent in that case. */
  begin(record: GhlDispatchRecord, meta: GhlDispatchMeta): Promise<void>;
  settle(record: GhlDispatchRecord): Promise<void>;
}

export interface GhlDispatchRecorder {
  records: GhlDispatchRecord[];
  hooks?: GhlDispatchHooks;
}

const storage = new AsyncLocalStorage<GhlDispatchRecorder>();

/** Thrown when a non-idempotent request may have been processed but the response was lost. */
export class GhlAmbiguousDispatchError extends Error {
  readonly code = "GHL_AMBIGUOUS_DISPATCH";
  constructor(detail: string) {
    super(`GHL_AMBIGUOUS_DISPATCH:${detail}`);
    this.name = "GhlAmbiguousDispatchError";
  }
}

export function classifyGhlOperation(method: string, path: string): GhlOperationClass {
  const m = method.toUpperCase();
  const p = path.split("?")[0];
  if (/^\/contacts\/[^/]+\/tags\/?$/.test(p)) return "contact_tags";
  if (/^\/contacts\/[^/]+\/(?:customFields|permissions)\/?$/.test(p)) return "contact_permissions";
  if (/^\/contacts\/?$/.test(p) && m === "POST") return "contact_create";
  if (/^\/contacts\/upsert\/?$/.test(p)) return "contact_create";
  if (/^\/contacts\/[^/]+\/?$/.test(p) && m === "PUT") return "contact_update";
  if (m === "GET" && p.startsWith("/contacts")) return "contact_read";
  return "other";
}

export function isAmbiguousDispatchMessage(message: string | undefined): boolean {
  return !!message && /GHL_AMBIGUOUS_DISPATCH|aborted|AbortError|timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(message);
}

export function withGhlDispatchRecorder<T>(fn: () => Promise<T>, hooks?: GhlDispatchHooks): Promise<{ result: T; recorder: GhlDispatchRecorder } | { error: unknown; recorder: GhlDispatchRecorder }> {
  const recorder: GhlDispatchRecorder = { records: [], hooks };
  return storage.run(recorder, async () => {
    try {
      return { result: await fn(), recorder };
    } catch (error) {
      return { error, recorder };
    }
  });
}

/** Called immediately before the final HTTP request. Rejects when the final dispatch fence refuses the request. */
export async function markGhlDispatch(
  method: string, path: string, meta: GhlDispatchMeta = {},
): Promise<(outcome: Exclude<GhlDispatchOutcome, "pending">, httpStatus?: number | null) => Promise<void>> {
  const recorder = storage.getStore();
  if (!recorder) return async () => {};
  const record: GhlDispatchRecord = {
    operationId: globalThis.crypto.randomUUID(),
    method: method.toUpperCase(),
    operation: classifyGhlOperation(method, path),
    outcome: "pending",
    httpStatus: null,
  };
  const isMutation = record.method !== "GET" && record.operation !== "contact_read";
  // Fence and durable append happen BEFORE the record joins the in-memory list: a refused request is not a dispatch.
  if (isMutation && recorder.hooks) await recorder.hooks.begin(record, meta);
  recorder.records.push(record);
  return async (outcome, httpStatus = null) => {
    record.outcome = outcome;
    record.httpStatus = httpStatus;
    if (isMutation && recorder.hooks) await recorder.hooks.settle(record);
  };
}

export function summarizeDispatches(recorder: GhlDispatchRecorder): {
  dispatched: boolean;
  ambiguous: boolean;
  receipts: Record<string, { attempted: number; ok: number; failed: number; ambiguous: number; lastHttpStatus: number | null }>;
} {
  const receipts: Record<string, { attempted: number; ok: number; failed: number; ambiguous: number; lastHttpStatus: number | null }> = {};
  for (const record of recorder.records) {
    if (record.operation === "contact_read") continue;
    const entry = receipts[record.operation] ??= { attempted: 0, ok: 0, failed: 0, ambiguous: 0, lastHttpStatus: null };
    entry.attempted++;
    if (record.outcome === "ok") entry.ok++;
    else if (record.outcome === "http_error") entry.failed++;
    else entry.ambiguous++; // pending at settle time == the process could not observe a response
    entry.lastHttpStatus = record.httpStatus;
  }
  const mutations = recorder.records.filter(r => r.operation !== "contact_read" && r.method !== "GET");
  return {
    dispatched: mutations.length > 0,
    ambiguous: mutations.some(r => r.outcome === "ambiguous" || r.outcome === "pending"),
    receipts,
  };
}
