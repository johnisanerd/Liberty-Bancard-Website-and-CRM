import {randomUUID} from "node:crypto";
import {sql} from "drizzle-orm";
import {db} from "../db";
import {materializeCanonicalProviderImportRow,providerImportEmails} from "./canonical-provider-import";
import {assertSystemLinkDatabaseGuard} from "./commercial-link-authority";
import {claimSfpRuntimeDeploymentOwner,lockCurrentSfpRuntimeOwner,renewSfpRuntimeDeploymentOwner} from "./cro03/sfp-provider-operations";
import {runCanonicalTransaction,boundCanonicalWriteTransaction} from "./canonical-transaction-retry";
import {captureRecoveryFailure,safeDatabaseFailure} from "../lib/lock-trace";
import {CanonicalImportRecoveryFailure,isRecoverableImportRowFailure} from "./canonical-import-recovery-outcomes";
import {startAutomaticImportLockCapture} from "./primary-lock-capture";
import {canonicalRecoverableImportAccountingSql,CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION} from "./canonical-import-recovery-contract";
import {retainedResolvedIdentitySql,verifyProviderImportIdentity,
  loadProviderImportIdentity,hasBridgeEvidenceNativeGuard} from "./provider-import-identity";
export type RecoveryWorkClass="ordinary"|"legacy"|"hold";
export type CanonicalImportReplayScope={executionId:string;sourceRowNumbers:number[]};
const rows=(value:any):any[]=>value?.rows ?? value ?? [];
const MAX_ITEMS_PER_TICK=250;
const MAX_TICK_DURATION_MS=30_000;

export function validateCanonicalImportReplayScope(scope:CanonicalImportReplayScope):void {
  if (!scope || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.executionId)
    || !Array.isArray(scope.sourceRowNumbers) || scope.sourceRowNumbers.length<1
    || scope.sourceRowNumbers.length>MAX_ITEMS_PER_TICK
    || scope.sourceRowNumbers.some(row=>!Number.isSafeInteger(row) || row<1 || row>2_147_483_647)
    || new Set(scope.sourceRowNumbers).size!==scope.sourceRowNumbers.length) {
    throw new Error("CANONICAL_IMPORT_REPLAY_INVALID_SCOPE");
  }
}

/** Fence observation retrieval to the actual membership's indexed ID. Do not
 * let a fingerprint join turn into a scan/de-TOAST of every source observation.
 * Open the execution's original raw JSON only AFTER the ordered one-row claim;
 * it may contain the entire workbook, not just the chosen row. */
