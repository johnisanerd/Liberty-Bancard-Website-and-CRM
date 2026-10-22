/**
 * Governed Data Health reconciliation.
 *
 * Replaces the one-click `scripts/reconcile-orphans.ts` process. Two steps:
 *   1. readDataHealthReconcilePlan()  — read only; exact populations, per-item actions, ambiguity reasons.
 *   2. applyDataHealthReconcile()     — applies only the explicitly selected actions, each re-checked under a
 *                                       row lock, with the business change and its audit row in ONE transaction.
 *
 * Boundaries:
 *   - Nothing here sends, enrolls, reschedules, unpauses, calls a provider or touches GHL.
 *   - Enrollments with no next_action_at are reported only; this tool never invents a schedule.
 *   - A 2xx response means "receipt written"; the receipt carries per-action outcomes read back from the database.
 *   - The operation id is the idempotency identity. A replay returns the stored receipt; a changed selection under
 *     the same id is a conflict.
 *
 * Authority, identity and receipt protocol (D-V):
 *   - Every action transaction re-pins the actor: the user row is locked FOR SHARE and must still be an active admin
 *     with the same auth epoch and account version the request was bound to. If it is not, the operation stops, the
 *     remaining actions are reported as not attempted, and nothing further is written.
 *   - Allowed populations (identical at plan and apply): the deal must be non-archived with record_class 'production';
 *     the contact must be non-archived with record_class 'production'. Unknown, test, demo and synthetic records are
 *     never linked and never reclassified here; they are listed as left for a person.
 *   - "Exactly one contact with this email" is established under the same per-mailbox advisory lock that the canonical
 *     contact writer (writeContact) takes before it creates or matches a mailbox, so a participating writer cannot add a
 *     second matching contact between the check and the update. Contact inserts that bypass writeContact do not take
 *     this lock; no unique email index exists (migration 0352), so this is the strongest protocol available.
 *   - The receipt row carries an owner token and generation. Takeover of a stale operation bumps both with a
 *     compare-and-swap; every receipt write and every action transaction is fenced on them, and the action transaction
 *     holds the receipt row FOR SHARE so a takeover cannot interleave with an in-flight action. A worker that lost
 *     ownership stops without writing.
 */
import crypto from "node:crypto";
import { pool } from "../db";

export const DATA_HEALTH_RECONCILE_MAX_ACTIONS = 100;
export const DATA_HEALTH_ALLOWED_RECORD_CLASS = "production";
const PLAN_WINDOW = 200;
const RESUME_AFTER_MS = 120_000;
const OP_KEY_PREFIX = "data_health_reconcile_op:";
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;

export interface ReconcileActor { id: string; authEpoch: number; accountVersion?: number }

export type ReconcileActionType = "deal_link" | "enrollment_cancel";

export type ReconcileSkipReason =
  | "no_email_in_notes" | "no_contact_match" | "ambiguous_multiple_contacts" | "ineligible_contact";

export interface ReconcilePlanAction {
  key: string;
  type: ReconcileActionType;
  label: string;
  effect: string;
}

export interface ReconcilePlan {
  generatedAt: string;
  window: number;
  populations: {
    /** total = every unlinked deal (all classes, archived or not); inScope = active production unlinked deals, the only ones this tool may link. */
    orphanedDeals: { total: number; inScope: number; outOfScope: number; considered: number; actionable: number; unresolved: Record<ReconcileSkipReason, number> };
    orphanedEnrollments: { total: number; considered: number; actionable: number };
    nullLifecycleContacts: { total: number; changedByThisTool: false; note: string };
    activeEnrollmentsNoNextAction: { total: number; changedByThisTool: false; note: string };
  };
  actions: ReconcilePlanAction[];
  unresolvedDeals: Array<{ dealId: number; stage: string | null; reason: ReconcileSkipReason; candidateContactIds: number[] }>;
  outboundPause: string;
}

export type ActionOutcomeStatus = "applied" | "already_applied" | "not_current" | "failed";
export interface ActionOutcome { key: string; status: ActionOutcomeStatus; detail: string }

