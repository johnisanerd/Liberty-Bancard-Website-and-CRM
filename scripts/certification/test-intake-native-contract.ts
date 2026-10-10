import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {sourceFamilyRelationshipReasonsSql} from "../../shared/source-family-relationship-sql";
import {evaluateSouthFloridaGeography} from "../../server/services/cro03a/geography";
await assertDisposableTestInfrastructure({operation:"intake-native-contract",requireRedis:false});
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
} finally {await pool.end();}
