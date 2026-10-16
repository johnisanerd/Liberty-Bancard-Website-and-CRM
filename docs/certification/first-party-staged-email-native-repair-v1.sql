-- Explicit versioned owner repair for the first-party staged-email link (migrations 0361/0362 native objects).
-- Run AFTER Publish has created the tables/columns. Standard psql: submit the COMPLETE file.
-- SQL Console: select ALL statements between the standalone BEGIN; and COMMIT; below, from SET LOCAL
-- lock_timeout through END $trigger$;, and run ONCE as a selected batch. The console supplies the
-- transaction; do not run the outer BEGIN; / COMMIT;. Keep every inner DO/function block unchanged.

-- Agent production access remains read-only. No startup/build DDL, no publishing, no guard weakening.

-- Idempotent; refuses to replace an unrecognized routine body (drift aborts the whole transaction).

BEGIN;

SET LOCAL lock_timeout='5s';

SET LOCAL statement_timeout='120s';

DO $preflight$
BEGIN
  IF to_regclass('public.contact_business_first_party_link_evidence') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='contact_business_first_party_link_evidence'
            AND column_name IN ('crawl_domain','business_site_domain','site_relation'))<>3
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='contact_business_link_decisions'
            AND column_name='first_party_evidence_id' AND data_type='uuid')
     OR to_regclass('public.free_discovery_materialization_outcomes') IS NULL THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_PUBLISH_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
       WHERE p.oid=to_regprocedure('public.enforce_reviewed_contact_business_link()')
         AND strpos(p.prosrc,'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */')>0
         AND strpos(p.prosrc,'AND po.subject_type=''business'' AND po.subject_id=NEW.business_id')=0
         AND md5(replace(p.prosrc,'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */','AND po.subject_type=''business'' AND po.subject_id=NEW.business_id'))
             IN ('db87fee060dbdf3fa4b8c1f07070e5c7','36151ce032505a66054e6b8c70daa259')) THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_ROUTINE_DRIFT';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.cro02_first_party_link_evidence_append_only()')
       AND md5(prosrc)<>'62110488204b950f599a4defd7483104') THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_EVIDENCE_FUNCTION_DRIFT';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.contact_business_first_party_link_evidence'::regclass
       AND t.tgname='contact_business_first_party_link_evidence_append_only'
       AND (t.tgfoid IS DISTINCT FROM to_regprocedure('public.cro02_first_party_link_evidence_append_only()')
         OR t.tgenabled NOT IN ('O','A') OR t.tgisinternal OR t.tgqual IS NOT NULL OR t.tgtype<>27)) THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_EVIDENCE_TRIGGER_DRIFT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.contact_business_link_decisions'::regclass
       AND t.tgname='contact_business_link_review_contract' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
       AND t.tgqual IS NULL AND t.tgtype=23
       AND t.tgfoid=to_regprocedure('public.enforce_reviewed_contact_business_link()')) THEN
    RAISE EXCEPTION 'FIRST_PARTY_NATIVE_REPAIR_REVIEW_TRIGGER_MISSING';
  END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION cro02_first_party_link_evidence_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'COMMERCIAL_FIRST_PARTY_LINK_EVIDENCE_IMMUTABLE';
END $$;

DO $trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.contact_business_first_party_link_evidence'::regclass
       AND tgname='contact_business_first_party_link_evidence_append_only') THEN
    CREATE TRIGGER contact_business_first_party_link_evidence_append_only
  BEFORE UPDATE OR DELETE ON contact_business_first_party_link_evidence
  FOR EACH ROW EXECUTE FUNCTION cro02_first_party_link_evidence_append_only();
  END IF;
END $trigger$;

CREATE OR REPLACE FUNCTION enforce_reviewed_contact_business_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evidence_contact_id integer;
  evidence_actor_type text;
  evidence_actor_id text;
  reviewer_role text;
  evidence_row contact_business_system_link_evidence%ROWTYPE;
  sfp_evidence contact_business_sfp_link_evidence%ROWTYPE;
  fp_evidence contact_business_first_party_link_evidence%ROWTYPE;
