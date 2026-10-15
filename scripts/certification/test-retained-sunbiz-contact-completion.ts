import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"retained-sunbiz-contact-completion",requireRedis:false});
const {pool,db}=await import("../../server/db");
const {materializeSupportedContactBusiness:materialize}=await import("../../server/services/contact-business-materialization");
const {loadEvidenceRelationshipPage:load}=await import("../../server/services/contact-business-evidence-page");
const {applyContactBusinessSystemLink:apply}=await import("../../server/services/contact-business-system-links");
const {normalOrganizationName}=await import("../../server/services/organization-resolution-policy");
const {relationshipReasonsSql}=await import("../../shared/relationship-evidence-sql");
let checks=0;
async function fixture(options:{nameConflict?:boolean;stateConflict?:boolean;existing?:boolean;noncanonical?:boolean;ambiguous?:boolean;cold?:boolean}={}){
  const name=`Retained ${randomUUID()} LLC`,filing=`legacy-${randomUUID()}`;
  const id=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,city,state,record_class,updated_at)
    VALUES('Retained','Source',$1,'',$2,'Miami',$3,'production',now()-interval '30 days') RETURNING id`,
    [`${randomUUID()}@gmail.com`,options.nameConflict ? "Contradictory Company" : name,options.stateConflict ? "Alabama" : "Florida"])).rows[0].id;
  const prospect=(await pool.query(`INSERT INTO prospects(company_name,contact_id,status) VALUES($1,$2,'converted') RETURNING id`,[name,id])).rows[0].id;
  async function entity(key:string){
    const e=(await pool.query(`INSERT INTO sunbiz_entities(filing_number,entity_name,score,source,prospect_id,principal_address,principal_city,principal_state)
      VALUES($1,$2,$3,'sunbiz',$4,'10 Retained Rd','Miami','Florida') RETURNING id`,[key,name,options.cold ? "cold":"hot",prospect])).rows[0].id;
    await pool.query(`INSERT INTO sunbiz_bootstrap_claims(filing_number,sunbiz_entity_id,status,deferred_reason_code,completed_at)
      VALUES($1,$2,'deferred_collision','legacy_sunbiz_promotion_exists',now())`,[key,e]);
    return e;
  }
  const eid=await entity(filing);if(options.ambiguous)await entity(`other-${randomUUID()}`);
  let businessId:number|undefined;
  if(options.existing)businessId=(await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,city,state,record_class)
    VALUES($1,$2,'Miami','Florida',$3) RETURNING id`,[name,normalOrganizationName(name),
      options.noncanonical ? "production":"canonical"])).rows[0].id;
  return {id,filing,eid,businessId};
}
try{
  for(const existing of [false,true]){
    const f=await fixture({existing});
    const before=(await pool.query(`SELECT to_jsonb(c) v FROM sunbiz_bootstrap_claims c WHERE filing_number=$1`,[f.filing])).rows[0].v;
    const original=(await pool.query("SELECT company_name,phone,email,city,state FROM contacts WHERE id=$1",[f.id])).rows[0];
    const preview=(await load(db,0,1,f.id)).previews[0];
    assert(preview.hasSupportedMaterializationEvidence);checks++;
    const window=(await pool.query("SELECT clock_timestamp()::text t")).rows[0].t;
    assert((await load(db,f.id-1,1,undefined,window)).previews.some(r=>r.contactId===f.id));checks++;
    const out=await materialize(f.id,async()=>{});
    assert.equal(out.status,existing?"matched":"materialized",JSON.stringify(out));checks++;
    if(out.status!=="matched" && out.status!=="materialized")throw new Error(JSON.stringify(out));
    if(existing)assert.equal(out.businessId,f.businessId);
    const refreshed=(await load(db,0,1,f.id)).previews[0];
    assert(refreshed.eligible,JSON.stringify(refreshed));checks++;
    const parity=(await pool.query(`SELECT crm_automatic_relationship_reasons($1,$2,$3,$4) native,
      ${relationshipReasonsSql("$1","$2","$3","$4")} inline`,[f.id,out.businessId,out.sourceLinkId,f.eid])).rows[0];
    assert.deepEqual(parity.native,[]);assert.deepEqual(parity.native,parity.inline);checks+=2;
    assert.equal((await apply(refreshed as any)).status,"applied");checks++;
    assert.equal((await materialize(f.id,async()=>{})).status,"preserved");checks++;
    assert.deepEqual((await pool.query("SELECT to_jsonb(c) v FROM sunbiz_bootstrap_claims c WHERE filing_number=$1",[f.filing])).rows[0].v,before);checks++;
    assert.deepEqual((await pool.query("SELECT company_name,phone,email,city,state FROM contacts WHERE id=$1",[f.id])).rows[0],original);checks++;
    assert.equal((await pool.query("SELECT count(*)::int n FROM contact_source_events WHERE contact_id=$1",[f.id])).rows[0].n,1);checks++;
  }
  for(const [options,reason] of [
    [{nameConflict:true},"RETAINED_REGISTRY_IDENTITY_UNSUPPORTED"],
    [{stateConflict:true},"RETAINED_REGISTRY_LOCATION_CONFLICT"],
    [{ambiguous:true},"RETAINED_REGISTRY_SOURCE_AMBIGUOUS"],
    [{cold:true},"RETAINED_REGISTRY_IDENTITY_UNSUPPORTED"],
    [{existing:true,noncanonical:true},"RETAINED_REGISTRY_BUSINESS_NOT_CANONICAL"],
  ] as const){
    const f=await fixture(options),out=await materialize(f.id,async()=>{});
    assert.equal(out.status,"held");assert.equal("reasonCode" in out ? out.reasonCode : null,reason);checks+=2;
    assert.equal((await pool.query("SELECT count(*)::int n FROM contact_source_events WHERE contact_id=$1",[f.id])).rows[0].n,0);checks++;
  }
  const fenced=await fixture();
  await assert.rejects(()=>materialize(fenced.id,async()=>false),/AUTHORITY_FENCE_LOST/);checks++;
  assert.equal((await pool.query("SELECT count(*)::int n FROM canonical_source_links WHERE stable_key=$1",[fenced.filing])).rows[0].n,0);checks++;
  console.log(`Retained Sunbiz contact completion: ${checks} checks passed; original holds/identity preserved; zero providers/outbound`);
}finally{await pool.end();}
