/**
 * Automatic application of the independent domain + company + location assignment policy.
 *
 * The policy itself, its evidence record and its audited writer live in
 * contact-business-domain-location-links.ts (manual admin routes call the same functions). This worker
 * only supplies the missing automatic caller:
 *  - closed by default; an administrator turns it on and is recorded as the authorizing reviewer;
 *  - scans contacts in bounded id windows with a durable cursor and a token-fenced lease;
 *  - every commit goes through applyDomainLocationAssignment, which re-evaluates the policy and writes
 *    through decideContactBusinessLink inside its own transaction, so a conflict that appears after the
 *    scan is preserved (the write is rejected, never reassigned);
 *  - vertical, email validation and deliverability never gate or veto assignment (the policy ignores them);
 *  - assignment is not send permission, calls no provider and changes no outbound state.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import {
  DOMAIN_LOCATION_RULE,
  applyDomainLocationAssignment,
  evaluateDomainLocationPolicy,
} from "./contact-business-domain-location-links";

export const DOMAIN_LOCATION_AUTOMATION_KEY = "contact_domain_location_automation_v1";
const WINDOW_SPAN = 10000;
const LEASE_MINUTES = 2;
/** After a full pass, rescan no sooner than this; unchanged contacts are cheap but the policy query is set-based. */
export const DOMAIN_LOCATION_RESCAN_HOURS = 6;
const rows = (r: any): any[] => r?.rows ?? r ?? [];

export interface DomainLocationAutomationState {
  version: 1;
  rule: string;
  enabled: boolean;
  /** Administrator recorded as the reviewer on every automatic decision. */
  authorizedBy: string;
  cursor: number;
  passes: number;
  scanned: number;
  committed: number;
  replayed: number;
  held: number;
  reasons: Record<string, number>;
  rejectedCodes: Record<string, number>;
  leaseToken: string | null;
  leaseUntil: string | null;
  lastPassCompletedAt: string | null;
  updatedAt: string;
  lastError: string | null;
}

export async function getDomainLocationAutomationStatus(): Promise<DomainLocationAutomationState | null> {
  const r = await pool.query("SELECT value FROM system_settings WHERE key=$1", [DOMAIN_LOCATION_AUTOMATION_KEY]);
  const v = r.rows[0]?.value;
  return v?.version === 1 && v?.rule === DOMAIN_LOCATION_RULE ? v : null;
}

/** Operator on/off. Enabling records the acting administrator as the authorizing reviewer. */
export async function setDomainLocationAutomation(enabled: boolean, actorId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [DOMAIN_LOCATION_AUTOMATION_KEY]);
    const reviewer = await client.query("SELECT role FROM users WHERE id=$1", [actorId]);
    if (reviewer.rows[0]?.role !== "admin") throw new Error("DOMAIN_LOCATION_AUTOMATION_ADMIN_REQUIRED");
    const stored = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [DOMAIN_LOCATION_AUTOMATION_KEY]);
    const previous = stored.rows[0]?.value as DomainLocationAutomationState | undefined;
    const state: DomainLocationAutomationState = previous?.version === 1 && previous.rule === DOMAIN_LOCATION_RULE ? previous : {
      version: 1, rule: DOMAIN_LOCATION_RULE, enabled: false, authorizedBy: actorId, cursor: 0, passes: 0,
      scanned: 0, committed: 0, replayed: 0, held: 0, reasons: {}, rejectedCodes: {}, leaseToken: null, leaseUntil: null,
      lastPassCompletedAt: null, updatedAt: new Date().toISOString(), lastError: null,
    };
    state.enabled = enabled;
    state.authorizedBy = actorId;
    state.updatedAt = new Date().toISOString();
    await client.query(`INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=NOW()`,
      [DOMAIN_LOCATION_AUTOMATION_KEY, JSON.stringify(state)]);
    await client.query(`INSERT INTO audit_logs(user_id,action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES($1,'domain_location_automation_authorized','contact_business_link_program',$2,$3::jsonb,'user',$1)`,
      [actorId, DOMAIN_LOCATION_AUTOMATION_KEY, JSON.stringify({ enabled, rule: DOMAIN_LOCATION_RULE, paidProviderCalls: 0, outboundChanges: 0 })]);
    await client.query("COMMIT");
    return state;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function checkpoint(state: DomainLocationAutomationState, token: string) {
  state.updatedAt = new Date().toISOString();
  // The latest operator enable/disable decision always wins over the worker's copy.
  const r = await pool.query(`UPDATE system_settings
    SET value=$2::jsonb || jsonb_build_object('enabled',value->'enabled','authorizedBy',value->'authorizedBy'),updated_at=NOW()
    WHERE key=$1 AND value->>'leaseToken'=$3 AND (value->>'leaseUntil')::timestamptz>NOW()`,
    [DOMAIN_LOCATION_AUTOMATION_KEY, JSON.stringify(state), token]);
  if (r.rowCount !== 1) throw new Error("DOMAIN_LOCATION_AUTOMATION_LEASE_LOST");
}

const bump = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };

