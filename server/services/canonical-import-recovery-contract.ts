import {sql} from "drizzle-orm";
import {retainedResolvedIdentitySql,verifyProviderImportIdentity} from "./provider-import-identity";

export type CanonicalImportRecoveryClaim={itemId:string;claimToken:string};
// The old qualification predates identity-based shared-mailbox matching.
// Preserve old receipts, but requalify their original items under this contract.
export const CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION="mailbox_business_identity_v2";
/** An original staging infrastructure failure is not an identity/safety denial.
 * Retry only this evidenced failure class, preserving its immutable receipt.
 * Other originally failed imports do not become recoverable by default. */
export function canonicalRecoverableImportAccountingSql() {
  return sql`(accounting.disposition='deferred' OR (
    accounting.disposition='failed' AND accounting.reason_code='RECOVERY_PROVIDER_STAGING_FAILED')
    OR (accounting.disposition IN ('created','matched_noop')
      AND item.state IN ('blocked','running','completed')
      AND ((item.state IN ('blocked','running') AND item.terminal_code IN ('CANONICAL_IMPORT_AMBIGUOUS_ORGANIZATION_MATCH',
        'CANONICAL_IMPORT_INSUFFICIENT_ORGANIZATION_EVIDENCE',
        'CANONICAL_IMPORT_CONTACT_AFFILIATION_HELD','CANONICAL_IMPORT_STABLE_SOURCE_CONFLICT',
        'CANONICAL_IMPORT_BUSINESS_IDENTITY_MISSING')
      AND EXISTS(SELECT 1 FROM audit_logs partial_hold
        WHERE partial_hold.entity_type='cro03_enrichment_item'
          AND partial_hold.entity_key=item.id::text
          AND partial_hold.action='canonical_import_hold_evidence'
          AND partial_hold.details->>'holdEvidenceVersion'='native_revision_bound_v1'
          AND partial_hold.details->>'executionId'=accounting.execution_id::text
          AND partial_hold.details->>'sourceRowNumber'=accounting.source_row_number::text
          AND partial_hold.details->>'rowFingerprint'=accounting.row_fingerprint))
        OR ${canonicalCreatedOriginalRetrySql()})))`;
}
/** Created/matched originals whose only unfinished work is the never-run (or
 * transiently failed) native fulfillment of the SAME original row. This is not
 * a blanket created-row admission and never manufactures hold evidence:
 *  - the initial `STAGING_RECIPE_DISABLED` item is admitted only when its
 *    retained observation fingerprint equals the immutable accounting
 *    fingerprint and the original raw row (raw-v2/v3 observation or the
 *    execution payload) is retained for the same execution/coordinate;
 *  - the two worker-authored retryable codes (a failed attempt's
 *    RETRY_REQUIRED and the capability hold) mutate that terminal code, so they
 *    additionally require this worker's own durable receipt for the SAME
 *    execution/row/fingerprint, written only after the rule above admitted it.
 * Requires `item`, `accounting` and `observation` aliases in scope. */
