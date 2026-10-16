import crypto from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {runCanonicalTransaction} from "./canonical-transaction-retry";
import { canonicalAddressReceiptNativeFingerprint, currentReviewedLinkRoutineFingerprint } from "./canonical-address-receipt-contract";
import {
  lockCommercialGraphMembershipSets,
  lockCommercialGraphNodes,
  type CommercialGraphNode,
} from "./commercial-graph-locks";

export type LinkDecision = "verified" | "missing" | "conflicted" | "legacy_unknown" | "rejected";
export type MappingDecision = Exclude<LinkDecision, "missing">;

export class CommercialRevisionConflict extends Error {
  readonly code = "COMMERCIAL_REVISION_CONFLICT";
  constructor() { super("Commercial link revision is stale"); }
}

// Pinned from the exact 0312_contact_business_system_links.sql PL/pgSQL
// function bodies after installation on the migration-certification
// PostgreSQL version. Keep these as code-owned constants: production readiness
// never depends on reading migration files from the running filesystem. These
// exact body hashes intentionally fail closed even for formatting-only rewrites;
// update them only from a reviewed, freshly migrated schema.
const SYSTEM_LINK_EVIDENCE_TRIGGER_BODY_MD5 = "0851a20c34b3ce424364b5c3fc6e556b";

// Fingerprints of PostgreSQL's canonical pg_get_expr(conbin, conrelid, true)
// output for the 0309 typed-contact source contracts. Whitespace is folded and
// case normalized before hashing, so DDL formatting-only changes are accepted;
// semantic changes and server deparser changes fail closed for review.
const SFP_ELIGIBILITY_CONTACT_CHECK_MD5 = "e83217cf6cea8fb0a75857ac2100d4e3";
const SFP_STAGING_CONTACT_CHECK_MD5 = "ddb906e4ac5e57a0700b1ea776bf8ed6";
const SFP_LINK_EVIDENCE_TRIGGER_BODY_MD5 = "21f201cf1e11660637a43dc6f2176b29";
const FIRST_PARTY_LINK_EVIDENCE_TRIGGER_BODY_MD5 = "62110488204b950f599a4defd7483104";
const SFP_RECIPIENT_TRANSITION_TRIGGER_BODY_MD5 = "e5315a402bb4f800ae1240a547c163e4";
const SFP_RECIPIENT_ALIAS_TRIGGER_BODY_MD5 = "bcbaf3c57b9cc79abf0574e73c17cb9e";
const SFP_BRIDGE_HOLD_TRIGGER_BODY_MD5 = "9e57bf5845f626fc2e58bfdc6849d3a4";

