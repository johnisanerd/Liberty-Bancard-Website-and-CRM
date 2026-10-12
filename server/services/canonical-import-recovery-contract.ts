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
    accounting.disposition='failed' AND accounting.reason_code='RECOVERY_PROVIDER_STAGING_FAILED'))`;
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