import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {relationshipReasonsSql} from "../../shared/relationship-evidence-sql";
await assertDisposableTestInfrastructure({operation:"source-family-business-materialization",requireRedis:false});
const {pool,db}=await import("../../server/db");
const {materializeSupportedContactBusiness}=await import("../../server/services/contact-business-materialization");
const {loadEvidenceRelationshipPage}=await import("../../server/services/contact-business-evidence-page");
const {applyContactBusinessSystemLink}=await import("../../server/services/contact-business-system-links");
const {assertSystemLinkDatabaseGuard}=await import("../../server/services/commercial-link-authority");
let checks=0;
try {
  await assertSystemLinkDatabaseGuard(db);checks++;
  const domain=`${randomUUID()}.test`,name=`Shared ${randomUUID()}`;
  async function fixture(source:string,city:string,street:string,weak=false){
    const proof={canonicalName:name,websiteDomain:weak ? null : domain,mainPhone:weak ? null : "2025550199",
      streetAddress:weak ? null : street,city:weak ? null : city,state:weak ? null : "Florida"};
    const id=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,address,city,state,website,record_class)
      VALUES('Named','Source',$1,$2,$3,$4,$5,' fl ',$6,'production') RETURNING id`,
      [`${randomUUID()}@gmail.com`,proof.mainPhone ?? "",name,proof.streetAddress,proof.city,proof.websiteDomain])).rows[0].id;
    await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata)
      VALUES($1,$2,$3,'inbound',$4,'system',$5::jsonb)`,
      [id,randomUUID(),source,randomUUID(),JSON.stringify({businessEvidence:proof})]);
    return id;
  }
  for(const [source,city,street] of [["ghl_sync","Fort Lauderdale","10 Main St"],["apollo","Miami","20 Main St"],["manual_crm","West Palm Beach","30 Main St"]]){
    const contactId=await fixture(source,city,street);
    const result=await materializeSupportedContactBusiness(contactId,async()=>{});
    assert.equal(result.status,"materialized");checks++;
    if(result.status!=="materialized")throw new Error("EXPECTED_MATERIALIZATION");
    await pool.query("UPDATE businesses SET canonical_name=$2 WHERE id=$1",[result.businessId,`${name} LLC`]);
    const preview=(await loadEvidenceRelationshipPage(db,0,1,contactId)).previews[0];
    assert(preview.eligible);checks++;
    const parity=(await pool.query(`SELECT crm_automatic_relationship_reasons($1,$2,$3,NULL) native,
      ${relationshipReasonsSql("$1","$2","$3","NULL")} inline`,[contactId,result.businessId,result.sourceLinkId])).rows[0];
    assert.deepEqual(parity.native,parity.inline);assert.deepEqual(parity.native,[]);checks+=2;
    const retainedSource=(await pool.query(`SELECT source_category,source_type,source_external_id,metadata
      FROM contact_source_events WHERE contact_id=$1 ORDER BY id DESC LIMIT 1`,[contactId])).rows[0];
    await pool.query(`INSERT INTO contact_source_events
      (contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata)
      VALUES($1,$2,$3,$4,$5,'system',$6::jsonb)`,[contactId,randomUUID(),retainedSource.source_category,
      retainedSource.source_type,retainedSource.source_external_id,JSON.stringify({businessEvidence:{
        ...retainedSource.metadata.businessEvidence,streetAddress:"99 Contradictory Ave"}})]);
    const corrected=(await pool.query(`SELECT crm_automatic_relationship_reasons($1,$2,$3,NULL) native,
      ${relationshipReasonsSql("$1","$2","$3","NULL")} inline`,[contactId,result.businessId,result.sourceLinkId])).rows[0];
    assert.deepEqual(corrected.native,corrected.inline);
    assert(corrected.native.includes("independent_corroboration_required"));checks+=2;
    await pool.query(`INSERT INTO contact_source_events
      (contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata)
      VALUES($1,$2,$3,$4,$5,'system',$6::jsonb)`,[contactId,randomUUID(),retainedSource.source_category,
      retainedSource.source_type,retainedSource.source_external_id,JSON.stringify(retainedSource.metadata)]);
    const current=(await loadEvidenceRelationshipPage(db,0,1,contactId)).previews[0];
    assert(current.eligible);checks++;
    const applied=await applyContactBusinessSystemLink(current as any);
    assert.equal(applied.status,"applied");checks++;
    const repeated=await materializeSupportedContactBusiness(contactId,async()=>{});
    assert.equal(repeated.status,"preserved");checks++;
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM businesses WHERE website_domain=$1",[domain])).rows[0].n,3);checks++;
  const weak=await fixture("ghl_sync","Fort Lauderdale","40 Main St",true);
  assert.equal((await materializeSupportedContactBusiness(weak,async()=>{})).status,"held");checks++;
  console.log(`Source-family materialization: ${checks} checks passed; personal email allowed; shared-brand locations separate; no providers/outbound`);
} finally {await pool.end();}
