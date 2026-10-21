/**
 * Bounded recovery for ZeroBounce calls that were dispatched and then ended with an unknown outcome
 * (timeout/transport after dispatch, billing unknown, no definitive receipt).
 *
 * Rule: at most ONE additional authorized attempt per address, ever. The original operation, attempts,
 * observations and billing facts are preserved untouched. A fresh valid/invalid receipt is always reused
 * first (no purchase). The additional attempt is a normal validation attempt under every existing gate
 * (provider controls/pause, DBPR, current recipient selection, bounded 24h attempt count); this module
 * only lifts the held shared-address claim once. A second uncertainty stays held because the address
 * has already used its recovery.
 *
 * Nothing here calls the provider. `preview` is read-only; `authorize` is an explicit, snapshot-bound
 * admin act and is never run implicitly.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { settledAddressOperation } from "./canonical-address-validation";

const rows = (r: any): any[] => r?.rows ?? r ?? [];
export const ZB_RECOVERY_COOLDOWN_HOURS = 24;
export const ZB_RECOVERY_FRESH_RECEIPT_DAYS = 30;

type Executor = { execute(query: any): Promise<any> };

const candidateRows = (executor: Executor) => executor.execute(sql`
  SELECT c.email_token_hash,c.dispatched_at,op.id operation_id,op.state op_state,
    (c.dispatched_at + make_interval(hours => ${ZB_RECOVERY_COOLDOWN_HOURS}) <= clock_timestamp()) cooldown_ready,
    COALESCE((SELECT array_agg(DISTINCT o2.id) FROM provider_operations o2
      WHERE o2.provider='zerobounce' AND (o2.id=op.id OR (o2.target_fingerprint=c.email_token_hash
        AND EXISTS (SELECT 1 FROM provider_attempts a WHERE a.operation_id=o2.id AND a.dispatch_marked_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM provider_observations s WHERE s.operation_id=o2.id
          AND s.email_token_hash=c.email_token_hash AND s.retryable=FALSE AND s.outcome IN ('valid','invalid'))))
    ),ARRAY[op.id]) superseded,
    (SELECT count(*)::int FROM validation_intents vi WHERE vi.normalized_email_token_hash=c.email_token_hash
      AND (vi.state IN ('pending','processing') OR (vi.state='blocked' AND vi.terminal_code='ambiguous_billing'))) open_intents,
    (SELECT count(DISTINCT ct.business_id)::int FROM validation_intents vi JOIN contacts ct ON ct.id=vi.contact_id
      WHERE vi.normalized_email_token_hash=c.email_token_hash
        AND (vi.state IN ('pending','processing') OR (vi.state='blocked' AND vi.terminal_code='ambiguous_billing'))) businesses,
    EXISTS (SELECT 1 FROM provider_observations o WHERE o.provider='zerobounce' AND o.email_token_hash=c.email_token_hash
      AND o.retryable=FALSE AND o.outcome IN ('valid','invalid')
      AND o.observed_at>clock_timestamp()-make_interval(days => ${ZB_RECOVERY_FRESH_RECEIPT_DAYS})) fresh_receipt,
    (SELECT r.state FROM zerobounce_ambiguous_recoveries r WHERE r.email_token_hash=c.email_token_hash) recovery_state
  FROM canonical_address_validation_claims c
  JOIN provider_operations op ON op.id=c.operation_id AND op.provider='zerobounce'
  WHERE c.dispatched_at IS NOT NULL AND c.lease_expires_at<clock_timestamp()
    AND op.provider_usage_status IS DISTINCT FROM 'known'
    AND NOT ${settledAddressOperation}
    AND EXISTS (SELECT 1 FROM validation_intents vi WHERE vi.normalized_email_token_hash=c.email_token_hash
      AND (vi.state IN ('pending','processing') OR (vi.state='blocked' AND vi.terminal_code='ambiguous_billing')))
  ORDER BY c.email_token_hash
`);

const fingerprint = (hashes: string[]) =>
  createHash("sha256").update(["zb-ambiguous-recovery-v1", ...hashes].join("\n")).digest("hex");

export interface AmbiguousRecoveryPreview {
  cooldownHours: number;
  rule: "one_additional_attempt_per_address";
  /** Distinct addresses whose earlier call is held with an unknown outcome and that still have an open need. */
  distinctEligibleAddresses: number;
  /** Addresses that have waited out the cooldown and have no fresh receipt: each may cost one purchase. */
  readyNow: number;
  cooldownPending: number;
  /** Held addresses that already have a fresh definitive receipt: reused, never purchased. */
  freshReceiptReuse: number;
  alreadyAuthorizedOrUsed: number;
  /** Upper bound on additional purchases if every ready address were authorized and re-attempted once. */
  maxAdditionalPurchases: number;
  supersededOperations: number;
  openIntents: number;
  businesses: number;
  byOriginalOperationState: Record<string, number>;
  /** Authorization binds to this: ready addresses plus fresh-receipt addresses (which cost nothing). */
  readyFingerprint: string;
  authorizableAddresses: number;
}

