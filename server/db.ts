import { drizzle, NodePgSession, NodePgTransaction } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import pg from "pg";
import {createHash} from "node:crypto";
import * as schema from "@shared/schema";
import { getDbContext } from "./lib/db-context";
import { observeTransactionConnections } from "./lib/transaction-observability";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX ?? "20", 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  allowExitOnIdle: false,
});

// Set a 30 s per-statement wall-clock limit on every new physical connection
// so runaway queries from background workers cannot block the pool indefinitely.
pool.on("connect", (client) => {
  client.query("SET statement_timeout = 30000").catch((err: Error) => {
    console.warn("[DB] Failed to set statement_timeout on new connection:", err.message);
  });
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// ---------------------------------------------------------------------------
// Pool-pressure sampler — emits only when waitingCount > 0.
// Uses setInterval + unref() so it never prevents process exit.
// No DB call — reads in-process pool object properties only.
// ---------------------------------------------------------------------------
const _pressureTimer = setInterval(() => {
  if (pool.waitingCount > 0) {
    console.warn(JSON.stringify({
      event: "db:pool_pressure",
      waitingCount: pool.waitingCount,
      totalCount:   pool.totalCount,
      idleCount:    pool.idleCount,
      ts: new Date().toISOString(),
    }));
  }
}, 15_000);
_pressureTimer.unref();

// ---------------------------------------------------------------------------
// Connection-level observability — pool.connect() wrapper.
//
// Tracks separately:
//   acquireWaitMs   — time waiting in the pool queue for a free connection
//   queryDurationMs — wall-clock time spent executing the query
//   checkoutDurationMs — total time the connection was out of the pool
//
// Also emits db:long_transaction when a connection is held open > 5 s
// without being released (indicates a long-running transaction).
//
// Logs are annotated with correlationId + normalizedRoute from
// AsyncLocalStorage (set by the Express correlation middleware or BullMQ
// job processors via setDbContext()).
//
// Does NOT log SQL parameter values, PII, credentials, or full SQL bodies.
// ---------------------------------------------------------------------------
const _SLOW_QUERY_MS   = parseInt(process.env.DB_SLOW_QUERY_MS   ?? "2000",  10);
const _SLOW_ACQUIRE_MS = parseInt(process.env.DB_SLOW_ACQUIRE_MS ?? "500", 10);

function _fingerprint(sql: string): string {
  // Raw SQL may contain literals even when most callers bind parameters.
  return `sha256:${createHash("sha256").update(sql.replace(/\s+/g, " ").trim()).digest("hex").slice(0,16)}`;
}

function _poolSnapshot() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

// Observe acquisition and pool release EVENTS; never wrap client.release().
// Query instrumentation is physical-connection scoped, not checkout scoped.
// Timing-only observations (a slow but successful query, a normal release of a slow checkout) are informational and go to
// stdout; stderr is classified as ERROR by the platform, so routing them there made ordinary 2 s+ background queries
// look like hundreds of errors per window. Failures, acquisition errors, connection errors and leaked checkouts stay on stderr.
const _emitDbObservation = (event: Record<string, unknown>) => {
  const failed = Boolean(event.sqlState || event.failure || event.transactionOpen);
  const informational = !failed && (event.event === "db:transaction_query" || event.event === "db:connection_release" || event.event === "db:acquired");
  (informational ? console.info : console.warn)(JSON.stringify(event));
};
observeTransactionConnections(pool, {slowMs: _SLOW_QUERY_MS, emit: _emitDbObservation,
  tagSql: process.env.NODE_ENV === "production" && process.env.REPLIT_DEPLOYMENT === "1"});

// Wrap pool.query() for callers that use the shorthand (no explicit
// connect/release).  These cannot separate acquire from query time, but they
// do get correlationId / normalizedRoute.
const _origQuery = pool.query.bind(pool) as typeof pool.query;

pool.query = function observedPoolQuery(...args: any[]): any {
  const textOrConfig=args[0];
  const acquireStart  = Date.now();
  const poolAtAcquire = _poolSnapshot();
  const ctx           = getDbContext();
  const fingerprint   = typeof textOrConfig === "string"
    ? _fingerprint(textOrConfig)
    : (typeof textOrConfig?.text === "string" ? _fingerprint(textOrConfig.text) : "<config>");

  const observe=(err?:any)=>{
      const totalMs = Date.now() - acquireStart;
      if (!err && (totalMs >= _SLOW_QUERY_MS || poolAtAcquire.waiting >= 5)) {
        // Successful but slow: informational (stdout), not an error.
        (poolAtAcquire.waiting >= 5 ? console.warn : console.info)(JSON.stringify({
          event:            "db:slow_query",
          correlationId:    ctx?.correlationId  ?? null,
          normalizedRoute:  ctx?.normalizedRoute ?? null,
          // pool.query() does not separate acquire from query; report as totalMs
          acquireWaitMs:    null,
          queryDurationMs:  totalMs,
          checkoutDurationMs: null,
          fingerprintSql:   fingerprint,
          poolAtAcquire,
          poolAtRelease:    _poolSnapshot(),
          ts: new Date().toISOString(),
        }));
      }
      if (err && (totalMs >= _SLOW_ACQUIRE_MS || poolAtAcquire.waiting >= 5)) {
        console.warn(JSON.stringify({
          event:           "db:query_error",
          correlationId:   ctx?.correlationId  ?? null,
          normalizedRoute: ctx?.normalizedRoute ?? null,
          acquireWaitMs:   null,
          queryDurationMs: totalMs,
          fingerprintSql:  fingerprint,
          poolAtAcquire,
          errorType:       err instanceof Error ? err.constructor.name : "UnknownError",
          ts: new Date().toISOString(),
        }));
      }
  };
  const callbackIndex=typeof args[args.length-1]==="function" ? args.length-1 : -1;
  if (callbackIndex>=0) {
    const callback=args[callbackIndex];
    args[callbackIndex]=function(this:any,err:any,...results:any[]) {
      observe(err);return callback.call(this,err,...results);
    };
  }
  const result=(_origQuery as any)(...args);
  if (!result?.then) return result;
  return result.then((value:any)=>{observe();return value;},(err:any)=>{observe(err);throw err;});
};

export const db = drizzle(pool, { schema });

// drizzle-orm 0.45 node-postgres runs `begin` before its try/finally, so a failed BEGIN (for example a connection
// terminated while the client is checked out) never releases the client. The leaked checkout stays out of the pool and the
// connection observer reports it as db:long_checkout every few seconds until restart. This keeps drizzle's transaction
// semantics (commit, rollback, error propagation) and adds the missing release; a client whose BEGIN failed is destroyed.
{
  const poolSession = (db as any).session as InstanceType<typeof NodePgSession>;
  (poolSession as any).transaction = async function releasingTransaction(transaction: (tx: any) => Promise<unknown>, config?: any) {
    const client = await pool.connect();
    let destroyClient = false;
    try {
      const session = new NodePgSession(client, (poolSession as any).dialect, (poolSession as any).schema, (poolSession as any).options);
      const tx = new NodePgTransaction((poolSession as any).dialect, session, (poolSession as any).schema);
      try {
        await tx.execute(drizzleSql`begin${config ? drizzleSql` ${tx.getTransactionConfigSQL(config)}` : undefined}`);
      } catch (error) {
        destroyClient = true;
        throw error;
      }
      try {
        const result = await transaction(tx);
        await tx.execute(drizzleSql`commit`);
        return result;
      } catch (error) {
        await tx.execute(drizzleSql`rollback`);
        throw error;
      }
    } finally {
      client.release(destroyClient ? true : undefined);
    }
  };
}
