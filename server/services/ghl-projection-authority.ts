/**
 * GHL contact projection authority (#2105).
 *
 * One open desired projection per contact and provider. Every producer goes
 * through `enqueueContactProjection`; the worker claims only work whose
 * persisted export disposition and live contact facts allow provider export,
 * and every settlement is a generation compare-and-swap so an edit made while
 * a projection is in flight is never reported as complete.
 *
 * Counters have separate meanings:
 *  - attempt_count    provider dispatch attempts that consume the failure budget
 *  - deferral_count   local deferrals (control/review/circuit); never consumes budget
 *  - dispatch_count   lifetime provider mutation dispatches
 *
 * Nothing here calls the provider or reads secrets.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db";

export const CONTACT_PROJECTION_MAX_ATTEMPTS = 8;
export const PROJECTION_LEASE_MS = 2 * 60 * 1000;
export const AMBIGUOUS_RETRY_MS = 5 * 60 * 1000;
export const DEFERRAL_RETRY_MS = 60 * 1000;
export const UNREOPENABLE_TERMINAL_REASONS = ["pipeline_local_only", "superseded_by_merge", "DISPATCH_AMBIGUOUS_UNRESOLVED"] as const;

export type ExportDisposition =
  | "current_intake" | "linked_update" | "historical_hold"
  | "local_only" | "test_local_only" | "closed" | "unclassified";

export const EXPORTABLE_DISPOSITIONS: readonly ExportDisposition[] = ["current_intake", "linked_update"];

export interface ExportFacts {
  recordClass: string | null;
  archived: boolean;
  hasGhlContactId: boolean;
  localOnlyFence: boolean;
}

/** Pure export classification for a newly requested projection. */
export function classifyExportDisposition(facts: ExportFacts): { disposition: ExportDisposition; reason: string } {
  if (facts.localOnlyFence) return { disposition: "local_only", reason: "pipeline_local_only_fence" };
  const recordClass = (facts.recordClass ?? "unknown").toLowerCase();
  if (recordClass === "test" || recordClass === "demo" || recordClass === "synthetic") {
    return { disposition: "test_local_only", reason: `record_class_${recordClass}` };
  }
  if (facts.archived) return { disposition: "closed", reason: "contact_archived" };
  return facts.hasGhlContactId
    ? { disposition: "linked_update", reason: "linked_contact_changed" }
    : { disposition: "current_intake", reason: "current_intake_new_desired_state" };
}

export interface SqlExecutor { execute(query: any): Promise<any> }
const rowsOf = (result: any): any[] => (result?.rows ?? result ?? []) as any[];

export type EnqueueOutcome =
  | { action: "coalesced" | "reopened" | "inserted"; disposition: ExportDisposition; desiredGeneration: number }
  | { action: "not_exported"; disposition: ExportDisposition; reason: string };

