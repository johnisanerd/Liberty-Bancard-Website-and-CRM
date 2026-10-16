import fs from "node:fs";
import assert from "node:assert/strict";

/**
 * Owner-executed administration file only. Never imported by server startup, the
 * build command or a production runner.
 *
 * Why this exists: managed Publish applies the table/column/index/FK diff only. It does NOT
 * install PL/pgSQL bodies or triggers. The first-party staged-email link needs (a) the
 * replacement reviewed-link routine (migration 0362 body) and (b) the immutable evidence
 * function + trigger (migration 0361). This file installs exactly those bytes, idempotently,
 * after Publish has created the tables/columns, and refuses to touch an unrecognized routine.
 */
export const FIRST_PARTY_EVIDENCE_TRIGGER_BODY_MD5 = "62110488204b950f599a4defd7483104";
export const FIRST_PARTY_PRE_ROUTINE_INVERSE_MD5 = "db87fee060dbdf3fa4b8c1f07070e5c7";
export const FIRST_PARTY_CURRENT_ROUTINE_INVERSE_MD5 = "36151ce032505a66054e6b8c70daa259";
const CLAUSE_NEW = "AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */";
const CLAUSE_OLD = "AND po.subject_type=''business'' AND po.subject_id=NEW.business_id";

function between(text: string, start: string, end: string) {
  const a = text.indexOf(start);
  assert(a >= 0, `Generator marker missing: ${start}`);
  const b = text.indexOf(end, a);
  assert(b >= 0, `Generator end marker missing: ${end}`);
  return text.slice(a, b + end.length);
}

export function firstPartyNativeOwnerSql() {
  const m361 = fs.readFileSync("migrations/0361_first_party_staged_email_links.sql", "utf8");
  const m362 = fs.readFileSync("migrations/0362_first_party_link_attribution.sql", "utf8");
  const evidenceFunction = between(m361, "CREATE OR REPLACE FUNCTION cro02_first_party_link_evidence_append_only()", "END $$;");
  const evidenceTrigger = between(m361, "CREATE TRIGGER contact_business_first_party_link_evidence_append_only", "cro02_first_party_link_evidence_append_only();");
  const routine = between(m362, "CREATE OR REPLACE FUNCTION enforce_reviewed_contact_business_link()", "END $$;");
  const preflight = `DO $preflight$
BEGIN
  IF to_regclass('public.contact_business_first_party_link_evidence') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='contact_business_first_party_link_evidence'
            AND column_name IN ('crawl_domain','business_site_domain','site_relation'))<>3
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='contact_business_link_decisions'
            AND column_name='first_party_evidence_id' AND data_type='uuid')
     OR to_regclass('public.free_discovery_materialization_outcomes') IS NULL THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_PUBLISH_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
       WHERE p.oid=to_regprocedure('public.enforce_reviewed_contact_business_link()')
         AND strpos(p.prosrc,'${CLAUSE_NEW}')>0
         AND strpos(p.prosrc,'${CLAUSE_OLD}')=0
         AND md5(replace(p.prosrc,'${CLAUSE_NEW}','${CLAUSE_OLD}'))
             IN ('${FIRST_PARTY_PRE_ROUTINE_INVERSE_MD5}','${FIRST_PARTY_CURRENT_ROUTINE_INVERSE_MD5}')) THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_ROUTINE_DRIFT';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.cro02_first_party_link_evidence_append_only()')
       AND md5(prosrc)<>'${FIRST_PARTY_EVIDENCE_TRIGGER_BODY_MD5}') THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_EVIDENCE_FUNCTION_DRIFT';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.contact_business_first_party_link_evidence'::regclass
       AND t.tgname='contact_business_first_party_link_evidence_append_only'
       AND (t.tgfoid IS DISTINCT FROM to_regprocedure('public.cro02_first_party_link_evidence_append_only()')
         OR t.tgenabled NOT IN ('O','A') OR t.tgisinternal OR t.tgqual IS NOT NULL OR t.tgtype<>27)) THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_EVIDENCE_TRIGGER_DRIFT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.contact_business_link_decisions'::regclass
       AND t.tgname='contact_business_link_review_contract' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
       AND t.tgqual IS NULL AND t.tgtype=23
       AND t.tgfoid=to_regprocedure('public.enforce_reviewed_contact_business_link()')) THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_REVIEW_TRIGGER_MISSING';
  END IF;
END $preflight$;`;
  const guardedTrigger = `DO $trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.contact_business_first_party_link_evidence'::regclass
       AND tgname='contact_business_first_party_link_evidence_append_only') THEN
    ${evidenceTrigger}
  END IF;
END $trigger$;`;
  return [
    "-- Explicit versioned owner repair for the first-party staged-email link (migrations 0361/0362 native objects).\n" +
    "-- Run AFTER Publish has created the tables/columns. Standard psql: submit the COMPLETE file.\n" +
    "-- SQL Console: select ALL statements between the standalone BEGIN; and COMMIT; below, from SET LOCAL\n" +
    "-- lock_timeout through END $trigger$;, and run ONCE as a selected batch. The console supplies the\n" +
    "-- transaction; do not run the outer BEGIN; / COMMIT;. Keep every inner DO/function block unchanged.",
    "-- Agent production access remains read-only. No startup/build DDL, no publishing, no guard weakening.",
    "-- Idempotent; refuses to replace an unrecognized routine body (drift aborts the whole transaction).",
    "BEGIN;", "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='120s';",
    preflight, evidenceFunction, guardedTrigger, routine, "COMMIT;", "",
  ].join("\n\n");
}

