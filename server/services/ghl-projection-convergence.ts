/**
 * Idempotent data convergence for legacy contact_provider_projections rows.
 *
 * GHL_PROJECTION_CONVERGENCE_STATEMENTS are embedded verbatim in applied migration 0374 and are never edited.
 * The runtime loop runs GHL_RUNTIME_RECONCILE_STATEMENTS instead (the same classification statement, a corrected
 * dedupe, and an authority reconcile); the legacy creation-time correction is applied by migration 0375 only and is
 * subsumed at runtime by the authority reconcile. Publish delivers schema, not data steps, so the full tick runs
 * the loop (cheaply, only when work remains).
 *
 * Nothing is deleted. Duplicate open rows become `superseded` evidence that
 * points at the surviving row; export disposition is a persisted, reasoned
 * fact computed from record and source facts.
 */
import { pool } from "../db";

export const GHL_EXPORT_POLICY_KEY = "ghl_export_policy";
export const GHL_EXPORT_POLICY_DEFAULT_SINCE = "2026-10-23T04:00:00Z";

/** Source categories that prove a person actually asked to be in the CRM (current intake). Imports, discovery, registry
 *  loads and inbound provider sync are never intake evidence. */
export const GHL_INTAKE_EVIDENCE_CATEGORIES = ["website_form", "partner_referral", "merchant_application", "manual_crm"] as const;

/** timestamp (UTC wall clock) of the current-intake policy cutoff, as a SQL expression. */
export const GHL_INTAKE_CUTOFF_SQL = `(COALESCE((SELECT value->>'currentIntakeSince' FROM system_settings WHERE key = 'ghl_export_policy'), '${GHL_EXPORT_POLICY_DEFAULT_SINCE}')::timestamptz AT TIME ZONE 'UTC')`;

/**
 * Current-intake evidence for a contact: a source event of an intake category created on or after the cutoff.
 * Queue row creation time and caller-supplied source strings never grant this authority.
 */
export function ghlIntakeEvidenceSql(contactIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM contact_source_events e
          WHERE e.contact_id = ${contactIdExpr}
            AND e.source_category IN (${GHL_INTAKE_EVIDENCE_CATEGORIES.map(c => `'${c}'`).join(", ")})
            AND e.created_at >= ${GHL_INTAKE_CUTOFF_SQL})`;
}

/**
 * Existing-population scope (#2105 item A). The CRM's existing records are processed by the ordinary projection workers
 * under a durable, code-defined scope instead of requiring post-cutoff intake evidence:
 *  - a production, non-archived contact that already carries a GHL contact id is in scope for profile/permission
 *    updates (identity is known; no create happens);
 *  - an unlinked contact is in scope for a create only when it has a CRM-source event of a create-source category at
 *    any date (default: the intake categories). Discovery, registry (Sunbiz/DBPR), imports, identity matching,
 *    inbound sync and source-less prospects stay out unless policy.existingPopulation.createSourceCategories names them
 *    (registry categories can never be named).
 * Contact age never grants scope, test/demo/synthetic and archived records are never in scope, and the local-only
 * fence and suppression facts are enforced elsewhere (scope never clears them).
 * system_settings.ghl_export_policy.existingPopulation.enabled = false switches the whole scope off (default on).
 */
export const GHL_EXISTING_POPULATION_NEVER_CATEGORIES = ["sunbiz", "dbpr", "registry"] as const;

const EXISTING_POPULATION_ENABLED_SQL = `COALESCE((SELECT (s.value->'existingPopulation'->>'enabled')::boolean
     FROM system_settings s WHERE s.key = '${GHL_EXPORT_POLICY_KEY}'), true)`;

const EXISTING_POPULATION_CREATE_CATEGORIES_SQL = `COALESCE((SELECT ARRAY(SELECT jsonb_array_elements_text(s.value->'existingPopulation'->'createSourceCategories'))
     FROM system_settings s WHERE s.key = '${GHL_EXPORT_POLICY_KEY}'
       AND jsonb_typeof(s.value->'existingPopulation'->'createSourceCategories') = 'array'),
     ARRAY[${GHL_INTAKE_EVIDENCE_CATEGORIES.map(c => `'${c}'`).join(", ")}]::text[])`;

export function ghlExistingPopulationSql(contactIdExpr: string): string {
  return `(${EXISTING_POPULATION_ENABLED_SQL}
     AND EXISTS (SELECT 1 FROM contacts sc
       WHERE sc.id = ${contactIdExpr}
         AND COALESCE(sc.record_class, 'unknown') NOT IN ('test', 'demo', 'synthetic')
         AND sc.archived_at IS NULL
         AND (sc.ghl_contact_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM contact_source_events e2
                         WHERE e2.contact_id = sc.id
                           AND e2.source_category = ANY(${EXISTING_POPULATION_CREATE_CATEGORIES_SQL})
                           AND e2.source_category NOT IN (${GHL_EXISTING_POPULATION_NEVER_CATEGORIES.map(c => `'${c}'`).join(", ")})))))`;
}

/** Export authority = current-intake evidence OR the existing-population scope. */
export function ghlExportAuthoritySql(contactIdExpr: string): string {
  return `(${ghlIntakeEvidenceSql(contactIdExpr)} OR ${ghlExistingPopulationSql(contactIdExpr)})`;
}

/** Statements take $1 = batch size (contacts / rows) so every run is bounded and resumable. */
export const GHL_PROJECTION_CONVERGENCE_STATEMENTS: readonly string[] = [
  // 1. Persisted export disposition for rows that predate the disposition column. Evidence-based: a legacy row is
  //    current intake only when the contact has real intake evidence, never because the row was created recently.
  `UPDATE contact_provider_projections p