/** The only producer entry point for GHL contact projections. Safe inside a caller's transaction. */
export async function enqueueContactProjection(
  executor: SqlExecutor,
  input: { contactId: number; sourceKind: string },
): Promise<EnqueueOutcome> {
  const contactId = input.contactId;
  const facts = rowsOf(await executor.execute(sql`
    SELECT c.record_class, (c.archived_at IS NOT NULL) AS archived, (c.ghl_contact_id IS NOT NULL) AS has_ghl,
           EXISTS (SELECT 1 FROM contact_provider_projections f
                   WHERE f.contact_id = c.id AND f.provider = 'ghl' AND f.state = 'terminal'
                     AND f.terminal_reason = 'pipeline_local_only') AS fence
    FROM contacts c WHERE c.id = ${contactId}
  `))[0];
  if (!facts) return { action: "not_exported", disposition: "closed", reason: "contact_missing" };
  const { disposition, reason } = classifyExportDisposition({
    recordClass: facts.record_class, archived: facts.archived === true,
    hasGhlContactId: facts.has_ghl === true, localOnlyFence: facts.fence === true,
  });
  if (!EXPORTABLE_DISPOSITIONS.includes(disposition)) return { action: "not_exported", disposition, reason };
  const key = `contact:${contactId}`;

  for (let round = 0; round < 3; round++) {
    // 1. Coalesce into the single open projection. A row being processed only has its desired
    //    generation advanced; its settlement returns it to pending instead of completing it.
    const coalesced = rowsOf(await executor.execute(sql`
      UPDATE contact_provider_projections p
      SET desired_generation = p.desired_generation + 1,
          authority_version = COALESCE(p.authority_version, 1),
          export_disposition = ${disposition},
          export_reason = ${reason},
          source_kind = ${input.sourceKind},
          updated_at = now()
      WHERE p.id = (
        SELECT id FROM contact_provider_projections
        WHERE contact_id = ${contactId} AND provider = 'ghl' AND state IN ('pending', 'retry', 'processing')
        ORDER BY (authority_version IS NOT NULL) DESC, created_at DESC, id DESC
        LIMIT 1 FOR UPDATE)
      RETURNING p.desired_generation
    `))[0];
    if (coalesced) return { action: "coalesced", disposition, desiredGeneration: Number(coalesced.desired_generation) };

    // 2. A closed projection for the same contact gets a new generation with a fresh failure budget.
    //    Local-only fences, merge supersession and unresolved ambiguity are never reopened.
    const reopened = rowsOf(await executor.execute(sql`
      UPDATE contact_provider_projections p
      SET state = 'pending', desired_generation = p.desired_generation + 1, attempt_count = 0,
          next_attempt_at = now(), terminal_reason = NULL, last_error_code = NULL, completed_at = NULL,
          claim_token = NULL, lease_expires_at = NULL, claimed_generation = NULL, authority_version = 1,
          export_disposition = ${disposition}, export_reason = ${reason}, source_kind = ${input.sourceKind},
          superseded_by = NULL, superseded_at = NULL, updated_at = now()
      WHERE p.contact_id = ${contactId} AND p.provider = 'ghl' AND p.projection_key = ${key}
        AND p.dispatch_state <> 'ambiguous'
        AND (p.state IN ('succeeded', 'superseded')
             OR (p.state = 'terminal' AND p.terminal_reason IS DISTINCT FROM 'pipeline_local_only'
                 AND p.terminal_reason IS DISTINCT FROM 'superseded_by_merge'
                 AND p.terminal_reason IS DISTINCT FROM 'DISPATCH_AMBIGUOUS_UNRESOLVED'))
      RETURNING p.desired_generation
    `))[0];
    if (reopened) return { action: "reopened", disposition, desiredGeneration: Number(reopened.desired_generation) };

    // 3. First projection for this contact. ON CONFLICT without a target absorbs the key and
    //    open-slot conflicts of a concurrent producer; the next round coalesces into it.
    const inserted = rowsOf(await executor.execute(sql`
      INSERT INTO contact_provider_projections
        (contact_id, provider, projection_key, state, authority_version, desired_generation,
         export_disposition, export_reason, source_kind)
      VALUES (${contactId}, 'ghl', ${key}, 'pending', 1, 1, ${disposition}, ${reason}, ${input.sourceKind})
      ON CONFLICT DO NOTHING
      RETURNING desired_generation
    `))[0];
    if (inserted) return { action: "inserted", disposition, desiredGeneration: Number(inserted.desired_generation) };

    // 4. A closed row that must never be reopened (unresolved ambiguous create, merge supersession) owns
    //    the projection key. Report it; never throw into the producer's write path.
    const blocker = rowsOf(await executor.execute(sql`
      SELECT terminal_reason, dispatch_state FROM contact_provider_projections
      WHERE contact_id = ${contactId} AND provider = 'ghl' AND projection_key = ${key}
        AND state NOT IN ('pending', 'retry', 'processing')
      LIMIT 1
    `))[0];
    if (blocker && (blocker.dispatch_state === "ambiguous"
        || ["superseded_by_merge", "DISPATCH_AMBIGUOUS_UNRESOLVED", "pipeline_local_only"].includes(blocker.terminal_reason))) {
      return { action: "not_exported", disposition: "closed", reason: `blocked_${String(blocker.terminal_reason ?? "ambiguous_dispatch")}` };
    }
  }
  throw new Error("GHL_PROJECTION_ENQUEUE_CONTENDED");
}

