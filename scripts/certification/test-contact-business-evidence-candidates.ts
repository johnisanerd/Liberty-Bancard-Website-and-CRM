import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { evidenceRelationshipCandidateCte } from "../../server/services/contact-business-evidence-candidates";
import { identityNameSql,identityDomainSql } from "../../shared/relationship-evidence-sql";
import {hasMaterializableSourceEvidence,MATERIALIZATION_SOURCE_CATEGORIES,MATERIALIZATION_SOURCE_TYPES} from "../../server/services/contact-business-materialization-policy";

await assertDisposableTestInfrastructure({operation:"Candidate retrieval parity and scale"});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const client=await pool.connect();
let checks=0;
const dialect=new PgDialect();
const candidates=(ids:number[])=>dialect.sqlToQuery(sql`
  ${evidenceRelationshipCandidateCte(ids)}
  SELECT DISTINCT k.contact_id,k.business_id FROM candidate_business_keys k
  JOIN businesses b ON b.id=k.business_id AND b.record_class='canonical'
  JOIN canonical_source_links sl ON sl.business_id=b.id
  ORDER BY 1,2
`);
try {
  // Session-private tables test the retrieval predicate without granting any
  // native write authority or mutating the application's real ledgers.
  await client.query(`
    CREATE TEMP TABLE contacts(id integer PRIMARY KEY,company_name text,website text);
    CREATE TEMP TABLE businesses(id integer PRIMARY KEY,canonical_name text,website_domain text,record_class text);
    CREATE TEMP TABLE canonical_source_links(business_id integer,source_system text,source_type text,stable_key text);
    CREATE TEMP TABLE sunbiz_entities(filing_number text,entity_name text,dba text,source text);
    CREATE TEMP TABLE contact_source_events(contact_id integer,metadata jsonb);
    CREATE INDEX fixture_business_name ON businesses(crm_identity_name(canonical_name))
      WHERE record_class='canonical';
    CREATE INDEX fixture_business_domain ON businesses(crm_identity_domain(website_domain))
      WHERE record_class='canonical';
    CREATE INDEX fixture_registry_name ON sunbiz_entities(crm_identity_name(entity_name))
      WHERE filing_number IS NOT NULL AND source IN ('sunbiz','cordata','corevt');
    CREATE INDEX fixture_registry_dba ON sunbiz_entities(crm_identity_name(dba))
      WHERE filing_number IS NOT NULL AND dba IS NOT NULL AND source IN ('sunbiz','cordata','corevt');
    INSERT INTO contacts VALUES
      (1,'Café Dental LLC',NULL),(2,'Other','https://www.example.invalid/path'),
      (3,'Trading Alias',NULL),(4,'',NULL),(5,NULL,NULL),(6,'Duplicate Name',NULL),
      (7,'Unsupported',NULL),(8,'Registry DBA',NULL);
    INSERT INTO businesses VALUES
      (1,'Cafe Dental Inc',NULL,'canonical'),(2,'Domain Identity','example.invalid','canonical'),
      (3,'Registry Legal',NULL,'canonical'),(4,'Stable Identity',NULL,'canonical'),
      (5,'Duplicate Name',NULL,'canonical'),(6,'Duplicate Name',NULL,'canonical'),
      (7,'Unsupported',NULL,'test'),(8,'Wrong Registry',NULL,'canonical');
    INSERT INTO canonical_source_links VALUES
      (1,'google_maps','place','place-1'),(2,'google_maps','place','place-2'),
      (3,'sunbiz','sunbiz_entity','filing-3'),(4,'google_maps','place','place-4'),
      (5,'google_maps','place','place-5'),(6,'google_maps','place','place-6'),
      (7,'google_maps','place','place-7'),(8,'other','entity','filing-8');
    INSERT INTO sunbiz_entities VALUES
      ('filing-3','Trading Alias','Registry DBA','sunbiz'),
      ('filing-8','Unsupported','Registry DBA','sunbiz');
    INSERT INTO contact_source_events VALUES
      (4,'{"google_place_id":"place-4"}'),(5,'{"filingNumber":"filing-3"}'),
      (5,'{"filing_number":"filing-3","place_id":"place-4","placeId":"place-4"}');
  `);
  const ids=[1,2,3,4,5,6,7,8];
  const old=dialect.sqlToQuery(sql`
    SELECT DISTINCT c.id contact_id,b.id business_id FROM contacts c
    JOIN businesses b ON b.record_class='canonical'
    JOIN canonical_source_links sl ON sl.business_id=b.id
    LEFT JOIN sunbiz_entities se ON sl.source_system='sunbiz' AND sl.source_type='sunbiz_entity'
      AND se.filing_number=sl.stable_key AND se.source IN ('sunbiz','cordata','corevt')
    WHERE c.id=ANY(ARRAY[${sql.join(ids.map(id=>sql`${id}`),sql`, `)}]::integer[])
      AND (${sql.raw(identityNameSql("c.company_name"))}<>'' AND
        ${sql.raw(identityNameSql("c.company_name"))} IN (${sql.raw(identityNameSql("b.canonical_name"))},
          ${sql.raw(identityNameSql("se.entity_name"))},${sql.raw(identityNameSql("se.dba"))})
        OR ${sql.raw(identityDomainSql("c.website"))} IS NOT NULL AND
          ${sql.raw(identityDomainSql("c.website"))}=${sql.raw(identityDomainSql("b.website_domain"))}
        OR EXISTS(SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=c.id
          AND (ev.metadata->>'filingNumber'=sl.stable_key OR ev.metadata->>'filing_number'=sl.stable_key
            OR ev.metadata->>'place_id'=sl.stable_key OR ev.metadata->>'placeId'=sl.stable_key
            OR ev.metadata->>'google_place_id'=sl.stable_key)))
    ORDER BY 1,2
  `);
  const baseline=(await client.query(old.sql,old.params)).rows;
  const query=candidates(ids);
  const actual=(await client.query(query.sql,query.params)).rows;
  assert.deepEqual(actual,baseline);checks++;
  for(const [contact,business] of [[1,1],[2,2],[3,3],[4,4],[5,3],[5,4],[8,3]]) {
    assert(actual.some(r=>r.contact_id===contact && r.business_id===business));checks++;
  }
  assert.equal(actual.filter(r=>r.contact_id===6).length,2);checks++;
  assert(!actual.some(r=>r.business_id===7 || r.business_id===8));checks++;
  // No artificial match limit; thousands of unrelated identities must not
  // multiply the selected page before relationship evaluation.
  await client.query(`INSERT INTO businesses SELECT n,'Unrelated '||n,NULL,'canonical'
    FROM generate_series(100,50100) n;
    INSERT INTO canonical_source_links SELECT n,'google_maps','place','unrelated-'||n
    FROM generate_series(100,50100) n;
    INSERT INTO sunbiz_entities SELECT 'registry-'||n,'Unrelated Legal '||n,'Unrelated DBA '||n,'sunbiz'
    FROM generate_series(100,50100) n;
    INSERT INTO canonical_source_links SELECT n,'sunbiz','sunbiz_entity','registry-'||n
    FROM generate_series(100,50100) n;
    ANALYZE businesses; ANALYZE canonical_source_links; ANALYZE sunbiz_entities;`);
  const plan=(await client.query("EXPLAIN (ANALYZE,FORMAT JSON) "+query.sql,query.params)).rows[0]["QUERY PLAN"][0];
  assert.deepEqual((await client.query(query.sql,query.params)).rows,baseline);checks++;
  const source=fs.readFileSync("server/services/contact-business-evidence-page.ts","utf8");
  assert(source.includes("FROM candidate_business_keys candidate"));checks++;
  assert(source.includes('relationshipReasonsSql("c.id","b.id","sl.id","se.id")'));checks++;
  const indexedNodes:string[]=[];
  function visit(node:any) {
    if(node["Index Name"]) indexedNodes.push(node["Index Name"]);
    for(const child of node.Plans ?? []) visit(child);
  }
  visit(plan.Plan);
  assert(indexedNodes.includes("fixture_business_name"),"Inline read normalizer uses unchanged native-function index");checks++;
  assert(indexedNodes.includes("fixture_business_domain"),"Domain lookup uses its exact native normalization index");checks++;
  assert(indexedNodes.includes("fixture_registry_name"),"Registry legal-name branch uses the exact normalization index");checks++;
  assert(indexedNodes.includes("fixture_registry_dba"),"Registry alias branch uses the exact normalization index");checks++;
  for(const source_category of MATERIALIZATION_SOURCE_CATEGORIES) {
    assert(hasMaterializableSourceEvidence([{source_category,metadata:{businessEvidence:{canonicalName:"Source"}}}]));
    checks++;
  }
  for(const source_type of MATERIALIZATION_SOURCE_TYPES) {
    assert(hasMaterializableSourceEvidence([{source_type,metadata:{businessEvidence:{canonicalName:"Source"}}}]));
    checks++;
  }
  for(const events of [[],[{source_category:"crm",metadata:{}}],
    [{source_category:"crm",metadata:{businessEvidence:null}}],
    [{source_category:"crm",metadata:{businessEvidence:[]}}],
    [{source_category:"unsupported",metadata:{businessEvidence:{canonicalName:"Source"}}}]]) {
    assert.equal(hasMaterializableSourceEvidence(events),false);checks++;
  }
  assert.throws(()=>hasMaterializableSourceEvidence(undefined),/SOURCE_SNAPSHOT_UNAVAILABLE/);checks++;
  fs.writeFileSync("docs/certification/canonical-enrichment-candidate-retrieval.json",JSON.stringify({
    checks,scope:"Disposable SQL retrieval parity; native write authority unchanged",
    unrelatedBusinesses:50001,unrelatedRegistryEntities:50001,
    indexesUsed:indexedNodes,executionMs:plan["Execution Time"],planningMs:plan["Planning Time"],
    candidatePairs:actual.length,productionWrites:false,taskComplete:false,
  },null,2)+"\n");
  console.log(`PASS: ${checks} candidate retrieval checks; ${plan["Execution Time"]}ms with 50,001 unrelated businesses`);
} finally {client.release();await pool.end();}