SET export_disposition = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'local_only'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'test_local_only'
      WHEN p.state IN ('pending', 'retry', 'processing') AND ${ghlIntakeEvidenceSql("p.contact_id")}
        THEN CASE WHEN c.ghl_contact_id IS NULL THEN 'current_intake' ELSE 'linked_update' END
      WHEN p.state IN ('pending', 'retry', 'processing') THEN 'historical_hold'
      ELSE 'closed'
    END,
    export_reason = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'pipeline_local_only_fence'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'record_class_' || c.record_class
      WHEN p.state IN ('pending', 'retry', 'processing') AND ${ghlIntakeEvidenceSql("p.contact_id")}
        THEN 'current_intake_evidence'
      WHEN p.state IN ('pending', 'retry', 'processing') THEN 'no_current_intake_evidence'
      ELSE 'not_open_work'
    END,
    source_kind = COALESCE(p.source_kind, 'legacy')
FROM contacts c
WHERE c.id = p.contact_id AND p.provider = 'ghl' AND p.export_disposition = 'unclassified'
  AND p.id IN (SELECT id FROM contact_provider_projections
               WHERE provider = 'ghl' AND export_disposition = 'unclassified' ORDER BY id LIMIT $1)`,
  // 2. One open desired projection per contact and provider: duplicates become audited superseded evidence. A live
  //    lease wins, then any uncertain dispatch; the survivor inherits uncertainty so no ambiguity evidence is lost.
  `WITH batch AS (
  SELECT DISTINCT contact_id FROM contact_provider_projections
  WHERE provider = 'ghl' AND state IN ('pending', 'retry', 'processing') AND authority_version IS NULL
  ORDER BY contact_id LIMIT $1
), ranked AS (
  SELECT p.id,
         row_number() OVER w AS rn,
         first_value(p.id) OVER w AS survivor,
         bool_or(p.dispatch_state IN ('reserved', 'ambiguous')) OVER (PARTITION BY p.contact_id, p.provider) AS any_uncertain
  FROM contact_provider_projections p
  WHERE p.provider = 'ghl' AND p.state IN ('pending', 'retry', 'processing')
    AND p.contact_id IN (SELECT contact_id FROM batch)
  WINDOW w AS (PARTITION BY p.contact_id, p.provider
               ORDER BY (p.authority_version IS NOT NULL) DESC,
                        (p.state = 'processing' AND p.lease_expires_at > now()) DESC,
                        (p.dispatch_state IN ('reserved', 'ambiguous')) DESC,
                        p.created_at DESC, p.id DESC)
)
UPDATE contact_provider_projections p
SET state = CASE WHEN r.rn = 1 THEN p.state ELSE 'superseded' END,
    authority_version = CASE WHEN r.rn = 1 THEN 1 ELSE p.authority_version END,
    terminal_reason = CASE WHEN r.rn = 1 THEN p.terminal_reason ELSE 'superseded_duplicate' END,
    superseded_by = CASE WHEN r.rn = 1 THEN NULL ELSE r.survivor END,
    superseded_at = CASE WHEN r.rn = 1 THEN NULL ELSE now() END,
    claim_token = CASE WHEN r.rn = 1 THEN p.claim_token ELSE NULL END,
    lease_expires_at = CASE WHEN r.rn = 1 THEN p.lease_expires_at ELSE NULL END,
    dispatch_state = CASE WHEN r.rn = 1 AND r.any_uncertain AND p.dispatch_state = 'none' THEN 'ambiguous' ELSE p.dispatch_state END,
    completed_at = CASE WHEN r.rn = 1 THEN p.completed_at ELSE now() END,
    updated_at = now()
