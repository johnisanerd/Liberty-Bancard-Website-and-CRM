import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getDbContext } from "./db-context";
import {fingerprintQuery, tagLockTrace, safeDatabaseFailure} from "./lock-trace";

const phases = new AsyncLocalStorage<string>();
export function withTransactionPhase<T>(phase: string, fn: () => T): T {
  return phases.run(phase, fn);
}

/** Never intercept release or install checkout-scoped client methods. pg-pool
 * replaces release on every acquisition. Release events close our WeakMap
 * record; a query observer is installed exactly once per physical connection. */
export function observeTransactionConnections(pool: any, options: {
  emit?: (event: Record<string, unknown>) => void;
  slowMs?: number;
  sampleMs?: number;
  tagSql?: boolean;
} = {}) {
  const emit = options.emit ?? (event => console.warn(JSON.stringify(event)));
  const slowMs = options.slowMs ?? 2000;
  const active = new WeakMap<object, any>();
  const physical = new WeakMap<object, string>();
  const checkedOut = new Set<object>();
  const snapshot = () => ({total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount});
  const report = (event: string, state: any, extra: Record<string, unknown> = {}) => {
    // Observation must never change successful query/release behavior.
    try { emit({event, connectionId: state.connectionId, backendId: state.backendId,
      backendIdSource: "protocol", protocolBackendId: state.backendId,
      checkoutId: state.checkoutId, correlationId: state.context?.correlationId ?? null,
      normalizedRoute: state.context?.normalizedRoute ?? null, phase: state.phase,
      ...extra, pool: snapshot(), ts: new Date().toISOString()}); } catch { /* telemetry only */ }
  };
  const originalConnect = pool.connect;
  pool.connect = function(callback?: Function) {
    const start = performance.now(), context = getDbContext(), phase = phases.getStore() ?? null;
    const acquired = (error: any, client: any) => {
      const acquireWaitMs = performance.now() - start;
      if (error) {
        report("db:acquire_error", {context, phase}, {acquireWaitMs, sqlState: error.code ?? null});
        return;
      }
      const state = {connectionId: physical.get(client), backendId: client.processID,
        checkoutId: randomUUID(), context, phase, acquiredAt: performance.now(),
        acquireWaitMs, transaction: false, inFlight: 0, executionMs: 0,
        lastCompletedAt: performance.now(), lastQuery: null};
      active.set(client, state); checkedOut.add(client);
      if (acquireWaitMs >= slowMs) report("db:acquired", state, {acquireWaitMs});
    };
    if (typeof callback === "function") {
      return originalConnect.call(this, (error: any, client: any, release: any) => {
        acquired(error, client);
        // Pass pg's CURRENT release through untouched, including acquisition errors.
        callback(error, client, release);
      });
    }
    return originalConnect.call(this).then((client: any) => {
      acquired(null, client); return client;
    }, (error: any) => {acquired(error, null); throw error;});
  };
  const onConnect = (client: any) => {
    if (physical.has(client)) return;
    physical.set(client, randomUUID());
    client.on("error", (error: any) => {
      const state=active.get(client);
      if (state) report("db:checked_out_connection_error",state,{sqlState:error?.code ?? null,
        transactionOpen:state.transaction,lastQuery:state.lastQuery});
    });
    const originalQuery = client.query;
    client.query = function(...args: any[]) {
      const state = active.get(client);
      if (!state) return originalQuery.apply(this, args);
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      // Hash only; no SQL body, literals, parameters, contact data or errors.
      const queryHash = fingerprintQuery(text);
      const command = /^\s*(begin|commit|rollback|savepoint|release)\b/i.exec(text)?.[1]?.toLowerCase() ?? "query";
      const queryKind = text.includes("pg_advisory") ? "advisory_lock"
        : text.includes("sfp_runtime_") ? "runtime_authority" : command;
      const started = performance.now(), phase = phases.getStore() ?? state.phase;
      // SQL comments require no extra round trips or session setting changes.
      // The primary observer extracts this tag and supplies the REAL backend PID.
      // Do not mutate caller configs or pg Query objects, or named prepared SQL.
      if (options.tagSql && (state.transaction || command === "begin") && text) {
        if (typeof args[0] === "string") {
          args[0] = tagLockTrace(text, state.checkoutId, state.context?.normalizedRoute, phase);
        } else if (!args[0]?.name && typeof args[0]?.submit !== "function") {
          args[0] = {...args[0], text: tagLockTrace(text, state.checkoutId, state.context?.normalizedRoute, phase)};
        }
      }
      state.inFlight++; state.lastQuery = {queryHash, queryKind, phase};
      let finished = false;
      const finish = (error?: any) => {
        if (finished) return; finished = true;
        const executionMs = performance.now() - started;
        state.inFlight--; state.executionMs += executionMs; state.lastCompletedAt = performance.now();
        if (!error && command === "begin") state.transaction = true;
        if (!error && (command === "commit" || command === "rollback") && !/\bto\b/i.test(text))
          state.transaction = false;
        if (error || executionMs >= slowMs) {
          report("db:transaction_query", state, {phase, queryHash, queryKind,
            executionMs, sqlState: error?.code ?? null, transactionOpen: state.transaction,
            ...(error ? {failure: safeDatabaseFailure(error)} : {})});
        }
      };
      // All pg overloads: query(text, callback), query(text, values, callback),
      // query(config with callback), promises, and event-emitting Query objects.
      const callbackIndex = typeof args[args.length - 1] === "function" ? args.length - 1 : -1;
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex];
        args[callbackIndex] = function(this: any, error: any, ...results: any[]) {
          finish(error); return callback.call(this, error, ...results);
        };
      } else if (args[0]?.callback && typeof args[0].callback === "function") {
        const query = args[0], callback = query.callback;
        if (typeof query.submit !== "function") {
          args[0] = {...query, callback: function(this: any, error: any, ...results: any[]) {
            finish(error); return callback.call(this, error, ...results);
          }};
        } else {
          // pg Query objects must preserve identity/events. This wrapper is
          // query-scoped (never client/checkout-scoped) and restores itself
          // before invoking user code, including Query callback overloads.
          query.callback = function(this: any, error: any, ...results: any[]) {
            query.callback = callback;
            finish(error); return callback.call(this, error, ...results);
          };
        }
      }
      try {
        const result = originalQuery.apply(this, args);
        if (result?.then) result.then(() => finish(), (error: any) => finish(error));
        else if (result?.once) {
          result.once("end", () => finish()); result.once("error", (error: any) => finish(error));
        } else if (callbackIndex < 0) finish();
        return result;
      } catch (error) {finish(error); throw error;}
    };
  };
  const onRelease = (error: any, client: any) => {
    const state = active.get(client);
    if (!state) return;
    const checkoutDurationMs = performance.now() - state.acquiredAt;
    if (state.transaction || checkoutDurationMs >= slowMs || error) {
      report("db:connection_release", state, {acquireWaitMs: state.acquireWaitMs,
        executionMs: state.executionMs, checkoutDurationMs, transactionOpen: state.transaction,
        sqlState: error?.code ?? null, lastQuery: state.lastQuery});
    }
    checkedOut.delete(client); active.delete(client);
  };
  pool.on("connect", onConnect);
  pool.on("release", onRelease);
  const timer = setInterval(() => {
    for (const client of checkedOut) {
      const state = active.get(client);
      if (!state || performance.now() - state.acquiredAt < slowMs) continue;
      // A checkout that is never released would otherwise log an error every sample forever. Report it when first
      // seen, then at most once per minute for the same checkout.
      const now = performance.now();
      if (state.lastLongReportAt !== undefined && now - state.lastLongReportAt < 60_000) continue;
      state.lastLongReportAt = now;
      report("db:long_checkout", state, {acquireWaitMs: state.acquireWaitMs,
        checkoutDurationMs: performance.now() - state.acquiredAt,
        transactionOpen: state.transaction, inFlight: state.inFlight,
        idleMs: state.inFlight ? 0 : performance.now() - state.lastCompletedAt,
        lastQuery: state.lastQuery});
    }
  }, options.sampleMs ?? 5000);
  timer.unref();
  return () => {clearInterval(timer);};
}