export interface ReconcileReceipt {
  operationId: string;
  status: "in_progress" | "complete";
  requestHash: string;
  actorId: string;
  /** The exact sorted selection, so an interrupted operation can be resubmitted after a reload. */
  actionKeys: string[];
  /** Fencing identity of the worker that owns this operation; never sent to clients. */
  ownerToken?: string;
  generation?: number;
  stoppedReason?: string | null;
  startedAt: string;
  heartbeatAt: string;
  completedAt: string | null;
  requested: number;
  outcomes: ActionOutcome[];
  counts: Record<ActionOutcomeStatus, number>;
}

export class ReconcileError extends Error {
  constructor(public code: string, public httpStatus: number, message: string) { super(message); }
}

type Parsed =
  | { type: "deal_link"; dealId: number; contactId: number }
  | { type: "enrollment_cancel"; enrollmentId: number };

export function parseReconcileActionKey(key: string): Parsed | null {
  const m = /^(deal_link|enrollment_cancel):(\d{1,9})(?::(\d{1,9}))?$/.exec(key);
  if (!m) return null;
  const a = Number(m[2]); const b = m[3] == null ? null : Number(m[3]);
  if (m[1] === "deal_link") return b == null ? null : { type: "deal_link", dealId: a, contactId: b };
  if (b != null) return null;
  return { type: "enrollment_cancel", enrollmentId: a };
}

const emailIn = (notes: string | null) => (notes ? EMAIL_RE.exec(notes)?.[0]?.toLowerCase() ?? null : null);
const isEligibleContact = (c: { archived_at: unknown; record_class: string | null }) =>
  c.archived_at == null && c.record_class === DATA_HEALTH_ALLOWED_RECORD_CLASS;
const isEligibleDeal = (d: { archived_at: unknown; record_class: string | null }) =>
  d.archived_at == null && d.record_class === DATA_HEALTH_ALLOWED_RECORD_CLASS;
const IN_SCOPE_DEAL_SQL = `contact_id IS NULL AND archived_at IS NULL AND record_class='${DATA_HEALTH_ALLOWED_RECORD_CLASS}'`;
export const publicReconcileReceipt = (r: ReconcileReceipt): ReconcileReceipt => { const { ownerToken: _t, ...rest } = r; return rest as ReconcileReceipt; };

type Q = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };

/** Classifies one orphaned deal against every contact (including archived) sharing the notes email. */
function classifyDeal(notes: string | null, contacts: Array<{ id: number; archived_at: unknown; record_class: string | null }>) {
  const email = emailIn(notes);
  if (!email) return { reason: "no_email_in_notes" as const, candidates: [] as number[] };
  if (contacts.length === 0) return { reason: "no_contact_match" as const, candidates: [] };
  if (contacts.length > 1) return { reason: "ambiguous_multiple_contacts" as const, candidates: contacts.map(c => c.id) };
  if (!isEligibleContact(contacts[0])) return { reason: "ineligible_contact" as const, candidates: [contacts[0].id] };
  return { reason: null, candidates: [contacts[0].id] };
}

