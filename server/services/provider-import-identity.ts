import {sql} from "drizzle-orm";
import {computeFileHash} from "./import-normalizer";
import {mapProviderCsvRow} from "./provider-import-columns";
import {hashCro03Evidence} from "./cro03/source-staging";

export const RETAINED_IDENTITY_BRIDGE_VERSION="original_row_identity_v1";
const rows=(result:any):any[]=>result?.rows ?? result ?? [];
export async function hasBridgeEvidenceNativeGuard(tx:any):Promise<boolean> {
  const guarded=rows(await tx.execute(sql`SELECT EXISTS (
    SELECT 1 FROM pg_trigger trigger
    JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
    WHERE trigger.tgrelid='public.cro03_source_observations'::regclass
      AND trigger.tgname='cro03_source_observation_immutable' AND trigger.tgtype=27
      AND trigger.tgenabled IN ('O','A') AND NOT trigger.tgisinternal AND trigger.tgqual IS NULL
      AND procedure.proname='cro03_immutable_row_guard'
      AND procedure.pronamespace='public'::regnamespace
      AND md5(procedure.prosrc)='f0c933f2b332d19ec7d51866e2ad5a7b') installed`))[0];
  return guarded?.installed===true;
}
async function assertBridgeEvidenceNativeGuard(tx:any) {
  if(!await hasBridgeEvidenceNativeGuard(tx))
    throw new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING");
}

/** Scalar proof lookup. Raw workbook extraction belongs after bounded selection.
 * The proof lives on the SAME immutable source subject, with no membership,
 * candidate, job, contact or provider operation of its own. */
export function retainedIdentityBridgeSql() {
  return sql`EXISTS (SELECT 1 FROM cro03_source_observations bridge
    WHERE bridge.source_subject_id=observation.source_subject_id
      AND bridge.payload->>'representation'=${RETAINED_IDENTITY_BRIDGE_VERSION}
      AND bridge.payload->>'executionId'=accounting.execution_id::text
      AND bridge.payload->>'sourceRowNumber'=accounting.source_row_number::text
      AND bridge.payload->>'originalObservationId'=observation.id::text
      AND bridge.payload->>'originalPayloadHash'=observation.payload_hash
      AND bridge.payload->>'mappedFingerprint'=observation.payload->>'rowFingerprint'
      AND bridge.payload->>'accountingFingerprint'=accounting.row_fingerprint
      AND accounting.disposition='failed'
      AND accounting.reason_code='RECOVERY_PROVIDER_STAGING_FAILED')`;
}
export function retainedResolvedIdentitySql() {
  return sql`(observation.payload->>'rowFingerprint'=accounting.row_fingerprint
    OR ${retainedIdentityBridgeSql()})`;
}