export function canonicalImportRecoveryClaimSql(preferred:RecoveryWorkClass="ordinary",
  replay?:CanonicalImportReplayScope) {
  if(replay)validateCanonicalImportReplayScope(replay);
  // Explicit replay changes selection only. The original native claim,
  // accounting, identity, owner and relationship fences still authorize writes.
  // Never rearm items or reopen/replace a completed import execution.
  const scope=replay ? sql`execution.id=${replay.executionId}::uuid
    AND accounting.source_row_number IN (${sql.join(replay.sourceRowNumbers.map(row=>sql`${row}`),sql`,`)})`
    : sql`TRUE`;
  const workClass=sql`CASE WHEN item.state='completed' THEN 'legacy'
    WHEN item.state='blocked' AND item.terminal_code IN (
      'CANONICAL_IMPORT_AMBIGUOUS_ORGANIZATION_MATCH','CANONICAL_IMPORT_INSUFFICIENT_ORGANIZATION_EVIDENCE',
      'CANONICAL_IMPORT_CONTACT_AFFILIATION_HELD','CANONICAL_IMPORT_STABLE_SOURCE_CONFLICT',
      'CANONICAL_IMPORT_BUSINESS_IDENTITY_MISSING') THEN 'hold'
    ELSE 'ordinary' END`;
  return sql`WITH selected_import AS MATERIALIZED (
    SELECT item.id,execution.id execution_id,accounting.source_row_number,
      observation.payload->>'sourceFormat' source_format,
      raw_member.source_observation_id raw_observation_id,${workClass} work_class
    FROM cro03_enrichment_items item
    JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id AND batch.purpose='staging_review'
    JOIN cro03_batch_memberships member ON member.id=item.membership_id
    JOIN LATERAL (
      SELECT original.id,original.source_subject_id,original.payload_hash,original.payload
      FROM cro03_source_observations original
       WHERE original.id=member.source_observation_id OFFSET 0
    ) observation ON TRUE
    JOIN import_row_dispositions accounting ON
      batch.idempotency_key='csv-source:'||accounting.execution_id::text||':'||accounting.source_row_number::text
       AND ${canonicalRecoverableImportAccountingSql()}
      AND (${retainedResolvedIdentitySql()} OR (
        accounting.disposition='failed' AND accounting.reason_code='RECOVERY_PROVIDER_STAGING_FAILED'
        AND accounting.diagnostic->>'error'='CRO03_IDEMPOTENCY_PAYLOAD_MISMATCH'))
    JOIN import_executions execution ON execution.id=accounting.execution_id AND execution.status='completed'
    LEFT JOIN LATERAL (
      SELECT raw_member.source_observation_id FROM cro03_enrichment_batches raw_batch
      JOIN cro03_batch_memberships raw_member ON raw_member.batch_id=raw_batch.id
      WHERE raw_batch.idempotency_key IN (
        'csv-source-raw-v2:'||execution.id::text||':'||accounting.source_row_number::text,
        'csv-source-raw-v3:'||execution.id::text||':'||accounting.source_row_number::text)
      ORDER BY raw_batch.idempotency_key DESC LIMIT 1
    ) raw_member ON TRUE
    WHERE observation.payload->>'sourceFormat' IN ('google_maps_outscraper','apollo_lead_list')
      AND ${scope}
      AND ((item.state='blocked' AND (
        item.terminal_code='STAGING_RECIPE_DISABLED' OR item.terminal_code LIKE 'CANONICAL_IMPORT_%'))
        OR (item.state='running' AND item.current_provider='canonical_local_import'
           AND item.lease_expires_at<=clock_timestamp())
         OR (item.state='completed' AND item.terminal_code='CANONICAL_LOCAL_IMPORT_FULFILLED'
            AND (${!!replay}::boolean OR NOT EXISTS (SELECT 1 FROM audit_logs fulfillment
             WHERE fulfillment.entity_type='cro03_enrichment_item' AND fulfillment.entity_key=item.id::text
               AND fulfillment.action='canonical_import_row_fulfilled'
                AND fulfillment.details->>'qualificationVersion'=${CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION}))))
      AND (${!!replay}::boolean OR item.next_attempt_at<=clock_timestamp())
    ORDER BY CASE WHEN ${workClass}=${preferred} THEN 0 ELSE 1 END,
      item.next_attempt_at,item.id LIMIT 1 FOR UPDATE OF item SKIP LOCKED
  )
  SELECT selected_import.id,selected_import.execution_id,selected_import.source_row_number,
    selected_import.source_format,selected_import.work_class,
    COALESCE(CASE WHEN jsonb_typeof(raw_observation.payload->'rawSourceRow')='object'
      THEN raw_observation.payload->'rawSourceRow' END,
      CASE WHEN jsonb_typeof(execution.source_payload->(selected_import.source_row_number-1))='object'
      THEN execution.source_payload->(selected_import.source_row_number-1) END) raw_row,
    execution.metadata
  FROM selected_import
  JOIN import_executions execution ON execution.id=selected_import.execution_id
  LEFT JOIN cro03_source_observations raw_observation ON raw_observation.id=selected_import.raw_observation_id`;
}

/** Local fulfillment of retained, completed imports through their ORIGINAL
 * source work items. No fabricated import, cohort, approval or provider run. */