export async function readDataHealthReconcilePlan(): Promise<ReconcilePlan> {
  const [totals, dealRows, enrollRows] = await Promise.all([
    pool.query(`SELECT
        (SELECT COUNT(*) FROM deals WHERE contact_id IS NULL)::int od,
        (SELECT COUNT(*) FROM deals WHERE ${IN_SCOPE_DEAL_SQL})::int ods,
        (SELECT COUNT(*) FROM sequence_enrollments se LEFT JOIN follow_up_sequences fs ON fs.id=se.sequence_id
           WHERE se.status IN ('active','paused') AND fs.id IS NULL)::int oe,
        (SELECT COUNT(*) FROM contacts WHERE lifecycle_state IS NULL AND archived_at IS NULL)::int nl,
        (SELECT COUNT(*) FROM sequence_enrollments WHERE status='active' AND next_action_at IS NULL)::int nn`),
    pool.query(`SELECT id,stage,notes FROM deals WHERE ${IN_SCOPE_DEAL_SQL} ORDER BY id DESC LIMIT $1`, [PLAN_WINDOW]),
    pool.query(`SELECT se.id,se.contact_id,se.sequence_id,se.status FROM sequence_enrollments se
        LEFT JOIN follow_up_sequences fs ON fs.id=se.sequence_id
        WHERE se.status IN ('active','paused') AND fs.id IS NULL ORDER BY se.id DESC LIMIT $1`, [PLAN_WINDOW]),
  ]);
  const t = totals.rows[0];
  const emails = [...new Set(dealRows.rows.map((d: any) => emailIn(d.notes)).filter((e): e is string => !!e))];
  const matches = emails.length
    ? (await pool.query(`SELECT id,lower(email) email,archived_at,record_class FROM contacts WHERE lower(email)=ANY($1::text[])`, [emails])).rows
    : [];
  const byEmail = new Map<string, any[]>();
  for (const c of matches) byEmail.set(c.email, [...(byEmail.get(c.email) ?? []), c]);

  const unresolved: Record<ReconcileSkipReason, number> = { no_email_in_notes: 0, no_contact_match: 0, ambiguous_multiple_contacts: 0, ineligible_contact: 0 };
  const actions: ReconcilePlanAction[] = [];
  const unresolvedDeals: ReconcilePlan["unresolvedDeals"] = [];
  let dealActionable = 0;
  for (const d of dealRows.rows) {
    const email = emailIn(d.notes);
    const verdict = classifyDeal(d.notes, email ? byEmail.get(email) ?? [] : []);
    if (verdict.reason) {
      unresolved[verdict.reason]++;
      if (unresolvedDeals.length < 50) unresolvedDeals.push({ dealId: d.id, stage: d.stage, reason: verdict.reason, candidateContactIds: verdict.candidates });
    } else {
      dealActionable++;
      actions.push({ key: `deal_link:${d.id}:${verdict.candidates[0]}`, type: "deal_link",
        label: `Deal #${d.id} → Contact #${verdict.candidates[0]}`,
        effect: "Sets the deal's contact. Only applied while the deal is still an active production deal and its notes email still matches exactly one contact, which must be an active production contact." });
    }
  }
  for (const e of enrollRows.rows) {
    actions.push({ key: `enrollment_cancel:${e.id}`, type: "enrollment_cancel",
      label: `Enrollment #${e.id} (contact #${e.contact_id}, missing sequence #${e.sequence_id}, ${e.status})`,
      effect: "Sets status to cancelled. The sequence no longer exists, so nothing can be sent for it. No new schedule is created." });
  }
  return {
    generatedAt: new Date().toISOString(),
    window: PLAN_WINDOW,
    populations: {
      orphanedDeals: { total: t.od, inScope: t.ods, outOfScope: t.od - t.ods, considered: dealRows.rows.length, actionable: dealActionable, unresolved },
      orphanedEnrollments: { total: t.oe, considered: enrollRows.rows.length, actionable: enrollRows.rows.length },
      nullLifecycleContacts: { total: t.nl, changedByThisTool: false,
        note: "Reported only. contacts.lifecycle_state is NOT NULL with a PROSPECT default, so a non-zero count means the schema contract was bypassed and needs investigation, not a blind backfill." },
      activeEnrollmentsNoNextAction: { total: t.nn, changedByThisTool: false,
        note: "Reported only. This tool never sets or reschedules next_action_at; review the sequence owner before changing these." },
    },
    actions,
    unresolvedDeals,
    outboundPause: "Not touched. Global outbound pause stays in force; none of these actions can send.",
  };
}

// ── Apply ─────────────────────────────────────────────────────────────────────

const opKey = (operationId: string) => OP_KEY_PREFIX + operationId;
const lostOwnership = () => new ReconcileError("OPERATION_OWNERSHIP_LOST", 409, "Another worker took over this operation; this worker stopped without writing.");
const lostAuthority = () => new ReconcileError("AUTHORITY_CHANGED", 403, "Administrator authority changed during the operation.");

async function withTx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

async function audit(c: Q, action: string, entityType: string, entityId: number, actorId: string, operationId: string, before: unknown, after: unknown, details: string) {
  await c.query(
    `INSERT INTO audit_logs(user_id,action,entity_type,entity_id,entity_key,details,before_state,after_state,actor_type,actor_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,'user',$1)`,
    [actorId, action, entityType, entityId, `data_health_reconcile:${operationId}`, JSON.stringify({ operationId, detail: details }),
      JSON.stringify(before), JSON.stringify(after)]);
}

