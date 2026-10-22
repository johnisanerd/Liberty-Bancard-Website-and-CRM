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
 */
import crypto from "node:crypto";
import { pool } from "../db";

export const DATA_HEALTH_RECONCILE_MAX_ACTIONS = 100;
const PLAN_WINDOW = 200;
const RESUME_AFTER_MS = 120_000;
const OP_KEY_PREFIX = "data_health_reconcile_op:";
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;
const NONPRODUCTION_CLASSES = ["test", "demo", "synthetic"];

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
    orphanedDeals: { total: number; considered: number; actionable: number; unresolved: Record<ReconcileSkipReason, number> };
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
  c.archived_at == null && !NONPRODUCTION_CLASSES.includes(c.record_class ?? "unknown");

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
        (SELECT COUNT(*) FROM sequence_enrollments se LEFT JOIN follow_up_sequences fs ON fs.id=se.sequence_id
           WHERE se.status IN ('active','paused') AND fs.id IS NULL)::int oe,
        (SELECT COUNT(*) FROM contacts WHERE lifecycle_state IS NULL AND archived_at IS NULL)::int nl,
        (SELECT COUNT(*) FROM sequence_enrollments WHERE status='active' AND next_action_at IS NULL)::int nn`),
    pool.query(`SELECT id,stage,notes FROM deals WHERE contact_id IS NULL ORDER BY id DESC LIMIT $1`, [PLAN_WINDOW]),
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
        effect: "Sets the deal's contact. Only applied while the notes email still matches exactly one active production contact." });
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
      orphanedDeals: { total: t.od, considered: dealRows.rows.length, actionable: dealActionable, unresolved },
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

async function applyOne(p: Parsed, key: string, actorId: string, operationId: string): Promise<ActionOutcome> {
  try {
    return await withTx(async (c): Promise<ActionOutcome> => {
      if (p.type === "deal_link") {
        const d = (await c.query(`SELECT id,contact_id,notes FROM deals WHERE id=$1 FOR UPDATE`, [p.dealId])).rows[0];
        if (!d) return { key, status: "not_current", detail: "Deal no longer exists." };
        if (d.contact_id === p.contactId) return { key, status: "already_applied", detail: "Deal already linked to this contact." };
        if (d.contact_id != null) return { key, status: "not_current", detail: "Deal is no longer unlinked." };
        const email = emailIn(d.notes);
        const contacts = email ? (await c.query(`SELECT id,archived_at,record_class FROM contacts WHERE lower(email)=$1 FOR SHARE`, [email])).rows : [];
        const verdict = classifyDeal(d.notes, contacts);
        if (verdict.reason || verdict.candidates[0] !== p.contactId) {
          return { key, status: "not_current", detail: `Identity is no longer a unique active match (${verdict.reason ?? "different contact"}).` };
        }
        await c.query(`UPDATE deals SET contact_id=$2, updated_at=NOW() WHERE id=$1 AND contact_id IS NULL`, [p.dealId, p.contactId]);
        await audit(c, "DATA_HEALTH_DEAL_LINKED", "deal", p.dealId, actorId, operationId, { contactId: null }, { contactId: p.contactId }, "Linked unlinked deal to its unique exact-email contact.");
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
        await audit(c, "DATA_HEALTH_ENROLLMENT_CANCELLED", "sequence_enrollment", p.enrollmentId, actorId, operationId, { status: e.status }, { status: "cancelled" }, "Cancelled enrollment whose sequence no longer exists.");
        return { key, status: "applied", detail: "Enrollment cancelled." };
      }
      return { key, status: "failed", detail: "Unsupported action." };
    });
  } catch (err: any) {
    // The transaction rolled back, so neither the change nor its audit row exists.
    return { key, status: "failed", detail: `Rolled back: ${String(err?.code ?? err?.message ?? "error").slice(0, 120)}` };
  }
}

const emptyCounts = (): Record<ActionOutcomeStatus, number> => ({ applied: 0, already_applied: 0, not_current: 0, failed: 0 });
const tally = (outcomes: ActionOutcome[]) => { const c = emptyCounts(); for (const o of outcomes) c[o.status]++; return c; };

async function saveReceipt(r: ReconcileReceipt) {
  await pool.query(`UPDATE system_settings SET value=$2::jsonb, updated_at=NOW() WHERE key=$1`, [OP_KEY_PREFIX + r.operationId, JSON.stringify(r)]);
}

export async function readDataHealthReconcileReceipt(operationId: string): Promise<ReconcileReceipt | null> {
  const row = (await pool.query(`SELECT value FROM system_settings WHERE key=$1`, [OP_KEY_PREFIX + operationId])).rows[0];
  return (row?.value as ReconcileReceipt) ?? null;
}

export async function applyDataHealthReconcile(input: { operationId: string; actionKeys: string[]; actorId: string }): Promise<{ receipt: ReconcileReceipt; replayed: boolean }> {
  const keys = [...new Set(input.actionKeys)].sort();
  if (!/^[0-9a-f-]{36}$/i.test(input.operationId)) throw new ReconcileError("OPERATION_ID_REQUIRED", 400, "A UUID operation id is required.");
  if (keys.length === 0) throw new ReconcileError("NO_ACTIONS", 400, "Select at least one planned action.");
  if (keys.length > DATA_HEALTH_RECONCILE_MAX_ACTIONS) throw new ReconcileError("TOO_MANY_ACTIONS", 400, `At most ${DATA_HEALTH_RECONCILE_MAX_ACTIONS} actions per operation.`);
  const parsed = keys.map(k => ({ key: k, p: parseReconcileActionKey(k) }));
  const bad = parsed.find(x => !x.p);
  if (bad) throw new ReconcileError("INVALID_ACTION", 400, `Unrecognized action: ${bad.key.slice(0, 60)}`);
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(keys)).digest("hex");

  const now = new Date().toISOString();
  const fresh: ReconcileReceipt = { operationId: input.operationId, status: "in_progress", requestHash, actorId: input.actorId,
    startedAt: now, heartbeatAt: now, completedAt: null, requested: keys.length, outcomes: [], counts: emptyCounts() };
  const claimed = await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [OP_KEY_PREFIX + input.operationId, JSON.stringify(fresh)]);
  let receipt = fresh;
  if (claimed.rowCount === 0) {
    const existing = await readDataHealthReconcileReceipt(input.operationId);
    if (!existing) throw new ReconcileError("OPERATION_UNREADABLE", 500, "Operation record could not be read.");
    if (existing.requestHash !== requestHash || existing.actorId !== input.actorId) {
      throw new ReconcileError("OPERATION_CONFLICT", 409, "This operation id was already used for a different selection or administrator.");
    }
    if (existing.status === "complete") return { receipt: existing, replayed: true };
    if (Date.now() - Date.parse(existing.heartbeatAt) < RESUME_AFTER_MS) return { receipt: existing, replayed: true };
    // Stale in-progress operation (process died): resume with a compare-and-swap on the heartbeat.
    const takeover = await pool.query(
      `UPDATE system_settings SET value=jsonb_set(value,'{heartbeatAt}',to_jsonb($3::text)),updated_at=NOW()
        WHERE key=$1 AND value->>'heartbeatAt'=$2 AND value->>'status'='in_progress' RETURNING key`,
      [OP_KEY_PREFIX + input.operationId, existing.heartbeatAt, now]);
    if (takeover.rowCount === 0) return { receipt: (await readDataHealthReconcileReceipt(input.operationId)) ?? existing, replayed: true };
    receipt = { ...existing, heartbeatAt: now };
  }

  const done = new Set(receipt.outcomes.map(o => o.key));
  for (const { key, p } of parsed) {
    if (done.has(key)) continue;
    receipt.outcomes.push(await applyOne(p!, key, input.actorId, input.operationId));
    receipt.heartbeatAt = new Date().toISOString();
    receipt.counts = tally(receipt.outcomes);
    await saveReceipt(receipt);
  }
  receipt.status = "complete";
  receipt.completedAt = new Date().toISOString();
  receipt.counts = tally(receipt.outcomes);
  await saveReceipt(receipt);
  return { receipt, replayed: false };
}
