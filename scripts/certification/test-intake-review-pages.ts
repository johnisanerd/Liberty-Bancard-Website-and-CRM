import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import {CONTACT_LINK_COVERAGE_BATCH_SQL} from "../../server/services/contact-link-coverage-query";
import {CONTACT_LINK_COVERAGE_BATCH_SQL as PRIOR_COVERAGE_SQL} from "./fixtures/contact-link-coverage-prior";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"intake authenticated review pages",requireRedis:false});
const {pool}=await import("../../server/db");
const {setupAuth}=await import("../../server/replit_integrations/auth/replitAuth");
const {registerContactLinkCoverageRoutes}=await import("../../server/routes/contact-link-coverage");
const {listContactLinkCoverageCandidates}=await import("../../server/services/contact-link-coverage");
const app=express();app.use(express.json());
await setupAuth(app);
const unused=async()=>{throw new Error("UNUSED_REVIEW_FIXTURE_OPERATION");};
registerContactLinkCoverageRoutes(app,{getStatus:unused,listCandidates:listContactLinkCoverageCandidates,
  start:unused,step:unused,pause:unused,resume:unused,reviewBatch:unused,
  previewSourceRecoveryBatch:unused,applySourceRecoveryBatch:unused,auditSourceRecovery:unused});
const server=await new Promise<ReturnType<typeof app.listen>>(resolve=>{
  const value=app.listen(0,"127.0.0.1",()=>resolve(value));
});
const url=`http://127.0.0.1:${(server.address() as any).port}`;
let checks=0;
try {
  const contact=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class)
    VALUES('Review','Fixture',$1,'','Review Fixture','production') RETURNING id`,[`${randomUUID()}@gmail.com`])).rows[0];
  const business=(await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,record_class)
    VALUES('Review Fixture','reviewfixture','canonical') RETURNING id`)).rows[0];
  for(let i=0;i<3;i++)await pool.query(`INSERT INTO contact_business_link_candidates
    (contact_id,business_id,source,source_version,candidate_key,confidence,created_at)
    VALUES($1,$2,'sdr_orchestration','contact_link_coverage_v1',$3,50,
      '2020-01-01T00:00:00.123456Z')`,[contact.id,business.id,randomUUID()]);
  const pagePath="/api/admin/contact-link-coverage/candidates";
  // Compare the full native read against the actual prior implementation,
  // not a hand-written approximation or a fixture's expected candidate count.
  const params=[0,2147483647,500,[contact.id]];
  const oldRows=(await pool.query(PRIOR_COVERAGE_SQL,params)).rows;
  const newRows=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,params)).rows;
  assert.deepEqual(newRows,oldRows,"Indexed read must retain every fact, proof and candidate");checks++;
  const edgeBusiness=(await pool.query(`INSERT INTO businesses
    (canonical_name,normalized_name,website_domain,main_phone,street_address,city,state,record_class)
    VALUES('Thé Anchor Café, Incorporated','th anchor caf','www.anchor-key.example',
    '13055550099','10 Main St.','Miami','FL','canonical') RETURNING id`)).rows[0];
  const edgeFiling=`COV-${randomUUID()}`;
  await pool.query(`INSERT INTO sunbiz_entities(entity_name,dba,filing_number,website,phone,owner_phone,
    principal_address,principal_city,principal_state,source)
    VALUES('Anchor Site Alias Inc','Thé Anchor Café LLC',$1,
    'https://www.anchor-key.example.:443/path?x=1','+1 (305) 555-0099','305-555-0199',
    '10 Main St.','Miami','FL','sunbiz')`,[edgeFiling]);
  await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
    VALUES($1,'sunbiz','sunbiz_entity',$2)`,[edgeBusiness.id,edgeFiling]);
  const edgeContacts=(await pool.query(`INSERT INTO contacts
    (first_name,last_name,company_name,email,website,phone,address,city,state,row_provenance,record_class)
    VALUES('Key','Fixture','Thé Anchor Café LLC',$1,'https://www.anchor-key.example/path?x=1',
      '+1 (305) 555-0099','10 Main St.','Miami','FL','{}','production'),
    ('Key','Fixture','Owner Phone Only',$2,NULL,'305-555-0199',NULL,NULL,NULL,'{}','production'),
    ('Key','Fixture','Filing Only',$3,NULL,'',NULL,NULL,NULL,
      jsonb_build_object('filingNumber',lower($4::text)),'production'),
    ('Key','Fixture','Anchor Site Alias',$5,NULL,'',NULL,NULL,NULL,'{}','production')
    RETURNING id`,[`${randomUUID()}@gmail.com`,`${randomUUID()}@gmail.com`,
      `${randomUUID()}@gmail.com`,edgeFiling,`${randomUUID()}@gmail.com`])).rows;
  const edgeParams=[0,2147483647,500,edgeContacts.map(row=>row.id)];
  const edgePrior=(await pool.query(PRIOR_COVERAGE_SQL,edgeParams)).rows;
  const edgeIndexed=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,edgeParams)).rows;
  assert.deepEqual(edgeIndexed,edgePrior,
    "Legal suffixes/Unicode, URL/phone/address, source DBA/name/owner-phone and filing keys retain parity");checks++;
  assert(edgeIndexed.every(row=>row.businesses.some((b:any)=>b.businessId===edgeBusiness.id)),
    "Each independently selected identity-key branch must hydrate the same real business");checks++;

  // Exercise the rewritten competing-address evaluator, not only lookups that
  // never enter that branch. The prior helper retains its original broad scan.
  const competitor=(await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,record_class)
    VALUES('Independent competing site','independent competing site','canonical') RETURNING id`)).rows[0];
  const competitorFiling=`COV-PEER-${randomUUID()}`;
  await pool.query(`INSERT INTO sunbiz_entities(entity_name,filing_number,
    principal_address,principal_city,principal_state,source)
    VALUES('Thé Anchor Café LLC',$1,'10 Main St.','Miami','Florida','cordata')`,[competitorFiling]);
  await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
    VALUES($1,'sunbiz','sunbiz_entity',$2)`,[competitor.id,competitorFiling]);
  const competitorPrior=(await pool.query(PRIOR_COVERAGE_SQL,edgeParams)).rows;
  const competitorIndexed=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,edgeParams)).rows;
  assert.deepEqual(competitorIndexed,competitorPrior,
    "Indexed competing-registry probes retain full independent conflict evidence");checks++;
  assert(competitorIndexed.find(row=>row.contactId===edgeContacts[0].id).businesses
    .find((b:any)=>b.businessId===edgeBusiness.id).automaticRelationshipReasons
    .includes("address_competing_businesses"),"The conflict branch actually executed");checks++;

  // Missing source entities still contribute filing-only candidates. An inner
  // join for every source key would silently lose this retained source link.
  const missingFiling=`COV-MISSING-${randomUUID()}`;
  await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
    VALUES($1,'sunbiz','sunbiz_entity',$2)`,[competitor.id,missingFiling]);
  const filingContact=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,
    row_provenance,record_class) VALUES('Missing entity','Fixture',$1,'','Filing-only retained identity',
    jsonb_build_object('filingNumber',lower($2::text)),'production') RETURNING id`,
    [`${randomUUID()}@gmail.com`,missingFiling])).rows[0];
  const filingParams=[0,2147483647,500,[filingContact.id]];
  const filingIndexed=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,filingParams)).rows;
  assert.deepEqual(filingIndexed,(await pool.query(PRIOR_COVERAGE_SQL,filingParams)).rows);checks++;
  assert(filingIndexed[0].businesses.some((b:any)=>b.businessId===competitor.id));checks++;
  // Capture after every relevant fixture mutation. The missing-entity link is
  // also a real fact on the competing business seen by the original contacts.
  const beforeNoiseSourceRows=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,edgeParams)).rows;
  // A few source-backed contacts did not reproduce per-page-key universe hash
  // rebuilds. Retain the complete 500-contact payload and frozen-query oracle.
  // Owner-phone evidence deliberately differs from the business main phone:
  // these remain independent-corroboration holds, not fabricated valid links.
  const pagePrefix=randomUUID();
  const fullPageContacts=(await pool.query(`INSERT INTO contacts
    (first_name,last_name,company_name,email,phone,record_class)
    SELECT 'Page','Fixture','Owner Phone Only '||n,$1::text||'.'||n||'@gmail.com',
      '305-555-0199','production' FROM generate_series(1,500) n RETURNING id`,
    [pagePrefix])).rows;
  const fullPageParams=[0,2147483647,500,fullPageContacts.map(row=>row.id)];
  const fullPagePrior=(await pool.query(PRIOR_COVERAGE_SQL,fullPageParams)).rows;
  assert.equal(fullPagePrior.length,500);checks++;
  assert(fullPagePrior.every(row=>row.businesses.some((b:any)=>b.businessId===edgeBusiness.id)),
    "Full-page fixture must actually exercise indexed source-owned keys");checks++;

  // Production-sized unrelated population. This is local serving-volume proof,
  // not a replacement for timing the deployed corrected primary request.
  await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,website_domain,main_phone,
    street_address,city,state,record_class)
    SELECT 'Coverage noise '||n,'coverage noise '||n,'coverage-noise-'||n||'.example.invalid',
    '800'||lpad(n::text,7,'0'),n||' Noise Street','Noise City','FL','canonical'
    FROM generate_series(1,147000) n`);
  await pool.query(`INSERT INTO sunbiz_entities(entity_name,filing_number,website,phone,
    principal_address,principal_city,principal_state,source)
    SELECT 'Coverage noise '||n,'COVNOISE'||n,'https://coverage-noise-'||n||'.example.invalid',
    '800'||lpad(n::text,7,'0'),n||' Noise Street','Noise City','FL','sunbiz'
    FROM generate_series(1,127000) n`);
  // Real INSERT guards acquire business-scoped advisory locks. Populate in
  // bounded committed transactions instead of exhausting native lock slots.
  for(let start=1;start<=127000;start+=512) {
    await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
      SELECT b.id,'sunbiz','sunbiz_entity','COVNOISE'||split_part(b.normalized_name,' ',3)
      FROM businesses b WHERE b.normalized_name IN (
        SELECT 'coverage noise '||n FROM generate_series($1::integer,$2::integer) n)`,
      [start,Math.min(start+511,127000)]);
  }
  await pool.query("ANALYZE businesses");
  await pool.query("ANALYZE sunbiz_entities");
  await pool.query("ANALYZE canonical_source_links");
  const scaledStart=performance.now();
  const scaledRows=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,params)).rows;
  const scaledMs=performance.now()-scaledStart;
  assert.deepEqual(scaledRows,newRows,"Unrelated native population must not change hydrated facts");checks++;
  console.log(JSON.stringify({event:"intake_review_native_volume",businesses:147003,
    linkedSources:127003,contactIds:1,elapsedMs:scaledMs,productionExecution:false}));
  const sourceScaledStart=performance.now();
  const sourceScaledRows=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,edgeParams)).rows;
  const sourceScaledMs=performance.now()-sourceScaledStart;
  assert.deepEqual(sourceScaledRows,beforeNoiseSourceRows,
    "Source-backed domain/DBA/name/owner-phone/filing proofs retain parity at native serving volume");checks++;
  console.log(JSON.stringify({event:"intake_review_source_native_volume",businesses:147003,
    linkedSources:127003,contactIds:edgeContacts.length,elapsedMs:sourceScaledMs,productionExecution:false}));
  const plan=(await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+CONTACT_LINK_COVERAGE_BATCH_SQL,params)).rows[0]["QUERY PLAN"];
  const planText=JSON.stringify(plan);
  assert(planText.includes("businesses_coverage_name_key_idx"),
    "Actual plan must use the native indexed name key");checks++;
  const fullPageStart=performance.now();
  const fullPageRows=(await pool.query(CONTACT_LINK_COVERAGE_BATCH_SQL,fullPageParams)).rows;
  const fullPageMs=performance.now()-fullPageStart;
  assert.deepEqual(fullPageRows,fullPagePrior,
    "Complete 500-contact payload retains frozen-query parity at native serving volume");checks++;
  const fullPagePlan=(await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+
    CONTACT_LINK_COVERAGE_BATCH_SQL,fullPageParams)).rows[0]["QUERY PLAN"];
  function nodes(node:any):any[] {
    return [node,...(node.Plans ?? []).flatMap(nodes)];
  }
  const pairPlan=nodes(fullPagePlan[0].Plan).find(node=>node["Subplan Name"]==="CTE candidate_pairs");
  assert(pairPlan,"Actual full-page plan must contain the bounded candidate-pair stage");checks++;
  assert(!nodes(pairPlan).some(node=>node["Node Type"]==="Seq Scan" &&
    ["businesses","canonical_source_links"].includes(node["Relation Name"]) &&
    node["Actual Loops"]>1),
    "Source-owned page keys must not repeatedly scan the full business/source universe");checks++;
  assert(nodes(pairPlan).some(node=>node["Index Name"]==="canonical_source_links_namespace_key_unique" &&
    node["Actual Loops"]>0),"Full-page source namespace probe must execute its index");checks++;
  assert(nodes(pairPlan).some(node=>node["Index Name"]==="businesses_pkey" &&
    node["Actual Loops"]>0),"Business existence remains an executed PK probe");checks++;
  console.log(JSON.stringify({event:"intake_review_full_source_page_native_volume",
    contactIds:500,elapsedMs:fullPageMs,productionExecution:false}));
  assert.equal((await fetch(url+pagePath)).status,401);checks++;
  const password=randomUUID(),hash=await bcrypt.hash(password,4);
  for(const role of ["admin","manager","agent"]) {
    const email=`${randomUUID()}@example.invalid`,id=randomUUID();
    await pool.query(`INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)`,[id,email,hash,role]);
    const login=await fetch(url+"/api/auth/login",{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
    assert.equal(login.status,200,"Real local sign-in must succeed");
    const cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    const firstResponse=await fetch(url+pagePath+"?limit=1",{headers:{cookie}});
    if(role!=="admin"){assert.equal(firstResponse.status,403);checks++;continue;}
    assert.equal(firstResponse.status,200);checks++;
    const first=await firstResponse.json() as any;
    assert.equal(first.candidates.length,1);checks++;
    assert.equal(first.candidates[0].contactId,contact.id);checks++;
    assert(Object.keys(first.candidates[0].evidence).length>0,"First page must contain hydrated business evidence");checks++;
    const next=new URLSearchParams({limit:"1",afterCreatedAt:first.nextCursor.createdAt,afterId:first.nextCursor.id});
    const secondResponse=await fetch(url+pagePath+"?"+next,{headers:{cookie}});
    assert.equal(secondResponse.status,200);checks++;
    const second=await secondResponse.json() as any;
    assert.equal(second.candidates.length,1);checks++;
    assert.notEqual(second.candidates[0].candidateId,first.candidates[0].candidateId,
      "Lossless native timestamp cursor must advance, not repeat the last hydrated candidate");checks++;
    const thirdParams=new URLSearchParams({limit:"1",afterCreatedAt:second.nextCursor.createdAt,afterId:second.nextCursor.id});
    const third=await (await fetch(url+pagePath+"?"+thirdParams,{headers:{cookie}})).json() as any;
    assert.equal(third.candidates.length,1);checks++;
    assert(![first.candidates[0].candidateId,second.candidates[0].candidateId].includes(third.candidates[0].candidateId));checks++;
    const endParams=new URLSearchParams({limit:"1",afterCreatedAt:third.nextCursor.createdAt,afterId:third.nextCursor.id});
    const end=await (await fetch(url+pagePath+"?"+endParams,{headers:{cookie}})).json() as any;
    assert.deepEqual(end.candidates,[]);assert.equal(end.nextCursor,null);checks+=2;
  }
  console.log(`Authenticated native review pages: ${checks} checks passed; admin hydration and lossless keyset; manager/agent 403; unsigned 401`);
} catch(error) {
  console.error(error);
  process.exitCode=1;
} finally {
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
