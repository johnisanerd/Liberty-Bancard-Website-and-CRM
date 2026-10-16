import fs from "node:fs";
import assert from "node:assert/strict";

/** Owner-executed administration file only. Never imported by server startup,
 * the build command or a production runner. Preserve canonical routine bytes. */
export function canonicalAddressPreparationOwnerSql() {
  const address=fs.readFileSync("migrations/0330_canonical_address_validation.sql","utf8")
    .replace("CREATE TABLE canonical_address_validation_claims","CREATE TABLE IF NOT EXISTS canonical_address_validation_claims")
    .replace("CREATE INDEX canonical_address_receipt_lookup_idx","CREATE INDEX IF NOT EXISTS canonical_address_receipt_lookup_idx")
    // A database already past migration 0361 holds the same address-receipt body plus the
    // first-party link branch; recognise it as installed instead of reporting drift.
    .replace("md5(replace(body,new_clause,old_clause))='46f89326f7c158ac739814ce343c2559'",
      "md5(replace(body,new_clause,old_clause)) IN ('46f89326f7c158ac739814ce343c2559','36151ce032505a66054e6b8c70daa259')")
    // Same for a database that has the 0361 body but still carries the original address clause.
    .replace("md5(body)<>'46f89326f7c158ac739814ce343c2559'",
      "md5(body) NOT IN ('46f89326f7c158ac739814ce343c2559','36151ce032505a66054e6b8c70daa259')");
  const preparation=fs.readFileSync("migrations/0331_canonical_recipient_preparation.sql","utf8");
  const parts=preparation.split("--> statement-breakpoint").map(part=>part.trim());
  assert.equal(parts.length,5,"Preparation migration structure changed: review the owner delivery generator");
  const columnClause=parts[0].split("  ADD CONSTRAINT canonical_preparation_scope_chk")[0]
    .replaceAll("ADD COLUMN ","ADD COLUMN IF NOT EXISTS ").trim().replace(/,$/,"")+";";
  const constraint=parts[0].slice(parts[0].indexOf("  ADD CONSTRAINT canonical_preparation_scope_chk")).trim();
  const capacityFunction=parts[3].replace("CREATE FUNCTION crm_enforce_canonical_preparation_capacity()",
    "CREATE OR REPLACE FUNCTION crm_enforce_canonical_preparation_capacity()");
  assert(capacityFunction.includes("CREATE OR REPLACE FUNCTION crm_enforce_canonical_preparation_capacity()"));
  const preflight=`DO $preflight$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.crm_enforce_canonical_preparation_capacity()')
    AND md5(prosrc)<>'6e8864b97bd634386a156bca78c2dc5b') THEN
    RAISE EXCEPTION 'CANONICAL_PREPARATION_OWNER_REPAIR_FUNCTION_DRIFT';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.cr04_enrollment_intents'::regclass
    AND t.tgname='canonical_preparation_capacity'
    AND (t.tgfoid IS DISTINCT FROM to_regprocedure('public.crm_enforce_canonical_preparation_capacity()')
      OR t.tgenabled NOT IN ('O','A') OR t.tgisinternal OR t.tgqual IS NOT NULL OR t.tgtype<>23)) THEN
    RAISE EXCEPTION 'CANONICAL_PREPARATION_OWNER_REPAIR_TRIGGER_DRIFT';
  END IF;
END $preflight$;`;
  const guardedConstraint=`DO $constraint$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.cr04_enrollment_intents'::regclass
    AND conname='canonical_preparation_scope_chk') THEN
    ALTER TABLE cr04_enrollment_intents ${constraint}
  END IF;
END $constraint$;`;
  const indexes=parts.slice(1,3).join("\n").replaceAll("CREATE UNIQUE INDEX ","CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replaceAll("CREATE INDEX ","CREATE INDEX IF NOT EXISTS ");
  const trigger=`DO $trigger$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.cr04_enrollment_intents'::regclass
    AND tgname='canonical_preparation_capacity') THEN
    ${parts[4]}
  END IF;
END $trigger$;`;
  return [
    "-- Explicit versioned owner repair. Standard psql: submit the COMPLETE file.\n"+
    "-- SQL Console: select ALL statements between the standalone BEGIN; and COMMIT;\n"+
    "-- below, from SET LOCAL lock_timeout through END $trigger$;, and run ONCE as a\n"+
    "-- selected batch. The console supplies the transaction; do not run the outer\n"+
    "-- BEGIN; / COMMIT;. Keep every inner DO/function BEGIN/END block unchanged.",
    "-- Agent production access remains read-only. No startup/build DDL or publishing.",
    "-- Installs only canonical address/preparation prerequisites; not discovery or whole-task acceptance.",
    "BEGIN;","SET LOCAL lock_timeout='5s';","SET LOCAL statement_timeout='120s';",
    preflight,address,columnClause,guardedConstraint,indexes,capacityFunction,trigger,"COMMIT;","",
  ].join("\n\n");
}

/** Read-only postcondition shared by the console footer and its result row. */
export function canonicalAddressPreparationVerificationSql() {
  return `WITH checks AS (SELECT
  to_regclass('public.canonical_address_validation_claims') IS NOT NULL AS address_claims_present,
  (SELECT count(*)=5 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cr04_enrollment_intents'
      AND (column_name,data_type) IN (('program_id','uuid'),('business_id','integer'),
        ('normalized_email_hash','text'),('preparation_state','text'),
        ('preparation_snapshot','jsonb'))) AS preparation_fields_present,
  EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.cr04_enrollment_intents')
      AND t.tgname='canonical_preparation_capacity' AND t.tgenabled IN ('O','A')
      AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=23
      AND p.pronamespace='public'::regnamespace
      AND p.proname='crm_enforce_canonical_preparation_capacity'
      AND md5(p.prosrc)='6e8864b97bd634386a156bca78c2dc5b') AS preparation_capacity_exact,
  EXISTS(SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure('public.enforce_reviewed_contact_business_link()')
      AND strpos(p.prosrc,'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */')>0
      AND strpos(p.prosrc,'AND po.subject_type=''business'' AND po.subject_id=NEW.business_id')=0
      AND md5(replace(p.prosrc,
        'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */',
        'AND po.subject_type=''business'' AND po.subject_id=NEW.business_id'))
        IN ('46f89326f7c158ac739814ce343c2559',  -- approved original routine
            '36151ce032505a66054e6b8c70daa259')  -- plus the migration-0362 first-party link branch
      ) AS address_receipt_exact,
  EXISTS(SELECT 1 FROM pg_constraint
    WHERE conrelid=to_regclass('public.cr04_enrollment_intents')
      AND conname='canonical_preparation_scope_chk' AND contype='c'
      AND convalidated AND conislocal AND coninhcount=0) AS preparation_scope_constraint_present,
  to_regclass('public.canonical_address_receipt_lookup_idx') IS NOT NULL AS address_receipt_index_present,
  to_regclass('public.canonical_preparation_business_program_idx') IS NOT NULL AS preparation_index_present,
  to_regclass('public.canonical_preparation_sequence_address_idx') IS NOT NULL AS preparation_unique_index_present
)
SELECT checks.*,
  (address_claims_present AND preparation_fields_present AND preparation_capacity_exact
    AND address_receipt_exact AND preparation_scope_constraint_present
    AND address_receipt_index_present AND preparation_index_present
    AND preparation_unique_index_present) AS repair_verified
FROM checks`;
}

/** Same canonical installation bytes, with only the outer client transaction
 * removed and a rejecting postcondition added. SQL Console owns its batch tx. */
export function canonicalAddressPreparationConsoleSql() {
  const ownerSql=canonicalAddressPreparationOwnerSql();
  const start=ownerSql.indexOf("\n\nBEGIN;\n\n");
  assert(start>=0,"Canonical owner transaction boundary changed");
  const interior=ownerSql.slice(start+"\n\nBEGIN;\n\n".length)
    .replace(/\n\nCOMMIT;\s*$/,"");
  assert(!/^(?:BEGIN|COMMIT);$/m.test(interior),"Outer client transaction survived");
  const verification=canonicalAddressPreparationVerificationSql();
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
    RAISE EXCEPTION 'CANONICAL_ADDRESS_PREPARATION_REPAIR_INCOMPLETE';
  END IF;
END $verify_complete$;`,
    verification+";","",
  ].join("\n\n");
}

if(process.argv[1]?.endsWith("generate-canonical-address-preparation-repair.ts")) {
  const consoleBatch=process.argv.includes("--console");
  const target=consoleBatch
    ? "docs/certification/canonical-enrichment-address-preparation-console-batch-v1.sql"
    : "docs/certification/canonical-enrichment-address-preparation-native-repair-v1.sql";
  fs.writeFileSync(target,consoleBatch
    ? canonicalAddressPreparationConsoleSql() : canonicalAddressPreparationOwnerSql());
  console.log(`Generated ${target}; no database connection or execution.`);
}