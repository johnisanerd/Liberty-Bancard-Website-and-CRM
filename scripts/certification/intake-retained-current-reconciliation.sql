-- Read-only, exact historical 713 item IDs are bound by the caller.
WITH scope AS MATERIALIZED (
 SELECT i.id,i.state,i.terminal_code,d.execution_id,d.source_row_number,
   d.row_fingerprint,d.contact_id,a.details hold,a.created_at audit_at
 FROM cro03_enrichment_items i
 JOIN cro03_enrichment_batches b ON b.id=i.batch_id
 JOIN import_row_dispositions d
   ON b.idempotency_key='csv-source:'||d.execution_id::text||':'||d.source_row_number::text
 LEFT JOIN LATERAL (SELECT details,created_at FROM audit_logs a
   WHERE a.entity_key=i.id::text AND a.action='canonical_import_hold_evidence'
   ORDER BY a.id DESC LIMIT 1) a ON true
 WHERE i.id=ANY($1::uuid[])
), row_contacts AS (
 SELECT s.id item_id,s.contact_id FROM scope s WHERE s.contact_id IS NOT NULL
 UNION SELECT s.id,(v->>'contactId')::int FROM scope s
 CROSS JOIN LATERAL jsonb_array_elements(s.hold->'diagnostic'->'nativeSnapshots') v
 UNION SELECT s.id,e.contact_id FROM scope s JOIN contact_source_events e
   ON e.import_execution_id=s.execution_id AND e.row_fingerprint=s.row_fingerprint
), contacts_current AS (
 SELECT DISTINCT rc.item_id,c.id,c.business_id,
   (c.archived_at IS NULL AND c.record_class IS NOT NULL
     AND c.record_class NOT IN ('test','demo','synthetic')) active_production,
   coalesce(d.decision='verified' AND c.business_id=d.business_id
     AND b.record_class='canonical',false) verified
 FROM row_contacts rc JOIN contacts c ON c.id=rc.contact_id
 LEFT JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.superseded_at IS NULL
 LEFT JOIN businesses b ON b.id=d.business_id
), native_receipt_checks AS (
 SELECT s.id, n->>'contactId' contact_id,
   c.id IS NOT NULL AND c.updated_at::text=n->>'contactRevision'
   AND c.business_id IS NOT DISTINCT FROM (n->>'projectedBusinessId')::int
   AND d.id IS NOT DISTINCT FROM (n->>'currentDecisionId')::uuid
   AND NOT EXISTS(SELECT 1 FROM contact_source_events ev
     WHERE ev.contact_id=c.id AND ev.created_at>s.audit_at)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n->'candidateEvidence') e
     LEFT JOIN businesses b ON b.id=(e->>'businessId')::int
     LEFT JOIN canonical_source_links sl ON sl.id=(e->>'sourceLinkId')::uuid
     LEFT JOIN sunbiz_entities se ON se.id=(e->>'sourceEntityId')::int
     WHERE b.id IS NULL OR sl.id IS NULL OR b.updated_at::text IS DISTINCT FROM e->>'businessRevision'
       OR sl.updated_at::text IS DISTINCT FROM e->>'sourceRevision'
       OR se.updated_at::text IS DISTINCT FROM e->>'entityRevision') retained_pins_current
 FROM scope s CROSS JOIN LATERAL jsonb_array_elements(s.hold->'diagnostic'->'nativeSnapshots') n
 LEFT JOIN contacts c ON c.id=(n->>'contactId')::int
 LEFT JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.superseded_at IS NULL
)
SELECT jsonb_build_object(
 'observedAt',clock_timestamp()::text,'rows',(SELECT count(*) FROM scope),
 'byExecution',(SELECT jsonb_agg(x) FROM (SELECT execution_id,count(*) rows FROM scope GROUP BY execution_id) x),
 'states',(SELECT jsonb_agg(x) FROM (SELECT state,terminal_code,count(*) rows FROM scope GROUP BY state,terminal_code) x),
 'contactOverlap',(SELECT jsonb_build_object(
   'distinctReferencedContacts',count(DISTINCT id),
   'activeProduction',count(DISTINCT id) FILTER(WHERE active_production),
   'verified',count(DISTINCT id) FILTER(WHERE active_production AND verified),
   'unresolved',count(DISTINCT id) FILTER(WHERE active_production AND NOT verified),
   'rowsWithVerifiedContacts',count(DISTINCT item_id) FILTER(WHERE active_production AND verified))
   FROM contacts_current),
 'holdEvidence',(SELECT jsonb_build_object(
   'withVersionedReceipt',count(*) FILTER(WHERE hold->>'holdEvidenceVersion'='native_revision_bound_v1'),
   'missingReceipt',count(*) FILTER(WHERE hold IS NULL),
   'oldestAudit',min(audit_at)::text,'newestAudit',max(audit_at)::text) FROM scope),
 'nativeReceiptPins',(SELECT jsonb_build_object('snapshots',count(*),
   'current',count(*) FILTER(WHERE retained_pins_current),
   'changedOrMissing',count(*) FILTER(WHERE NOT retained_pins_current)) FROM native_receipt_checks),
 'currentFulfillmentReceipts',(SELECT count(*) FROM scope s WHERE EXISTS(
   SELECT 1 FROM audit_logs a WHERE a.entity_key=s.id::text AND a.action='canonical_import_row_fulfilled'
     AND a.details->>'qualificationVersion'='mailbox_business_identity_v2')),
 'rowDetails',(SELECT jsonb_agg(jsonb_build_object(
   'itemId',s.id,'executionId',s.execution_id,'row',s.source_row_number,'fingerprint',s.row_fingerprint,
   'expectedBusinessId',s.hold->'diagnostic'->'businessId',
   'candidateRevisions',s.hold->'diagnostic'->'candidateRevisions',
   'contacts',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'businessId',c.business_id,
     'verified',c.verified,'activeProduction',c.active_production)) FROM contacts_current c WHERE c.item_id=s.id)
 )) FROM scope s)
) result;