/** Receipt ownership, read under a share lock so a takeover cannot interleave with this transaction. */
async function assertOwnership(c: Q, operationId: string, token: string, generation: number) {
  const row = (await c.query(`SELECT value->>'ownerToken' t, COALESCE((value->>'generation')::int,0) g FROM system_settings WHERE key=$1 FOR SHARE`, [opKey(operationId)])).rows[0];
  if (!row || row.t !== token || Number(row.g) !== generation) throw lostOwnership();
}

/** The actor must still be an active admin with the same auth epoch and account version the request was bound to. */
async function assertAuthority(c: Q, actor: ReconcileActor) {
  const u = (await c.query(`SELECT role,account_state,auth_epoch,account_version FROM users WHERE id=$1 FOR SHARE`, [actor.id])).rows[0];
  if (!u || u.account_state !== "active" || u.role !== "admin" || Number(u.auth_epoch) !== actor.authEpoch ||
      (actor.accountVersion !== undefined && Number(u.account_version) !== actor.accountVersion)) throw lostAuthority();
}

interface Fence { token: string; generation: number }

async function applyOne(p: Parsed, key: string, actor: ReconcileActor, operationId: string, fence: Fence): Promise<ActionOutcome> {
  try {
    return await withTx(async (c): Promise<ActionOutcome> => {
      await assertOwnership(c, operationId, fence.token, fence.generation);
      await assertAuthority(c, actor);
      if (p.type === "deal_link") {
        // Serialize with every writeContact mailbox resolution for this address BEFORE any row lock (the writer's own order).
        const pre = (await c.query(`SELECT notes FROM deals WHERE id=$1`, [p.dealId])).rows[0];
        const preEmail = pre ? emailIn(pre.notes) : null;
        if (preEmail) await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`contact-mailbox:${preEmail}`]);
        const d = (await c.query(`SELECT id,contact_id,notes,archived_at,record_class FROM deals WHERE id=$1 FOR UPDATE`, [p.dealId])).rows[0];
        if (!d) return { key, status: "not_current", detail: "Deal no longer exists." };
        if (d.contact_id === p.contactId) return { key, status: "already_applied", detail: "Deal already linked to this contact." };
        if (d.contact_id != null) return { key, status: "not_current", detail: "Deal is no longer unlinked." };
        if (!isEligibleDeal(d)) return { key, status: "not_current", detail: "Deal is not an active production deal; this tool never links or reclassifies other records." };
        const email = emailIn(d.notes);
        if (email !== preEmail) return { key, status: "not_current", detail: "Deal notes changed while the identity check was starting; nothing was changed." };
        const contacts = email ? (await c.query(`SELECT id,archived_at,record_class FROM contacts WHERE lower(email)=$1 FOR SHARE`, [email])).rows : [];
        const verdict = classifyDeal(d.notes, contacts);
        if (verdict.reason || verdict.candidates[0] !== p.contactId) {
          return { key, status: "not_current", detail: `Identity is no longer a unique active production match (${verdict.reason ?? "different contact"}).` };
        }
        await c.query(`UPDATE deals SET contact_id=$2, updated_at=NOW() WHERE id=$1 AND contact_id IS NULL`, [p.dealId, p.contactId]);
        await audit(c, "DATA_HEALTH_DEAL_LINKED", "deal", p.dealId, actor.id, operationId, { contactId: null }, { contactId: p.contactId }, "Linked unlinked production deal to its unique exact-email production contact.");
        return { key, status: "applied", detail: `Linked to contact #${p.contactId}.` };
      }
      if (p.type === "enrollment_cancel") {
        const e = (await c.query(`SELECT se.id,se.status,se.sequence_id,(SELECT 1 FROM follow_up_sequences fs WHERE fs.id=se.sequence_id) has_seq
          FROM sequence_enrollments se WHERE se.id=$1 FOR UPDATE OF se`, [p.enrollmentId])).rows[0];
        if (!e) return { key, status: "not_current", detail: "Enrollment no longer exists." };
        if (e.status === "cancelled") return { key, status: "already_applied", detail: "Enrollment already cancelled." };
        if (e.has_seq) return { key, status: "not_current", detail: "The sequence exists again; nothing to repair." };
        if (!["active", "paused"].includes(e.status)) return { key, status: "not_current", detail: `Enrollment is ${e.status}.` };
        await c.query(`UPDATE sequence_enrollments SET status='cancelled', updated_at=NOW(),
          metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('canceledBy','data-health-reconcile','cancelReason','sequence_not_found','operationId',$2::text)
          WHERE id=$1`, [p.enrollmentId, operationId]);
        await audit(c, "DATA_HEALTH_ENROLLMENT_CANCELLED", "sequence_enrollment", p.enrollmentId, actor.id, operationId, { status: e.status }, { status: "cancelled" }, "Cancelled enrollment whose sequence no longer exists.");
        return { key, status: "applied", detail: "Enrollment cancelled." };
      }
      return { key, status: "failed", detail: "Unsupported action." };
    });
  } catch (err: any) {
    // Ownership and authority loss stop the whole operation; they are not per-action failures.
    if (err instanceof ReconcileError) throw err;
    // The transaction rolled back, so neither the change nor its audit row exists.
    return { key, status: "failed", detail: `Rolled back: ${String(err?.code ?? err?.message ?? "error").slice(0, 120)}` };
  }
}

