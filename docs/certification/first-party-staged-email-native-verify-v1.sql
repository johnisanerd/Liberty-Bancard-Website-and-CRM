WITH checks AS (SELECT
  (SELECT count(*)=3 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contact_business_first_party_link_evidence'
      AND column_name IN ('crawl_domain','business_site_domain','site_relation')) AS site_relation_columns,
  EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.contact_business_first_party_link_evidence')
      AND t.tgname='contact_business_first_party_link_evidence_append_only' AND t.tgenabled IN ('O','A')
      AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=27
      AND p.pronamespace='public'::regnamespace AND p.proname='cro02_first_party_link_evidence_append_only'
      AND md5(p.prosrc)='62110488204b950f599a4defd7483104') AS evidence_immutable_trigger,
  EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.contact_business_link_decisions')
      AND t.tgname='contact_business_link_review_contract' AND t.tgenabled IN ('O','A')
      AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=23
      AND p.pronamespace='public'::regnamespace AND p.proname='enforce_reviewed_contact_business_link'
      AND strpos(p.prosrc,'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */')>0
      AND strpos(p.prosrc,'AND po.subject_type=''business'' AND po.subject_id=NEW.business_id')=0
      AND md5(replace(p.prosrc,'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */','AND po.subject_type=''business'' AND po.subject_id=NEW.business_id'))
          ='36151ce032505a66054e6b8c70daa259') AS reviewed_link_routine_current
)
SELECT checks.*,
  (site_relation_columns AND evidence_immutable_trigger AND reviewed_link_routine_current) AS repair_verified
FROM checks;
