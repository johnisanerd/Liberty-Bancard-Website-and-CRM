/**
 * Native database object reconciler.
 *
 * Replit Publish reconciles tables, columns, indexes and foreign keys, but not PL/pgSQL function
 * bodies or triggers. Authority guards live in those objects, so this installs reviewed, versioned
 * entries automatically at production startup, after Publish has applied the schema diff.
 *
 * It is deliberately NOT a migration replay:
 *   - only entries in the manifest run; each is the exact reviewed SQL, regenerated and certified;
 *   - each entry carries its own preflight that refuses to replace an unrecognized object (drift)
 *     and refuses to run before its Publish-created prerequisites exist;
 *   - a current object is detected by a read-only verification query and left untouched;
 *   - one transaction per entry, short lock_timeout, a session advisory lock so replicas never race;
 *   - it never throws into startup. A refused or failed entry leaves the existing fail-closed guards
 *     in force, is logged loudly and is audited, so nothing is weakened or silently skipped.
 */
import pg from "pg";
import { FIRST_PARTY_STAGED_EMAIL_NATIVE_ENTRY } from "./first-party-staged-email.generated";

export interface NativeObjectEntry {
  id: string;
  version: string;
  /** Statements run inside one transaction (their own preflight raises coded exceptions). */
  installSql: string;
  /** Read-only; single row with a boolean repair_verified column. */
  verifySql: string;
}

export const NATIVE_OBJECT_MANIFEST: readonly NativeObjectEntry[] = [FIRST_PARTY_STAGED_EMAIL_NATIVE_ENTRY];

export type NativeObjectStatus =
  | "already_current" | "installed" | "skipped_locked"
  | "prerequisites_missing" | "drift_refused" | "failed";

export interface NativeObjectResult {
  id: string;
  version: string;
  status: NativeObjectStatus;
  detail?: string;
  attempts: number;
}

/** Production only, and a kill switch for emergencies. Dev/test already apply migrations directly. */
export function shouldReconcileNativeObjects(
  nodeEnv: string | undefined, env: Record<string, string | undefined> = process.env,
): boolean {
  return nodeEnv === "production" && String(env.NATIVE_OBJECT_RECONCILE ?? "").toLowerCase() !== "off";
}

const lockKey = (id: string) => `native_object_reconcile:${id}`;
const isVerified = (rows: any[]) => rows?.[0]?.repair_verified === true;

function classify(error: any): { status: NativeObjectStatus; retryable: boolean; code: string } {
  const message = String(error?.message ?? error);
  if (/_PUBLISH_PREREQUISITE_MISSING/.test(message)) return { status: "prerequisites_missing", retryable: false, code: message };
  if (/_(?:ROUTINE|EVIDENCE_FUNCTION|EVIDENCE_TRIGGER|REVIEW_TRIGGER)_(?:DRIFT|MISSING)/.test(message)) {
    return { status: "drift_refused", retryable: false, code: message };
  }
  // lock_not_available / deadlock_detected / serialization: another writer was busy, safe to retry.
  if (["55P03", "40P01", "40001"].includes(String(error?.code))) return { status: "failed", retryable: true, code: message };
  return { status: "failed", retryable: false, code: message };
}

async function reconcileEntry(
  entry: NativeObjectEntry,
  options: { connectionString: string; attempts: number; retryDelayMs: number },
): Promise<NativeObjectResult> {
  const client = new pg.Client({ connectionString: options.connectionString, application_name: "native-object-reconciler" });
  let attempts = 0;
  let locked = false;
  try {
    await client.connect();
    const got = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [lockKey(entry.id)]);
    locked = got.rows[0]?.locked === true;
    if (!locked) return { id: entry.id, version: entry.version, status: "skipped_locked", attempts };

    if (isVerified((await client.query(entry.verifySql)).rows)) {
      return { id: entry.id, version: entry.version, status: "already_current", attempts };
    }
    for (;;) {
      attempts += 1;
      try {
        await client.query("BEGIN");
        await client.query(entry.installSql);
        if (!isVerified((await client.query(entry.verifySql)).rows)) {
          throw new Error(`NATIVE_OBJECT_INSTALL_INCOMPLETE:${entry.id}`);
        }
        await client.query("COMMIT");
        return { id: entry.id, version: entry.version, status: "installed", attempts };
      } catch (error: any) {
        await client.query("ROLLBACK").catch(() => undefined);
        const verdict = classify(error);
        if (verdict.retryable && attempts < options.attempts) {
          await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs * attempts));
          continue;
        }
        return { id: entry.id, version: entry.version, status: verdict.status, detail: verdict.code.slice(0, 300), attempts };
      }
    }
  } catch (error: any) {
    return {
      id: entry.id, version: entry.version, status: "failed",
      detail: String(error?.message ?? error).slice(0, 300), attempts,
    };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey(entry.id)]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function audit(connectionString: string, results: NativeObjectResult[], actorId: string) {
  const changed = results.filter((r) => r.status !== "already_current" && r.status !== "skipped_locked");
  if (changed.length === 0) return;
  const client = new pg.Client({ connectionString, application_name: "native-object-reconciler-audit" });
  try {
    await client.connect();
    for (const r of changed) {
      await client.query(
        `INSERT INTO audit_logs(user_id, action, entity_type, entity_key, details, actor_type, actor_id)
         VALUES ($1, 'native_object_reconcile', 'native_object', $2, $3::jsonb, 'system', $1)`,
        [actorId, `${r.id}:${r.version}:${Date.now()}`, JSON.stringify({
          status: r.status, detail: r.detail ?? null, attempts: r.attempts, paidProviderCalls: 0, outboundChanges: 0,
        })]);
    }
  } catch (error: any) {
    console.error("[NativeObjects] audit write failed:", error?.message);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Never throws. Returns one result per manifest entry. */
export async function reconcileNativeObjects(input: {
  connectionString?: string;
  entries?: readonly NativeObjectEntry[];
  attempts?: number;
  retryDelayMs?: number;
  actorId?: string;
} = {}): Promise<NativeObjectResult[]> {
  const connectionString = input.connectionString ?? process.env.DATABASE_URL;
  const entries = input.entries ?? NATIVE_OBJECT_MANIFEST;
  if (!connectionString) {
    console.error("[NativeObjects] DATABASE_URL is not set; nothing reconciled.");
    return entries.map((e) => ({ id: e.id, version: e.version, status: "failed" as const, detail: "NO_DATABASE_URL", attempts: 0 }));
  }
  const results: NativeObjectResult[] = [];
  for (const entry of entries) {
    const result = await reconcileEntry(entry, {
      connectionString, attempts: Math.max(1, input.attempts ?? 3), retryDelayMs: input.retryDelayMs ?? 1500,
    });
    results.push(result);
    const line = `[NativeObjects] ${entry.id}@${entry.version}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`;
    if (result.status === "installed" || result.status === "already_current" || result.status === "skipped_locked") console.log(line);
    else console.error(`${line} - dependent guards stay fail-closed until this is resolved`);
  }
  await audit(connectionString, results, input.actorId ?? "system:native-object-reconciler");
  return results;
}
