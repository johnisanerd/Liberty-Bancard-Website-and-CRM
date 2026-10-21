import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";

type Executor = { execute(query: any): Promise<any> };
const rows = (result: any): any[] => result?.rows ?? result ?? [];
// A definitive response (including retryable unknown/HTTP failure) is different
// from an unknown network outcome. Retain its billing/attempt facts and allow
// the existing bounded retry policy to work. Never release ambiguous I/O merely
// because an operation's coarse state is "failed".
export const settledAddressOperation = sql`(
  op.provider='zerobounce' AND (
    (op.state='completed' AND EXISTS (
      SELECT 1 FROM provider_observations receipt
       WHERE receipt.operation_id=op.id AND receipt.provider='zerobounce'
         AND receipt.email_token_hash=c.email_token_hash
         AND receipt.retryable=FALSE AND receipt.outcome IN ('valid','invalid')
    ))
    OR (op.state IN ('completed','failed') AND op.provider_usage_status='known'
      AND op.provider_usage_quantity>0 AND op.settled_units>0
      AND EXISTS (SELECT 1 FROM provider_attempts attempt
        WHERE attempt.operation_id=op.id AND attempt.dispatch_marked_at IS NOT NULL
          AND attempt.dispatch_marked_at>=c.dispatched_at AND attempt.completed_at IS NOT NULL
          AND attempt.outcome IN ('completed','retryable_failed'))
      AND EXISTS (SELECT 1 FROM provider_observations receipt
        WHERE receipt.operation_id=op.id AND receipt.provider='zerobounce'
          AND receipt.email_token_hash=c.email_token_hash))
    OR (op.state IN ('completed','failed')
      AND op.sfp_dispatch_receipt->>'schema'='sfp-dispatch-receipt-v1'
      AND op.sfp_dispatch_receipt->>'operationId'=op.id::text
      AND op.sfp_dispatch_receipt->>'outcome' IN ('completed','failed','no_result')
      AND op.sfp_dispatch_receipt->'providerUsage'->>'status'='known'
      AND EXISTS (SELECT 1 FROM provider_attempts attempt
        WHERE attempt.operation_id=op.id
          AND attempt.dispatch_marked_at IS NOT NULL
          AND attempt.dispatch_marked_at=
            (op.sfp_dispatch_receipt->>'dispatchMarkedAt')::timestamptz)
      AND EXISTS (SELECT 1 FROM provider_observations receipt
        WHERE receipt.operation_id=op.id AND receipt.provider='zerobounce'
          AND receipt.email_token_hash=c.email_token_hash))
  )
)`;

export interface AddressValidationClaim {
  emailTokenHash: string;
  claimToken: string;
}

/** Last physical-client guard. A missing context can never purchase validation. */
export async function assertCanonicalAddressDispatchClaim(claim: AddressValidationClaim, operationId: string) {
  assertHash(claim.emailTokenHash);
  const current=rows(await db.execute(sql`SELECT 1
    FROM canonical_address_validation_claims c JOIN provider_operations op ON op.id=c.operation_id
    WHERE c.email_token_hash=${claim.emailTokenHash} AND c.claim_token=${claim.claimToken}::uuid
      AND op.id=${operationId}::uuid AND op.provider='zerobounce' AND op.state='running'
      AND c.dispatched_at IS NOT NULL AND c.lease_expires_at>clock_timestamp()
      AND EXISTS (SELECT 1 FROM provider_attempts a
        WHERE a.operation_id=op.id AND a.dispatch_marked_at IS NOT NULL)
    LIMIT 1`));
  if (!current.length) throw new Error("CANONICAL_ADDRESS_PHYSICAL_DISPATCH_FENCE_LOST");
}

function assertHash(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("CANONICAL_ADDRESS_HASH_INVALID");
}

/**
 * Call ONLY after canonical recipient admission. Neither parsing an address nor
 * claiming it establishes affiliation, program eligibility or send permission.
 * The transaction lock serializes claim acquisition; the persisted fence owns
 * the network interval and survives a worker restart.
 */