const emptyCounts = (): Record<ActionOutcomeStatus, number> => ({ applied: 0, already_applied: 0, not_current: 0, failed: 0 });
const tally = (outcomes: ActionOutcome[]) => { const c = emptyCounts(); for (const o of outcomes) c[o.status]++; return c; };

/** Every progress or final write is fenced on the owner token and generation; a lost fence throws and nothing is written. */
async function saveReceipt(r: ReconcileReceipt, fence: Fence) {
  const saved = await pool.query(
    `UPDATE system_settings SET value=$2::jsonb, updated_at=NOW()
      WHERE key=$1 AND value->>'ownerToken'=$3 AND COALESCE((value->>'generation')::int,0)=$4 RETURNING key`,
    [opKey(r.operationId), JSON.stringify({ ...r, ownerToken: fence.token, generation: fence.generation }), fence.token, fence.generation]);
  if (saved.rowCount === 0) throw lostOwnership();
}

export async function readDataHealthReconcileReceipt(operationId: string, actorId?: string): Promise<ReconcileReceipt | null> {
  const row = (await pool.query(`SELECT value FROM system_settings WHERE key=$1`, [opKey(operationId)])).rows[0];
  const receipt = (row?.value as ReconcileReceipt | undefined) ?? null;
  // A receipt is only retrievable by the administrator who started the operation.
  if (receipt && actorId !== undefined && receipt.actorId !== actorId) return null;
  return receipt;
}

/** Certification-only seam: lets a disposable-database test pause a worker between steps to prove ownership fencing. */
export interface ReconcileTestHooks { beforeAction?: (key: string) => Promise<void>; afterAction?: (key: string) => Promise<void> }

