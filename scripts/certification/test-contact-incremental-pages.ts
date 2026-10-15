import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import fs from "node:fs";
import {PgDialect} from "drizzle-orm/pg-core";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"incremental contact inspection",requireRedis:false});
const {pool,db}=await import("../../server/db");
const {loadEvidenceRelationshipPage}=await import("../../server/services/contact-business-evidence-page");
const prefix=randomUUID();
let checks=0;
const check=(value:unknown,message:string)=>{assert(value,message);checks++;};
try {
  const base=Number((await pool.query("SELECT coalesce(max(id),0) id FROM contacts")).rows[0].id);
  const ids=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,website,record_class,updated_at)
    SELECT 'Incremental','Fixture',$1||n||'@example.invalid','',$1||n,
      'https://'||$1||n||'.example.invalid','production','2026-10-01'::timestamptz
    FROM generate_series(1,76) n RETURNING id`,[prefix])).rows.map(r=>Number(r.id));
  // The exact saved production window is opaque; no JS Date conversion.
  const since="2026-10-03 13:06:25.56618+00";
  const first=await loadEvidenceRelationshipPage(db,base,25,undefined,since);
  check(!first.previews.length && !first.passExhausted && first.inspectedThroughContactId===ids[24],
    "Empty first page advances raw inspection, with real lookahead");
  const second=await loadEvidenceRelationshipPage(db,ids[24],25,undefined,since);
  check(!second.previews.length && second.inspectedThroughContactId===ids[49],"Sparse continuation");
  const b=(await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,record_class,website_domain,updated_at)
    VALUES($1,$1,'canonical',$2,'2026-10-01') RETURNING id`,[prefix+"26",prefix+"40.example.invalid"])).rows[0];
  const sl=(await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key,created_at,updated_at)
    VALUES($1,'google_maps','place',$2,'2026-10-01','2026-10-01') RETURNING id`,[b.id,prefix+"key"])).rows[0];
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,actor_type,metadata,created_at)
    VALUES($1,$2,'import','inbound','system',$3::jsonb,'2026-10-01')`,
    [ids[51],prefix,JSON.stringify({placeId:prefix+"key"})]);
  check(!(await loadEvidenceRelationshipPage(db,ids[49],25,undefined,since)).previews.length,
    "Historical retained key never bypasses changedSince");
  await pool.query("UPDATE canonical_source_links SET updated_at='2026-10-04' WHERE id=$1",[sl.id]);
  const named=await loadEvidenceRelationshipPage(db,ids[24],25,undefined,since);
  check(named.previews.some(r=>r.contactId===ids[25]),"Source-link-only name change");
  check(named.previews.some(r=>r.contactId===ids[39]),"Source-link-only domain change");
  check((await loadEvidenceRelationshipPage(db,ids[49],25,undefined,since)).previews.some(r=>r.contactId===ids[51]),
    "Source-link-only retained place change");
  // Changed registry aliases and missing filings/supported namespaces remain
  // selectable: candidate authority, not this filter, decides affiliation.
  await pool.query(`INSERT INTO sunbiz_entities(filing_number,entity_name,dba,source,updated_at)
    VALUES($1,$2,$3,'sunbiz','2026-10-04')`,[prefix+"filing",prefix+"55",prefix+"56"]);
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,actor_type,metadata,created_at)
    VALUES($1,$2,'import','inbound','system',$3::jsonb,'2026-10-01')`,
    [ids[56],prefix+"filing-event",JSON.stringify({filing_number:prefix+"filing"})]);
  const registry=await loadEvidenceRelationshipPage(db,ids[49],25,undefined,since);
  for (const n of [54,55,56]) check(registry.previews.some(r=>r.contactId===ids[n]),"Registry revision "+n);
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,actor_type,metadata)
    VALUES($1,$2,'import','inbound','system','{}')`,[ids[75],prefix+"new-event"]);
  const final=await loadEvidenceRelationshipPage(db,ids[74],25,undefined,since);
  check(final.passExhausted && final.previews[0]?.contactId===ids[75],"Source-event-only final page");
  const empty=await loadEvidenceRelationshipPage(db,ids[75],25,undefined,since);
  check(empty.passExhausted && empty.inspectedThroughContactId===ids[75],"Actually exhausted empty page");
  await pool.query(`UPDATE contacts SET updated_at='2026-10-04' WHERE id=$1`,[ids[1]]);
  check((await loadEvidenceRelationshipPage(db,base,25,undefined,since)).previews.some(r=>r.contactId===ids[1]),
    "Behind-cursor change remains in next traversal's overlapping window");
  check((await loadEvidenceRelationshipPage(db,0,1,ids[0],since)).previews.length===1,
    "Point refresh bypasses changedSince");
  await pool.query("UPDATE businesses SET google_place_id=$2,updated_at='2026-10-01' WHERE id=$1",
    [b.id,prefix+"key"]);
  await pool.query("UPDATE canonical_source_links SET updated_at='2026-10-01' WHERE id=$1",[sl.id]);
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,actor_type,metadata,created_at)
    VALUES($1,$2,'import','inbound','system',$3::jsonb,'2026-10-01')`,
    [ids[25],prefix+"old-eligible",JSON.stringify({placeId:prefix+"key"})]);
  const oldEligible=(await loadEvidenceRelationshipPage(db,ids[24],25,undefined,since)).previews
    .find(row=>row.contactId===ids[25]);
  check(oldEligible?.eligible,"Currently corroborated old evidence is reconsidered without window reset");
  check(oldEligible?.snapshotHash===(await loadEvidenceRelationshipPage(db,0,1,ids[25])).previews[0]?.snapshotHash,
    "Window optimization never contaminates the canonical snapshot");
  await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,record_class)
    SELECT $1||n,$1||n,'canonical' FROM generate_series(1,20000) n`,[prefix+"decoy"]);
  await pool.query(`INSERT INTO sunbiz_entities(filing_number,entity_name,dba,source)
    SELECT $1||n,$1||n,$1||n,'sunbiz' FROM generate_series(1,10000) n`,[prefix+"decoy"]);
  // Reproduce the production empty-name/NULL-DBA cardinality, not only
  // selective nonempty keys. Timestamp must be an index condition too.
  await pool.query(`INSERT INTO sunbiz_entities(filing_number,entity_name,dba,source,updated_at)
    SELECT $1||n,$1||n,NULL,'sunbiz','2026-10-01'
    FROM generate_series(1,10000) n`,[prefix+"empty-dba"]);
  await pool.query("UPDATE contacts SET company_name=NULL WHERE id=$1",[ids[0]]);
  await pool.query("ANALYZE businesses");await pool.query("ANALYZE sunbiz_entities");
  const queries:any[]=[];const dialect=new PgDialect();
  const executor={execute:async(q:any)=>{queries.push(dialect.sqlToQuery(q));return db.execute(q);}};
  const started=performance.now();
  await loadEvidenceRelationshipPage(executor,ids[24],25,undefined,since);
  const elapsedMs=performance.now()-started;
  check(elapsedMs<3000,"Representative page finishes within unchanged 30s budget");
  const plan=(await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+queries[1].sql,queries[1].params)).rows;
  const text=JSON.stringify(plan);
  check(text.includes("contact_change_business_name_idx"),"Executed full-scope name index");
  check(text.includes("contact_change_business_domain_idx"),"Executed full-scope domain index");
  const emptyStarted=performance.now();
  const blank=await loadEvidenceRelationshipPage(db,base,25,undefined,since);
  check(blank.previews.every(row=>row.contactId!==ids[0]) && performance.now()-emptyStarted<3000,
    "Unchanged blank-name contact avoids enumerating the historical NULL-DBA registry");
  const hydrationPlan=(await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+queries[2].sql,queries[2].params)).rows;
  fs.mkdirSync("generated-artifacts/intake-incremental",{recursive:true});
  fs.writeFileSync("generated-artifacts/intake-incremental/disposable-page-test.json",
    JSON.stringify({checks,elapsedMs,plan,hydrationPlan,productionAcceptance:false},null,2));
  console.log(JSON.stringify({checks,elapsedMs,productionAcceptance:false}));
} finally {await pool.end();}
