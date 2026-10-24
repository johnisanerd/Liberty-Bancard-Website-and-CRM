/**
 * Durable per-effect ledger for GHL webhook handlers (#2105 H5/H6).
 *
 * The receipt only says "this delivery was claimed". Each effect a handler performs is a named step under that
 * receipt. A completed step is never run again on a retry, whatever happened to the settlement or the response.
 *
 *  - runReceiptTxStep: a LOCAL database effect. The step is completed in the SAME transaction as the effect, so there
 *    is no state in which the effect committed and the ledger does not know. This is the form for state changes.
 *  - runReceiptStep: an EXTERNAL or non-transactional effect (provider enrollment, tag write). The step is claimed
 *    with a lease before the call and completed after it. A crash between the call and the completion repeats only
 *    that one step, and the callee must therefore carry a stable idempotency identity (the step key is passed in).
 *
 * Both are fenced by the receipt claim: a delivery whose claim expired or was taken over cannot start or finish a step.
 * Outside a receipt (direct callers, tests) the effect simply runs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "../db";

export const RECEIPT_STEP_LEASE_SECONDS = 120;

export interface ReceiptStepContext { receiptId: string; claimToken: string; lost: boolean }

export const receiptStepContext = new AsyncLocalStorage<ReceiptStepContext>();

export class ReceiptClaimLostError extends Error {
  constructor() { super("GHL_WEBHOOK_RECEIPT_CLAIM_LOST"); this.name = "ReceiptClaimLostError"; }
}
export class ReceiptStepInFlightError extends Error {
  constructor(readonly stepKey: string) { super(`GHL_WEBHOOK_STEP_IN_FLIGHT:${stepKey}`); this.name = "ReceiptStepInFlightError"; }
}

export type ReceiptStepResult<T> = { result: T; replayed: boolean };
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function currentReceiptId(): string | null {
  return receiptStepContext.getStore()?.receiptId ?? null;
}

const CLAIM_HELD_SQL = `SELECT 1 FROM ghl_provider_event_receipts
  WHERE id = $1 AND claim_token = $2 AND state = 'claimed' AND lease_expires_at > now()`;

function failLost(ctx: ReceiptStepContext): never { ctx.lost = true; throw new ReceiptClaimLostError(); }

/** External / non-transactional effect: claimed with a lease, run once, completed. Callee must be idempotent on stepKey. */
export async function runReceiptStep<T>(
  stepKey: string, fn: (info: { stepKey: string; receiptId: string | null; attempt: number }) => Promise<T>,
): Promise<ReceiptStepResult<T>> {
  const ctx = receiptStepContext.getStore();
  if (!ctx) return { result: await fn({ stepKey, receiptId: null, attempt: 1 }), replayed: false };
  if (ctx.lost) throw new ReceiptClaimLostError();
  const held = await pool.query(CLAIM_HELD_SQL, [ctx.receiptId, ctx.claimToken]);
  if ((held.rowCount ?? 0) !== 1) failLost(ctx);
  const token = randomUUID();
  const claimed = await pool.query(
    `INSERT INTO ghl_webhook_effect_steps AS s (receipt_id, step_key, state, step_token, lease_expires_at)
     VALUES ($1, $2, 'running', $3, now() + ($4::int * interval '1 second'))
     ON CONFLICT (receipt_id, step_key) DO UPDATE
       SET step_token = EXCLUDED.step_token, lease_expires_at = EXCLUDED.lease_expires_at, attempt_count = s.attempt_count + 1
       WHERE s.state = 'running' AND COALESCE(s.lease_expires_at, to_timestamp(0)) < now()
     RETURNING attempt_count`,
    [ctx.receiptId, stepKey, token, RECEIPT_STEP_LEASE_SECONDS]);
  if (!claimed.rows[0]) {
    const existing = (await pool.query(
      `SELECT state, result FROM ghl_webhook_effect_steps WHERE receipt_id = $1 AND step_key = $2`,
      [ctx.receiptId, stepKey])).rows[0];
    if (existing?.state === "done") return { result: (existing.result?.value ?? null) as T, replayed: true };
    throw new ReceiptStepInFlightError(stepKey);
  }
  let result: T;
  try {
    result = await fn({ stepKey, receiptId: ctx.receiptId, attempt: Number(claimed.rows[0].attempt_count) });
  } catch (error) {
    // A step that failed is released so the sender's retry can run it again; only an uncompleted step is released.
    await pool.query(
      `UPDATE ghl_webhook_effect_steps SET lease_expires_at = now() - interval '1 second'
       WHERE receipt_id = $1 AND step_key = $2 AND step_token = $3 AND state = 'running'`,
      [ctx.receiptId, stepKey, token]).catch(() => undefined);
    throw error;
  }
  const done = await pool.query(
    `UPDATE ghl_webhook_effect_steps SET state = 'done', result = $4::jsonb, completed_at = now(), lease_expires_at = NULL
     WHERE receipt_id = $1 AND step_key = $2 AND step_token = $3 AND state = 'running'`,
    [ctx.receiptId, stepKey, token, JSON.stringify({ value: result ?? null })]);
  if ((done.rowCount ?? 0) !== 1) throw new ReceiptClaimLostError();
  return { result, replayed: false };
}

/** Local database effect: the step completes in the same transaction as the effect (exactly once). */
export async function runReceiptTxStep<T>(
  stepKey: string, fn: (tx: DbTx) => Promise<T>,
): Promise<ReceiptStepResult<T>> {
  const ctx = receiptStepContext.getStore();
  if (!ctx) return { result: await db.transaction(tx => fn(tx)), replayed: false };
  return db.transaction(async tx => {
    if (ctx.lost) throw new ReceiptClaimLostError();
    const held = await tx.execute(sql`SELECT 1 FROM ghl_provider_event_receipts
      WHERE id = ${ctx.receiptId}::uuid AND claim_token = ${ctx.claimToken}::uuid AND state = 'claimed'
        AND lease_expires_at > now()`);
    if (held.rows.length !== 1) failLost(ctx);
    await tx.execute(sql`INSERT INTO ghl_webhook_effect_steps (receipt_id, step_key, state)
      VALUES (${ctx.receiptId}::uuid, ${stepKey}, 'running') ON CONFLICT (receipt_id, step_key) DO NOTHING`);
    const row = (await tx.execute(sql`SELECT state, result FROM ghl_webhook_effect_steps
      WHERE receipt_id = ${ctx.receiptId}::uuid AND step_key = ${stepKey} FOR UPDATE`)).rows[0] as
      { state: string; result: { value?: unknown } | null } | undefined;
    if (row?.state === "done") return { result: (row.result?.value ?? null) as T, replayed: true };
    const result = await fn(tx);
    await tx.execute(sql`UPDATE ghl_webhook_effect_steps
      SET state = 'done', result = ${JSON.stringify({ value: result ?? null })}::jsonb, completed_at = now(),
          lease_expires_at = NULL
      WHERE receipt_id = ${ctx.receiptId}::uuid AND step_key = ${stepKey}`);
    return { result, replayed: false };
  });
}
