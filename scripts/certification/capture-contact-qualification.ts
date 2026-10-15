import fs from "node:fs";
import {PgDialect} from "drizzle-orm/pg-core";
import {loadEvidenceRelationshipPage} from "../../server/services/contact-business-evidence-page";

// Capture the actual read evaluator; no DB connection, writer or controls.
const queries:any[]=[];
const dialect=new PgDialect();
await loadEvidenceRelationshipPage({execute:async(q:any)=>{
  queries.push(dialect.sqlToQuery(q));
  return {rows:queries.length===1?[{id:1}]:queries.length===2?
    [{contact_id:1,source_event_revisions:[]}]:[]};
}},0,1);
let native=queries[2].sql;
let replaced=0;
native=native.replace(/c\.id=ANY\(ARRAY\[\s*\$\d+\s*\]::integer\[\]\)/g,()=>{
  replaced++;return "c.id IN (SELECT id FROM audit_scope)";
});
if(replaced!==2 || /\$\d/.test(native))throw Error("NATIVE_CAPTURE_PARAMETER_DRIFT");
const query=`WITH audit_scope AS MATERIALIZED (
 SELECT c.id FROM contacts c
 LEFT JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.superseded_at IS NULL
 LEFT JOIN businesses b ON b.id=d.business_id
 WHERE c.id>$1 AND c.archived_at IS NULL AND c.record_class IS NOT NULL
 AND c.record_class NOT IN ('test','demo','synthetic')
 AND NOT coalesce(d.decision='verified' AND c.business_id=d.business_id AND b.record_class='canonical',false)
 ORDER BY c.id LIMIT $2
), native_matches AS MATERIALIZED (${native}),
evaluated AS (
 SELECT c.id,c.updated_at::text revision,c.business_id,
 count(DISTINCT m.business_id) candidate_businesses,
 count(DISTINCT m.business_id) FILTER(WHERE cardinality(m.relationship_reasons)=0) eligible_businesses,
 coalesce(jsonb_agg(DISTINCT m.relationship_reasons) FILTER(WHERE m.business_id IS NOT NULL),'[]'::jsonb) reason_sets,
 EXISTS(SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=c.id
   AND jsonb_typeof(ev.metadata->'businessEvidence')='object'
   AND (ev.source_category IN ('ghl_sync','crm','crm_manual','manual_crm','csv_import','manual_import','apollo')
     OR ev.source_type IN ('google_maps_outscraper','apollo_lead_list'))) structured_evidence
 FROM audit_scope s JOIN contacts c ON c.id=s.id
 LEFT JOIN native_matches m ON m.contact_id=c.id GROUP BY c.id
)
SELECT jsonb_build_object('id',id,'revision',revision,'projectedBusinessId',business_id,
 'candidateBusinesses',candidate_businesses,'eligibleBusinesses',eligible_businesses,
 'reasonSets',reason_sets,'structuredEvidence',structured_evidence,
 'outcome',CASE WHEN eligible_businesses=1 THEN 'unique_relationship_preview'
 WHEN eligible_businesses>1 THEN 'competing_corroborated_businesses'
 WHEN candidate_businesses>0 THEN 'native_reasons'
 WHEN structured_evidence THEN 'materialization_requires_current_organization_resolution'
 ELSE 'independent_business_identity_not_found' END) record
 FROM evaluated ORDER BY id`;
fs.mkdirSync("generated-artifacts/intake-incremental",{recursive:true});
fs.writeFileSync("generated-artifacts/intake-incremental/qualification-query.sql",query);
console.log("Captured bounded, read-only native qualification query");