FROM ranked r
WHERE p.id = r.id AND (r.rn > 1 OR p.authority_version IS NULL)`,
];

/** Applied once by migration 0375 and re-checkable at any time: demote legacy rows that only had creation-time authority. */
export const GHL_LEGACY_CREATION_TIME_CORRECTION_STATEMENT = `UPDATE contact_provider_projections p
SET export_disposition = 'historical_hold',
    export_reason = 'no_current_intake_evidence',
    updated_at = now()
WHERE p.provider = 'ghl'
  AND p.state IN ('pending', 'retry')
  AND p.export_disposition = 'current_intake'
  AND p.source_kind = 'legacy'
  AND p.dispatch_count = 0
  AND NOT EXISTS (
    SELECT 1 FROM contact_source_events e
    WHERE e.contact_id = p.contact_id
      AND e.source_category IN ('website_form', 'partner_referral', 'merchant_application', 'manual_crm')
      AND e.created_at >= ${GHL_INTAKE_CUTOFF_SQL})`;

/**
 * Runtime-only reconciliation (migration 0374 is applied history and is never rewritten; the two statements above
 * stay byte-identical to it so clean-apply and runtime cannot drift).
 *
 * DEDUPE_V2 replaces statement 2 at runtime. Differences, each a defect of the applied version:
 *  - a live lease ranks first, so adoption never supersedes work a worker is executing;
 *  - a row with a live lease is never superseded; if two live leases exist for one contact the group is left alone;
 *  - every provider operation record of a superseded row is re-pointed at the survivor, so an unresolved create's
 *    original identity stays reachable for ambiguity recovery.
 * Statement 3 reconciles authority of EVERY open exportable row: an exportable disposition without current-intake
 * evidence is returned to the historical hold whatever its source_kind or dispatch history. Rows in processing are
 * not touched here (a worker owns them; the final eligibility predicate also proves evidence, so they cannot dispatch).
 */
export const GHL_RUNTIME_DEDUPE_STATEMENT = `WITH batch AS (
  SELECT DISTINCT contact_id FROM contact_provider_projections
  WHERE provider = 'ghl' AND state IN ('pending', 'retry', 'processing') AND authority_version IS NULL
  ORDER BY contact_id LIMIT $1
), ranked AS (
  SELECT p.id, p.contact_id,
         row_number() OVER w AS rn,
         first_value(p.id) OVER w AS survivor,
         bool_or(p.dispatch_state IN ('reserved', 'ambiguous')) OVER (PARTITION BY p.contact_id, p.provider) AS any_uncertain,
         count(*) FILTER (WHERE p.state = 'processing' AND p.lease_expires_at > now()) OVER (PARTITION BY p.contact_id, p.provider) AS live_leases
  FROM contact_provider_projections p
  WHERE p.provider = 'ghl' AND p.state IN ('pending', 'retry', 'processing')
    AND p.contact_id IN (SELECT contact_id FROM batch)
  WINDOW w AS (PARTITION BY p.contact_id, p.provider
               ORDER BY (p.state = 'processing' AND p.lease_expires_at > now()) DESC,
                        (p.dispatch_state IN ('reserved', 'ambiguous')) DESC,
                        (p.authority_version IS NOT NULL) DESC,
                        p.created_at DESC, p.id DESC)
), actionable AS (
  SELECT * FROM ranked WHERE live_leases <= 1
), moved AS (
  UPDATE ghl_projection_operations o SET projection_id = a.survivor
  FROM actionable a WHERE a.rn > 1 AND o.projection_id = a.id
  RETURNING o.id
)
UPDATE contact_provider_projections p
SET state = CASE WHEN a.rn = 1 THEN p.state ELSE 'superseded' END,
    authority_version = CASE WHEN a.rn = 1 THEN 1 ELSE p.authority_version END,
    terminal_reason = CASE WHEN a.rn = 1 THEN p.terminal_reason ELSE 'superseded_duplicate' END,
    superseded_by = CASE WHEN a.rn = 1 THEN NULL ELSE a.survivor END,
    superseded_at = CASE WHEN a.rn = 1 THEN NULL ELSE now() END,
    claim_token = CASE WHEN a.rn = 1 THEN p.claim_token ELSE NULL END,
    lease_expires_at = CASE WHEN a.rn = 1 THEN p.lease_expires_at ELSE NULL END,
    dispatch_state = CASE WHEN a.rn = 1 AND a.any_uncertain AND p.dispatch_state = 'none' THEN 'ambiguous' ELSE p.dispatch_state END,
    completed_at = CASE WHEN a.rn = 1 THEN p.completed_at ELSE now() END,
    updated_at = now()