export async function applyDataHealthReconcile(input: { operationId: string; actionKeys: string[]; actor: ReconcileActor; testHooks?: ReconcileTestHooks }): Promise<{ receipt: ReconcileReceipt; replayed: boolean }> {
  const actor = input.actor;
  const keys = [...new Set(input.actionKeys)].sort();
  if (!/^[0-9a-f-]{36}$/i.test(input.operationId)) throw new ReconcileError("OPERATION_ID_REQUIRED", 400, "A UUID operation id is required.");
  if (keys.length === 0) throw new ReconcileError("NO_ACTIONS", 400, "Select at least one planned action.");
  if (keys.length > DATA_HEALTH_RECONCILE_MAX_ACTIONS) throw new ReconcileError("TOO_MANY_ACTIONS", 400, `At most ${DATA_HEALTH_RECONCILE_MAX_ACTIONS} actions per operation.`);
  const parsed = keys.map(k => ({ key: k, p: parseReconcileActionKey(k) }));
  const bad = parsed.find(x => !x.p);
  if (bad) throw new ReconcileError("INVALID_ACTION", 400, `Unrecognized action: ${bad.key.slice(0, 60)}`);
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(keys)).digest("hex");

  const now = new Date().toISOString();
  const fence: Fence = { token: crypto.randomUUID(), generation: 1 };
  const fresh: ReconcileReceipt = { operationId: input.operationId, status: "in_progress", requestHash, actorId: actor.id, actionKeys: keys,
    ownerToken: fence.token, generation: fence.generation,
    startedAt: now, heartbeatAt: now, completedAt: null, requested: keys.length, outcomes: [], counts: emptyCounts() };
  const claimed = await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [opKey(input.operationId), JSON.stringify(fresh)]);
  let receipt = fresh;
  if (claimed.rowCount === 0) {
    const existing = await readDataHealthReconcileReceipt(input.operationId);
    if (!existing) throw new ReconcileError("OPERATION_UNREADABLE", 500, "Operation record could not be read.");
    if (existing.requestHash !== requestHash || existing.actorId !== actor.id) {
      throw new ReconcileError("OPERATION_CONFLICT", 409, "This operation id was already used for a different selection or administrator.");
    }
    if (existing.status === "complete") return { receipt: publicReconcileReceipt(existing), replayed: true };
    if (Date.now() - Date.parse(existing.heartbeatAt) < RESUME_AFTER_MS) return { receipt: publicReconcileReceipt(existing), replayed: true };
    // Stale in-progress operation (process died): take ownership with a compare-and-swap on heartbeat AND generation.
    const nextGeneration = (existing.generation ?? 0) + 1;
    const takeover = await pool.query(
      `UPDATE system_settings SET value=value||jsonb_build_object('heartbeatAt',$3::text,'ownerToken',$4::text,'generation',$5::int),updated_at=NOW()
        WHERE key=$1 AND value->>'heartbeatAt'=$2 AND value->>'status'='in_progress' AND COALESCE((value->>'generation')::int,0)=$6 RETURNING key`,
      [opKey(input.operationId), existing.heartbeatAt, now, fence.token, nextGeneration, existing.generation ?? 0]);
    if (takeover.rowCount === 0) {
      const current = (await readDataHealthReconcileReceipt(input.operationId)) ?? existing;
      return { receipt: publicReconcileReceipt(current), replayed: true };
    }
    fence.generation = nextGeneration;
    receipt = { ...existing, heartbeatAt: now, ownerToken: fence.token, generation: fence.generation };
  }

  try {
    const done = new Set(receipt.outcomes.map(o => o.key));
    for (const { key, p } of parsed) {
      if (done.has(key)) continue;
      let outcome: ActionOutcome;
      await input.testHooks?.beforeAction?.(key);
      try { outcome = await applyOne(p!, key, actor, input.operationId, fence); }
      catch (err) {
        if (!(err instanceof ReconcileError) || err.code !== "AUTHORITY_CHANGED") throw err;
        // Stop here: every remaining action is reported as not attempted and nothing further is applied.
        receipt.stoppedReason = err.message;
        for (const rest of parsed) if (!receipt.outcomes.some(o => o.key === rest.key)) {
          receipt.outcomes.push({ key: rest.key, status: "not_current", detail: "Not attempted: administrator authority changed before this action ran." });
        }
        break;
      }
      await input.testHooks?.afterAction?.(key);
      receipt.outcomes.push(outcome);
      receipt.heartbeatAt = new Date().toISOString();
      receipt.counts = tally(receipt.outcomes);
      await saveReceipt(receipt, fence);
    }
    receipt.status = "complete";
    receipt.completedAt = new Date().toISOString();
    receipt.counts = tally(receipt.outcomes);
    await saveReceipt(receipt, fence);
    return { receipt: publicReconcileReceipt(receipt), replayed: false };
  } catch (err) {
    // A worker that lost ownership reports the new owner's stored state and writes nothing further.
    if (err instanceof ReconcileError && err.code === "OPERATION_OWNERSHIP_LOST") {
      const current = await readDataHealthReconcileReceipt(input.operationId);
      if (current) return { receipt: publicReconcileReceipt(current), replayed: true };
    }
    throw err;
  }
}
