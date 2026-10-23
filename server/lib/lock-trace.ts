import {createHash, randomUUID} from "node:crypto";

const instanceId = randomUUID();
/** Correlate process-only diagnostics with SQL tags; never a session/owner token. */
export function lockTraceProcessInstanceId() { return instanceId; }
const marker = /^\/\*lbc_lock_trace:([A-Za-z0-9_-]{1,700})\*\/\s*/;
export function fingerprintQuery(text: string) {
  return createHash("sha256").update(text.replace(marker, "").replace(/\s+/g, " ").trim())
    .digest("hex").slice(0, 16);
}

/** No source data, SQL parameters, claim tokens or credentials enter this tag.
 * Named prepared queries must never be rewritten with checkout-specific text. */
export function tagLockTrace(text: string, checkoutId: string, route: unknown, phase: unknown) {
  const trace = {
    instanceId, checkoutId,
    worker: typeof route === "string" && /^BullMQ [a-z0-9-]{1,80}$/.test(route) ? route : null,
    phase: typeof phase === "string" && /^[a-z_]{1,64}$/.test(phase) ? phase : null,
  };
  return `/*lbc_lock_trace:${Buffer.from(JSON.stringify(trace)).toString("base64url")}*/ ${text}`;
}

export function readLockTrace(text: string) {
  const match = marker.exec(text);
  if (!match) return null;
  try {
    const trace = JSON.parse(Buffer.from(match[1], "base64url").toString());
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if (!uuid.test(trace.instanceId) || !uuid.test(trace.checkoutId)) return null;
    return {
      instanceId: trace.instanceId, checkoutId: trace.checkoutId,
      worker: typeof trace.worker === "string" && /^BullMQ [a-z0-9-]{1,80}$/.test(trace.worker)
        ? trace.worker : null,
      phase: typeof trace.phase === "string" && /^[a-z_]{1,64}$/.test(trace.phase) ? trace.phase : null,
    };
  } catch { return null; }
}

/** Preserve PostgreSQL causes and deadlock edges, never raw message/detail/SQL.
 * PostgreSQL deadlock details can append full statements containing source PII. */
export function safeDatabaseFailure(error: unknown) {
  const causes: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  // Transaction preservation retains callback and rollback failures as named
  // branches, not a linear Error.cause chain. Visit only these known exception
  // edges, with bounded depth/count, without exposing arbitrary object fields.
  const pending: Array<{value: unknown; depth: number}> = [{value: error, depth: 0}];
  while (pending.length && causes.length < 12) {
    const {value, depth} = pending.shift()!;
    if (!value || typeof value !== "object" || depth >= 5 || seen.has(value)) continue;
    const current: any = value;
    seen.add(current);
    const detail = typeof current.detail === "string" ? current.detail : "";
    const deadlockEdges = [...detail.matchAll(
      /Process (\d+) waits for ([A-Za-z]+) on [^\n;]+; blocked by process (\d+)/g,
    )].slice(0, 16).map(match => ({
      waiterPid: Number(match[1]), blockerPid: Number(match[3]), mode: match[2],
    }));
    causes.push({
      ...(typeof current.code==="string" &&
        ["ECONNRESET","EPIPE","ETIMEDOUT","ECONNREFUSED","ECONNABORTED","ENETUNREACH","EHOSTUNREACH"]
          .includes(current.code) ? {transportCode:current.code} : {}),
      sqlState: typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code) ? current.code : null,
      phase: typeof current.canonicalTransactionPhase === "string"
        && /^[a-z_]{1,64}$/.test(current.canonicalTransactionPhase) ? current.canonicalTransactionPhase : null,
      reasonCode: typeof current.message === "string"
        ? /^(?:CANONICAL|SFP|SYSTEM_LINK|PROVIDER_IMPORT)_[A-Z0-9_]+/.exec(current.message)?.[0] ?? null : null,
      deadlockEdges,
    });
    for (const edge of ["cause", "originalError", "cleanupError"] as const) {
      if (current[edge] && typeof current[edge] === "object")
        pending.push({value: current[edge], depth: depth + 1});
    }
  }
  return {causes};
}

/** Capture both failures without imposing exception precedence on recovery. */
export async function captureRecoveryFailure(
  originalError: unknown,
  cleanup: () => Promise<unknown>,
  coordinates: {executionId: string; itemId: string; sourceRowNumber: number},
  emit: (event: Record<string, unknown>) => void = event => console.warn(JSON.stringify(event)),
): Promise<{failureId: string; originalError: unknown; cleanupError?: unknown; cleanupResult?: unknown}> {
  const failureId = randomUUID();
  const report = (event: string, error: unknown) => {
    try { emit({event, failureId, ...coordinates, failure: safeDatabaseFailure(error),
      ts: new Date().toISOString()}); } catch { /* Observation must not replace either error. */ }
  };
  report("canonical_import_recovery_original_error", originalError);
  try {
    const cleanupResult = await cleanup();
    return {failureId, originalError, cleanupResult};
  }
  catch (cleanupError) {
    report("canonical_import_recovery_cleanup_error", cleanupError);
    return {failureId, originalError, cleanupError};
  }
}

/** Existing diagnostic callers retain their explicit throw contract. */
export async function observeRecoveryFailure(
  originalError: unknown,
  cleanup: () => Promise<unknown>,
  coordinates: {executionId: string; itemId: string; sourceRowNumber: number},
  emit?: (event: Record<string, unknown>) => void,
): Promise<never> {
  const failure = await captureRecoveryFailure(originalError, cleanup, coordinates, emit);
  throw failure.cleanupError ?? failure.originalError;
}

/** One-line, parameter-free description of a failure for logs. drizzle's "Failed query" message embeds the whole
 * multi-line SQL and bound parameters (which can include owner tokens); every line becomes a separate error entry. */
export function summarizeFailureForLog(error: unknown): string {
  const raw = String((error as any)?.message ?? error);
  if (/^Failed query:/.test(raw)) return `database query failed ${JSON.stringify(safeDatabaseFailure(error))}`;
  return raw.split("\n")[0].slice(0, 300);
}
