/**
 * Idempotent data convergence for legacy contact_provider_projections rows.
 *
 * The same statements are embedded verbatim in migration 0374 (clean apply and
 * upgrade-with-duplicates). Publish delivers schema but not migration data
 * steps, so the full tick also runs them (cheaply, only when work remains).
 * A test asserts the migration file contains each statement unchanged.
 *
 * Nothing is deleted. Duplicate open rows become `superseded` evidence that
 * points at the surviving row; export disposition is a persisted, reasoned
 * fact computed from record and source facts.
 */
import { pool } from "../db";

export const GHL_EXPORT_POLICY_KEY = "ghl_export_policy";
export const GHL_EXPORT_POLICY_DEFAULT_SINCE = "2026-10-23T04:00:00Z";

export const GHL_PROJECTION_CONVERGENCE_STATEMENTS: readonly string[] = [
  // 1. Persisted export disposition for rows that predate the disposition column.
  `UPDATE contact_provider_projections p
SET export_disposition = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'local_only'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'test_local_only'
      WHEN p.state IN ('pending', 'retry', 'processing')
        AND p.created_at >= (COALESCE((SELECT value->>'currentIntakeSince' FROM system_settings WHERE key = 'ghl_export_policy'), '${GHL_EXPORT_POLICY_DEFAULT_SINCE}')::timestamptz AT TIME ZONE 'UTC')
        THEN 'current_intake'
      WHEN p.state IN ('pending', 'retry', 'processing') THEN 'historical_hold'
      ELSE 'closed'
    END,
    export_reason = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'pipeline_local_only_fence'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'record_class_' || c.record_class
      WHEN p.state IN ('pending', 'retry', 'processing')
        AND p.created_at >= (COALESCE((SELECT value->>'currentIntakeSince' FROM system_settings WHERE key = 'ghl_export_policy'), '${GHL_EXPORT_POLICY_DEFAULT_SINCE}')::timestamptz AT TIME ZONE 'UTC')
        THEN 'created_on_or_after_policy_cutoff'
      WHEN p.state IN ('pending', 'retry', 'processing') THEN 'created_before_policy_cutoff_historical_bulk'
      ELSE 'not_open_work'
    END,
    source_kind = COALESCE(p.source_kind, 'legacy')
FROM contacts c
WHERE c.id = p.contact_id AND p.export_disposition = 'unclassified'`,
  // 2. One open desired projection per contact and provider: duplicates become audited superseded evidence.
  `WITH ranked AS (
  SELECT id,
         row_number() OVER w AS rn,
         first_value(id) OVER w AS survivor
  FROM contact_provider_projections
  WHERE provider = 'ghl' AND state IN ('pending', 'retry', 'processing')
  WINDOW w AS (PARTITION BY contact_id, provider
               ORDER BY (authority_version IS NOT NULL) DESC, (state = 'processing' AND lease_expires_at > now()) DESC, created_at DESC, id DESC)
)
UPDATE contact_provider_projections p
SET state = CASE WHEN r.rn = 1 THEN p.state ELSE 'superseded' END,
    authority_version = CASE WHEN r.rn = 1 THEN 1 ELSE p.authority_version END,
    terminal_reason = CASE WHEN r.rn = 1 THEN p.terminal_reason ELSE 'superseded_duplicate' END,
    superseded_by = CASE WHEN r.rn = 1 THEN NULL ELSE r.survivor END,
    superseded_at = CASE WHEN r.rn = 1 THEN NULL ELSE now() END,
    claim_token = CASE WHEN r.rn = 1 THEN p.claim_token ELSE NULL END,
    lease_expires_at = CASE WHEN r.rn = 1 THEN p.lease_expires_at ELSE NULL END,
    completed_at = CASE WHEN r.rn = 1 THEN p.completed_at ELSE now() END,
    updated_at = now()
FROM ranked r
WHERE p.id = r.id AND (r.rn > 1 OR p.authority_version IS NULL)`,
];

export async function projectionConvergenceNeeded(): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM contact_provider_projections
       WHERE provider = 'ghl'
         AND (export_disposition = 'unclassified'
              OR (state IN ('pending', 'retry', 'processing') AND authority_version IS NULL))
     ) AS needed`,
  );
  return result.rows[0]?.needed === true;
}

/** Runs the convergence statements in one transaction. Safe to run repeatedly and concurrently. */
export async function convergeLegacyProjectionRows(): Promise<{ ran: boolean }> {
  if (!await projectionConvergenceNeeded()) return { ran: false };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    // One convergence at a time across processes; losers simply skip.
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('ghl_projection_convergence')) AS ok");
    if (lock.rows[0]?.ok !== true) {
      await client.query("ROLLBACK");
      return { ran: false };
    }
    for (const statement of GHL_PROJECTION_CONVERGENCE_STATEMENTS) await client.query(statement);
    await client.query("COMMIT");
    return { ran: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