/** One bounded tick. Returns ran:false while closed, leased elsewhere, or between passes. */
export async function processDomainLocationAutomationTick(budget: { maxDurationMs?: number } = {}) {
  const maxDurationMs = budget.maxDurationMs ?? 25_000;
  const deadline = Date.now() + maxDurationMs;
  const token = crypto.randomUUID();
  const claim = await pool.query(`UPDATE system_settings
    SET value=jsonb_set(jsonb_set(value,'{leaseToken}',to_jsonb($2::text)),
      '{leaseUntil}',to_jsonb((clock_timestamp()+($3||' minutes')::interval)::text)),updated_at=NOW()
    WHERE key=$1 AND value->>'enabled'='true' AND value->>'version'='1' AND value->>'rule'=$4
      AND (value->>'leaseUntil' IS NULL OR (value->>'leaseUntil')::timestamptz<=clock_timestamp())
      AND (value->>'lastPassCompletedAt' IS NULL
        OR (value->>'lastPassCompletedAt')::timestamptz<=clock_timestamp()-($5||' hours')::interval
        OR (value->>'cursor')::int>0)
    RETURNING value`, [DOMAIN_LOCATION_AUTOMATION_KEY, token, String(LEASE_MINUTES), DOMAIN_LOCATION_RULE, String(DOMAIN_LOCATION_RESCAN_HOURS)]);
  const state = claim.rows[0]?.value as DomainLocationAutomationState | undefined;
  if (!state) return { ran: false as const };
  let committedThisTick = 0;
  try {
    const reviewerId = state.authorizedBy;
    const maxId = Number(rows(await db.execute(sql`SELECT COALESCE(max(id),0) m FROM contacts`))[0].m);
    while (Date.now() < deadline) {
      const after = state.cursor;
      const upper = after + WINDOW_SPAN;
      // The set-based policy query scans businesses and candidate contacts once per window (about 5-10 s on
      // production), so it gets its own statement limit instead of the pool default.
      const items = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '90s'`);
        return evaluateDomainLocationPolicy(tx, sql`c.id > ${after} AND c.id <= ${upper}`);
      });
      const seen = new Set<number>();
      const byContact = new Map<number, typeof items>();
      for (const it of items) byContact.set(it.contactId, [...(byContact.get(it.contactId) ?? []), it]);
      let stopped = false;
      for (const [contactId, candidates] of byContact) {
        if (Date.now() >= deadline) { stopped = true; break; }
        seen.add(contactId);
        const eligible = candidates.filter(c => c.eligible);
        // Two eligible businesses for one contact is itself a conflict: preserve it, assign neither.
        if (eligible.length !== 1) {
          state.scanned++; state.held++;
          for (const reason of eligible.length > 1 ? ["multiple_eligible_businesses"] : [...new Set(candidates.flatMap(c => c.reasons))]) bump(state.reasons, reason);
          continue;
        }
        const live = await pool.query(`SELECT value->>'enabled' e, value->>'leaseToken' t FROM system_settings WHERE key=$1`, [DOMAIN_LOCATION_AUTOMATION_KEY]);
        if (live.rows[0]?.e !== "true" || live.rows[0]?.t !== token) { stopped = true; break; }
        const outcome = await applyDomainLocationAssignment(eligible[0], reviewerId);
        state.scanned++;
        if (outcome.status === "applied") { state.committed++; committedThisTick++; }
        else if (outcome.status === "replayed") state.replayed++;
        else { state.held++; bump(state.rejectedCodes, String((outcome as any).code ?? "REJECTED")); }
      }
      if (stopped) break;
      state.cursor = upper >= maxId ? 0 : upper;
      if (upper >= maxId) {
        state.passes++;
        state.lastPassCompletedAt = new Date().toISOString();
        await checkpoint(state, token);
        break;
      }
      await checkpoint(state, token);
    }
    state.lastError = null;
    return { ran: true as const, committed: committedThisTick, cursor: state.cursor, passes: state.passes, held: state.held };
  } catch (error: any) {
    state.lastError = String(error?.code ?? error?.message ?? "DOMAIN_LOCATION_AUTOMATION_FAILED").slice(0, 180);
    throw error;
  } finally {
    state.leaseToken = null;
    state.leaseUntil = null;
    // Release the lease directly; checkpoint() requires a live lease and may be past it.
    await pool.query(`UPDATE system_settings
      SET value=$2::jsonb || jsonb_build_object('enabled',value->'enabled','authorizedBy',value->'authorizedBy',
        'leaseToken',NULL,'leaseUntil',NULL),updated_at=NOW()
      WHERE key=$1 AND (value->>'leaseToken'=$3)`,
      [DOMAIN_LOCATION_AUTOMATION_KEY, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), token]).catch(() => undefined);
    if (committedThisTick > 0) {
      await pool.query(`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
        VALUES('domain_location_automation_committed','contact_business_link_program',$1,$2::jsonb,'system','system:domain-location-automation')`,
        [DOMAIN_LOCATION_AUTOMATION_KEY, JSON.stringify({ committed: committedThisTick, rule: DOMAIN_LOCATION_RULE, authorizedBy: state.authorizedBy, paidProviderCalls: 0, outboundChanges: 0 })]).catch(() => undefined);
    }
  }
}