export async function loadProviderImportIdentity(tx:any,input:{
  executionId:string;sourceRowNumber:number;rawRow:Record<string,string>;
}) {
  const originals=rows(await tx.execute(sql`SELECT observation.id,observation.source_subject_id,
      observation.payload,observation.provenance,observation.payload_hash,
      subject.subject_key,subject.subject_type,subject.source_system,
      accounting.row_fingerprint,accounting.disposition,accounting.reason_code,accounting.diagnostic,
      execution.metadata->'sourceCoordinates'->(${input.sourceRowNumber}-1) coordinate,
      execution.source_payload->(${input.sourceRowNumber}-1) retained_row,
      (SELECT jsonb_build_object('payload',raw.payload,'provenance',raw.provenance,
        'subjectId',raw.source_subject_id,'payloadHash',raw.payload_hash)
        FROM cro03_enrichment_batches raw_batch
        JOIN cro03_batch_memberships raw_member ON raw_member.batch_id=raw_batch.id
        JOIN cro03_source_observations raw ON raw.id=raw_member.source_observation_id
        WHERE raw_batch.idempotency_key IN (
          ${`csv-source-raw-v2:${input.executionId}:${input.sourceRowNumber}`},
          ${`csv-source-raw-v3:${input.executionId}:${input.sourceRowNumber}`})
          AND jsonb_typeof(raw.payload->'rawSourceRow')='object'
        ORDER BY raw_batch.idempotency_key DESC LIMIT 1) original_raw_evidence
    FROM cro03_enrichment_batches batch
    JOIN cro03_batch_memberships member ON member.batch_id=batch.id
    JOIN cro03_source_observations observation ON observation.id=member.source_observation_id
    JOIN cro03_source_subjects subject ON subject.id=observation.source_subject_id
    JOIN import_executions execution ON execution.id=${input.executionId}::uuid
    LEFT JOIN import_row_dispositions accounting ON accounting.execution_id=execution.id
      AND accounting.source_row_number=${input.sourceRowNumber}
    WHERE batch.idempotency_key=${`csv-source:${input.executionId}:${input.sourceRowNumber}`}`));
  if(!originals.length) return null;
  if(originals.length!==1) throw new Error("PROVIDER_IMPORT_ORIGINAL_EVIDENCE_MISMATCH");
  const original=originals[0];
  const rawEvidence=original.original_raw_evidence;
  if(rawEvidence && (
    rawEvidence.subjectId!==original.source_subject_id ||
    rawEvidence.provenance?.importExecutionId!==input.executionId ||
    Number(rawEvidence.provenance?.sourceRowNumber)!==input.sourceRowNumber ||
    Number(rawEvidence.payload?.sourceRowNumber)!==input.sourceRowNumber ||
    rawEvidence.payload?.sourceFormat!==original.payload?.sourceFormat ||
    ![original.payload?.rowFingerprint,original.row_fingerprint].includes(rawEvidence.payload?.rowFingerprint) ||
    hashCro03Evidence(rawEvidence.payload)!==rawEvidence.payloadHash))
    throw new Error("PROVIDER_IMPORT_ORIGINAL_EVIDENCE_MISMATCH");
  const raw=rawEvidence?.payload?.rawSourceRow ?? original.retained_row;
  if(!raw || typeof raw!=="object" || Array.isArray(raw))
    throw new Error("PROVIDER_IMPORT_ORIGINAL_RAW_EVIDENCE_UNAVAILABLE");
  if(hashCro03Evidence(raw)!==hashCro03Evidence(input.rawRow))
    throw new Error("PROVIDER_IMPORT_ORIGINAL_EVIDENCE_MISMATCH");
  const mappedFingerprint=String(original.payload?.rowFingerprint ?? "");
  if(!mappedFingerprint)throw new Error("PROVIDER_IMPORT_ORIGINAL_EVIDENCE_MISMATCH");
  return {...original,mappedFingerprint,
    fingerprint:String(original.row_fingerprint ?? mappedFingerprint),
    bridged:original.row_fingerprint!=null && original.row_fingerprint!==mappedFingerprint,
    rawEvidenceHash:hashCro03Evidence(raw)};
}

/** Prove exact original row/coordinate, not just matching business/email. No
 * arbitrary serialization fallback: if the retained acquisition hash cannot be
 * independently reproduced, this failure class remains explicitly unreachable. */
export function retainedIdentityBridgeProof(identity:any,input:{
  executionId:string;sourceRowNumber:number;rawRow:Record<string,string>;sourceCoordinate?:unknown;
}) {
  if(identity.disposition!=="failed" || identity.reason_code!=="RECOVERY_PROVIDER_STAGING_FAILED"
    || identity.diagnostic?.error!=="CRO03_IDEMPOTENCY_PAYLOAD_MISMATCH"
    || identity.subject_type!=="provider_csv_row"
    || identity.subject_key!==`${input.executionId}:${input.sourceRowNumber}`
    || identity.provenance?.importExecutionId!==input.executionId
    || Number(identity.provenance?.sourceRowNumber)!==input.sourceRowNumber
    || identity.provenance?.rowFingerprint!==identity.mappedFingerprint
    || Number(identity.payload?.sourceRowNumber)!==input.sourceRowNumber
    || identity.payload_hash!==hashCro03Evidence(identity.payload)
    || !["google_maps_outscraper","apollo_lead_list"].includes(identity.payload.sourceFormat)
    || identity.source_system!==(identity.payload.sourceFormat==="google_maps_outscraper" ? "outscraper" : "apollo")
    || hashCro03Evidence(input.rawRow)!==identity.rawEvidenceHash
    || hashCro03Evidence(identity.retained_row)!==identity.rawEvidenceHash
    || (input.sourceCoordinate!==undefined &&
      hashCro03Evidence(input.sourceCoordinate)!==hashCro03Evidence(identity.coordinate ?? null))
    || computeFileHash(Buffer.from(JSON.stringify(identity.retained_row)))!==identity.fingerprint) {
    throw new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_UNPROVED");
  }
  const mapped=mapProviderCsvRow(input.rawRow,identity.payload.sourceFormat);
  // Explicit historical projection aliases; unknown fields are NOT ignored.
  const aliases:Record<string,string>={businessName:"companyName"};
  for(const [key,value] of Object.entries(identity.payload)) {
    if(["sourceFormat","sourceRowNumber","rowFingerprint"].includes(key))continue;
    // The retained legacy Maps projection used businessName and street.
    // Today's address may include the whole formatted address. Prove the old
    // street cell exactly; never substitute either value into the observation.
    const historicalStreet=key==="address" && identity.payload.sourceFormat==="google_maps_outscraper"
      && typeof identity.payload.businessName==="string" && typeof input.rawRow.street==="string"
      && value===input.rawRow.street;
    if(mapped[aliases[key] ?? key]!==value && !historicalStreet)
      throw new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_UNPROVED");
  }
  return {representation:RETAINED_IDENTITY_BRIDGE_VERSION,
    executionId:input.executionId,sourceRowNumber:input.sourceRowNumber,
    originalObservationId:String(identity.id),originalPayloadHash:identity.payload_hash,
    mappedFingerprint:identity.mappedFingerprint,accountingFingerprint:identity.fingerprint,
    rawEvidenceHash:identity.rawEvidenceHash,
    coordinate:identity.coordinate ?? {format:"retained_logical",recordNumber:input.sourceRowNumber},
    coordinatePrecision:identity.coordinate ? "original" : "logical_record_only"};
}

