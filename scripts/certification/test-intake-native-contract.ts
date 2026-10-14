import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {sourceFamilyRelationshipReasonsSql} from "../../shared/source-family-relationship-sql";
import {evaluateSouthFloridaGeography} from "../../server/services/cro03a/geography";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";
await assertDisposableTestInfrastructure({operation:"intake-native-contract",requireRedis:false});
applyCertificationProviderDenyBoundary({fatal:true});
const {pool,db}=await import("../../server/db");
const {hasBridgeEvidenceNativeGuard}=await import("../../server/services/provider-import-identity");
try {
  assert(await hasBridgeEvidenceNativeGuard(db));
  const installed=(await pool.query(`SELECT proname,md5(prosrc) body_hash FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname IN (
      'crm_source_family_relationship_reasons','crm_automatic_relationship_reasons',
      'enforce_reviewed_contact_business_link') ORDER BY proname`)).rows;
  console.log("INTAKE_NATIVE_FINGERPRINTS",JSON.stringify(installed));
  console.log("INTAKE_GUARD_ADDRESS_INVERSE_HASH",(await pool.query(`SELECT md5(replace(prosrc,
    'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */',
    'AND po.subject_type=''business'' AND po.subject_id=NEW.business_id')) hash FROM pg_proc
    WHERE oid='public.enforce_reviewed_contact_business_link()'::regprocedure`)).rows[0].hash);
  const body=`\n  SELECT ${sourceFamilyRelationshipReasonsSql("contact_key","business_key","source_key")}\n`;
  assert.equal(installed.find(row=>row.proname==="crm_source_family_relationship_reasons")!.body_hash,
    createHash("md5").update(body).digest("hex"),"Native source-family function equals read-side SQL exactly");
  const migrated=readFileSync("migrations/0349_source_family_relationship_identity.sql","utf8");
  assert(migrated.includes(body));
  const inputs={county:"Broward",zip:"33301"};
  for(const state of ["FL"," fl ","Florida"," florida "])
    assert(evaluateSouthFloridaGeography({...inputs,state}).eligible);
  assert(!evaluateSouthFloridaGeography({...inputs,state:"GA"}).eligible);
  assert(!evaluateSouthFloridaGeography({county:"Broward",zip:"33101",state:"FL"}).eligible);
  assert(!evaluateSouthFloridaGeography({county:"Monroe",state:"Florida"}).eligible);
  assert(!evaluateSouthFloridaGeography({}).eligible);
  console.log("Intake native guard and alias contract passed");
  const {claimCsvExecution,completeImportExecution}=await import("../../server/services/import-execution");
  const {materializeCanonicalProviderImportRow}=await import("../../server/services/canonical-provider-import");
  const suffix=randomUUID();
  const rawRow={name:`[TEST] replay hold ${suffix}`,place_id:`test-place-${suffix}`,
    email:`replay.${suffix}@example.invalid`,phone:"2025550199",address:"100 Native Test Street",
    city:"Fort Lauderdale",state:"FL"};
  const claim=await claimCsvExecution({fileHash:randomUUID(),totalRows:1,actorType:"system",
    actorId:"native-replay-hold",sourcePayload:[rawRow],metadata:{sourceFormat:"google_maps_outscraper"}});
  const input={executionId:claim.execution.id,claimToken:claim.claimToken!,
    sourceRowNumber:1,sourceFormat:"google_maps_outscraper",actorId:"native-replay-hold",rawRow};
  const first=await materializeCanonicalProviderImportRow(input);
  assert.equal(first.fulfillmentState,"completed");
  const original=(await pool.query(`SELECT * FROM import_row_dispositions WHERE execution_id=$1`,
    [claim.execution.id])).rows[0];
  assert.equal(original.disposition,"created");
  // Current organization evidence contradicts the unchanged retained original.
  // Replay must hold the current item, not rewrite its already committed receipt.
  await pool.query("UPDATE businesses SET state='GA' WHERE id=$1",[first.businessId]);
  const held=await materializeCanonicalProviderImportRow(input);
  assert.equal(held.fulfillmentState,"held");
  assert.deepEqual((await pool.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",
    [claim.execution.id])).rows[0],original,"Original receipt stays byte-for-byte equal");
  const item=(await pool.query(`SELECT item.id,item.state,item.terminal_code FROM cro03_enrichment_items item
    JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
    WHERE batch.idempotency_key=$1`,[`csv-source:${claim.execution.id}:1`])).rows[0];
  assert.equal(item.state,"blocked");
  assert.match(item.terminal_code,/^CANONICAL_IMPORT_/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_logs
    WHERE action='canonical_import_hold_evidence' AND entity_key=$1
      AND details->>'rowFingerprint'=$2`,[String(item.id),original.row_fingerprint])).rows[0].n,1);
  assert((await completeImportExecution({executionId:claim.execution.id,claimToken:claim.claimToken!,
    expectedRows:1})).completed,"A committed evidence-backed hold closes ordinary accounting");
  const {processPersistedCsvImport}=await import("../../server/services/csv-import-processor");
  const {isRecoverableImportRowFailure}=await import("../../server/services/canonical-import-recovery-outcomes");
  const abortRaw={...rawRow,name:`[TEST] confirmed abort ${suffix}`,place_id:`abort-place-${suffix}`,
    email:`abort.${suffix}@example.invalid`,address:"200 Native Test Street"};
  const abortClaim=await claimCsvExecution({fileHash:randomUUID(),totalRows:1,actorType:"system",
    actorId:"native-confirmed-abort",sourcePayload:[abortRaw],
    metadata:{sourceFormat:"google_maps_outscraper"}});
  await pool.query(`CREATE FUNCTION cert_import_abort() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.email LIKE 'abort.%@example.invalid' THEN
      RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='CERT_CONFIRMED_IMPORT_ABORT';
    END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER cert_import_abort BEFORE INSERT ON contacts
    FOR EACH ROW EXECUTE FUNCTION cert_import_abort()`);
  await assert.rejects(()=>processPersistedCsvImport({records:[abortRaw],executionClaim:abortClaim,
    importRecord:{id:0} as any,sourceFormat:"google_maps_outscraper",
    actor:{actorType:"system",actorId:"native-confirmed-abort"},filename:"native-abort.csv"}),
    (error)=>isRecoverableImportRowFailure(error));
  assert.equal((await pool.query(`SELECT count(*)::int n FROM import_row_dispositions
    WHERE execution_id=$1`,[abortClaim.execution.id])).rows[0].n,0,
    "Confirmed transient abort must not manufacture immutable failed accounting");
  assert(!(await completeImportExecution({executionId:abortClaim.execution.id,
    claimToken:abortClaim.claimToken!,expectedRows:1})).completed);
  await pool.query("DROP TRIGGER cert_import_abort ON contacts");
  await pool.query("DROP FUNCTION cert_import_abort()");
  const resumed=await materializeCanonicalProviderImportRow({...input,rawRow:abortRaw,
    executionId:abortClaim.execution.id,claimToken:abortClaim.claimToken!});
  assert.equal(resumed.fulfillmentState,"completed");
  assert((await completeImportExecution({executionId:abortClaim.execution.id,
    claimToken:abortClaim.claimToken!,expectedRows:1})).completed);
  assert.equal(getBlockedCertificationNetworkAttemptCount(),0);
  console.log("PASS native current hold and confirmed-abort retry; immutable accounting and zero external effects");
} finally {await pool.end();}
