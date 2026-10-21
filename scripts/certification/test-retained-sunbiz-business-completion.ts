import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"retained-sunbiz-business-completion",requireRedis:false});
const {pool}=await import("../../server/db");
const {processRetainedSunbizBusinessCompletionTick:tick,RETAINED_SUNBIZ_COMPLETION_CURSOR_KEY:CURSOR,completeRetainedSunbizEntity:complete}=
  await import("../../server/services/retained-sunbiz-business-completion");
const {normalOrganizationName}=await import("../../server/services/organization-resolution-policy");
let checks=0;
type Opts={contact?:boolean;cold?:boolean;city?:string;state?:string;zip?:string;existing?:"canonical"|"production";site?:boolean};
async function fixture(o:Opts={}){
  const name=`Legacy Completion ${randomUUID().slice(0,8)} LLC`,filing=`lc-${randomUUID()}`;
  let contactId:number|null=null;
  if(o.contact)contactId=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class)
    VALUES('L','C',$1,'',$2,'production') RETURNING id`,[`${randomUUID()}@gmail.com`,name])).rows[0].id;
  const prospect=(await pool.query(`INSERT INTO prospects(company_name,contact_id,status) VALUES($1,$2,'new') RETURNING id`,[name,contactId])).rows[0].id;
  const eid=(await pool.query(`INSERT INTO sunbiz_entities(filing_number,entity_name,score,source,prospect_id,principal_address,principal_city,principal_state,principal_zip,website)
    VALUES($1,$2,$3,'corevt',$4,'10 Legacy Rd',$5,$6,$7,$8) RETURNING id`,
    [filing,name,o.cold?"cold":"hot",prospect,o.city??"Miami",o.state??"FL",o.zip??"33130",o.site===false?null:`https://${filing}.example.com`])).rows[0].id;
  await pool.query(`INSERT INTO sunbiz_bootstrap_claims(filing_number,sunbiz_entity_id,status,deferred_reason_code,completed_at)
    VALUES($1,$2,'deferred_collision','legacy_sunbiz_promotion_exists',now())`,[filing,eid]);
  let businessId:number|undefined;
  if(o.existing)businessId=(await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,city,state,record_class)
    VALUES($1,$2,'Miami','FL',$3) RETURNING id`,[name,normalOrganizationName(name),o.existing]).catch(()=>({rows:[{id:undefined}]}))).rows[0].id;
  return {name,filing,eid,prospect,businessId};
}
const links=async(filing:string)=>(await pool.query(`SELECT business_id,raw_evidence FROM canonical_source_links WHERE source_system='sunbiz' AND source_type='sunbiz_entity' AND stable_key=$1`,[filing])).rows;
const claim=async(filing:string)=>(await pool.query(`SELECT to_jsonb(c) v FROM sunbiz_bootstrap_claims c WHERE filing_number=$1`,[filing])).rows[0].v;
try{
  await pool.query(`DELETE FROM system_settings WHERE key=$1`,[CURSOR]);
  const created=await fixture();
  const matched=await fixture({existing:"canonical"});
  const heldNonCanonical=await fixture({existing:"production"});
  const outside=await fixture({city:"Orlando",zip:"32801"});
  const outOfState=await fixture({state:"NY",city:"Albany",zip:"12207"});
  const withContact=await fixture({contact:true});
  const cold=await fixture({cold:true});
  const all=[created,matched,heldNonCanonical,outside,outOfState,withContact,cold];
  const before=new Map<string,any>();
  for(const f of all)before.set(f.filing,{claim:await claim(f.filing),prospect:(await pool.query("SELECT to_jsonb(p) v FROM prospects p WHERE id=$1",[f.prospect])).rows[0].v});
  const contactsBefore=(await pool.query("SELECT count(*)::int n FROM contacts")).rows[0].n;
  const businessesBefore=(await pool.query("SELECT count(*)::int n FROM businesses")).rows[0].n;

  const result=await tick({limit:200});
  assert(result.created>=1&&result.matched>=1,JSON.stringify(result));checks++;

  const createdLink=await links(created.filing);
  assert.equal(createdLink.length,1);checks++;
  assert.equal(createdLink[0].raw_evidence.representation,"retained_legacy_business_completion_v1");checks++;
  const business=(await pool.query("SELECT record_class,canonical_name FROM businesses WHERE id=$1",[createdLink[0].business_id])).rows[0];
  assert.equal(business.record_class,"canonical");assert.equal(business.canonical_name,created.name);checks+=2;
  if(matched.businessId){
    const l=await links(matched.filing);assert.equal(l.length,1);assert.equal(Number(l[0].business_id),matched.businessId);checks+=2;
  }
  // Held / out-of-scope entities get no lineage and no business.
  for(const f of [heldNonCanonical,outside,outOfState,withContact,cold]){
    assert.equal((await links(f.filing)).length,0,`unexpected link for ${f.name}`);checks++;
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM businesses WHERE canonical_name=ANY($1)",[[outside.name,outOfState.name,withContact.name,cold.name]])).rows[0].n,0);checks++;
  // Original claim and prospect rows are untouched; no contacts were created; no outbound/provider writes.
  for(const f of all){
    assert.deepEqual(await claim(f.filing),before.get(f.filing).claim);
    assert.deepEqual((await pool.query("SELECT to_jsonb(p) v FROM prospects p WHERE id=$1",[f.prospect])).rows[0].v,before.get(f.filing).prospect);checks+=2;
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM contacts")).rows[0].n,contactsBefore);checks++;
  const audit=(await pool.query(`SELECT details FROM audit_logs WHERE action='retained_sunbiz_business_completed' AND entity_key=$1`,[created.filing])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].details.paidProviderCalls,0);assert.equal(audit[0].details.outboundChanges,0);checks+=3;

  // Idempotent: completed entities drop out, a replay creates nothing, and the cursor wraps after the pass.
  const businessesAfter=(await pool.query("SELECT count(*)::int n FROM businesses")).rows[0].n;
  assert(businessesAfter>businessesBefore);checks++;
  await tick({limit:200});
  const replay=await tick({limit:200});
  assert.equal(replay.created,0);assert.equal((await pool.query("SELECT count(*)::int n FROM businesses")).rows[0].n,businessesAfter);checks+=2;
  assert.equal((await links(created.filing)).length,1);checks++;

  // Per-tick limit stops at the last handled entity without skipping the rest.
  await pool.query(`DELETE FROM system_settings WHERE key=$1`,[CURSOR]);
  const a=await fixture(),b=await fixture();
  // Held entities ahead of a/b consume slots too, so drive ticks until both are done.
  let handled=0;
  for(let i=0;i<8&&(await links(a.filing)).length+(await links(b.filing)).length<2;i++){
    const t=await tick({limit:1});
    assert(t.eligible<=1);handled+=t.eligible;
  }
  assert.equal((await links(a.filing)).length+(await links(b.filing)).length,2);checks+=2;
  assert(handled>=2);checks++;

  // Authority fence loss aborts before any write.
  const fenced=await fixture();
  const [row]=(await pool.query(`SELECT se.* FROM sunbiz_entities se WHERE se.id=$1`,[fenced.eid])).rows;
  await assert.rejects(()=>complete(row,async()=>false),/AUTHORITY_FENCE_LOST/);checks++;
  assert.equal((await links(fenced.filing)).length,0);checks++;
  assert.equal((await pool.query("SELECT count(*)::int n FROM businesses WHERE canonical_name=$1",[fenced.name])).rows[0].n,0);checks++;
  console.log(`Retained Sunbiz business completion: ${checks} checks passed; original claims/prospects preserved; zero providers/outbound`);
}finally{await pool.end();}