export async function processCanonicalImportRecoveryTick(
   budget:{maxItems?:number;maxDurationMs?:number;replay?:CanonicalImportReplayScope}={},
) {
  // These are local execution/fairness bounds, never provider admission limits.
  // Tests and callers may lower them but cannot exceed the production ceiling.
  const maxItems=budget.maxItems ?? MAX_ITEMS_PER_TICK;
  const maxDurationMs=budget.maxDurationMs ?? MAX_TICK_DURATION_MS;
  if (!Number.isInteger(maxItems) || maxItems<1 || maxItems>MAX_ITEMS_PER_TICK
    || !Number.isInteger(maxDurationMs) || maxDurationMs<1 || maxDurationMs>MAX_TICK_DURATION_MS) {
    throw new Error("CANONICAL_IMPORT_RECOVERY_INVALID_TICK_BUDGET");
  }
  if(budget.replay)validateCanonicalImportReplayScope(budget.replay);
   const tickStarted=Date.now();
   let processingStarted:number|null=null;
   let authorityAcquisitionMs=0;
   let fulfilled=0,held=0,attempted=0,failed=0,cleanupFailed=0,abandoned=0;
   let outcome="authority_acquisition_failed";
   let fatalError:unknown;
   try {
  // Observation is independent, read-only and never awaited by recovery.
  startAutomaticImportLockCapture();
   let owner=await runCanonicalTransaction("import_owner_claim",()=>
     claimSfpRuntimeDeploymentOwner({boundTransaction:boundCanonicalWriteTransaction}));
   // A healthy matching lease is observed, not renewed. Only a lease too close
   // to expiry for this processing window needs the separate short renewal.
   // Renewal must still match the snapshot token/epoch and a LIVE lease.
   if (owner.leaseRemainingMs!==undefined && owner.leaseRemainingMs<=maxDurationMs+10_000) {
     owner=await runCanonicalTransaction("import_owner_claim",()=>renewSfpRuntimeDeploymentOwner({
       expectedOwner:owner,boundTransaction:boundCanonicalWriteTransaction}));
   }
   const remainingReplayRows=new Set(budget.replay?.sourceRowNumbers ?? []);
   const rowOutcomes:Array<{sourceRowNumber:number;itemId:string;
     outcome:"fulfilled"|"held"|"failed"|"original_unavailable"|"capability_blocked"}>=[];
   authorityAcquisitionMs=Date.now()-tickStarted;
   processingStarted=Date.now();
   const deadline=processingStarted+maxDurationMs;
   outcome="row_processing_failed";
  const ownerAuthorityCheck=async(tx:any)=>{
    await boundCanonicalWriteTransaction(tx);
    const live=await lockCurrentSfpRuntimeOwner(tx);
    if (live.ownerEpoch!==owner.ownerEpoch || live.ownerToken!==owner.ownerToken)
      throw new Error("CANONICAL_IMPORT_RECOVERY_RUNTIME_OWNER_CHANGED");
    await assertSystemLinkDatabaseGuard(tx,{prepared:true});
  };
  // Missing-original accounting shares the bounded row claim below. Never run
  // a backlog-wide UPDATE while holding the singleton runtime-owner fence.
  // Mapped observations still cannot substitute for an original raw row.
  for (let index=0;index<maxItems && Date.now()<deadline;index++) {
     if(budget.replay && remainingReplayRows.size===0)break;
    const token=randomUUID();
    const candidate=await runCanonicalTransaction("import_cursor_claim",()=>db.transaction(async tx=>{
      await ownerAuthorityCheck(tx);
       // Durable round-robin survives short ticks and restarts. Only a committed
       // original-item claim advances the lane, not a failed/empty cursor read.
       const last=rows(await tx.execute(sql`SELECT details->>'workClass' work_class FROM audit_logs
         WHERE action IN ('canonical_import_row_claimed','canonical_import_capability_opportunity')
           AND actor_id='system:canonical-import-recovery'
         ORDER BY id DESC LIMIT 1`))[0]?.work_class;
       const preferred:RecoveryWorkClass=last==="ordinary" ? "legacy" : last==="legacy" ? "hold" : "ordinary";
         const selected=rows(await tx.execute(canonicalImportRecoveryClaimSql(preferred,
           budget.replay ? {...budget.replay,sourceRowNumbers:[...remainingReplayRows]} : undefined)))[0];
      if (!selected) return null;
      if (selected.raw_row == null) {
        await tx.execute(sql`UPDATE cro03_enrichment_items
          SET terminal_code='CANONICAL_IMPORT_ORIGINAL_RAW_UNAVAILABLE',state='blocked',
            claim_token=NULL,lease_expires_at=NULL,current_provider=NULL,
             next_attempt_at=clock_timestamp()+INTERVAL '1 hour',
            updated_at=clock_timestamp()
          WHERE id=${String(selected.id)}::uuid`);
        return {...selected,originalUnavailable:true};
      }
      const retainedIdentity=await loadProviderImportIdentity(tx,{executionId:String(selected.execution_id),
        sourceRowNumber:Number(selected.source_row_number),rawRow:selected.raw_row});
      if(!retainedIdentity)throw new Error("PROVIDER_IMPORT_ORIGINAL_EVIDENCE_MISMATCH");
      // Inspect the specific capability before creating a lease or a bridge.
      // Known missing capability commits an honest hold and a fairness opportunity;
      // no authority/identity/unknown-commit failure is caught or reclassified.
      if(retainedIdentity.bridged && !await hasBridgeEvidenceNativeGuard(tx)) {
        await ownerAuthorityCheck(tx);
        await tx.execute(sql`UPDATE cro03_enrichment_items SET state='blocked',
          terminal_code='CANONICAL_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING',
          claim_token=NULL,lease_expires_at=NULL,current_provider=NULL,completed_at=NULL,
          next_attempt_at=clock_timestamp()+INTERVAL '1 minute',updated_at=clock_timestamp()
          WHERE id=${String(selected.id)}::uuid`);
        await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
          VALUES('canonical_import_capability_opportunity','cro03_enrichment_item',${String(selected.id)},
            ${JSON.stringify({executionId:selected.execution_id,sourceRowNumber:selected.source_row_number,
              workClass:selected.work_class,rowFingerprint:retainedIdentity.fingerprint,
              ...(budget.replay ? {explicitReplay:true} : {}),
              outcome:"blocked_source_capability",reasonCode:"PROVIDER_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING"})}::jsonb,
            'system','system:canonical-import-recovery')`);
        return {...selected,capabilityBlocked:true};
      }
      await tx.execute(sql`UPDATE cro03_enrichment_items SET state='running',
        current_provider='canonical_local_import',claim_token=${token}::uuid,
        lease_expires_at=clock_timestamp()+INTERVAL '2 minutes',execution_fence=execution_fence+1,
        attempt_count=attempt_count+1,next_attempt_at=clock_timestamp()+INTERVAL '5 minutes',
        completed_at=NULL,updated_at=clock_timestamp() WHERE id=${String(selected.id)}::uuid`);
       const identity=await verifyProviderImportIdentity(tx,{executionId:String(selected.execution_id),
         sourceRowNumber:Number(selected.source_row_number),rawRow:selected.raw_row},
         {createBridge:true,itemId:String(selected.id),claimToken:token,authorityCheck:ownerAuthorityCheck});
       if(!identity)throw new Error("PROVIDER_IMPORT_ORIGINAL_EVIDENCE_MISMATCH");
       await ownerAuthorityCheck(tx);
       await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
         VALUES('canonical_import_row_claimed','cro03_enrichment_item',${String(selected.id)},
           ${JSON.stringify({executionId:selected.execution_id,sourceRowNumber:selected.source_row_number,
              workClass:selected.work_class,rowFingerprint:identity.fingerprint,
              ...(budget.replay ? {explicitReplay:true} : {}),
             bridgeHash:identity.bridgeHash ?? null})}::jsonb,'system','system:canonical-import-recovery')`);
      return selected;
    }));
    if (!candidate) break;
     attempted++;
     remainingReplayRows.delete(Number(candidate.source_row_number));
     const rowReference={sourceRowNumber:Number(candidate.source_row_number),itemId:String(candidate.id)};
     if (candidate.originalUnavailable || candidate.capabilityBlocked) {
       held++;
       rowOutcomes.push({...rowReference,outcome:candidate.originalUnavailable?"original_unavailable":"capability_blocked"});
       continue;
     }
    try {
      const result=await materializeCanonicalProviderImportRow({
        executionId:String(candidate.execution_id),sourceRowNumber:Number(candidate.source_row_number),
        sourceFormat:String(candidate.source_format),rawRow:candidate.raw_row,
        actorId:"system:canonical-import-recovery",
        recoveryClaim:{itemId:String(candidate.id),claimToken:token},ownerAuthorityCheck,
        sourceCoordinate:candidate.metadata?.sourceCoordinates?.[Number(candidate.source_row_number)-1],
        fileName:candidate.metadata?.fileName,
      });
       if ("fulfillmentState" in result && result.fulfillmentState==="held") {
         held++;rowOutcomes.push({...rowReference,outcome:"held"});continue;
       }
      await runCanonicalTransaction("import_finalize",()=>db.transaction(async tx=>{
        await ownerAuthorityCheck(tx);
         // Preserve the materializer's owner -> original item -> graph order.
         // Evaluate claim expiry after this lock wait, before any graph pins.
         const liveItem=rows(await tx.execute(sql`WITH pinned AS MATERIALIZED (
           SELECT id,lease_expires_at FROM cro03_enrichment_items
           WHERE id=${String(candidate.id)}::uuid AND state='running'
             AND claim_token=${token}::uuid FOR UPDATE
         ) SELECT id FROM pinned WHERE lease_expires_at>clock_timestamp()`));
         if (!liveItem.length) throw new Error("CANONICAL_IMPORT_RECOVERY_FINALIZATION_LEASE_LOST");
          const identity=await verifyProviderImportIdentity(tx,{executionId:String(candidate.execution_id),
            sourceRowNumber:Number(candidate.source_row_number),rawRow:candidate.raw_row});
         const business=rows(await tx.execute(sql`SELECT id FROM businesses
           WHERE id=${result.businessId} FOR SHARE`));
         const contacts=result.contactIds.length ? rows(await tx.execute(sql`
           SELECT id,email,business_id FROM contacts
           WHERE id IN (${sql.join(result.contactIds.map(id=>sql`${id}`),sql`,`)}) FOR SHARE`)) : [];
         const expectedEmails=providerImportEmails(candidate.raw_row);
         const actualEmails=contacts.map(contact=>String(contact.email ?? "").trim().toLowerCase()).sort();
         if (business.length!==1 || contacts.length!==expectedEmails.length ||
             JSON.stringify(actualEmails)!==JSON.stringify(expectedEmails) ||
             contacts.some(contact=>Number(contact.business_id)!==result.businessId)) {
           throw new Error("CANONICAL_IMPORT_RECOVERY_FULFILLMENT_EVIDENCE_CHANGED");
         }
        const receipt=rows(await tx.execute(sql`WITH pinned AS MATERIALIZED (
          SELECT id,lease_expires_at FROM cro03_enrichment_items
          WHERE id=${String(candidate.id)}::uuid AND state='running'
            AND claim_token=${token}::uuid FOR UPDATE
        ) UPDATE cro03_enrichment_items item
          SET state='completed',terminal_code='CANONICAL_LOCAL_IMPORT_FULFILLED',
            claim_token=NULL,lease_expires_at=NULL,current_provider=NULL,completed_at=clock_timestamp(),
            updated_at=clock_timestamp()
          FROM pinned WHERE item.id=pinned.id AND item.state='running'
            AND item.claim_token=${token}::uuid AND pinned.lease_expires_at>clock_timestamp() RETURNING item.id`));
        if (!receipt.length) throw new Error("CANONICAL_IMPORT_RECOVERY_FINALIZATION_LEASE_LOST");
        await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
          VALUES('canonical_import_row_fulfilled','cro03_enrichment_item',${String(candidate.id)},
            ${JSON.stringify({executionId:candidate.execution_id,sourceRowNumber:candidate.source_row_number,
              originalDisposition:result.disposition,businessId:result.businessId,contactIds:result.contactIds,
                qualificationVersion:CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION,
                ...(budget.replay ? {explicitReplay:true} : {}),
               rowFingerprint:identity?.fingerprint,bridgeHash:identity?.bridgeHash ?? null,
              paidProviderCalls:0,outboundChanges:0})}::jsonb,'system','system:canonical-import-recovery')`);
      }));
      fulfilled++;
       rowOutcomes.push({...rowReference,outcome:"fulfilled"});
    } catch (error) {
       const failure=await captureRecoveryFailure(error,()=>runCanonicalTransaction("import_failure",()=>db.transaction(async tx=>{
        await ownerAuthorityCheck(tx);
         const released=rows(await tx.execute(sql`UPDATE cro03_enrichment_items SET state='blocked',
          terminal_code='CANONICAL_IMPORT_RECOVERY_RETRY_REQUIRED',claim_token=NULL,lease_expires_at=NULL,
          current_provider=NULL,updated_at=clock_timestamp()
           WHERE id=${String(candidate.id)}::uuid AND state='running' AND claim_token=${token}::uuid
           RETURNING id`));
         return {released:released.length===1};
      })),{executionId:String(candidate.execution_id),itemId:String(candidate.id),
        sourceRowNumber:Number(candidate.source_row_number)});
       failed++;
        rowOutcomes.push({...rowReference,outcome:"failed"});
        if(budget.replay)remainingReplayRows.add(Number(candidate.source_row_number));
       if (failure.cleanupError) cleanupFailed++;
       if (!isRecoverableImportRowFailure(error) ||
           (failure.cleanupError && !isRecoverableImportRowFailure(failure.cleanupError))) {
         throw new CanonicalImportRecoveryFailure(failure);
       }
       // A confirmed row-level abort can yield only after a fresh, bounded
       // authority/database check. Failed cleanup leaves its token untouched:
       // the ordinary expired-claim selector later reclaims it with a NEW token.
       try {
         await runCanonicalTransaction("import_failure",()=>db.transaction(ownerAuthorityCheck));
       } catch (authorityError) {
         const failureToThrow=new CanonicalImportRecoveryFailure(failure);
         Object.assign(failureToThrow,{authorityError});
         throw failureToThrow;
       }
       if (failure.cleanupError) abandoned++;
    }
  }
   const budgetExhausted=attempted>=maxItems || Date.now()>=deadline;
   outcome=fulfilled>0 ? "committed_progress" : failed>0 ? "row_failures_without_fulfillment"
     : held>0 ? "held_without_fulfillment" : budgetExhausted ? "budget_exhausted_without_fulfillment"
     : "no_eligible_rows";
   return {ran:attempted>0,fulfilled,held,attempted,failed,cleanupFailed,abandoned,
     budgetExhausted,outcome,zeroFulfillment:fulfilled===0,authorityAcquisitionMs,
      rowProcessingMs:Date.now()-processingStarted,
      ...(budget.replay ? {replay:{executionId:budget.replay.executionId,rowOutcomes,
        remainingSourceRowNumbers:[...remainingReplayRows],
        scopeAttempted:remainingReplayRows.size===0 && failed===0}} : {})};
   } catch(error) {
     fatalError=error;
     throw error;
   } finally {
     if(processingStarted===null) authorityAcquisitionMs=Date.now()-tickStarted;
     console.warn(JSON.stringify({event:"canonical_import_recovery_tick",outcome,
       fulfilled,held,attempted,failed,cleanupFailed,abandoned,zeroFulfillment:fulfilled===0,
       authorityAcquisitionMs,rowProcessingMs:processingStarted===null ? 0 : Date.now()-processingStarted,
       totalMs:Date.now()-tickStarted,failure:fatalError ? safeDatabaseFailure(fatalError) : null,
        authorityFailure:fatalError instanceof CanonicalImportRecoveryFailure && fatalError.authorityError
          ? safeDatabaseFailure(fatalError.authorityError) : null,
       ts:new Date().toISOString()}));
   }
}