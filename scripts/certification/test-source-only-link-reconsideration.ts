import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"source-only-link-reconsideration",requireRedis:false});
const {pool,db}=await import("../../server/db");
const {loadEvidenceRelationshipPage}=await import("../../server/services/contact-business-evidence-page");
let checks=0;
try {
  const label=`Source revision ${randomUUID()}`;
  const c=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,updated_at)
    VALUES('Source','Revision',$1,'2025550198',$2,'production',now()-INTERVAL '1 day') RETURNING id,updated_at`,
    [`${randomUUID()}@gmail.com`,label])).rows[0];
  const since=(await pool.query("SELECT clock_timestamp()::text value")).rows[0].value;
  assert.equal((await loadEvidenceRelationshipPage(db,0,100,undefined,since)).previews.length,0);checks++;
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,actor_type,metadata)
    VALUES($1,$2,'csv_import','inbound','system',$3::jsonb)`,
    [c.id,randomUUID(),JSON.stringify({place_id:"revision-place"})]);
  const changed=await loadEvidenceRelationshipPage(db,0,100,undefined,since);
  assert(changed.previews.some((row:any)=>row.contactId===c.id));checks++;
  const oldSnapshot=changed.previews.find((row:any)=>row.contactId===c.id)!.snapshotHash;
  // Native provenance is immutable: a correction is another source observation,
  // never an UPDATE of the original event.
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,actor_type,metadata)
    VALUES($1,$2,'csv_import','inbound','system','{"place_id":"corrected-place"}'::jsonb)`,[c.id,randomUUID()]);
  const updated=await loadEvidenceRelationshipPage(db,0,100,undefined,since);
  assert.notEqual(updated.previews.find((row:any)=>row.contactId===c.id)!.snapshotHash,oldSnapshot);checks++;
  assert.equal((await pool.query("SELECT updated_at FROM contacts WHERE id=$1",[c.id])).rows[0].updated_at.getTime(),
    c.updated_at.getTime());checks++;
  const unchangedSince=(await pool.query("SELECT clock_timestamp()::text value")).rows[0].value;
  const beforeRefresh=(await loadEvidenceRelationshipPage(db,0,1,c.id)).previews[0].snapshotHash;
  await pool.query("UPDATE contact_source_events SET last_seen_at=clock_timestamp() WHERE contact_id=$1",[c.id]);
  assert.equal((await loadEvidenceRelationshipPage(db,0,1,c.id)).previews[0].snapshotHash,beforeRefresh);checks++;
  assert(!(await loadEvidenceRelationshipPage(db,0,100,undefined,unchangedSince)).previews
    .some((row:any)=>row.contactId===c.id));checks++;
  // Older unchanged contacts with supported retained evidence must reach the
  // materializer; the saved change window only bounds repeat work, never
  // permanently excludes them. The materializer's recorded outcome for the SAME
  // contact revision/evidence snapshot defers re-evaluation for 24 hours.
  const old=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,updated_at)
    VALUES('Old','Evidence',$1,'',$2,'production',now()-INTERVAL '30 days') RETURNING id`,
    [`${randomUUID()}@gmail.com`,`Old evidence ${randomUUID()}`])).rows[0];
  const addEvidence=(city:string)=>pool.query(`INSERT INTO contact_source_events
    (contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata,created_at)
    VALUES($1,$2,'ghl_sync','inbound',$3,'system',$4::jsonb,now()-INTERVAL '30 days')`,
    [old.id,randomUUID(),randomUUID(),JSON.stringify({businessEvidence:{canonicalName:"Old Evidence",city}})]);
  await addEvidence("Miami");
  const windowNow=(await pool.query("SELECT clock_timestamp()::text value")).rows[0].value;
  const reaches=async()=>(await loadEvidenceRelationshipPage(db,0,100,undefined,windowNow))
    .previews.find((row:any)=>row.contactId===old.id);
  const reached=await reaches();
  assert(reached && reached.hasSupportedMaterializationEvidence && !reached.eligible);checks++;
  assert(!(await loadEvidenceRelationshipPage(db,0,100,undefined,windowNow)).previews
    .some((row:any)=>row.contactId===c.id),"Contact with unsupported evidence stays excluded");checks++;
  const record=(createdAt:string,revision=reached!.contactRevision,evidence=reached!.materializationEvidenceRevision)=>
    pool.query(`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id,created_at)
      VALUES('contact_link_materialization_outcome','contact',$1,$2::jsonb,'system','system:contact-link-automation',
        ${createdAt})`,[String(old.id),JSON.stringify({status:"held",
        reasonCode:"INDEPENDENT_ORGANIZATION_CORROBORATION_REQUIRED",contactRevision:revision,evidenceRevision:evidence})]);
  await record("now()");
  assert(!await reaches(),"A recent outcome for the same revision defers repeat evaluation");checks++;
  await addEvidence("Orlando");
  assert(await reaches(),"New retained evidence makes the contact reachable again");checks++;
  await pool.query("DELETE FROM audit_logs WHERE action='contact_link_materialization_outcome' AND entity_key=$1",[String(old.id)]);
  const current=await reaches();
  await record("now()-INTERVAL '2 days'",current!.contactRevision,current!.materializationEvidenceRevision);
  assert(await reaches(),"A stale outcome is re-evaluated, since resolver evidence can change");checks++;
  assert((await loadEvidenceRelationshipPage(db,0,1,old.id)).previews.length===1);checks++;
  console.log(`Source-only link reconsideration: ${checks} checks passed without contact timestamp touches`);
} finally {await pool.end();}