/** Read-only postcondition; also appended to the console batch. */
export function firstPartyNativeVerificationSql() {
  return `WITH checks AS (SELECT
  (SELECT count(*)=3 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contact_business_first_party_link_evidence'
      AND column_name IN ('crawl_domain','business_site_domain','site_relation')) AS site_relation_columns,
  EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.contact_business_first_party_link_evidence')
      AND t.tgname='contact_business_first_party_link_evidence_append_only' AND t.tgenabled IN ('O','A')
      AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=27
      AND p.pronamespace='public'::regnamespace AND p.proname='cro02_first_party_link_evidence_append_only'
      AND md5(p.prosrc)='${FIRST_PARTY_EVIDENCE_TRIGGER_BODY_MD5}') AS evidence_immutable_trigger,
  EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.contact_business_link_decisions')
      AND t.tgname='contact_business_link_review_contract' AND t.tgenabled IN ('O','A')
      AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=23
      AND p.pronamespace='public'::regnamespace AND p.proname='enforce_reviewed_contact_business_link'
      AND strpos(p.prosrc,'${CLAUSE_NEW}')>0
      AND strpos(p.prosrc,'${CLAUSE_OLD}')=0
      AND md5(replace(p.prosrc,'${CLAUSE_NEW}','${CLAUSE_OLD}'))
          ='${FIRST_PARTY_CURRENT_ROUTINE_INVERSE_MD5}') AS reviewed_link_routine_current
)
SELECT checks.*,
  (site_relation_columns AND evidence_immutable_trigger AND reviewed_link_routine_current) AS repair_verified
FROM checks`;
}

export function firstPartyNativeConsoleSql() {
  const ownerSql = firstPartyNativeOwnerSql();
  const start = ownerSql.indexOf("\n\nBEGIN;\n\n");
  assert(start >= 0, "Owner transaction boundary changed");
  const interior = ownerSql.slice(start + "\n\nBEGIN;\n\n".length).replace(/\n\nCOMMIT;\s*$/, "");
  assert(!/^(?:BEGIN|COMMIT);$/m.test(interior), "Outer client transaction survived");
  const verification = firstPartyNativeVerificationSql();
  return [
    "-- Production SQL Console: replace editor contents with this COMPLETE file.",
    "-- Select ALL text and run ONCE as a batch; the console supplies the transaction.",
    "-- Inner function/DO BEGIN/END blocks must remain unchanged.",
    "-- Completion requires the final repair_verified result to be true.",
    "-- Owner execution only; Agent production access stays read-only.",
    interior,
    `DO $verify_complete$
BEGIN
  IF (SELECT repair_verified FROM (${verification}) verified) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_INCOMPLETE';
  END IF;
END $verify_complete$;`,
    verification + ";", "",
  ].join("\n\n");
}

if (process.argv[1]?.endsWith("generate-first-party-staged-email-native-repair.ts")) {
  const consoleBatch = process.argv.includes("--console");
  const target = consoleBatch
    ? "docs/certification/first-party-staged-email-console-batch-v1.sql"
    : "docs/certification/first-party-staged-email-native-repair-v1.sql";
  fs.writeFileSync(target, consoleBatch ? firstPartyNativeConsoleSql() : firstPartyNativeOwnerSql());
  fs.writeFileSync("docs/certification/first-party-staged-email-native-verify-v1.sql", firstPartyNativeVerificationSql() + ";\n");
  console.log(`Generated ${target} and verify SQL; no database connection or execution.`);
}