export interface ClaimedProjection {
  id: string;
  contactId: number;
  attemptCount: number;
  claimedGeneration: number;
  dispatchState: string;
  claimToken: string;
}

/**
 * Claim eligible projections. Eligibility is evaluated against live contact facts so a contact
 * reclassified as test/demo/synthetic after enqueue is never exported. Claiming never consumes
 * attempts; a processing row whose lease expired is reclaimed (its dispatch state is kept so a
 * crash between reservation and settlement is treated as ambiguous).
 */
export async function claimEligibleProjections(limit: number): Promise<ClaimedProjection[]> {
  const claimToken = globalThis.crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + PROJECTION_LEASE_MS);
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT p.id
      FROM contact_provider_projections p
      JOIN contacts c ON c.id = p.contact_id
      WHERE p.provider = 'ghl'
        AND p.authority_version IS NOT NULL
        AND p.export_disposition IN ('current_intake', 'linked_update')
        AND c.record_class NOT IN ('test', 'demo', 'synthetic')
        AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM contact_provider_projections f
                        WHERE f.contact_id = p.contact_id AND f.provider = 'ghl'
                          AND f.state = 'terminal' AND f.terminal_reason = 'pipeline_local_only')
        AND p.attempt_count < ${CONTACT_PROJECTION_MAX_ATTEMPTS}
        AND ((p.state IN ('pending', 'retry') AND p.next_attempt_at <= now())
             OR (p.state = 'processing' AND p.lease_expires_at < now()))
      ORDER BY (p.export_disposition = 'current_intake') DESC, p.created_at
      FOR UPDATE OF p SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE contact_provider_projections p
    SET state = 'processing', claim_token = ${claimToken}, lease_expires_at = ${leaseUntil},
        claimed_generation = p.desired_generation,
        dispatch_state = CASE WHEN p.dispatch_state = 'reserved' THEN 'ambiguous' ELSE p.dispatch_state END,
        updated_at = now()
    FROM candidates
    WHERE p.id = candidates.id
    RETURNING p.id, p.contact_id, p.attempt_count, p.claimed_generation, p.dispatch_state
  `);
  return rowsOf(result).map(r => ({
    id: r.id, contactId: Number(r.contact_id), attemptCount: Number(r.attempt_count),
    claimedGeneration: Number(r.claimed_generation), dispatchState: r.dispatch_state, claimToken,
  }));
}

/** Extend a held claim. Returns false when the claim was lost (never write after a false). */
export async function renewProjectionLease(row: ClaimedProjection): Promise<boolean> {
  const result = await pool.query(
    `UPDATE contact_provider_projections SET lease_expires_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
     WHERE id = $1 AND claim_token = $2 AND state = 'processing'`,
    [row.id, row.claimToken, PROJECTION_LEASE_MS]);
  return (result.rowCount ?? 0) === 1;
}

/** Persist dispatch identity before any provider I/O is possible. */
export async function reserveProjectionDispatch(row: ClaimedProjection): Promise<string | null> {
  const operationId = globalThis.crypto.randomUUID();
  const result = await pool.query(
    `UPDATE contact_provider_projections SET dispatch_state = 'reserved', dispatch_operation_id = $3, updated_at = now()
     WHERE id = $1 AND claim_token = $2 AND state = 'processing'`,
    [row.id, row.claimToken, operationId]);
  return (result.rowCount ?? 0) === 1 ? operationId : null;
}

export type ProjectionSettlement =
  | { kind: "success"; receipts: Record<string, unknown> }
  | { kind: "deferred"; code: string; retryAfterMs?: number }
  | { kind: "retry"; code: string; receipts: Record<string, unknown>; consumedAttempt: boolean; dispatched: boolean; delayMs: number }
  | { kind: "ambiguous"; code: string; receipts: Record<string, unknown>; delayMs?: number }
  | { kind: "terminal"; reason: string; code: string; receipts: Record<string, unknown>; consumedAttempt: boolean; dispatched: boolean }
  | { kind: "released" };

/**
 * Generation-CAS settlement fenced by the claim token. Returns false when the claim was lost.
 * A success for generation N while desired generation > N returns the row to pending with a
 * fresh failure budget instead of completing it.
 */
export async function settleProjection(row: ClaimedProjection, outcome: ProjectionSettlement): Promise<boolean> {
  const where = sql`id = ${row.id} AND claim_token = ${row.claimToken} AND state = 'processing'`;
  let result: any;
  switch (outcome.kind) {
    case "success":
      result = await db.execute(sql`
        UPDATE contact_provider_projections SET
          settled_generation = ${row.claimedGeneration},
          state = CASE WHEN desired_generation > ${row.claimedGeneration} THEN 'pending' ELSE 'succeeded' END,
          next_attempt_at = CASE WHEN desired_generation > ${row.claimedGeneration} THEN now() ELSE next_attempt_at END,
          completed_at = CASE WHEN desired_generation > ${row.claimedGeneration} THEN NULL ELSE now() END,
          attempt_count = CASE WHEN desired_generation > ${row.claimedGeneration} THEN 0 ELSE attempt_count END,
          claim_token = NULL, lease_expires_at = NULL, claimed_generation = NULL,
          dispatch_state = 'none', dispatch_operation_id = NULL, last_dispatch_at = now(),
          dispatch_count = dispatch_count + 1,
          component_receipts = ${JSON.stringify(outcome.receipts)}::jsonb,
          last_error_code = NULL, terminal_reason = NULL, updated_at = now()
        WHERE ${where} RETURNING id`);
      break;
    case "deferred":
      result = await db.execute(sql`
        UPDATE contact_provider_projections SET
          state = 'retry', deferral_count = deferral_count + 1,
          next_attempt_at = now() + (${outcome.retryAfterMs ?? DEFERRAL_RETRY_MS}::int * interval '1 millisecond'),
          last_error_code = ${outcome.code}, claim_token = NULL, lease_expires_at = NULL, claimed_generation = NULL,
          dispatch_state = CASE WHEN dispatch_state = 'ambiguous' THEN 'ambiguous' ELSE 'none' END,
          dispatch_operation_id = NULL, updated_at = now()
        WHERE ${where} RETURNING id`);
      break;
    case "released":
      result = await db.execute(sql`
        UPDATE contact_provider_projections SET
          state = 'pending', claim_token = NULL, lease_expires_at = NULL, claimed_generation = NULL,
          dispatch_state = CASE WHEN dispatch_state = 'ambiguous' THEN 'ambiguous' ELSE 'none' END,
          dispatch_operation_id = NULL, updated_at = now()
        WHERE ${where} RETURNING id`);
      break;
    case "retry":
      result = await db.execute(sql`
        UPDATE contact_provider_projections SET
          state = 'retry',
          attempt_count = attempt_count + ${outcome.consumedAttempt ? 1 : 0},
          dispatch_count = dispatch_count + ${outcome.dispatched ? 1 : 0},
          last_dispatch_at = CASE WHEN ${outcome.dispatched}::boolean THEN now() ELSE last_dispatch_at END,
          next_attempt_at = now() + (${outcome.delayMs}::int * interval '1 millisecond'),
          last_error_code = ${outcome.code}, claim_token = NULL, lease_expires_at = NULL, claimed_generation = NULL,
          dispatch_state = 'none', dispatch_operation_id = NULL,
          component_receipts = ${JSON.stringify(outcome.receipts)}::jsonb, updated_at = now()
        WHERE ${where} RETURNING id`);
      break;
    case "ambiguous":
      result = await db.execute(sql`
        UPDATE contact_provider_projections SET
          state = CASE WHEN attempt_count + 1 >= ${CONTACT_PROJECTION_MAX_ATTEMPTS} THEN 'terminal' ELSE 'retry' END,
          terminal_reason = CASE WHEN attempt_count + 1 >= ${CONTACT_PROJECTION_MAX_ATTEMPTS} THEN 'DISPATCH_AMBIGUOUS_UNRESOLVED' ELSE NULL END,
          attempt_count = attempt_count + 1, dispatch_count = dispatch_count + 1, last_dispatch_at = now(),
          next_attempt_at = now() + (${outcome.delayMs ?? AMBIGUOUS_RETRY_MS}::int * interval '1 millisecond'),
          last_error_code = ${outcome.code}, claim_token = NULL, lease_expires_at = NULL, claimed_generation = NULL,
          dispatch_state = 'ambiguous', component_receipts = ${JSON.stringify(outcome.receipts)}::jsonb, updated_at = now()
        WHERE ${where} RETURNING id`);
      break;
    case "terminal":
      result = await db.execute(sql`
        UPDATE contact_provider_projections SET
          state = 'terminal', terminal_reason = ${outcome.reason}, last_error_code = ${outcome.code},
          attempt_count = attempt_count + ${outcome.consumedAttempt ? 1 : 0},
          dispatch_count = dispatch_count + ${outcome.dispatched ? 1 : 0},
          completed_at = now(), claim_token = NULL, lease_expires_at = NULL, claimed_generation = NULL,
          dispatch_state = 'none', dispatch_operation_id = NULL,
          component_receipts = ${JSON.stringify(outcome.receipts)}::jsonb, updated_at = now()
        WHERE ${where} RETURNING id`);
      break;
  }
  return rowsOf(result).length === 1;
}

/** Clear an unresolved ambiguity after a read-only reconciliation found the remote identity state. */
export async function clearProjectionAmbiguity(row: ClaimedProjection): Promise<void> {
  await pool.query(
    `UPDATE contact_provider_projections SET dispatch_state = 'none', dispatch_operation_id = NULL, updated_at = now()
     WHERE id = $1 AND claim_token = $2 AND state = 'processing'`,
    [row.id, row.claimToken]);
}

/**
 * Release rows stranded by pre-fix deferral accounting: open rows that consumed their whole budget
 * while the latest outcome was a proven local deferral (no provider dispatch recorded, contact never
 * linked to a remote record). Succeeded, terminal, in-flight and ambiguous rows are never touched.
 * Idempotent: a repaired row has attempt_count 0 and no longer matches.
 */
export async function repairStrandedProjections(maxRows = 500): Promise<number> {
  const result = await pool.query(
    `WITH stranded AS (
       SELECT p.id FROM contact_provider_projections p
       JOIN contacts c ON c.id = p.contact_id
       WHERE p.provider = 'ghl' AND p.state IN ('pending', 'retry')
         AND p.attempt_count >= $1
         AND p.last_error_code = 'GHL_SYNC_DEFERRED_BLOCKED'
         AND p.dispatch_state = 'none' AND p.last_dispatch_at IS NULL
         AND c.ghl_contact_id IS NULL
       ORDER BY p.created_at LIMIT $2
       FOR UPDATE OF p SKIP LOCKED)
     UPDATE contact_provider_projections p
     SET attempt_count = 0, next_attempt_at = now(), updated_at = now()
     FROM stranded WHERE p.id = stranded.id
     RETURNING p.id`,
    [CONTACT_PROJECTION_MAX_ATTEMPTS, maxRows]);
  return result.rowCount ?? 0;
}

export interface ProjectionBacklog {
  eligiblePending: number;
  eligibleRetryDue: number;
  eligibleRetryWaiting: number;
  processing: number;
  heldHistorical: number;
  localOnlyOrTest: number;
  ambiguous: number;
  terminal: number;
  succeeded: number;
  deferralsTotal: number;
}

export async function getProjectionBacklog(): Promise<ProjectionBacklog> {
  const r = (await pool.query(`
    SELECT
      count(*) FILTER (WHERE state = 'pending' AND export_disposition IN ('current_intake','linked_update')) AS eligible_pending,
      count(*) FILTER (WHERE state = 'retry' AND export_disposition IN ('current_intake','linked_update') AND next_attempt_at <= now()) AS eligible_retry_due,
      count(*) FILTER (WHERE state = 'retry' AND export_disposition IN ('current_intake','linked_update') AND next_attempt_at > now()) AS eligible_retry_waiting,
      count(*) FILTER (WHERE state = 'processing') AS processing,
      count(*) FILTER (WHERE state IN ('pending','retry') AND export_disposition IN ('historical_hold','unclassified')) AS held_historical,
      count(*) FILTER (WHERE export_disposition IN ('local_only','test_local_only')) AS local_only_or_test,
      count(*) FILTER (WHERE dispatch_state = 'ambiguous') AS ambiguous,
      count(*) FILTER (WHERE state = 'terminal') AS terminal,
      count(*) FILTER (WHERE state = 'succeeded') AS succeeded,
      COALESCE(sum(deferral_count), 0) AS deferrals_total
    FROM contact_provider_projections WHERE provider = 'ghl'`)).rows[0];
  const n = (v: unknown) => Number(v ?? 0);
  return {
    eligiblePending: n(r.eligible_pending), eligibleRetryDue: n(r.eligible_retry_due),
    eligibleRetryWaiting: n(r.eligible_retry_waiting), processing: n(r.processing),
    heldHistorical: n(r.held_historical), localOnlyOrTest: n(r.local_only_or_test),
    ambiguous: n(r.ambiguous), terminal: n(r.terminal), succeeded: n(r.succeeded),
    deferralsTotal: n(r.deferrals_total),
  };
}

export type ProjectionReceiptLevel =
  | "recorded_locally" | "waiting" | "processing" | "provider_accepted" | "held" | "ambiguous" | "failed" | "not_applicable";

export interface ContactProjectionView {
  present: boolean;
  receiptLevel: ProjectionReceiptLevel;
  state: string | null;
  exportDisposition: string | null;
  exportReason: string | null;
  desiredGeneration: number | null;
  settledGeneration: number | null;
  attemptCount: number | null;
  deferralCount: number | null;
  dispatchState: string | null;
  lastDispatchAt: string | null;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  terminalReason: string | null;
  componentReceipts: Record<string, unknown>;
  /** Provider read-back verification is not performed by the projection; accepted is never shown as verified. */
  verified: false;
}

/** Authoritative per-contact projection state. Missing data is `present:false`, never an implied success. */
export async function describeContactProjection(contactId: number): Promise<ContactProjectionView> {
  const row = (await pool.query(
    `SELECT * FROM contact_provider_projections
     WHERE contact_id = $1 AND provider = 'ghl' AND state <> 'superseded'
     ORDER BY (state IN ('pending','retry','processing')) DESC, updated_at DESC LIMIT 1`, [contactId])).rows[0];
  if (!row) {
    return {
      present: false, receiptLevel: "not_applicable", state: null, exportDisposition: null, exportReason: null,
      desiredGeneration: null, settledGeneration: null, attemptCount: null, deferralCount: null, dispatchState: null,
      lastDispatchAt: null, nextAttemptAt: null, lastErrorCode: null, terminalReason: null, componentReceipts: {}, verified: false,
    };
  }
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  let receiptLevel: ProjectionReceiptLevel;
  if (row.dispatch_state === "ambiguous") receiptLevel = "ambiguous";
  else if (row.state === "terminal") receiptLevel = "failed";
  else if (["historical_hold", "unclassified", "local_only", "test_local_only"].includes(row.export_disposition)
    && ["pending", "retry"].includes(row.state)) receiptLevel = "held";
  else if (row.state === "processing") receiptLevel = "processing";
  else if (row.state === "retry") receiptLevel = "waiting";
  else if (row.state === "pending") receiptLevel = Number(row.deferral_count) > 0 ? "waiting" : "recorded_locally";
  else if (row.state === "succeeded") receiptLevel = Number(row.settled_generation) >= Number(row.desired_generation) ? "provider_accepted" : "waiting";
  else receiptLevel = "recorded_locally";
  return {
    present: true, receiptLevel, state: row.state, exportDisposition: row.export_disposition, exportReason: row.export_reason,
    desiredGeneration: Number(row.desired_generation), settledGeneration: Number(row.settled_generation),
    attemptCount: Number(row.attempt_count), deferralCount: Number(row.deferral_count), dispatchState: row.dispatch_state,
    lastDispatchAt: iso(row.last_dispatch_at), nextAttemptAt: iso(row.next_attempt_at), lastErrorCode: row.last_error_code,
    terminalReason: row.terminal_reason, componentReceipts: (row.component_receipts ?? {}) as Record<string, unknown>, verified: false,
  };
}