export function canonicalCreatedOriginalRetrySql() {
  return sql`(observation.payload->>'rowFingerprint'=accounting.row_fingerprint
    AND (EXISTS(SELECT 1 FROM cro03_enrichment_batches raw_batch
        JOIN cro03_batch_memberships raw_member ON raw_member.batch_id=raw_batch.id
        JOIN cro03_source_observations raw_original ON raw_original.id=raw_member.source_observation_id
        WHERE raw_batch.idempotency_key IN (
          'csv-source-raw-v2:'||accounting.execution_id::text||':'||accounting.source_row_number::text,
          'csv-source-raw-v3:'||accounting.execution_id::text||':'||accounting.source_row_number::text)
          AND jsonb_typeof(raw_original.payload->'rawSourceRow')='object')
      OR EXISTS(SELECT 1 FROM import_executions original_execution
        WHERE original_execution.id=accounting.execution_id
          AND jsonb_typeof(original_execution.source_payload->(accounting.source_row_number-1))='object'))
    AND ((item.state IN ('blocked','running') AND item.terminal_code='STAGING_RECIPE_DISABLED')
      OR (item.state IN ('completed','running') AND item.terminal_code='CANONICAL_LOCAL_IMPORT_FULFILLED')
      OR (item.state IN ('blocked','running') AND item.terminal_code IN ('CANONICAL_IMPORT_RECOVERY_RETRY_REQUIRED',
          'CANONICAL_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING')
        AND EXISTS(SELECT 1 FROM audit_logs receipt
          WHERE receipt.entity_type='cro03_enrichment_item' AND receipt.entity_key=item.id::text
            AND receipt.action IN ('canonical_import_row_claimed','canonical_import_capability_opportunity')
            AND receipt.actor_id='system:canonical-import-recovery'
            AND receipt.details->>'executionId'=accounting.execution_id::text
            AND receipt.details->>'sourceRowNumber'=accounting.source_row_number::text
            AND receipt.details->>'rowFingerprint'=accounting.row_fingerprint))))`;
}
export async function hasCanonicalImportRecoveryClaim(tx:any,input:{
  executionId:string;sourceRowNumber:number;rowFingerprint:string;
  recoveryClaim:CanonicalImportRecoveryClaim;
  renew?:boolean;
}):Promise<boolean> {
  // Lock first, evaluate expiry AFTER any lock wait. A heartbeat may only
  // extend its own LIVE claim, never revive an expired or replaced token.
  const pinned=sql`SELECT item.id,item.claim_token,item.lease_expires_at,item.state
    FROM cro03_enrichment_items item
    JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
    JOIN cro03_batch_memberships member ON member.id=item.membership_id
    JOIN cro03_source_observations observation ON observation.id=member.source_observation_id
    JOIN import_executions execution ON execution.id=${input.executionId}::uuid
      AND execution.status='completed'
    JOIN import_row_dispositions accounting ON accounting.execution_id=execution.id
      AND accounting.source_row_number=${input.sourceRowNumber}
      AND accounting.row_fingerprint=${input.rowFingerprint} AND ${canonicalRecoverableImportAccountingSql()}
    WHERE item.id=${input.recoveryClaim.itemId}::uuid
      AND item.claim_token=${input.recoveryClaim.claimToken}::uuid
      AND item.state='running'
      AND item.current_provider='canonical_local_import'
      AND batch.purpose='staging_review'
      AND batch.idempotency_key=${`csv-source:${input.executionId}:${input.sourceRowNumber}`}
       AND ${retainedResolvedIdentitySql()}
    FOR UPDATE OF item`;
  const result=await tx.execute(sql`WITH pinned AS MATERIALIZED (${pinned})
    SELECT pinned.id,COALESCE(raw.original_raw,
      execution.source_payload->(${input.sourceRowNumber}-1)) raw_row
    FROM pinned JOIN import_executions execution ON execution.id=${input.executionId}::uuid
    LEFT JOIN LATERAL (
      SELECT observation.payload->'rawSourceRow' original_raw FROM cro03_enrichment_batches batch
      JOIN cro03_batch_memberships member ON member.batch_id=batch.id
      JOIN cro03_source_observations observation ON observation.id=member.source_observation_id
      WHERE batch.idempotency_key IN (${`csv-source-raw-v2:${input.executionId}:${input.sourceRowNumber}`},
        ${`csv-source-raw-v3:${input.executionId}:${input.sourceRowNumber}`})
        AND jsonb_typeof(observation.payload->'rawSourceRow')='object'
      ORDER BY batch.idempotency_key DESC LIMIT 1
    ) raw ON TRUE
    WHERE pinned.lease_expires_at>clock_timestamp()`);
  const records=result?.rows ?? result ?? [];
  if(records.length!==1)return false;
  const identity=await verifyProviderImportIdentity(tx,{executionId:input.executionId,
    sourceRowNumber:input.sourceRowNumber,rawRow:records[0].raw_row});
  if(!identity || identity.fingerprint!==input.rowFingerprint)return false;
  const renewed=await tx.execute(input.renew ? sql`WITH pinned AS MATERIALIZED (${pinned})
      UPDATE cro03_enrichment_items item SET
        lease_expires_at=clock_timestamp()+INTERVAL '2 minutes'
      FROM pinned WHERE item.id=pinned.id
        AND pinned.lease_expires_at>clock_timestamp()
        AND item.claim_token=${input.recoveryClaim.claimToken}::uuid AND item.state='running'
       RETURNING item.id`
    : sql`WITH pinned AS MATERIALIZED (${pinned})
        SELECT id FROM pinned WHERE lease_expires_at>clock_timestamp()`);
  return (renewed?.rows ?? renewed ?? []).length===1;
}