export async function claimCanonicalAddressValidation(
  emailTokenHash: string,
  executor: Executor,
): Promise<AddressValidationClaim | null> {
  assertHash(emailTokenHash);
  if (executor === db) throw new Error("CANONICAL_ADDRESS_TRANSACTION_REQUIRED");
  const lock = rows(await executor.execute(sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(
      ${`canonical-address-validation:${emailTokenHash}`},0)) AS acquired
  `))[0];
  if (lock?.acquired !== true) return null;
  // Pre-consolidation workers did not persist the shared address claim. A new
  // owner must not assume a missing claim means an earlier purchase never
  // happened. Keep original operations untouched; uncertain legacy dispatch is
  // held until actual vendor/receipt evidence establishes its outcome.
  const legacyInFlight=rows(await executor.execute(sql`SELECT op.id
    FROM provider_operations op
    WHERE op.provider='zerobounce'
      AND NOT EXISTS(SELECT 1 FROM canonical_address_validation_claims owned
        WHERE owned.operation_id=op.id)
      AND (op.target_fingerprint=${emailTokenHash}
        OR EXISTS(SELECT 1 FROM validation_intents vi WHERE vi.operation_id=op.id
          AND vi.normalized_email_token_hash=${emailTokenHash})
        OR EXISTS(SELECT 1 FROM provider_observations fact WHERE fact.operation_id=op.id
          AND fact.email_token_hash=${emailTokenHash}))
      AND (op.state='running' AND op.lease_expires_at>clock_timestamp()
        OR EXISTS(SELECT 1 FROM provider_attempts a WHERE a.operation_id=op.id
          AND a.dispatch_marked_at IS NOT NULL)
        OR op.state='completed')
      AND NOT EXISTS(SELECT 1 FROM provider_observations settled
        WHERE settled.operation_id=op.id AND settled.email_token_hash=${emailTokenHash}
          AND settled.retryable=FALSE AND settled.outcome IN ('valid','invalid'))
      -- Operations named by this address's one bounded recovery stay as evidence but no longer block it.
      AND NOT EXISTS(SELECT 1 FROM zerobounce_ambiguous_recoveries recovery
        WHERE recovery.email_token_hash=${emailTokenHash} AND recovery.state IN ('authorized','consumed')
          AND op.id=ANY(recovery.superseded_operation_ids))
    LIMIT 1`));
  if (legacyInFlight.length) return null;
  await executor.execute(sql`
    INSERT INTO canonical_address_validation_claims(email_token_hash)
    VALUES(${emailTokenHash}) ON CONFLICT DO NOTHING
  `);
  // Single-use bounded recovery: an authorized, cooled-down recovery turns the held claim of its superseded
  // operations into an ordinary free claim exactly once. The state change and the release are one statement
  // under this address's transaction lock, so workers, contacts and old operations cannot reuse it. The
  // original operation, attempt, observation and billing rows are not touched.
  await executor.execute(sql`
    WITH recovery AS (
      UPDATE zerobounce_ambiguous_recoveries r
         SET state='consumed',consumed_at=clock_timestamp()
       WHERE r.email_token_hash=${emailTokenHash} AND r.state='authorized'
         AND r.cooldown_until<=clock_timestamp()
         AND EXISTS (SELECT 1 FROM canonical_address_validation_claims c
           WHERE c.email_token_hash=r.email_token_hash AND c.dispatched_at IS NOT NULL
             AND c.operation_id=ANY(r.superseded_operation_ids)
             AND c.lease_expires_at<clock_timestamp())
       RETURNING r.email_token_hash
    )
    UPDATE canonical_address_validation_claims c
       SET claim_token=NULL,lease_expires_at=NULL,operation_id=NULL,dispatched_at=NULL,updated_at=clock_timestamp()
      FROM recovery WHERE c.email_token_hash=recovery.email_token_hash
  `);
  const claimToken = randomUUID();
  const claimed = rows(await executor.execute(sql`
    UPDATE canonical_address_validation_claims c
       SET claim_token=${claimToken}::uuid,
           lease_expires_at=clock_timestamp()+INTERVAL '30 minutes',
           operation_id=NULL,dispatched_at=NULL,updated_at=clock_timestamp()
     WHERE c.email_token_hash=${emailTokenHash}
       AND (
         c.claim_token IS NULL
         OR (c.lease_expires_at<clock_timestamp() AND c.dispatched_at IS NULL
           AND (c.operation_id IS NULL OR EXISTS (
             SELECT 1 FROM provider_operations op WHERE op.id=c.operation_id
               AND NOT EXISTS (SELECT 1 FROM provider_attempts attempt
                 WHERE attempt.operation_id=op.id AND attempt.dispatch_marked_at IS NOT NULL)
           )))
         OR EXISTS (
           SELECT 1 FROM provider_operations op WHERE op.id=c.operation_id
              AND ${settledAddressOperation}
         )
       )
    RETURNING email_token_hash
  `));
  if (claimed.length) {
    await executor.execute(sql`
      UPDATE zerobounce_ambiguous_recoveries SET consumed_claim_token=${claimToken}::uuid
       WHERE email_token_hash=${emailTokenHash} AND state='consumed' AND consumed_claim_token IS NULL
    `);
  }
  return claimed.length ? { emailTokenHash, claimToken } : null;
}

/** Attach the ORIGINAL provider operation before marking any physical I/O. */
export async function bindCanonicalAddressOperation(
  claim: AddressValidationClaim, operationId: string, executor: Executor = db,
): Promise<void> {
  const result = rows(await executor.execute(sql`
    UPDATE canonical_address_validation_claims
       SET operation_id=${operationId}::uuid,updated_at=clock_timestamp()
     WHERE email_token_hash=${claim.emailTokenHash}
       AND claim_token=${claim.claimToken}::uuid
       AND lease_expires_at>clock_timestamp() AND dispatched_at IS NULL
       AND (operation_id IS NULL OR operation_id=${operationId}::uuid)
        AND EXISTS (SELECT 1 FROM provider_operations op
          WHERE op.id=${operationId}::uuid AND op.provider='zerobounce'
            AND op.state NOT IN ('completed','failed','blocked','cancelled'))
    RETURNING email_token_hash
  `));
  if (result.length !== 1) throw new Error("CANONICAL_ADDRESS_CLAIM_LOST");
  // Associate the additional attempt's new operation with its one recovery (no-op for ordinary claims).
  await executor.execute(sql`
    UPDATE zerobounce_ambiguous_recoveries SET new_operation_id=${operationId}::uuid
     WHERE email_token_hash=${claim.emailTokenHash} AND state='consumed'
       AND consumed_claim_token=${claim.claimToken}::uuid AND new_operation_id IS NULL
  `);
}

/** Executed in the final provider-dispatch transaction, after source rechecks. */
export async function markCanonicalAddressDispatch(
  claim: AddressValidationClaim, operationId: string, executor: Executor,
): Promise<void> {
  const result = rows(await executor.execute(sql`
    UPDATE canonical_address_validation_claims
       SET dispatched_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE email_token_hash=${claim.emailTokenHash}
       AND claim_token=${claim.claimToken}::uuid AND operation_id=${operationId}::uuid
       AND lease_expires_at>clock_timestamp() AND dispatched_at IS NULL
    RETURNING email_token_hash
  `));
  if (result.length !== 1) throw new Error("CANONICAL_ADDRESS_DISPATCH_FENCE_LOST");
}

/**
 * Release only definitely pre-I/O or durably settled work. An expired lease,
 * exception or unknown vendor response alone is NEVER authorization to spend
 * again. A displaced worker cannot release another worker's claim.
 */
export async function releaseCanonicalAddressValidation(
  claim: AddressValidationClaim, executor: Executor = db,
): Promise<boolean> {
  const result = rows(await executor.execute(sql`
    UPDATE canonical_address_validation_claims c
       SET claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
     WHERE c.email_token_hash=${claim.emailTokenHash}
       AND c.claim_token=${claim.claimToken}::uuid
       AND (
         (c.operation_id IS NULL AND c.dispatched_at IS NULL)
         OR EXISTS (SELECT 1 FROM provider_operations op WHERE op.id=c.operation_id
           AND ((c.dispatched_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM provider_attempts attempt
                WHERE attempt.operation_id=op.id AND attempt.dispatch_marked_at IS NOT NULL))
              OR ${settledAddressOperation}))
       )
    RETURNING email_token_hash
  `));
  return result.length === 1;
}