export async function assertSystemLinkDatabaseGuard(executor: any,options:{prepared?:boolean}={}) {
  const nativeContract = sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='public' AND c.relname='contact_business_link_decisions'
        AND t.tgname='contact_business_link_review_contract'
        AND t.tgenabled IN ('O','A')
        AND NOT t.tgisinternal AND t.tgqual IS NULL
        AND t.tgtype=23
        AND p.proname='enforce_reviewed_contact_business_link'
        AND p.pronamespace='public'::regnamespace
        AND ${canonicalAddressReceiptNativeFingerprint(sql`p.prosrc`)}
    ) AS installed,
    EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='public' AND c.relname='contact_business_system_link_evidence'
        AND t.tgname='contact_business_system_link_evidence_append_only'
        AND t.tgenabled IN ('O','A')
        AND NOT t.tgisinternal AND t.tgqual IS NULL
        AND t.tgtype=27
        AND p.proname='cro02_system_link_evidence_append_only'
        AND p.pronamespace='public'::regnamespace
        AND md5(p.prosrc)=${SYSTEM_LINK_EVIDENCE_TRIGGER_BODY_MD5}
    ) AS immutable_evidence_trigger,
    to_regclass('public.contact_business_system_link_evidence') IS NOT NULL AS evidence_table,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='contact_business_link_decisions'
        AND column_name='system_evidence_id' AND data_type='uuid'
    ) AS evidence_column,
    (SELECT bool_and(EXISTS (
        SELECT 1
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid=con.conrelid
          JOIN pg_namespace ns ON ns.oid=rel.relnamespace
          JOIN pg_attribute local_col ON local_col.attrelid=con.conrelid
                                    AND local_col.attnum=con.conkey[1]
          JOIN pg_class referenced_rel ON referenced_rel.oid=con.confrelid
          JOIN pg_namespace referenced_ns ON referenced_ns.oid=referenced_rel.relnamespace
          JOIN pg_attribute referenced_col ON referenced_col.attrelid=con.confrelid
                                          AND referenced_col.attnum=con.confkey[1]
         WHERE ns.nspname='public' AND rel.relname=expected.table_name
           AND con.conname=expected.constraint_name AND con.contype='f'
           AND con.convalidated AND con.confdeltype='r'
           AND array_length(con.conkey,1)=1 AND array_length(con.confkey,1)=1
           AND local_col.attname=expected.column_name
           AND referenced_ns.nspname='public'
           AND referenced_rel.relname=expected.referenced_table
           AND referenced_col.attname=expected.referenced_column
      ))
       FROM (VALUES
         ('contact_business_system_link_evidence','contact_business_system_link_evidence_contact_id_fkey','contact_id','contacts','id'),
         ('contact_business_system_link_evidence','contact_business_system_link_evidence_business_id_fkey','business_id','businesses','id'),
         ('contact_business_system_link_evidence','contact_business_system_link_evidence_source_link_id_fkey','source_link_id','canonical_source_links','id'),
         ('contact_business_system_link_evidence','contact_business_system_link_evidence_source_entity_id_fkey','source_entity_id','sunbiz_entities','id'),
         ('contact_business_link_decisions','contact_business_link_decisions_system_evidence_id_fkey','system_evidence_id','contact_business_system_link_evidence','id')
       ) AS expected(table_name,constraint_name,column_name,referenced_table,referenced_column)
    ) AS evidence_foreign_keys,
    (SELECT COUNT(*) = 2 AND bool_and(
        CASE rel.relname
          WHEN 'sfp_outreach_eligibility' THEN
            md5(lower(regexp_replace(btrim(pg_get_expr(con.conbin,con.conrelid,true)),
                                     '[[:space:]]+',' ','g')))=${SFP_ELIGIBILITY_CONTACT_CHECK_MD5}
          WHEN 'sfp_campaign_staging_intents' THEN
            md5(lower(regexp_replace(btrim(pg_get_expr(con.conbin,con.conrelid,true)),
                                     '[[:space:]]+',' ','g')))=${SFP_STAGING_CONTACT_CHECK_MD5}
          ELSE false
        END
      )
       FROM pg_constraint con
      JOIN pg_class rel ON rel.oid=con.conrelid
      JOIN pg_namespace ns ON ns.oid=rel.relnamespace
      WHERE (rel.relname,con.conname) IN (
        ('sfp_outreach_eligibility','sfp_outreach_eligibility_source_ref_one_of_chk'),
        ('sfp_campaign_staging_intents','sfp_campaign_staging_intents_source_ref_one_of_chk')
      )
       AND ns.nspname='public' AND con.contype='c' AND con.convalidated
       AND con.conislocal AND con.coninhcount=0
    ) AS sfp_contact_checks
    ,(SELECT count(*)=4 AND bool_and(md5(p.prosrc)=expected.body_hash)
      FROM (VALUES
        ('crm_identity_name','e45d1eb858ef5e5f9d94b8b9aa965c49'),
        ('crm_identity_domain','d0af69048a9c4845df1589219a522629'),
        ('crm_automatic_relationship_reasons','3ee7b8798d9dce2f2c6e92ef91c51c7e'),
        ('crm_source_family_relationship_reasons','4a6980a53fd86d9017679dbca80b2a49')
      ) expected(function_name,body_hash)
      JOIN pg_proc p ON p.proname=expected.function_name
        AND p.pronamespace='public'::regnamespace
    ) AS relationship_evaluator
  `;
  // Cache the SQL execution PLAN on this transaction's native connection,
  // NEVER the result. Every invocation still reads the live catalog, checks
  // exact trigger/function fingerprints and fails closed on schema drift.
  // Import recovery calls this many times per row: replanning this unchanged
  // catalog query was substantially more expensive than executing it.
  const triggerCheck = options.prepared
    ? (await executor.select({guard:sql`row_to_json(native_contract)`})
      .from(sql`(${nativeContract}) native_contract`)
      .prepare("canonical_system_link_guard_v1").execute())[0]?.guard
    : ((await executor.execute(nativeContract)) as any).rows?.[0];
  if (!triggerCheck?.installed || !triggerCheck?.immutable_evidence_trigger
      || !triggerCheck?.evidence_table || !triggerCheck?.evidence_column
      || !triggerCheck?.evidence_foreign_keys || !triggerCheck?.sfp_contact_checks
      || !triggerCheck?.relationship_evaluator) {
    throw new Error("COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING");
  }
}

/** Additional exact schema fence for typed free/paid SFP system links. */
export async function assertSfpLinkDatabaseGuard(executor: any) {
  await assertSystemLinkDatabaseGuard(executor);
  const result = (await executor.execute(sql`
    SELECT
      to_regclass('public.contact_business_sfp_link_evidence') IS NOT NULL AS evidence_table,
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='contact_business_link_decisions'
           AND column_name='sfp_evidence_id' AND data_type='uuid'
      ) AS evidence_column,
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='public' AND c.relname='contact_business_sfp_link_evidence'
          AND t.tgname='contact_business_sfp_link_evidence_append_only'
          AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL
          AND t.tgtype=27 AND p.proname='cro02_sfp_link_evidence_append_only'
          AND p.pronamespace='public'::regnamespace
          AND md5(p.prosrc)=${SFP_LINK_EVIDENCE_TRIGGER_BODY_MD5}
      ) AS immutable_evidence_trigger,
      (SELECT bool_and(EXISTS (
        SELECT 1 FROM pg_constraint con
        JOIN pg_class rel ON rel.oid=con.conrelid
        JOIN pg_namespace ns ON ns.oid=rel.relnamespace
        JOIN pg_attribute local_col ON local_col.attrelid=con.conrelid AND local_col.attnum=con.conkey[1]
        JOIN pg_class ref_rel ON ref_rel.oid=con.confrelid
        JOIN pg_namespace ref_ns ON ref_ns.oid=ref_rel.relnamespace
        JOIN pg_attribute ref_col ON ref_col.attrelid=con.confrelid AND ref_col.attnum=con.confkey[1]
        WHERE ns.nspname='public' AND rel.relname=expected.table_name
          -- Generated FK names are truncated by PostgreSQL. Prove the actual
          -- enforced column/target/action contract, not its generated label.
          AND con.contype='f'
          AND con.convalidated AND con.confdeltype='r'
          AND array_length(con.conkey,1)=1 AND array_length(con.confkey,1)=1
          AND local_col.attname=expected.column_name
          AND ref_ns.nspname='public' AND ref_rel.relname=expected.referenced_table
          AND ref_col.attname=expected.referenced_column
      ))
       FROM (VALUES
          ('contact_business_sfp_link_evidence','contact_id','contacts','id'),
          ('contact_business_sfp_link_evidence','business_id','businesses','id'),
          ('contact_business_sfp_link_evidence','eligibility_id','sfp_outreach_eligibility','id'),
          ('contact_business_sfp_link_evidence','free_candidate_id','free_discovery_candidates','id'),
          ('contact_business_sfp_link_evidence','paid_candidate_evidence_id','sfp_paid_candidate_evidence','id'),
          ('contact_business_sfp_link_evidence','validation_operation_id','provider_operations','id'),
          ('contact_business_link_decisions','sfp_evidence_id','contact_business_sfp_link_evidence','id')
        ) AS expected(table_name,column_name,referenced_table,referenced_column)
      ) AS evidence_foreign_keys,
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='public' AND c.relname='contact_business_link_decisions'
          AND t.tgname='contact_business_link_review_contract'
          AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL
          AND t.tgtype=23 AND p.proname='enforce_reviewed_contact_business_link'
          AND ${canonicalAddressReceiptNativeFingerprint(sql`p.prosrc`)}
      ) AS combined_decision_trigger
  `) as any).rows?.[0];
  if (!result?.evidence_table || !result?.evidence_column || !result?.immutable_evidence_trigger
      || !result?.evidence_foreign_keys || !result?.combined_decision_trigger) {
    const missing = ([
      "evidence_table", "evidence_column", "immutable_evidence_trigger",
      "evidence_foreign_keys", "combined_decision_trigger",
    ] as const).filter((name) => result?.[name] !== true);
    throw new Error(`COMMERCIAL_SFP_LINK_DATABASE_GUARD_MISSING:${missing.join(",")}`);
  }
}


/** Fence for the first-party staged-email link evidence kind (migration 0361).
 * Publish can add tables/columns without reliably installing PL/pgSQL bodies,
 * so the writer proves the native branch, immutable evidence trigger and FKs. */
export async function assertFirstPartyLinkDatabaseGuard(executor: any) {
  await assertSystemLinkDatabaseGuard(executor);
  const result = (await executor.execute(sql`
    SELECT
      to_regclass('public.contact_business_first_party_link_evidence') IS NOT NULL AS evidence_table,
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='contact_business_link_decisions'
           AND column_name='first_party_evidence_id' AND data_type='uuid'
      ) AS evidence_column,
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='public' AND c.relname='contact_business_first_party_link_evidence'
          AND t.tgname='contact_business_first_party_link_evidence_append_only'
          AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL
          AND t.tgtype=27 AND p.proname='cro02_first_party_link_evidence_append_only'
          AND p.pronamespace='public'::regnamespace
          AND md5(p.prosrc)=${FIRST_PARTY_LINK_EVIDENCE_TRIGGER_BODY_MD5}
      ) AS immutable_evidence_trigger,
      EXISTS (
        SELECT 1 FROM pg_proc p
         WHERE p.oid=to_regprocedure('public.enforce_reviewed_contact_business_link()')
           AND ${currentReviewedLinkRoutineFingerprint(sql`p.prosrc`)}
      ) AS native_branch,
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='contact_business_first_party_link_evidence'
           AND column_name IN ('crawl_domain','business_site_domain','site_relation')
         HAVING count(*)=3
      ) AS site_relation_columns
  `) as any).rows?.[0];
  const missing = (["evidence_table","evidence_column","immutable_evidence_trigger","native_branch","site_relation_columns"] as const)
    .filter((name) => result?.[name] !== true);
  if (missing.length) throw new Error(`COMMERCIAL_FIRST_PARTY_LINK_DATABASE_GUARD_MISSING:${missing.join(",")}`);
}

/** Full C1-C3 bridge schema fence; blocks readiness if Publish omitted SQL bodies. */
export async function assertSfpPipelineDatabaseGuard(executor: any) {
  await assertSfpLinkDatabaseGuard(executor);
  const result = (await executor.execute(sql`
    SELECT
      to_regclass('public.sfp_recipient_address_commitments') IS NOT NULL AS commitments_table,
      to_regclass('public.sfp_recipient_commitment_aliases') IS NOT NULL AS aliases_table,
      to_regclass('public.sfp_enrollment_bridge_holds') IS NOT NULL AS holds_table,
      (SELECT count(*)=1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sfp_campaign_staging_intents'
          AND column_name='recipient_commitment_id' AND data_type='uuid') AS staging_intent_commitment_column,
      (SELECT count(*)=3 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sfp_recipient_address_commitments'
          AND (column_name,data_type) IN
            (('objective_key','text'),('recipient_identity_hash','text'),
             ('recipient_identity_hash_version','integer'))) AS recipient_columns,
      (SELECT count(*)=3 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sfp_ready_held_enrollments'
          AND (column_name,data_type) IN
            (('contact_business_link_decision_id','uuid'),
             ('contact_business_link_revision','integer'),
             ('recipient_commitment_id','uuid'))) AS ledger_columns,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
        AND indexname='sfp_recipient_address_commitments_program_hash_uidx'
        AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
        AND indexdef ILIKE '%(program_id, objective_key, recipient_identity_hash)%') AS recipient_unique_index,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
        AND indexname='sfp_recipient_commitment_aliases_attempt_uidx'
        AND indexdef ILIKE 'CREATE UNIQUE INDEX%') AS aliases_unique_index,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
        AND indexname='sfp_ready_held_enrollments_commitment_uidx'
        AND indexdef ILIKE 'CREATE UNIQUE INDEX%') AS ledger_commitment_unique_index,
      (SELECT bool_and(EXISTS (
        SELECT 1 FROM pg_constraint con
         WHERE con.connamespace='public'::regnamespace
           AND con.conrelid=to_regclass('public.'||expected.table_name)
           AND con.conname=expected.constraint_name AND con.convalidated
           AND con.contype=expected.constraint_type
      ))
       FROM (VALUES
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_identity_chk','c'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_objective_chk','c'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_state_chk','c'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_commit_state_chk','c'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_staging_intent_uidx','u'),
         ('sfp_recipient_commitment_aliases','sfp_recipient_commitment_aliases_source_chk','c'),
         ('sfp_recipient_commitment_aliases','sfp_recipient_commitment_aliases_hash_version_chk','c'),
         ('sfp_recipient_commitment_aliases','sfp_recipient_commitment_aliases_disposition_chk','c'),
         ('sfp_recipient_commitment_aliases','sfp_recipient_commitment_aliases_attempt_uidx','u')
       ) expected(table_name,constraint_name,constraint_type)) AS recipient_constraints,
      (SELECT bool_and(EXISTS (
        SELECT 1 FROM pg_constraint con
        JOIN pg_class rel ON rel.oid=con.conrelid
        JOIN pg_namespace ns ON ns.oid=rel.relnamespace
        JOIN pg_attribute local_col ON local_col.attrelid=con.conrelid AND local_col.attnum=con.conkey[1]
        JOIN pg_class ref_rel ON ref_rel.oid=con.confrelid
        JOIN pg_namespace ref_ns ON ref_ns.oid=ref_rel.relnamespace
        JOIN pg_attribute ref_col ON ref_col.attrelid=con.confrelid AND ref_col.attnum=con.confkey[1]
        WHERE ns.nspname='public' AND rel.relname=expected.table_name
          AND con.contype='f'
          AND con.convalidated AND con.confdeltype='r'
          AND array_length(con.conkey,1)=1 AND array_length(con.confkey,1)=1
          AND local_col.attname=expected.column_name
          AND ref_ns.nspname='public' AND ref_rel.relname=expected.referenced_table
          AND ref_col.attname=expected.referenced_column
      ))
       FROM (VALUES
          ('sfp_campaign_staging_intents','sfp_campaign_staging_intents_recipient_commitment_id_fkey','recipient_commitment_id','sfp_recipient_address_commitments','id'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_program_id_fkey','program_id','sfp_programs','id'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_business_id_fkey','business_id','businesses','id'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_package_version_id_fkey','package_version_id','sfp_campaign_package_versions','id'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_staging_intent_id_fkey','staging_intent_id','sfp_campaign_staging_intents','id'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_contact_id_fkey','contact_id','contacts','id'),
         ('sfp_recipient_address_commitments','sfp_recipient_address_commitments_contact_business_link_decision_id_fkey','contact_business_link_decision_id','contact_business_link_decisions','id'),
         ('sfp_recipient_commitment_aliases','sfp_recipient_commitment_aliases_commitment_id_fkey','commitment_id','sfp_recipient_address_commitments','id'),
         ('sfp_recipient_commitment_aliases','sfp_recipient_commitment_aliases_staging_intent_id_fkey','staging_intent_id','sfp_campaign_staging_intents','id'),
         ('sfp_ready_held_enrollments','sfp_ready_held_enrollments_recipient_commitment_id_fkey','recipient_commitment_id','sfp_recipient_address_commitments','id'),
         ('sfp_enrollment_bridge_holds','sfp_enrollment_bridge_holds_staging_intent_id_fkey','staging_intent_id','sfp_campaign_staging_intents','id'),
         ('sfp_enrollment_bridge_holds','sfp_enrollment_bridge_holds_eligibility_id_fkey','eligibility_id','sfp_outreach_eligibility','id')
       ) expected(table_name,constraint_name,column_name,referenced_table,referenced_column)
      ) AS recipient_foreign_keys,
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='public' AND c.relname='sfp_recipient_address_commitments'
          AND t.tgname='sfp_recipient_commitment_transition' AND t.tgenabled IN ('O','A')
          AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=27
          AND p.proname='sfp_recipient_commitment_transition'
          AND md5(p.prosrc)=${SFP_RECIPIENT_TRANSITION_TRIGGER_BODY_MD5}
      ) AS commitment_transition_trigger,
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='public' AND c.relname='sfp_recipient_commitment_aliases'
          AND t.tgname='sfp_recipient_commitment_aliases_append_only' AND t.tgenabled IN ('O','A')
          AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=27
          AND p.proname='sfp_recipient_commitment_aliases_append_only'
          AND md5(p.prosrc)=${SFP_RECIPIENT_ALIAS_TRIGGER_BODY_MD5}
      ) AS alias_append_only_trigger,
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='public' AND c.relname='sfp_enrollment_bridge_holds'
          AND t.tgname='sfp_enrollment_bridge_holds_append_only' AND t.tgenabled IN ('O','A')
          AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=27
          AND p.proname='sfp_enrollment_bridge_holds_append_only'
          AND md5(p.prosrc)=${SFP_BRIDGE_HOLD_TRIGGER_BODY_MD5}
      ) AS hold_append_only_trigger,
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE n.nspname='public' AND c.relname='contacts'
          AND t.tgname='cro03_sfp_contact_address_commit_serialization_trg'
          AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
          AND t.tgqual IS NULL AND t.tgtype=31
          AND p.proname='cro03_sfp_contact_address_commit_serialization'
          AND p.prosrc ILIKE '%pg_advisory_xact_lock(hashtextextended%'
          AND p.prosrc ILIKE '%sfp-contact-address-v1:%'
          AND p.prosrc ILIKE '%NEW.opted_out_email%'
          AND p.prosrc ILIKE '%NEW.suppression_reason%'
      ) AS contact_address_serialization_trigger
  `) as any).rows?.[0];
  if (!result?.commitments_table || !result?.aliases_table || !result?.holds_table
      || !result?.staging_intent_commitment_column
      || !result?.recipient_columns || !result?.ledger_columns
      || !result?.recipient_unique_index || !result?.aliases_unique_index
      || !result?.ledger_commitment_unique_index || !result?.recipient_constraints
      || !result?.recipient_foreign_keys || !result?.commitment_transition_trigger
      || !result?.alias_append_only_trigger || !result?.hold_append_only_trigger
      || !result?.contact_address_serialization_trigger) {
    throw new Error("COMMERCIAL_SFP_PIPELINE_DATABASE_GUARD_MISSING");
  }
}

function requiresBusiness(decision: LinkDecision | MappingDecision) {
  return decision === "verified";
}

/** Heuristic/import discovery only. This never changes verified truth/projection. */
export async function recordContactBusinessLinkCandidate(input: {
  contactId: number;
  businessId: number;
  source: "csv_import" | "legacy_import" | "sdr_dedupe" | "sdr_orchestration";
  sourceVersion?: string | null;
  candidateKey: string;
  confidence: number;
}) {
  if (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 99) {
    throw new Error("COMMERCIAL_LINK_CANDIDATE_CONFIDENCE_INVALID");
  }
  if (!input.candidateKey) throw new Error("COMMERCIAL_LINK_CANDIDATE_KEY_REQUIRED");
  return db.transaction(async (tx) => {
    await lockCommercialGraphNodes(tx, [
      { type: "contact", id: input.contactId },
      { type: "business", id: input.businessId },
    ]);
    await lockCommercialGraphMembershipSets(tx, [
      { type: "contact", id: input.contactId },
      { type: "business", id: input.businessId },
    ], ["contact_business"]);
    const contact = (await tx.execute(sql`SELECT id FROM contacts WHERE id=${input.contactId} FOR UPDATE`) as any).rows?.[0];
    const business = (await tx.execute(sql`SELECT id FROM businesses WHERE id=${input.businessId} FOR UPDATE`) as any).rows?.[0];
    if (!contact || !business) throw new Error("CRM_OBJECT_NOT_FOUND");
    const replay = (await tx.execute(sql`SELECT * FROM contact_business_link_candidates
      WHERE candidate_key=${input.candidateKey}`) as any).rows?.[0];
    if (replay) {
      if (replay.contact_id !== input.contactId || replay.business_id !== input.businessId
          || replay.source !== input.source || replay.source_version !== (input.sourceVersion ?? null)
          || replay.confidence !== input.confidence) {
        throw new Error("COMMERCIAL_LINK_CANDIDATE_DIVERGENT_REPLAY");
      }
      return replay;
    }
    return (await tx.execute(sql`INSERT INTO contact_business_link_candidates
      (contact_id,business_id,source,source_version,candidate_key,confidence)
      VALUES (${input.contactId},${input.businessId},${input.source},${input.sourceVersion ?? null},
        ${input.candidateKey},${input.confidence}) RETURNING *`) as any).rows?.[0];
  });
}

/** Sole writer of contact/business link truth and its contacts.businessId projection. */
export async function decideContactBusinessLink(input: {
  contactId: number; businessId?: number | null; decision: LinkDecision; decisionKey: string;
  reviewerId: string; evidenceSourceEventId?: number | null; expectedRevision?: number;
  authorityCheck?: (tx: any) => Promise<boolean>;
}) {
  if (requiresBusiness(input.decision) !== Boolean(input.businessId)) {
    throw new Error("COMMERCIAL_LINK_DECISION_BUSINESS_MISMATCH");
  }
  if (!input.reviewerId) throw new Error("COMMERCIAL_LINK_REVIEWER_REQUIRED");
  if (input.decision === "verified" && !input.evidenceSourceEventId) throw new Error("COMMERCIAL_LINK_EVIDENCE_REQUIRED");
  return db.transaction(async (tx) => {
    if (input.authorityCheck && !(await input.authorityCheck(tx))) {
      throw new Error("COMMERCIAL_LINK_AUTHORITY_FENCE_LOST");
    }
    const reviewer = (await tx.execute(sql`SELECT role FROM users WHERE id=${input.reviewerId}`) as any).rows?.[0];
    if (!reviewer || reviewer.role !== "admin") throw new Error("COMMERCIAL_LINK_REVIEWER_ROLE_INVALID");
    const contactNode: CommercialGraphNode = { type: "contact", id: input.contactId };
    await lockCommercialGraphNodes(tx, [contactNode]);
    const currentHint = (await tx.execute(sql`SELECT business_id FROM contact_business_link_decisions
      WHERE contact_id=${input.contactId} AND superseded_at IS NULL`) as any).rows?.[0];
    const nodes: CommercialGraphNode[] = [
      contactNode,
      ...(input.businessId ? [{ type: "business" as const, id: input.businessId }] : []),
      ...(currentHint?.business_id ? [{ type: "business" as const, id: Number(currentHint.business_id) }] : []),
    ];
    await lockCommercialGraphNodes(tx, nodes.filter(node => node.type === "business"));
    await lockCommercialGraphMembershipSets(tx, nodes, ["contact_business"]);
    const replay = (await tx.execute(sql`SELECT * FROM contact_business_link_decisions WHERE decision_key=${input.decisionKey} FOR UPDATE`) as any).rows?.[0];
    if (replay) {
      if (replay.contact_id !== input.contactId || replay.business_id !== (input.businessId ?? null)
          || replay.decision !== input.decision || replay.reviewed_by !== input.reviewerId
          || replay.evidence_source_event_id !== (input.evidenceSourceEventId ?? null)) {
        throw new Error("COMMERCIAL_LINK_DIVERGENT_REPLAY");
      }
      return replay;
    }
    const contact = (await tx.execute(sql`SELECT id FROM contacts WHERE id=${input.contactId} FOR UPDATE`) as any).rows?.[0];
    const business = input.businessId ? (await tx.execute(sql`SELECT id FROM businesses WHERE id=${input.businessId} FOR UPDATE`) as any).rows?.[0] : true;
    if (!contact || !business) throw new Error("CRM_OBJECT_NOT_FOUND");
    if (input.evidenceSourceEventId) {
      const evidence = (await tx.execute(sql`SELECT contact_id,actor_type,actor_id
        FROM contact_source_events WHERE id=${input.evidenceSourceEventId} FOR SHARE`) as any).rows?.[0];
      if (!evidence || evidence.contact_id !== input.contactId) {
        throw new Error("COMMERCIAL_LINK_EVIDENCE_SUBJECT_MISMATCH");
      }
      if (evidence.actor_type === "user" && evidence.actor_id === input.reviewerId) {
        throw new Error("COMMERCIAL_LINK_REVIEWER_MUST_BE_INDEPENDENT");
      }
    }
    const current = (await tx.execute(sql`SELECT * FROM contact_business_link_decisions WHERE contact_id=${input.contactId} AND superseded_at IS NULL FOR UPDATE`) as any).rows?.[0];
    if (input.authorityCheck && !(await input.authorityCheck(tx))) {
      throw new Error("COMMERCIAL_LINK_AUTHORITY_FENCE_LOST");
    }
    if (input.expectedRevision !== undefined && (current?.revision ?? 0) !== input.expectedRevision) throw new CommercialRevisionConflict();
    if (current) await tx.execute(sql`UPDATE contact_business_link_decisions SET superseded_at=now() WHERE id=${current.id}`);
    const revision = (current?.revision ?? 0) + 1;
    const row = (await tx.execute(sql`INSERT INTO contact_business_link_decisions
      (contact_id,business_id,decision,decision_key,actor_id,revision,evidence_source_event_id,reviewed_by,reviewed_at)
      VALUES (${input.contactId},${input.businessId ?? null},${input.decision},${input.decisionKey},
        ${input.reviewerId},${revision},${input.evidenceSourceEventId ?? null},${input.reviewerId},now()) RETURNING *`) as any).rows?.[0];
    // Projection belongs in the same authority transaction as immutable truth.
    await tx.execute(sql`UPDATE contacts SET business_id=${input.decision === "verified" ? input.businessId! : null},updated_at=now() WHERE id=${input.contactId}`);
    return row;
  });
}

/**
 * Writes an SFP free/paid evidence-backed business relationship through this
 * same commercial-link authority. The transaction is supplied by the bridge
 * so contact creation, immutable evidence, decision/projection, commitment,
 * enrollment, and bridge receipt share one rollback boundary.
 */
export async function decideSfpContactBusinessLink(input: {
  executor: { execute: (query: any) => Promise<any> };
  contactId: number;
  businessId: number;
  eligibilityId: string;
  sourceKind: "free" | "paid";
  sourceReferenceId: string;
  normalizedValueHash: string;
  normalizedValueHashVersion: number;
  contactEmailTokenHash: string;
  decisionKey: string;
  facts?: Record<string, unknown>;
}) {
  const tx = input.executor;
  if (!Number.isSafeInteger(input.contactId) || !Number.isSafeInteger(input.businessId)
      || !["free", "paid"].includes(input.sourceKind)
      || ![0, 1].includes(input.normalizedValueHashVersion)
      || !/^[0-9a-f]{64}$/i.test(input.normalizedValueHash)
      || !/^[0-9a-f]{64}$/i.test(input.contactEmailTokenHash)
      || !input.sourceReferenceId || !input.eligibilityId || !input.decisionKey) {
    throw new Error("COMMERCIAL_SFP_LINK_TYPED_EVIDENCE_INVALID");
  }
  await assertSfpLinkDatabaseGuard(tx);

  const contactNode: CommercialGraphNode = { type: "contact", id: input.contactId };
  const businessNode: CommercialGraphNode = { type: "business", id: input.businessId };
  await lockCommercialGraphNodes(tx, [contactNode]);
  const currentHint = (await tx.execute(sql`
    SELECT business_id FROM contact_business_link_decisions
     WHERE contact_id=${input.contactId} AND superseded_at IS NULL
  `) as any).rows?.[0];
  const graphNodes: CommercialGraphNode[] = [
    contactNode,
    businessNode,
    ...(currentHint?.business_id ? [{ type: "business" as const, id: Number(currentHint.business_id) }] : []),
  ];
  await lockCommercialGraphNodes(tx, graphNodes.filter(node => node.type === "business"));
  await lockCommercialGraphMembershipSets(tx, graphNodes, ["contact_business"]);

  const contact = (await tx.execute(sql`
    SELECT id,business_id,email_token_hash FROM contacts WHERE id=${input.contactId} FOR UPDATE
  `) as any).rows?.[0];
  const business = (await tx.execute(sql`
    SELECT id,record_class,do_not_visit FROM businesses WHERE id=${input.businessId} FOR UPDATE
  `) as any).rows?.[0];
  if (!contact || !business) throw new Error("CRM_OBJECT_NOT_FOUND");
  if (String(contact.email_token_hash ?? "") !== input.contactEmailTokenHash
      || business.record_class !== "canonical" || business.do_not_visit === true) {
    throw new Error("COMMERCIAL_SFP_LINK_CONTACT_OR_BUSINESS_CHANGED");
  }
  const current = (await tx.execute(sql`
    SELECT id,business_id,decision,revision FROM contact_business_link_decisions
     WHERE contact_id=${input.contactId} AND superseded_at IS NULL FOR UPDATE
  `) as any).rows?.[0];
  if (current) {
    if (Number(current.business_id) === input.businessId && current.decision === "verified"
        && Number(contact.business_id) === input.businessId) return { ...current, replayed: true };
    throw new Error("COMMERCIAL_SFP_LINK_CURRENT_RELATIONSHIP_CONFLICT");
  }
  if (contact.business_id != null) throw new Error("COMMERCIAL_SFP_LINK_UNAUTHORIZED_BUSINESS_PROJECTION");

  const source = input.sourceKind === "free"
    ? (await tx.execute(sql`
        SELECT e.id,e.business_id,e.candidate_id,e.paid_candidate_evidence_id,
               e.normalized_value_hash,e.normalized_value_hash_version,
               COALESCE(e.validation_operation_id,e.reused_from_operation_id) AS validation_operation_id,
               e.status,e.zb_outcome,e.suppression_status,e.policy_document_id,e.policy_document_hash,
               fc.normalized_value_hash AS source_hash
          FROM sfp_outreach_eligibility e
          JOIN free_discovery_candidates fc ON fc.id=e.candidate_id
         WHERE e.id=${input.eligibilityId}::uuid AND e.business_id=${input.businessId}
           AND e.source_kind='free' AND e.candidate_id=${input.sourceReferenceId}::uuid
           AND e.paid_candidate_evidence_id IS NULL
         FOR SHARE OF e,fc
      `) as any).rows?.[0]
    : (await tx.execute(sql`
        SELECT e.id,e.business_id,e.candidate_id,e.paid_candidate_evidence_id,
               e.normalized_value_hash,e.normalized_value_hash_version,
               COALESCE(e.validation_operation_id,e.reused_from_operation_id) AS validation_operation_id,
               e.status,e.zb_outcome,e.suppression_status,e.policy_document_id,e.policy_document_hash,
               pe.normalized_value_hash AS source_hash
          FROM sfp_outreach_eligibility e
          JOIN sfp_paid_candidate_evidence pe ON pe.id=e.paid_candidate_evidence_id
         WHERE e.id=${input.eligibilityId}::uuid AND e.business_id=${input.businessId}
           AND e.source_kind='paid' AND e.paid_candidate_evidence_id=${input.sourceReferenceId}::uuid
           AND e.candidate_id IS NULL
         FOR SHARE OF e,pe
      `) as any).rows?.[0];
  if (!source
      || !["validated_outreach_eligible", "validated_review_required"].includes(String(source.status))
      || source.zb_outcome !== "valid" || source.suppression_status !== "not_suppressed"
      || String(source.normalized_value_hash ?? "") !== input.normalizedValueHash
      || Number(source.normalized_value_hash_version) !== input.normalizedValueHashVersion
      || (input.normalizedValueHashVersion === 1 && String(source.source_hash ?? "") !== input.normalizedValueHash)
      || !source.validation_operation_id) {
    throw new Error("COMMERCIAL_SFP_LINK_SOURCE_EVIDENCE_STALE");
  }
  const policy = (await tx.execute(sql`
     SELECT d.id,d.document_hash,d.validation_ttl_days
      FROM sfp_outreach_policy_control c
      JOIN sfp_outreach_policy_documents d ON d.id=c.active_policy_id
     WHERE c.singleton=TRUE AND d.id=${String(source.policy_document_id ?? "")}::uuid
       AND d.document_hash=${String(source.policy_document_hash ?? "")}
     FOR SHARE OF c,d
  `) as any).rows?.[0];
  if (!policy) throw new Error("COMMERCIAL_SFP_LINK_POLICY_STALE");
  const receipt = (await tx.execute(sql`
    SELECT po.operation_id FROM provider_observations po
    JOIN provider_operations op ON op.id=po.operation_id AND op.state='completed'
     WHERE po.operation_id=${String(source.validation_operation_id)}::uuid
       AND po.provider='zerobounce' AND po.outcome='valid' AND po.retryable=FALSE
       AND po.subject_type IN ('business','contact')
       AND po.email_token_hash=${input.contactEmailTokenHash}
        AND po.observed_at<=NOW()
        AND LEAST(
          COALESCE(po.expires_at,po.observed_at+(${Number(policy.validation_ttl_days)}::text||' days')::interval),
          po.observed_at+(${Number(policy.validation_ttl_days)}::text||' days')::interval
        )>NOW()
        AND EXISTS (
          SELECT 1 FROM sfp_outreach_eligibility e
           WHERE e.id=${input.eligibilityId}::uuid
             AND e.validation_at BETWEEN po.observed_at-INTERVAL '5 minutes'
                                     AND po.observed_at+INTERVAL '5 minutes'
             AND e.validation_expires_at<=LEAST(
               COALESCE(po.expires_at,po.observed_at+(${Number(policy.validation_ttl_days)}::text||' days')::interval),
               po.observed_at+(${Number(policy.validation_ttl_days)}::text||' days')::interval
             )
        )
     LIMIT 1 FOR SHARE OF po,op
  `) as any).rows?.[0];
  if (!receipt) throw new Error("COMMERCIAL_SFP_LINK_VALIDATION_RECEIPT_MISMATCH");

  const facts = {
    contract: "sfp_typed_source_v1",
    sourceKind: input.sourceKind,
    sourceReferenceId: input.sourceReferenceId,
    eligibilityId: input.eligibilityId,
    normalizedValueHash: input.normalizedValueHash,
    normalizedValueHashVersion: input.normalizedValueHashVersion,
    contactEmailTokenHash: input.contactEmailTokenHash,
    validationOperationId: String(source.validation_operation_id),
    ...(input.facts ?? {}),
  };
  const factsHash = crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  const evidence = (await tx.execute(sql`
    INSERT INTO contact_business_sfp_link_evidence
      (decision_key,contact_id,business_id,eligibility_id,source_kind,free_candidate_id,
       paid_candidate_evidence_id,normalized_value_hash,normalized_value_hash_version,
       contact_email_token_hash,validation_operation_id,facts_hash,facts)
    VALUES (${input.decisionKey},${input.contactId},${input.businessId},${input.eligibilityId}::uuid,
      ${input.sourceKind},${input.sourceKind === "free" ? input.sourceReferenceId : null}::uuid,
      ${input.sourceKind === "paid" ? input.sourceReferenceId : null}::uuid,
      ${input.normalizedValueHash},${input.normalizedValueHashVersion},${input.contactEmailTokenHash},
      ${String(source.validation_operation_id)}::uuid,${factsHash},${JSON.stringify(facts)}::jsonb)
    RETURNING id
  `) as any).rows?.[0];
  if (!evidence) throw new Error("COMMERCIAL_SFP_LINK_EVIDENCE_WRITE_FAILED");
  const decision = (await tx.execute(sql`
    INSERT INTO contact_business_link_decisions
      (contact_id,business_id,decision,decision_key,actor_id,revision,sfp_evidence_id)
    VALUES (${input.contactId},${input.businessId},'verified',${input.decisionKey},'system',1,${String(evidence.id)}::uuid)
    RETURNING *
  `) as any).rows?.[0];
  await tx.execute(sql`
    UPDATE contacts SET business_id=${input.businessId},updated_at=now() WHERE id=${input.contactId}
  `);
  return decision;
}


/**
 * Writes a verified relationship between a contact and the exact business whose
 * own website published its address (staged free-discovery email). The business
 * identity comes from the immutable candidate, never from a company-name match.
 * The database branch re-verifies candidate, hash, domain attribution, shared
 * address/location ambiguity and quarantine. No validation receipt is needed.
 * Callers supply the transaction so contact write, evidence and decision commit
 * or roll back together.
 */
export const FIRST_PARTY_LINK_RULE_VERSION = "first_party_staged_email_v2";
export async function decideFirstPartyContactBusinessLink(input: {
  executor: { execute: (query: any) => Promise<any> };
  contactId: number;
  businessId: number;
  candidateId: string;
  candidateHash: string;
  contactEmailTokenHash: string;
  addressDomain: string;
  domainBasis: "business_domain" | "provider_mailbox";
  /** Domain of the site the address was crawled from (candidate.domain, normalized). */
  crawlDomain: string;
  /** The business's own website domain at decision time (normalized). Must equal crawlDomain. */
  businessSiteDomain: string;
  attributionScope: "role" | "named";
  candidateSource: string;
  facts?: Record<string, unknown>;
}) {
  const tx = input.executor;
  if (!Number.isSafeInteger(input.contactId) || !Number.isSafeInteger(input.businessId)
      || !/^[0-9a-f]{64}$/i.test(input.candidateHash)
      || !/^[0-9a-f]{64}$/i.test(input.contactEmailTokenHash)
      || !input.candidateId || !input.addressDomain || !input.candidateSource
      || !input.crawlDomain || input.crawlDomain !== input.businessSiteDomain
      || !["business_domain", "provider_mailbox"].includes(input.domainBasis)
      || !["role", "named"].includes(input.attributionScope)) {
    throw new Error("COMMERCIAL_FIRST_PARTY_LINK_EVIDENCE_INVALID");
  }
  await assertFirstPartyLinkDatabaseGuard(tx);
  const decisionKey = `first-party-link-v1:${input.contactId}:${input.businessId}:${input.candidateId}`;

  const contactNode: CommercialGraphNode = { type: "contact", id: input.contactId };
  const businessNode: CommercialGraphNode = { type: "business", id: input.businessId };
  await lockCommercialGraphNodes(tx, [contactNode]);
  const currentHint = (await tx.execute(sql`
    SELECT business_id FROM contact_business_link_decisions
     WHERE contact_id=${input.contactId} AND superseded_at IS NULL
  `) as any).rows?.[0];
  const graphNodes: CommercialGraphNode[] = [
    contactNode, businessNode,
    ...(currentHint?.business_id ? [{ type: "business" as const, id: Number(currentHint.business_id) }] : []),
  ];
  await lockCommercialGraphNodes(tx, graphNodes.filter(node => node.type === "business"));
  await lockCommercialGraphMembershipSets(tx, graphNodes, ["contact_business"]);

  const contact = (await tx.execute(sql`
    SELECT id,business_id,email_token_hash FROM contacts WHERE id=${input.contactId} FOR UPDATE
  `) as any).rows?.[0];
  const business = (await tx.execute(sql`
    SELECT id,record_class,do_not_visit FROM businesses WHERE id=${input.businessId} FOR UPDATE
  `) as any).rows?.[0];
  if (!contact || !business) throw new Error("CRM_OBJECT_NOT_FOUND");
  if (String(contact.email_token_hash ?? "") !== input.contactEmailTokenHash
      || business.record_class !== "canonical" || business.do_not_visit === true) {
    throw new Error("COMMERCIAL_FIRST_PARTY_LINK_CONTACT_OR_BUSINESS_CHANGED");
  }
  const current = (await tx.execute(sql`
    SELECT id,business_id,decision,revision FROM contact_business_link_decisions
     WHERE contact_id=${input.contactId} AND superseded_at IS NULL FOR UPDATE
  `) as any).rows?.[0];
  if (current) {
    if (Number(current.business_id) === input.businessId && current.decision === "verified"
        && Number(contact.business_id) === input.businessId) return { ...current, replayed: true };
    throw new Error("COMMERCIAL_FIRST_PARTY_LINK_CURRENT_RELATIONSHIP_CONFLICT");
  }
  if (contact.business_id != null) throw new Error("COMMERCIAL_FIRST_PARTY_LINK_UNAUTHORIZED_BUSINESS_PROJECTION");

  const facts = {
    contract: FIRST_PARTY_LINK_RULE_VERSION,
    candidateId: input.candidateId,
    candidateHash: input.candidateHash,
    contactEmailTokenHash: input.contactEmailTokenHash,
    addressDomain: input.addressDomain,
    domainBasis: input.domainBasis,
    crawlDomain: input.crawlDomain,
    businessSiteDomain: input.businessSiteDomain,
    siteRelation: "business_website_domain",
    attributionScope: input.attributionScope,
    candidateSource: input.candidateSource,
    ...(input.facts ?? {}),
  };
  const factsHash = crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  const evidence = (await tx.execute(sql`
    INSERT INTO contact_business_first_party_link_evidence
      (decision_key,contact_id,business_id,candidate_id,candidate_hash,contact_email_token_hash,
       address_domain,domain_basis,attribution_scope,candidate_source,rule_version,facts_hash,facts,
       crawl_domain,business_site_domain,site_relation)
    VALUES (${decisionKey},${input.contactId},${input.businessId},${input.candidateId}::uuid,
      ${input.candidateHash},${input.contactEmailTokenHash},${input.addressDomain},${input.domainBasis},
      ${input.attributionScope},${input.candidateSource},${FIRST_PARTY_LINK_RULE_VERSION},
      ${factsHash},${JSON.stringify(facts)}::jsonb,
      ${input.crawlDomain},${input.businessSiteDomain},'business_website_domain')
    RETURNING id
  `) as any).rows?.[0];
  if (!evidence) throw new Error("COMMERCIAL_FIRST_PARTY_LINK_EVIDENCE_WRITE_FAILED");
  const decision = (await tx.execute(sql`
    INSERT INTO contact_business_link_decisions
      (contact_id,business_id,decision,decision_key,actor_id,revision,first_party_evidence_id)
    VALUES (${input.contactId},${input.businessId},'verified',${decisionKey},'system',1,${String(evidence.id)}::uuid)
    RETURNING *
  `) as any).rows?.[0];
  await tx.execute(sql`
    UPDATE contacts SET business_id=${input.businessId},updated_at=now() WHERE id=${input.contactId}
  `);
  return decision;
}

/**
 * Separate strict system-authority writer. It shares the canonical graph locks,
 * revision fence, append-only decision ledger and projection transaction with
 * admin decisions, but never supplies a reviewer identity or contact event.
 */
export async function decideSystemContactBusinessLink(input: {
  contactId: number;
  businessId: number;
  sourceLinkId: string;
  sourceEntityId: number | null;
  decisionKey: string;
  ruleVersion: string;
  factsHash: string;
  facts: Record<string, unknown>;
  beforeGraphLock?: (tx:any) => Promise<void>;
  authorityCheck: (tx: any) => Promise<boolean>;
}) {
  return runCanonicalTransaction("link_commit",()=>db.transaction(async (tx) => {
    // Publish schema-diff can add tables/columns but does not reliably install
    // PL/pgSQL trigger functions. Never let automatic system authority silently
    // proceed without the database-enforced system/admin decision split.
    await assertSystemLinkDatabaseGuard(tx);
    // Automatic callers pin deployment ownership before graph/domain locks.
    // Retain the fresh snapshot/authority recheck below at the actual write.
    if (input.beforeGraphLock) await input.beforeGraphLock(tx);
    const contactNode: CommercialGraphNode = { type: "contact", id: input.contactId };
    const businessNode: CommercialGraphNode = { type: "business", id: input.businessId };
    await lockCommercialGraphNodes(tx, [contactNode, businessNode]);
    await lockCommercialGraphMembershipSets(tx, [contactNode, businessNode], ["contact_business"]);
    const contact = (await tx.execute(sql`SELECT id FROM contacts WHERE id=${input.contactId} FOR UPDATE`) as any).rows?.[0];
    const business = (await tx.execute(sql`SELECT id FROM businesses WHERE id=${input.businessId} FOR UPDATE`) as any).rows?.[0];
    if (!contact || !business) throw new Error("CRM_OBJECT_NOT_FOUND");

    const replay = (await tx.execute(sql`SELECT d.id,d.contact_id,d.business_id,e.facts_hash,
        e.source_link_id,e.source_entity_id
      FROM contact_business_link_decisions d
      JOIN contact_business_system_link_evidence e ON e.id=d.system_evidence_id
      WHERE d.decision_key=${input.decisionKey} FOR UPDATE`) as any).rows?.[0];
    if (replay) {
      if (Number(replay.contact_id) !== input.contactId || Number(replay.business_id) !== input.businessId
          || replay.facts_hash !== input.factsHash || String(replay.source_link_id) !== input.sourceLinkId
          || (replay.source_entity_id == null ? null : Number(replay.source_entity_id)) !== input.sourceEntityId) {
        throw new Error("COMMERCIAL_LINK_DIVERGENT_REPLAY");
      }
      return { ...replay, replayed: true };
    }

    if (!(await input.authorityCheck(tx))) throw new Error("SYSTEM_LINK_SNAPSHOT_STALE");
    const current = (await tx.execute(sql`SELECT id,revision FROM contact_business_link_decisions
      WHERE contact_id=${input.contactId} AND superseded_at IS NULL FOR UPDATE`) as any).rows?.[0];
    if (current) throw new Error("CURRENT_LINK_DECISION_EXISTS");
    const evidence = (await tx.execute(sql`INSERT INTO contact_business_system_link_evidence
      (decision_key,contact_id,business_id,source_link_id,source_entity_id,rule_version,facts_hash,facts)
      VALUES (${input.decisionKey},${input.contactId},${input.businessId},${input.sourceLinkId}::uuid,
        ${input.sourceEntityId},${input.ruleVersion},${input.factsHash},${JSON.stringify(input.facts)}::jsonb)
      RETURNING id`) as any).rows?.[0];
    const revision = Number(current?.revision ?? 0) + 1;
    const decision = (await tx.execute(sql`INSERT INTO contact_business_link_decisions
      (contact_id,business_id,decision,decision_key,actor_id,revision,system_evidence_id,reviewed_by,reviewed_at)
      VALUES (${input.contactId},${input.businessId},'verified',${input.decisionKey},'system',${revision},
        ${evidence.id},NULL,NULL) RETURNING *`) as any).rows?.[0];
    await tx.execute(sql`UPDATE contacts SET business_id=${input.businessId},updated_at=now() WHERE id=${input.contactId}`);
    return decision;
  }));
}

/**
 * Task #1999 (C4): read-only projection of the ONLY predicate that may be treated
 * as an authoritative existing contact-business link — decision='verified' AND
 * superseded_at IS NULL, with contacts.business_id consistent with that decision
 * (decideContactBusinessLink above is the sole writer that keeps them consistent).
 * A historical 'verified' row later superseded by 'rejected'/'conflicted' is
 * NEVER returned here. contact_business_link_candidates rows are never authority
 * and are intentionally excluded — callers needing review evidence must query
 * that table directly and must not treat its rows as proof of a link.
 *
 * This function does not alter decision semantics; it only reads the existing
 * append-only ledger written by decideContactBusinessLink.
 */
export interface AuthoritativeContactBusinessLink {
  contactId: number;
  businessId: number;
  decisionId: string;
  revision: number;
  decisionKey: string;
  reviewedAt: string | null;
  contactEmail: string | null;
  contactName: string | null;
  contactTitle: string | null;
}

export async function getAuthoritativeVerifiedContactLinks(
  businessIds: number[],
): Promise<AuthoritativeContactBusinessLink[]> {
  if (businessIds.length === 0) return [];
  const result = await db.execute(sql`
     SELECT d.id AS decision_id, d.revision, d.decision_key, d.contact_id, d.business_id, d.reviewed_at,
           c.email AS contact_email,
           concat_ws(' ', nullif(c.first_name, ''), nullif(c.last_name, '')) AS contact_name,
           c.title AS contact_title
      FROM contact_business_link_decisions d
      JOIN contacts c ON c.id = d.contact_id
       JOIN businesses b ON b.id=d.business_id AND b.record_class='canonical'
     WHERE d.decision = 'verified'
       AND d.superseded_at IS NULL
       AND d.business_id = ANY(ARRAY[${sql.join(businessIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
       -- consistency guard: contacts.business_id (the live projection) must still
       -- agree with the decision ledger, or this row is stale/inconsistent and
       -- must not be treated as authoritative.
       AND c.business_id = d.business_id
        AND c.archived_at IS NULL
        AND c.record_class NOT IN ('test','demo','synthetic')
        AND COALESCE(c.existing_merchant_customer,FALSE)=FALSE
        AND COALESCE(c.do_not_contact,FALSE)=FALSE
        AND COALESCE(c.do_not_auto_contact,FALSE)=FALSE
        AND COALESCE(c.opted_out_email,FALSE)=FALSE
        AND c.opt_out_status IS DISTINCT FROM 'opted_out'
        AND c.unsubscribe_status IS DISTINCT FROM 'unsubscribed'
        AND c.complaint_status IS DISTINCT FROM 'reported'
        AND c.bounce_status IS DISTINCT FROM 'hard'
        AND c.email_status NOT IN ('bounced','invalid')
        AND c.suppression_reason IS NULL
  `);
  const rowsOut = (result as any).rows ?? result ?? [];
  return rowsOut.map((r: any) => ({
    contactId: Number(r.contact_id),
    businessId: Number(r.business_id),
    decisionId: String(r.decision_id),
    revision: Number(r.revision),
    decisionKey: String(r.decision_key),
    reviewedAt: r.reviewed_at ? String(r.reviewed_at) : null,
    contactEmail: r.contact_email ?? null,
    contactName: r.contact_name ?? null,
    contactTitle: r.contact_title ?? null,
  }));
}

export interface CurrentVerifiedContactLinkPin {
  contactId: number;
  businessId: number;
  decisionId: string;
  revision: number;
  normalizedEmailHash: string;
  normalizedEmailHashVersion: 1;
}

/**
 * Transaction-friendly final-boundary guard for consumers that freeze a
 * verified contact source. It deliberately returns only a normalized address
 * digest, never the plaintext email. Passing the caller's executor keeps the
 * authority read in the same transaction/snapshot as the consumer's write.
 */
export async function getCurrentVerifiedContactLinkPin(
  input: {
    contactId: number;
    businessId: number;
    decisionId?: string | null;
    revision?: number | null;
    normalizedEmailHash?: string | null;
    normalizedEmailHashVersion?: number | null;
  },
  executor: { execute: (query: any) => Promise<any> } = db,
): Promise<CurrentVerifiedContactLinkPin | null> {
  const result = await executor.execute(sql`
    SELECT c.id AS contact_id,c.business_id,c.email,d.id AS decision_id,d.revision
      FROM contacts c
      JOIN businesses b ON b.id=c.business_id AND b.record_class='canonical'
      JOIN contact_business_link_decisions d
        ON d.contact_id=c.id AND d.business_id=c.business_id
       AND d.decision='verified' AND d.superseded_at IS NULL
     WHERE c.id=${input.contactId}
       AND c.business_id=${input.businessId}
       AND c.archived_at IS NULL
       AND c.record_class NOT IN ('test','demo','synthetic')
       AND COALESCE(c.existing_merchant_customer,FALSE)=FALSE
       AND COALESCE(c.do_not_contact,FALSE)=FALSE
       AND COALESCE(c.do_not_auto_contact,FALSE)=FALSE
       AND COALESCE(c.opted_out_email,FALSE)=FALSE
       AND c.opt_out_status IS DISTINCT FROM 'opted_out'
       AND c.unsubscribe_status IS DISTINCT FROM 'unsubscribed'
       AND c.complaint_status IS DISTINCT FROM 'reported'
       AND c.bounce_status IS DISTINCT FROM 'hard'
       AND c.email_status NOT IN ('bounced','invalid')
       AND c.suppression_reason IS NULL
       AND c.email IS NOT NULL AND BTRIM(c.email)<>''
     LIMIT 1
     FOR SHARE OF c,b,d
  `);
  const row = (result as any).rows?.[0] ?? (result as any)[0];
  if (!row) return null;
  const normalizedEmailHash = crypto.createHash("sha256")
    .update(`email\u0000${String(row.email).trim().toLowerCase()}`).digest("hex");
  if ((input.decisionId && String(row.decision_id) !== input.decisionId)
      || (input.revision != null && Number(row.revision) !== input.revision)
      || (input.normalizedEmailHash && normalizedEmailHash !== input.normalizedEmailHash)
      || (input.normalizedEmailHashVersion != null && input.normalizedEmailHashVersion !== 1)) {
    return null;
  }
  return {
    contactId: Number(row.contact_id),
    businessId: Number(row.business_id),
    decisionId: String(row.decision_id),
    revision: Number(row.revision),
    normalizedEmailHash,
    normalizedEmailHashVersion: 1,
  };
}

/**
 * Task #1999 (C4): review-evidence-only projection of contact_business_link_candidates
 * for a set of businesses. Never authoritative — callers must never suppress a
 * provider call or attach an email based solely on rows returned here.
 */
export async function getReviewOnlyContactBusinessLinkCandidates(
  businessIds: number[],
): Promise<Array<{ contactId: number; businessId: number; source: string; confidence: number }>> {
  if (businessIds.length === 0) return [];
  const result = await db.execute(sql`
    SELECT contact_id, business_id, source, confidence
      FROM contact_business_link_candidates
     WHERE business_id = ANY(ARRAY[${sql.join(businessIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
  `);
  const rowsOut = (result as any).rows ?? result ?? [];
  return rowsOut.map((r: any) => ({
    contactId: Number(r.contact_id),
    businessId: Number(r.business_id),
    source: String(r.source),
    confidence: Number(r.confidence),
  }));
}

/** Sole writer for legacy-company to canonical-business mapping decisions. */
export async function decideLegacyCompanyMapping(input: {
  companyId: number; businessId?: number | null; decision: MappingDecision; decisionKey: string;
  actorId?: string | null; expectedRevision?: number;
}) {
  if (requiresBusiness(input.decision) !== Boolean(input.businessId)) throw new Error("COMMERCIAL_MAPPING_DECISION_BUSINESS_MISMATCH");
  return db.transaction(async (tx) => {
    const companyNode: CommercialGraphNode = { type: "company", id: input.companyId };
    await lockCommercialGraphNodes(tx, [companyNode]);
    const currentHint = (await tx.execute(sql`SELECT business_id FROM legacy_company_mapping_decisions
      WHERE company_id=${input.companyId} AND superseded_at IS NULL`) as any).rows?.[0];
    const nodes: CommercialGraphNode[] = [
      companyNode,
      ...(input.businessId ? [{ type: "business" as const, id: input.businessId }] : []),
      ...(currentHint?.business_id ? [{ type: "business" as const, id: Number(currentHint.business_id) }] : []),
    ];
    await lockCommercialGraphNodes(tx, nodes.filter(node => node.type === "business"));
    await lockCommercialGraphMembershipSets(tx, nodes, ["legacy_company_business"]);
    const replay = (await tx.execute(sql`SELECT * FROM legacy_company_mapping_decisions WHERE decision_key=${input.decisionKey} FOR UPDATE`) as any).rows?.[0];
    if (replay) {
      if (replay.company_id !== input.companyId || replay.business_id !== (input.businessId ?? null) || replay.decision !== input.decision) throw new Error("COMMERCIAL_MAPPING_DIVERGENT_REPLAY");
      return replay;
    }
    const company = (await tx.execute(sql`SELECT id FROM companies WHERE id=${input.companyId} FOR UPDATE`) as any).rows?.[0];
    const business = input.businessId ? (await tx.execute(sql`SELECT id FROM businesses WHERE id=${input.businessId} FOR UPDATE`) as any).rows?.[0] : true;
    if (!company || !business) throw new Error("CRM_OBJECT_NOT_FOUND");
    const current = (await tx.execute(sql`SELECT * FROM legacy_company_mapping_decisions WHERE company_id=${input.companyId} AND superseded_at IS NULL FOR UPDATE`) as any).rows?.[0];
    if (input.expectedRevision !== undefined && (current?.revision ?? 0) !== input.expectedRevision) throw new CommercialRevisionConflict();
    if (current) await tx.execute(sql`UPDATE legacy_company_mapping_decisions SET superseded_at=now() WHERE id=${current.id}`);
    const revision = (current?.revision ?? 0) + 1;
    const row = (await tx.execute(sql`INSERT INTO legacy_company_mapping_decisions
      (company_id,business_id,decision,decision_key,actor_id,revision)
      VALUES (${input.companyId},${input.businessId ?? null},${input.decision},${input.decisionKey},${input.actorId ?? null},${revision}) RETURNING *`) as any).rows?.[0];
    return row;
  });
}