FROM actionable a
WHERE p.id = a.id AND (a.rn > 1 OR p.authority_version IS NULL)`;

export const GHL_AUTHORITY_RECONCILE_STATEMENT = `UPDATE contact_provider_projections p
SET export_disposition = 'historical_hold',
    export_reason = CASE WHEN EXISTS (SELECT 1 FROM contacts hc WHERE hc.id = p.contact_id AND hc.ghl_contact_id IS NOT NULL)
                         THEN 'linked_without_export_authority' ELSE 'outside_existing_population_scope' END,
    updated_at = now()
WHERE p.id IN (
  SELECT x.id FROM contact_provider_projections x
  WHERE x.provider = 'ghl' AND x.state IN ('pending', 'retry')
    AND x.export_disposition IN ('current_intake', 'linked_update')
    AND NOT ${ghlExportAuthoritySql("x.contact_id")}
  ORDER BY x.id LIMIT $1)`;

/** Runtime classification of legacy unclassified rows under the full export authority (evidence or existing population). */
export const GHL_RUNTIME_CLASSIFY_STATEMENT = `UPDATE contact_provider_projections p
SET export_disposition = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'local_only'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'test_local_only'
      WHEN p.state IN ('pending', 'retry', 'processing') AND ${ghlExportAuthoritySql("p.contact_id")}
        THEN CASE WHEN c.ghl_contact_id IS NULL THEN 'current_intake' ELSE 'linked_update' END
      WHEN p.state IN ('pending', 'retry', 'processing') THEN 'historical_hold'
      ELSE 'closed'
    END,
    export_reason = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'pipeline_local_only_fence'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'record_class_' || c.record_class
      WHEN p.state IN ('pending', 'retry', 'processing') AND ${ghlIntakeEvidenceSql("p.contact_id")} THEN 'current_intake_evidence'
      WHEN p.state IN ('pending', 'retry', 'processing') AND ${ghlExistingPopulationSql("p.contact_id")}
        THEN CASE WHEN c.ghl_contact_id IS NULL THEN 'existing_crm_source' ELSE 'existing_linked_identity' END
      WHEN p.state IN ('pending', 'retry', 'processing') THEN
        CASE WHEN c.ghl_contact_id IS NULL THEN 'outside_existing_population_scope' ELSE 'linked_without_export_authority' END
      ELSE 'not_open_work'
    END,
    source_kind = COALESCE(p.source_kind, 'legacy')
FROM contacts c
WHERE c.id = p.contact_id AND p.provider = 'ghl' AND p.export_disposition = 'unclassified'
  AND p.id IN (SELECT id FROM contact_provider_projections
               WHERE provider = 'ghl' AND export_disposition = 'unclassified' ORDER BY id LIMIT $1)`;

/**
 * Releases held rows that the existing-population scope now covers (a hold only ever records "no export authority").
 * Rows in processing are not touched. A row that is out of scope stays held. Never clears a suppression: suppression
 * is enforced by the dispatch path, not by the hold.
 */
export const GHL_SCOPE_RELEASE_STATEMENT = `UPDATE contact_provider_projections p
SET export_disposition = CASE WHEN c.ghl_contact_id IS NULL THEN 'current_intake' ELSE 'linked_update' END,
    export_reason = CASE WHEN ${ghlIntakeEvidenceSql("p.contact_id")} THEN 'current_intake_evidence'
                         WHEN c.ghl_contact_id IS NULL THEN 'existing_crm_source' ELSE 'existing_linked_identity' END,
    next_attempt_at = LEAST(p.next_attempt_at, now()),
    updated_at = now()
FROM contacts c
WHERE c.id = p.contact_id
  AND p.id IN (
    SELECT x.id FROM contact_provider_projections x
    WHERE x.provider = 'ghl' AND x.state IN ('pending', 'retry') AND x.authority_version IS NOT NULL
      AND x.export_disposition = 'historical_hold'
      AND ${ghlExportAuthoritySql("x.contact_id")}
    ORDER BY x.id LIMIT $1)`;

/**
 * Enrols in-scope contacts that have no projection at all (any state) through the single projection table: this is
 * the ordinary worker's input, not a second engine. Self-terminating (a row now exists), bounded, resumable.
 */
export const GHL_EXISTING_POPULATION_ENQUEUE_STATEMENT = `INSERT INTO contact_provider_projections
  (contact_id, provider, projection_key, state, authority_version, desired_generation, export_disposition, export_reason, source_kind)