export async function verifyProviderImportIdentity(tx:any,input:{
  executionId:string;sourceRowNumber:number;rawRow:Record<string,string>;sourceCoordinate?:unknown;
},options:{createBridge?:boolean;itemId?:string;claimToken?:string;
  authorityCheck?:(tx:any)=>Promise<void>}={}) {
  const identity=await loadProviderImportIdentity(tx,input);
  if(!identity || !identity.bridged)return identity;
  await assertBridgeEvidenceNativeGuard(tx);
  const proof=retainedIdentityBridgeProof(identity,input);
  const payloadHash=hashCro03Evidence(proof);
  const existing=rows(await tx.execute(sql`SELECT payload,payload_hash FROM cro03_source_observations
    WHERE source_subject_id=${identity.source_subject_id}::uuid
      AND payload->>'representation'=${RETAINED_IDENTITY_BRIDGE_VERSION}`));
  if(existing.length) {
    if(existing.length!==1 || existing[0].payload_hash!==payloadHash
      || hashCro03Evidence(existing[0].payload)!==payloadHash)
      throw new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_DRIFT");
    return {...identity,bridge:proof,bridgeHash:payloadHash};
  }
  if(!options.createBridge)throw new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_REQUIRED");
  if(!options.authorityCheck)throw new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_OWNER_REQUIRED");
  await options.authorityCheck(tx);
  // Caller pins current owner before the original item. Recheck the live NEW
  // token after the row lock, before appending evidence in this transaction.
  const live=rows(await tx.execute(sql`WITH pinned AS MATERIALIZED (
    SELECT item.id,item.lease_expires_at FROM cro03_enrichment_items item
    JOIN cro03_batch_memberships member ON member.id=item.membership_id
    JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
    WHERE item.id=${options.itemId!}::uuid AND item.state='running'
      AND item.current_provider='canonical_local_import' AND item.claim_token=${options.claimToken!}::uuid
      AND member.source_observation_id=${identity.id}::uuid AND batch.purpose='staging_review'
      AND batch.idempotency_key=${`csv-source:${input.executionId}:${input.sourceRowNumber}`}
    FOR UPDATE OF item) SELECT id FROM pinned WHERE lease_expires_at>clock_timestamp()`));
  if(live.length!==1)throw new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_CLAIM_LOST");
  await options.authorityCheck(tx);
  await tx.execute(sql`INSERT INTO cro03_source_observations
    (source_subject_id,observed_at,observed_by_actor_type,observed_by_actor_id,
      provenance,payload,payload_hash,hash_algorithm_version)
    VALUES(${identity.source_subject_id}::uuid,clock_timestamp(),'system','system:canonical-import-recovery',
      ${JSON.stringify({representation:RETAINED_IDENTITY_BRIDGE_VERSION,
        originalObservationId:identity.id,executionId:input.executionId,
        sourceRowNumber:input.sourceRowNumber})}::jsonb,
      ${JSON.stringify(proof)}::jsonb,${payloadHash},'sha256-v1')
    ON CONFLICT(source_subject_id,payload_hash) DO NOTHING`);
  return {...identity,bridge:proof,bridgeHash:payloadHash};
}