export async function previewAmbiguousRecovery(executor: Executor = db): Promise<AmbiguousRecoveryPreview> {
  const all = rows(await candidateRows(executor));
  const open = all.filter(r => !r.recovery_state);
  const fresh = open.filter(r => r.fresh_receipt);
  const needsPurchase = open.filter(r => !r.fresh_receipt);
  const ready = needsPurchase.filter(r => r.cooldown_ready);
  // Fresh-receipt addresses need no purchase and no cooldown: lifting their held claim lets the ordinary
  // path find and reuse the receipt.
  const authorizable = open.filter(r => r.fresh_receipt || r.cooldown_ready);
  const byState: Record<string, number> = {};
  for (const r of open) byState[r.op_state] = (byState[r.op_state] ?? 0) + 1;
  return {
    cooldownHours: ZB_RECOVERY_COOLDOWN_HOURS, rule: "one_additional_attempt_per_address",
    distinctEligibleAddresses: open.length, readyNow: ready.length,
    cooldownPending: needsPurchase.length - ready.length, freshReceiptReuse: fresh.length,
    alreadyAuthorizedOrUsed: all.length - open.length, maxAdditionalPurchases: needsPurchase.length,
    supersededOperations: new Set(open.flatMap(r => r.superseded)).size,
    openIntents: open.reduce((n, r) => n + Number(r.open_intents), 0),
    businesses: open.reduce((n, r) => n + Number(r.businesses), 0),
    byOriginalOperationState: byState,
    authorizableAddresses: authorizable.length,
    readyFingerprint: fingerprint(authorizable.map(r => String(r.email_token_hash))),
  };
}

export interface AuthorizeAmbiguousRecoveryInput {
  authorizationKey: string;
  expectedAuthorizableAddresses: number;
  expectedReadyFingerprint: string;
  actor?: string;
}

/**
 * Snapshot-bound: succeeds only when the ready set still matches the preview the operator saw. Inserts one
 * recovery row per address (UNIQUE, so repeats are no-ops), reopens only the intents that were blocked
 * with ambiguous billing, and writes the audit row in the same transaction. Performs no provider I/O.
 */
export async function authorizeAmbiguousRecovery(input: AuthorizeAmbiguousRecoveryInput) {
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(input.authorizationKey)) throw new Error("ZB_RECOVERY_AUTHORIZATION_KEY_INVALID");
  return db.transaction(async (tx) => {
    const lock = rows(await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended('zerobounce-ambiguous-recovery-authorize',0)) acquired`))[0];
    if (lock?.acquired !== true) throw new Error("ZB_RECOVERY_AUTHORIZATION_IN_PROGRESS");
    const ready = rows(await candidateRows(tx)).filter(r => !r.recovery_state && (r.fresh_receipt || r.cooldown_ready));
    const hashes = ready.map(r => String(r.email_token_hash));
    if (ready.length !== input.expectedAuthorizableAddresses || fingerprint(hashes) !== input.expectedReadyFingerprint)
      throw new Error("ZB_RECOVERY_PREVIEW_STALE");
    let authorized = 0;
    for (const r of ready) {
      const inserted = rows(await tx.execute(sql`
        INSERT INTO zerobounce_ambiguous_recoveries
          (email_token_hash,superseded_operation_ids,authorization_key,authorized_by,cooldown_until,evidence)
        VALUES (${r.email_token_hash},${sql.raw("ARRAY[")}${sql.join((r.superseded as string[]).map(id => sql`${id}::uuid`), sql`,`)}${sql.raw("]")},
          ${input.authorizationKey},${input.actor ?? null},
          ${r.fresh_receipt ? sql`clock_timestamp()` : sql`${r.dispatched_at}::timestamptz + make_interval(hours => ${ZB_RECOVERY_COOLDOWN_HOURS})`},
          ${JSON.stringify({ freshReceiptReuse: !!r.fresh_receipt, originalOperationId: r.operation_id, originalOperationState: r.op_state,
            originalDispatchedAt: r.dispatched_at, rule: "one_additional_attempt_per_address" })}::jsonb)
        ON CONFLICT (email_token_hash) DO NOTHING RETURNING id`));
      authorized += inserted.length;
    }
    const reopened = hashes.length ? rows(await tx.execute(sql`
      UPDATE validation_intents
         SET state='pending',enqueue_state='deferred',terminal_code=NULL,completed_at=NULL,
             claim_token=NULL,lease_expires_at=NULL,next_attempt_at=NOW(),updated_at=NOW()
       WHERE normalized_email_token_hash IN (${sql.join(hashes.map(h => sql`${h}`), sql`,`)})
         AND state='blocked' AND terminal_code='ambiguous_billing'
       RETURNING id`)).length : 0;
    await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES('zerobounce_ambiguous_recovery_authorized','zerobounce_recovery',${input.authorizationKey},
        ${JSON.stringify({ authorized, intentsReopened: reopened, maxAdditionalPurchases: ready.filter(r => !r.fresh_receipt).length,
          readyFingerprint: input.expectedReadyFingerprint, providerCallsMade: 0 })}::jsonb,
        'user',${input.actor ?? 'system'})`);
    return { authorized, intentsReopened: reopened, providerCallsMade: 0 };
  });
}