BEGIN
  IF NEW.decision = 'verified' AND NEW.superseded_at IS NULL THEN
    IF NEW.actor_id = 'system' THEN
      IF NEW.sfp_evidence_id IS NOT NULL THEN
        IF NEW.business_id IS NULL OR NEW.system_evidence_id IS NOT NULL OR NEW.first_party_evidence_id IS NOT NULL
           OR NEW.evidence_source_event_id IS NOT NULL OR NEW.reviewed_by IS NOT NULL
           OR NEW.reviewed_at IS NOT NULL THEN
          RAISE EXCEPTION 'COMMERCIAL_SFP_SYSTEM_LINK_CONTRACT_REQUIRED';
        END IF;
        SELECT * INTO sfp_evidence
          FROM contact_business_sfp_link_evidence WHERE id=NEW.sfp_evidence_id;
        IF NOT FOUND OR sfp_evidence.contact_id <> NEW.contact_id
           OR sfp_evidence.business_id <> NEW.business_id
           OR sfp_evidence.decision_key <> NEW.decision_key THEN
          RAISE EXCEPTION 'COMMERCIAL_SFP_LINK_EVIDENCE_SUBJECT_MISMATCH';
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM contacts c
            JOIN businesses b ON b.id=NEW.business_id AND b.record_class='canonical'
            JOIN sfp_outreach_eligibility e ON e.id=sfp_evidence.eligibility_id
              AND e.business_id=NEW.business_id
              AND e.source_kind=sfp_evidence.source_kind
              AND e.normalized_value_hash=sfp_evidence.normalized_value_hash
              AND e.normalized_value_hash_version=sfp_evidence.normalized_value_hash_version
              AND e.zb_outcome='valid'
              AND e.suppression_status='not_suppressed'
              AND e.policy_document_id IS NOT NULL
              AND e.validation_expires_at > now()
            JOIN sfp_cohort_runs r ON r.id=e.cohort_run_id
              AND r.cohort_state='frozen' AND r.voided_at IS NULL AND r.superseded_at IS NULL
            JOIN sfp_programs p ON p.id=r.program_id AND p.is_active=TRUE
            JOIN sfp_outreach_policy_control pc ON pc.singleton=TRUE
            JOIN sfp_outreach_policy_documents pd ON pd.id=pc.active_policy_id
              AND e.policy_document_id=pd.id AND e.policy_document_hash=pd.document_hash
            JOIN provider_observations po
              ON po.operation_id=sfp_evidence.validation_operation_id
             AND po.provider='zerobounce' AND po.outcome='valid' AND po.retryable=FALSE
             AND po.subject_type IN ('business','contact') /* canonical_address_receipt_v1 */
             AND po.email_token_hash=sfp_evidence.contact_email_token_hash
             AND po.observed_at<=NOW()
             AND LEAST(
               COALESCE(po.expires_at,po.observed_at+(pd.validation_ttl_days::text||' days')::interval),
               po.observed_at+(pd.validation_ttl_days::text||' days')::interval
             )>NOW()
            JOIN provider_operations op ON op.id=po.operation_id AND op.state='completed'
           WHERE c.id=NEW.contact_id
             AND c.business_id IS NULL
             AND c.email_token_hash=sfp_evidence.contact_email_token_hash
             AND c.archived_at IS NULL
             AND c.record_class NOT IN ('test','demo','synthetic')
             AND COALESCE(c.existing_merchant_customer,FALSE)=FALSE
             AND COALESCE(c.do_not_contact,FALSE)=FALSE
             AND COALESCE(c.do_not_auto_contact,FALSE)=FALSE
             AND COALESCE(c.opted_out_email,FALSE)=FALSE
             AND COALESCE(c.opt_out_status,'active') <> 'opted_out'
             AND COALESCE(c.unsubscribe_status,'active') <> 'unsubscribed'
             AND COALESCE(c.bounce_status,'none') <> 'hard'
             AND COALESCE(c.complaint_status,'none') <> 'reported'
             AND COALESCE(c.email_status,'unvalidated') NOT IN ('bounced','invalid')
             AND c.suppression_reason IS NULL
              AND e.validation_at BETWEEN po.observed_at-INTERVAL '5 minutes'
                                       AND po.observed_at+INTERVAL '5 minutes'
              AND e.validation_expires_at<=LEAST(
                COALESCE(po.expires_at,po.observed_at+(pd.validation_ttl_days::text||' days')::interval),
                po.observed_at+(pd.validation_ttl_days::text||' days')::interval
              )
             AND (
               (sfp_evidence.source_kind='free'
                AND e.candidate_id=sfp_evidence.free_candidate_id
                AND e.paid_candidate_evidence_id IS NULL
                AND EXISTS (SELECT 1 FROM free_discovery_candidates fc
                             WHERE fc.id=sfp_evidence.free_candidate_id
                               AND fc.business_id=NEW.business_id
                               AND (e.normalized_value_hash_version<>1
                                    OR fc.normalized_value_hash=e.normalized_value_hash)))
               OR
               (sfp_evidence.source_kind='paid'
                AND e.paid_candidate_evidence_id=sfp_evidence.paid_candidate_evidence_id
                AND e.candidate_id IS NULL
                AND EXISTS (SELECT 1 FROM sfp_paid_candidate_evidence pe
                             WHERE pe.id=sfp_evidence.paid_candidate_evidence_id
                               AND pe.business_id=NEW.business_id
                               AND (e.normalized_value_hash_version<>1
                                    OR pe.normalized_value_hash=e.normalized_value_hash)))
             )
             AND (
               e.status='validated_outreach_eligible'
               OR (
                 e.status='validated_review_required' AND e.named_contact=TRUE
                 AND EXISTS (
                   SELECT 1 FROM sfp_named_email_eligibility_reviews rv
                    WHERE rv.eligibility_id=e.id AND rv.decision='approved'
                      AND rv.expected_updated_at=e.updated_at
                      AND rv.validation_operation_id=sfp_evidence.validation_operation_id
                      AND rv.source_kind=e.source_kind
                      AND rv.normalized_value_hash=e.normalized_value_hash
                      AND rv.normalized_value_hash_version=e.normalized_value_hash_version
                 )
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM contact_business_link_decisions current_link
                WHERE current_link.contact_id=c.id AND current_link.superseded_at IS NULL
             )
        ) THEN
          RAISE EXCEPTION 'COMMERCIAL_SFP_SYSTEM_LINK_AUTHORITY_FENCE_LOST';
        END IF;
      ELSIF NEW.first_party_evidence_id IS NOT NULL THEN
        IF NEW.business_id IS NULL OR NEW.system_evidence_id IS NOT NULL
           OR NEW.sfp_evidence_id IS NOT NULL
           OR NEW.evidence_source_event_id IS NOT NULL OR NEW.reviewed_by IS NOT NULL
           OR NEW.reviewed_at IS NOT NULL THEN
          RAISE EXCEPTION 'COMMERCIAL_FIRST_PARTY_LINK_CONTRACT_REQUIRED';
        END IF;
        SELECT * INTO fp_evidence
          FROM contact_business_first_party_link_evidence WHERE id=NEW.first_party_evidence_id;
        IF NOT FOUND OR fp_evidence.contact_id <> NEW.contact_id
           OR fp_evidence.business_id <> NEW.business_id
           OR fp_evidence.decision_key <> NEW.decision_key THEN
          RAISE EXCEPTION 'COMMERCIAL_FIRST_PARTY_LINK_EVIDENCE_SUBJECT_MISMATCH';
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM contacts c
            JOIN businesses b ON b.id=NEW.business_id AND b.record_class='canonical'
              AND COALESCE(b.do_not_visit,false)=false
            JOIN free_discovery_candidates fc ON fc.id=fp_evidence.candidate_id
              AND fc.field='email' AND fc.subject_type='business'
              AND fc.business_id=NEW.business_id
              AND fc.normalized_value_hash=fp_evidence.candidate_hash
              AND fc.attribution_scope=fp_evidence.attribution_scope
              AND fc.source=fp_evidence.candidate_source
            CROSS JOIN LATERAL (SELECT
              NULLIF(lower(regexp_replace(trim(coalesce(fc.domain,'')),'^www[.]','','i')),'') AS crawl_domain,
              NULLIF(lower(regexp_replace(trim(coalesce(b.website_domain,'')),'^www[.]','','i')),'') AS business_domain
            ) dom
           WHERE c.id=NEW.contact_id
             AND c.business_id IS NULL
             AND c.archived_at IS NULL
             AND c.record_class NOT IN ('test','demo','synthetic')
             AND COALESCE(c.existing_merchant_customer,false)=false
             -- The staged candidate IS this contact's address: the candidate hash is recomputed from the
             -- contact's own email, so two unrelated hashes can never be paired.
             AND c.email_token_hash=fp_evidence.contact_email_token_hash
             AND encode(sha256(convert_to(lower(trim(c.email)),'UTF8')),'hex')=fp_evidence.contact_email_token_hash
             AND encode(sha256(decode('656d61696c00','hex') || convert_to(lower(trim(c.email)),'UTF8')),'hex')=fp_evidence.candidate_hash
             AND split_part(lower(trim(c.email)),'@',2)=fp_evidence.address_domain
             -- Retained business-to-crawled-site relationship: the page the address was crawled from
             -- is the business's own website, and the evidence row snapshots both domains.
             AND fp_evidence.site_relation='business_website_domain'
             AND dom.crawl_domain IS NOT NULL AND dom.business_domain IS NOT NULL
             AND dom.crawl_domain=dom.business_domain
             AND fp_evidence.crawl_domain=dom.crawl_domain
             AND fp_evidence.business_site_domain=dom.business_domain
             AND dom.crawl_domain NOT IN ('gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','outlook.com','hotmail.com',
                    'live.com','aol.com','icloud.com','me.com','msn.com','proton.me','protonmail.com',
                    'mail.com','comcast.net','att.net','bellsouth.net','sbcglobal.net','verizon.net','cox.net')
             AND (
               (fp_evidence.domain_basis='business_domain'
                AND fp_evidence.address_domain<>''
                AND fp_evidence.address_domain NOT IN ('gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','outlook.com','hotmail.com',
                    'live.com','aol.com','icloud.com','me.com','msn.com','proton.me','protonmail.com',
                    'mail.com','comcast.net','att.net','bellsouth.net','sbcglobal.net','verizon.net','cox.net')
                AND (fp_evidence.address_domain=dom.crawl_domain
                     OR right(fp_evidence.address_domain,length(dom.crawl_domain)+1)='.'||dom.crawl_domain))
               OR
               (fp_evidence.domain_basis='provider_mailbox'
                AND fp_evidence.address_domain IN ('gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','outlook.com','hotmail.com',
                    'live.com','aol.com','icloud.com','me.com','msn.com','proton.me','protonmail.com',
                    'mail.com','comcast.net','att.net','bellsouth.net','sbcglobal.net','verizon.net','cox.net'))
             )
             AND NOT EXISTS (
               SELECT 1 FROM businesses other
                WHERE other.id<>b.id AND other.record_class='canonical'
                  AND lower(regexp_replace(trim(coalesce(other.website_domain,'')),'^www[.]','','i'))=dom.crawl_domain
             )
             AND NOT EXISTS (
               SELECT 1 FROM free_discovery_candidates rival
                 JOIN businesses rb ON rb.id=rival.business_id AND rb.record_class='canonical'
                WHERE rival.field='email' AND rival.subject_type='business'
                  AND rival.normalized_value_hash=fp_evidence.candidate_hash
                  AND rival.business_id<>NEW.business_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM sfp_identity_quarantines q
                WHERE q.business_id=NEW.business_id AND q.cleared_at IS NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM contact_business_link_decisions current_link
                WHERE current_link.contact_id=c.id AND current_link.superseded_at IS NULL
             )
        ) THEN
          RAISE EXCEPTION 'COMMERCIAL_FIRST_PARTY_LINK_AUTHORITY_FENCE_LOST';
        END IF;
      ELSIF NEW.system_evidence_id IS NOT NULL THEN
        IF NEW.business_id IS NULL
           OR NEW.evidence_source_event_id IS NOT NULL OR NEW.reviewed_by IS NOT NULL
           OR NEW.reviewed_at IS NOT NULL THEN
          RAISE EXCEPTION 'COMMERCIAL_SYSTEM_LINK_CONTRACT_REQUIRED';
        END IF;
        SELECT * INTO evidence_row
          FROM contact_business_system_link_evidence WHERE id=NEW.system_evidence_id;
        IF NOT FOUND OR evidence_row.contact_id <> NEW.contact_id
           OR evidence_row.business_id <> NEW.business_id
           OR evidence_row.decision_key <> NEW.decision_key THEN
          RAISE EXCEPTION 'COMMERCIAL_SYSTEM_LINK_EVIDENCE_SUBJECT_MISMATCH';
        END IF;
        IF evidence_row.rule_version <> 'crm_evidence_identity_v3' OR cardinality(crm_automatic_relationship_reasons(NEW.contact_id,NEW.business_id,evidence_row.source_link_id,evidence_row.source_entity_id))<>0 THEN
          RAISE EXCEPTION 'COMMERCIAL_SYSTEM_LINK_AUTHORITY_FENCE_LOST';
        END IF;
      ELSE
        RAISE EXCEPTION 'COMMERCIAL_SYSTEM_LINK_CONTRACT_REQUIRED';
      END IF;
    ELSE
      IF NEW.system_evidence_id IS NOT NULL OR NEW.sfp_evidence_id IS NOT NULL OR NEW.first_party_evidence_id IS NOT NULL THEN
        RAISE EXCEPTION 'COMMERCIAL_REVIEWED_LINK_EVIDENCE_KIND_MISMATCH';
      END IF;
      -- Existing independent-admin reviewer contract, unchanged.
      IF NEW.business_id IS NULL OR NEW.evidence_source_event_id IS NULL
         OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
        RAISE EXCEPTION 'COMMERCIAL_LINK_REVIEW_CONTRACT_REQUIRED';
      END IF;
      SELECT contact_id,actor_type,actor_id
        INTO evidence_contact_id,evidence_actor_type,evidence_actor_id
        FROM contact_source_events WHERE id=NEW.evidence_source_event_id;
      IF NOT FOUND OR evidence_contact_id <> NEW.contact_id THEN
        RAISE EXCEPTION 'COMMERCIAL_LINK_EVIDENCE_SUBJECT_MISMATCH';
      END IF;
      IF evidence_actor_type = 'user' AND evidence_actor_id = NEW.reviewed_by THEN
        RAISE EXCEPTION 'COMMERCIAL_LINK_REVIEWER_MUST_BE_INDEPENDENT';
      END IF;
      SELECT role INTO reviewer_role FROM users WHERE id=NEW.reviewed_by;
      IF reviewer_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'COMMERCIAL_LINK_REVIEWER_ROLE_INVALID';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;

