import { pool, db } from "../db";
import { assertSystemLinkDatabaseGuard, assertSfpLinkDatabaseGuard, assertSfpPipelineDatabaseGuard } from "./commercial-link-authority";
import { assertSfpRecipientCapacityDatabaseGuard } from "./cro03/sfp-recipient-capacity";
import { effectiveBusinessVerticalStatusSql } from "@shared/effective-vertical";
import type { CanonicalEnrichmentStatus } from "@shared/canonical-enrichment-status";
import {assertCanonicalPreparationDatabaseGuard} from "./canonical-recipient-preparation";
import {assertCanonicalAddressReceiptContract} from "./canonical-address-receipt-contract";
import {assertSfpProgramDiscoveryContract} from "./cro03/sfp-discovery-scope";

/** Observational projection only. Counts are not enrollment, transport,
 * qualification or completion authority. Failed reads never become zeroes. */
export async function readCanonicalEnrichmentStatus(): Promise<CanonicalEnrichmentStatus> {
  // Missing native prerequisites must remain visible in Settings & Health,
  // not make the whole observational endpoint fail before its guard report.
  const preparationSchemaAvailable=(await pool.query(`SELECT count(*)::int n FROM pg_attribute
    WHERE attrelid='public.cr04_enrollment_intents'::regclass AND NOT attisdropped
      AND attname IN ('program_id','business_id','normalized_email_hash','preparation_state','preparation_snapshot')`)).rows[0].n===5;
  const importOutcomes = (exceptions: boolean) => pool.query(`
    SELECT accounting.execution_id,accounting.source_row_number,accounting.disposition,
      accounting.reason_code,accounting.contact_id,
      CASE WHEN accounting.diagnostic->>'businessId' ~ '^[0-9]+$'
        THEN (accounting.diagnostic->>'businessId')::integer END business_id,
      current_contact.business_id current_business_id,
      source_item.terminal_code fulfillment_state,source_item.next_attempt_at::text next_attempt_at,
      (COALESCE(jsonb_typeof(execution.source_payload->(accounting.source_row_number-1))='object',FALSE)
        OR EXISTS(SELECT 1 FROM cro03_enrichment_batches raw_batch
          JOIN cro03_batch_memberships raw_member ON raw_member.batch_id=raw_batch.id
          JOIN cro03_source_observations original ON original.id=raw_member.source_observation_id
          WHERE raw_batch.idempotency_key IN ('csv-source-raw-v2:'||execution.id::text||':'||accounting.source_row_number::text,
            'csv-source-raw-v3:'||execution.id::text||':'||accounting.source_row_number::text)
            AND jsonb_typeof(original.payload->'rawSourceRow')='object')) original_available,
      accounting.completed_at::text completed_at
    FROM import_row_dispositions accounting JOIN import_executions execution ON execution.id=accounting.execution_id
    LEFT JOIN contacts current_contact ON current_contact.id=accounting.contact_id
    LEFT JOIN LATERAL(
      SELECT item.terminal_code,item.next_attempt_at,item.state
      FROM cro03_enrichment_batches batch JOIN cro03_enrichment_items item ON item.batch_id=batch.id
      WHERE batch.idempotency_key='csv-source:'||execution.id::text||':'||accounting.source_row_number::text
      ORDER BY item.id LIMIT 1
    ) source_item ON TRUE
    ${exceptions ? `WHERE accounting.disposition IN ('deferred','failed','rejected')
      AND source_item.terminal_code IS DISTINCT FROM 'CANONICAL_LOCAL_IMPORT_FULFILLED'` : ""}
    ORDER BY accounting.completed_at DESC,accounting.id DESC LIMIT 25`);
  const [contacts, businesses, preparations, imports, providers, nativeContracts, preparationCursor, validationQueue,
    recentImportOutcomes, importExceptions, projection, registryProjection, registryRecent] = await Promise.all([
    pool.query(`SELECT count(*)::int total,
      count(*) FILTER (WHERE email_status='valid')::int valid,
      count(*) FILTER (WHERE email_status IS NULL OR email_status IN ('active','unvalidated'))::int unvalidated,
      count(*) FILTER (WHERE do_not_contact OR do_not_auto_contact OR opted_out_email
        OR email_status IN ('bounced','invalid','opted_out','unsafe'))::int blocked
      FROM contacts WHERE record_class='production' AND archived_at IS NULL`),
    pool.query(`SELECT count(*)::int total,
      count(*) FILTER (WHERE vertical_status='mapped')::int mapped,
      count(*) FILTER (WHERE vertical_status='excluded')::int excluded,
      count(*) FILTER (WHERE vertical_status NOT IN ('mapped','excluded'))::int unresolved
      FROM (SELECT ${effectiveBusinessVerticalStatusSql("b")} vertical_status
        FROM businesses b WHERE b.record_class='canonical') current_businesses`),
    pool.query(`SELECT state,sum(n)::int n FROM (
      SELECT 'historical_sfp:'||state AS state,count(*)::int n
        FROM sfp_campaign_staging_intents GROUP BY state
      ${preparationSchemaAvailable ? `UNION ALL
      SELECT preparation_state AS state,count(*)::int n FROM cr04_enrollment_intents
        WHERE program_id IS NOT NULL GROUP BY preparation_state` : ""}
    ) preparation_states GROUP BY state`),
    pool.query("SELECT status AS state,count(*)::int n FROM import_executions GROUP BY status"),
    pool.query("SELECT state,count(*)::int n FROM provider_operations GROUP BY state"),
    Promise.all([
      assertSystemLinkDatabaseGuard(db), assertSfpLinkDatabaseGuard(db),
      assertSfpPipelineDatabaseGuard(db), assertSfpRecipientCapacityDatabaseGuard(db),
      assertCanonicalPreparationDatabaseGuard(db),assertCanonicalAddressReceiptContract(db),
      assertSfpProgramDiscoveryContract(db),
    ]).then(() => ({
      state: "verified" as const, reason: null,
    })).catch(error => ({
      state: "blocked" as const,
      reason: /DATABASE_GUARD_MISSING|^CANONICAL_(?:ADDRESS|PREPARATION|DISCOVERY)_NATIVE_CONTRACT_REQUIRED$/.test(String(error?.message))
        ? String(error.message).slice(0, 250) : "Native contract verification unavailable",
    })),
    pool.query("SELECT value FROM system_settings WHERE key='canonical_recipient_preparation_cursor'"),
    preparationSchemaAvailable ? pool.query(`SELECT count(*) FILTER(WHERE state='pending')::int pending,
      count(*) FILTER(WHERE state='processing')::int processing,
      min(created_at) FILTER(WHERE state='pending')::text oldest_pending_at
      FROM validation_intents WHERE state IN ('pending','processing')
        AND EXISTS(SELECT 1 FROM cr04_enrollment_intents prepared
          WHERE prepared.contact_id=validation_intents.contact_id
            AND prepared.normalized_email_hash=validation_intents.normalized_email_token_hash
             AND prepared.preparation_state IN ('pending_validation','ready_held'))`)
      : Promise.resolve({rows:[{pending:null,processing:null,oldest_pending_at:null}]}),
    importOutcomes(false),
    importOutcomes(true),
    pool.query("SELECT value FROM system_settings WHERE key='crm_effective_vertical_projection_v1'"),
    pool.query(`SELECT count(*)::int total,
      count(*) FILTER(WHERE item.terminal_code='CANONICAL_REGISTRY_ENTITY_FULFILLED')::int fulfilled,
      count(*) FILTER(WHERE item.state='blocked' AND item.terminal_code LIKE 'CANONICAL_REGISTRY_%')::int held,
      count(*) FILTER(WHERE item.state='running')::int processing,
      count(*) FILTER(WHERE item.state='blocked' AND item.terminal_code='STAGING_RECIPE_DISABLED'
        AND run.status='completed' AND subject.tombstoned_at IS NULL)::int pending,
      count(*) FILTER(WHERE run.status<>'completed' OR subject.tombstoned_at IS NOT NULL)::int source_unavailable,
      min(item.created_at) FILTER(WHERE item.state='blocked' AND item.terminal_code='STAGING_RECIPE_DISABLED'
        AND run.status='completed' AND subject.tombstoned_at IS NULL)::text oldest_pending_at
      FROM cro03_enrichment_items item JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
      JOIN cro03_batch_memberships member ON member.id=item.membership_id
      JOIN cro03_source_subjects subject ON subject.id=member.source_subject_id
      JOIN source_import_runs run ON
        batch.idempotency_key LIKE 'source-registry:'||run.adapter_key||':'||run.id::text||':offset-%'
      WHERE batch.purpose='staging_review' AND batch.idempotency_key LIKE 'source-registry:%'`),
    pool.query(`SELECT item.id item_id,run.id import_run_id,subject.source_system,item.state,
        CASE WHEN run.status<>'completed' THEN 'SOURCE_IMPORT_'||upper(run.status)
          WHEN subject.tombstoned_at IS NOT NULL THEN 'SOURCE_RECORD_RETIRED'
          ELSE item.terminal_code END terminal_code,
        canonical.business_id,item.next_attempt_at::text next_attempt_at
      FROM cro03_enrichment_items item JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
      JOIN cro03_batch_memberships member ON member.id=item.membership_id
      JOIN cro03_source_subjects subject ON subject.id=member.source_subject_id
      JOIN source_import_runs run ON
        batch.idempotency_key LIKE 'source-registry:'||run.adapter_key||':'||run.id::text||':offset-%'
      LEFT JOIN canonical_source_links canonical ON canonical.source_system=subject.source_system
        AND canonical.source_type='public_registry' AND canonical.stable_key=subject.subject_key
      WHERE batch.purpose='staging_review' AND batch.idempotency_key LIKE 'source-registry:%'
      ORDER BY item.updated_at DESC,item.id DESC LIMIT 25`),
  ]);
  const outcomeRows=(result:{rows:any[]})=>result.rows.map(row=>({
    executionId:String(row.execution_id),sourceRowNumber:Number(row.source_row_number),
    disposition:String(row.disposition),reasonCode:String(row.reason_code),
    contactId:row.contact_id == null ? null : Number(row.contact_id),
    businessId:row.business_id == null ? null : Number(row.business_id),
    currentBusinessId:row.current_business_id == null ? null : Number(row.current_business_id),
    fulfillmentState:row.fulfillment_state ?? null,nextAttemptAt:row.next_attempt_at ?? null,
    originalAvailable:row.original_available === true,completedAt:String(row.completed_at),
  }));
  const states = (result: { rows: any[] }) => ({
    total: result.rows.reduce((total, row) => total + Number(row.n), 0),
    byState: Object.fromEntries(result.rows.map(row => [String(row.state), Number(row.n)])),
  });
  const coverage=projection.rows[0]?.value?.coverageVersion===2 ? projection.rows[0].value : null;
  return {
    observedAt: new Date().toISOString(), scope: "production_records_with_historical_work",
    contacts: contacts.rows[0], businesses: businesses.rows[0],
    preparations: {...states(preparations),currentAvailable:preparationSchemaAvailable}, imports: states(imports), providers: states(providers),
    recentImportOutcomes:outcomeRows(recentImportOutcomes),importExceptions:outcomeRows(importExceptions),
    registryProjection:{
      total:Number(registryProjection.rows[0].total),fulfilled:Number(registryProjection.rows[0].fulfilled),
      held:Number(registryProjection.rows[0].held),processing:Number(registryProjection.rows[0].processing),
      pending:Number(registryProjection.rows[0].pending),oldestPendingAt:registryProjection.rows[0].oldest_pending_at,
      sourceUnavailable:Number(registryProjection.rows[0].source_unavailable),
      recent:registryRecent.rows.map(row=>({itemId:String(row.item_id),importRunId:String(row.import_run_id),
        sourceSystem:String(row.source_system),state:String(row.state),reason:row.terminal_code ?? null,
        businessId:row.business_id == null ? null : Number(row.business_id),nextAttemptAt:row.next_attempt_at ?? null})),
    },
    nativeContracts,
    automaticProgress:{
      projection:{
        observed:coverage!=null,scope:"all_record_classes",verifiedCycles:Number(coverage?.verifiedCycles ?? 0),
        businessCursor:Number(coverage?.businessCursor ?? 0),contactCursor:Number(coverage?.contactCursor ?? 0),
        populationBusinesses:Number(coverage?.populationBusinesses ?? 0),
        populationContacts:Number(coverage?.populationContacts ?? 0),
        businessesScanned:Number(coverage?.businessesScanned ?? 0),contactsScanned:Number(coverage?.contactsScanned ?? 0),
        lastCompletedCoverage:coverage?.lastCompletedCoverage ?? null,
      },
      preparation:{
        observed:preparationCursor.rows.length>0,
        cycles:Number(preparationCursor.rows[0]?.value?.cycles ?? 0),
        afterContactId:Number(preparationCursor.rows[0]?.value?.afterContactId ?? 0),
        scanned:Number(preparationCursor.rows[0]?.value?.scanned ?? 0),
        prepared:Number(preparationCursor.rows[0]?.value?.prepared ?? 0),
        held:Number(preparationCursor.rows[0]?.value?.held ?? 0),
        lastCycleAt:preparationCursor.rows[0]?.value?.lastCycleAt ?? null,
        reasons:preparationCursor.rows[0]?.value?.reasons ?? {},
        priority:preparationCursor.rows[0]?.value?.priority ?? null,
      },
      validation:{available:preparationSchemaAvailable,
        pending:preparationSchemaAvailable ? Number(validationQueue.rows[0].pending) : null,
        processing:preparationSchemaAvailable ? Number(validationQueue.rows[0].processing) : null,
        oldestPendingAt:validationQueue.rows[0].oldest_pending_at},
    },
    limitations: [
      "Contact, business, import, provider and preparation totals describe different populations.",
      "Valid email status alone does not establish current recipient eligibility or sending permission.",
      "Native contracts verify database safeguards, not deployed progression or full completion.",
      "Provider operation state and recorded usage do not prove vendor credits or invoices.",
      "Preparation, import and provider state totals include historical work; they are not a production-only cohort.",
      "Automatic preparation counters are cumulative pass transitions, not distinct qualified contacts; local cycle receipts do not certify deployed scheduled progression.",
      "Projection coverage includes all record classes in a frozen ID range; it does not prove identity linking, qualification or paid queue admission.",
      "Preparation-linked validation intent counts do not prove fresh dispatch eligibility; current canonical selection is rechecked before provider I/O.",
      "Priority preparation has a separate bounded cursor for currently bound recipients; its cycles and transitions are not full-population coverage or distinct recipients.",
    ],
  };
}