SELECT c.id, 'ghl', 'contact:' || c.id, 'pending', 1, 1,
       CASE WHEN c.ghl_contact_id IS NULL THEN 'current_intake' ELSE 'linked_update' END,
       CASE WHEN c.ghl_contact_id IS NULL THEN 'existing_crm_source' ELSE 'existing_linked_identity' END,
       'existing_population'
FROM contacts c
WHERE c.id IN (
    SELECT cl.id FROM contacts cl WHERE cl.ghl_contact_id IS NOT NULL
    UNION
    SELECT ev.contact_id FROM contact_source_events ev
    WHERE ev.source_category = ANY(${EXISTING_POPULATION_CREATE_CATEGORIES_SQL}))
  AND ${ghlExistingPopulationSql("c.id")}
  AND NOT EXISTS (SELECT 1 FROM contact_provider_projections q WHERE q.contact_id = c.id AND q.provider = 'ghl')
ORDER BY c.id LIMIT $1
ON CONFLICT DO NOTHING`;

export const GHL_RUNTIME_RECONCILE_STATEMENTS: readonly string[] = [
  GHL_RUNTIME_CLASSIFY_STATEMENT,
  GHL_RUNTIME_DEDUPE_STATEMENT,
  GHL_AUTHORITY_RECONCILE_STATEMENT,
  GHL_SCOPE_RELEASE_STATEMENT,
  GHL_EXISTING_POPULATION_ENQUEUE_STATEMENT,
];

export const GHL_CONVERGENCE_BATCH_SIZE = 500;
export const GHL_CONVERGENCE_MAX_BATCHES_PER_RUN = 20;

export async function projectionConvergenceNeeded(): Promise<boolean> {
  const result = await pool.query(
    `SELECT (
       EXISTS (
         SELECT 1 FROM contact_provider_projections
         WHERE provider = 'ghl'
           AND (export_disposition = 'unclassified'
                OR (state IN ('pending', 'retry', 'processing') AND authority_version IS NULL)
                OR (state IN ('pending', 'retry') AND export_disposition IN ('current_intake', 'linked_update')
                    AND NOT ${ghlExportAuthoritySql("contact_provider_projections.contact_id")})
                OR (state IN ('pending', 'retry') AND authority_version IS NOT NULL AND export_disposition = 'historical_hold'
                    AND ${ghlExportAuthoritySql("contact_provider_projections.contact_id")})))
       OR EXISTS (
         SELECT 1 FROM contacts c
         WHERE c.id IN (
             SELECT cl.id FROM contacts cl WHERE cl.ghl_contact_id IS NOT NULL
             UNION
             SELECT ev.contact_id FROM contact_source_events ev
             WHERE ev.source_category = ANY(${EXISTING_POPULATION_CREATE_CATEGORIES_SQL}))
           AND ${ghlExistingPopulationSql("c.id")}
           AND NOT EXISTS (SELECT 1 FROM contact_provider_projections q WHERE q.contact_id = c.id AND q.provider = 'ghl'))
     ) AS needed`,
  );
  return result.rows[0]?.needed === true;
}

/**
 * Runs bounded convergence batches, each in its own short transaction, so an ordinary worker tick never holds a
 * whole-set transaction or disables the statement timeout. Progress is durable: the next run resumes where the
 * unclassified / un-adopted rows remain. Safe to run repeatedly and concurrently.
 */
export async function convergeLegacyProjectionRows(): Promise<{ ran: boolean; batches: number; remaining: boolean }> {
  if (!await projectionConvergenceNeeded()) return { ran: false, batches: 0, remaining: false };
  let batches = 0;
  for (; batches < GHL_CONVERGENCE_MAX_BATCHES_PER_RUN; batches++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '60s'");
      // One convergence at a time across processes; losers simply skip.
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('ghl_projection_convergence')) AS ok");
      if (lock.rows[0]?.ok !== true) {
        await client.query("ROLLBACK");
        return { ran: batches > 0, batches, remaining: true };
      }
      let touched = 0;
      for (const statement of GHL_RUNTIME_RECONCILE_STATEMENTS) {
        const result = await client.query(statement, [GHL_CONVERGENCE_BATCH_SIZE]);
        touched += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      if (touched === 0) return { ran: batches > 0, batches: batches + 1, remaining: await projectionConvergenceNeeded() };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { ran: true, batches, remaining: await projectionConvergenceNeeded() };
}
