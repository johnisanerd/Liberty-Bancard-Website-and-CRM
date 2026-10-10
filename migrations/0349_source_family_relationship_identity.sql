-- Development-only schema delivery. Exact prior/current contracts are pinned;
-- owner-executed production delivery must use the separately approved route.
CREATE OR REPLACE FUNCTION public.crm_source_family_relationship_reasons(
  contact_key integer,business_key integer,source_key uuid)
RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT (WITH subject AS MATERIALIZED (
    SELECT c.*,b.id bid,b.record_class business_class,b.canonical_name,b.city business_city,
      b.state business_state,b.street_address,b.main_phone,b.website_domain,
      s.id sid,s.source_system,s.source_type,s.stable_key,s.raw_evidence->'businessEvidence' proof
    FROM (SELECT contact_key::integer cid,business_key::integer biz,source_key::uuid src) keys
    LEFT JOIN contacts c ON c.id=keys.cid LEFT JOIN businesses b ON b.id=keys.biz
    LEFT JOIN canonical_source_links s ON s.id=keys.src AND s.business_id=b.id
  ), facts AS MATERIALIZED (
    SELECT subject.*,
      regexp_replace(regexp_replace(lower(normalize(coalesce(company_name,''),NFKD)),
    '\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M','','g'),'[^a-z0-9]','','g')<>'' AND regexp_replace(regexp_replace(lower(normalize(coalesce(company_name,''),NFKD)),
    '\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M','','g'),'[^a-z0-9]','','g')=regexp_replace(regexp_replace(lower(normalize(coalesce(canonical_name,''),NFKD)),
    '\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M','','g'),'[^a-z0-9]','','g')
        AND regexp_replace(regexp_replace(lower(normalize(coalesce(company_name,''),NFKD)),
    '\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M','','g'),'[^a-z0-9]','','g')=regexp_replace(regexp_replace(lower(normalize(coalesce(proof->>'canonicalName',''),NFKD)),
    '\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M','','g'),'[^a-z0-9]','','g') name_match,
      regexp_replace(lower(btrim(coalesce(address,''))),'[^a-z0-9]','','g')<>'' AND regexp_replace(lower(btrim(coalesce(address,''))),'[^a-z0-9]','','g')=regexp_replace(lower(btrim(coalesce(street_address,''))),'[^a-z0-9]','','g')
        AND regexp_replace(lower(btrim(coalesce(address,''))),'[^a-z0-9]','','g')=regexp_replace(lower(btrim(coalesce(proof->>'streetAddress',''))),'[^a-z0-9]','','g')
        AND regexp_replace(lower(btrim(coalesce(city,''))),'[^a-z0-9]','','g')<>'' AND regexp_replace(lower(btrim(coalesce(city,''))),'[^a-z0-9]','','g')=regexp_replace(lower(btrim(coalesce(business_city,''))),'[^a-z0-9]','','g')
        AND regexp_replace(lower(btrim(coalesce(city,''))),'[^a-z0-9]','','g')=regexp_replace(lower(btrim(coalesce(proof->>'city',''))),'[^a-z0-9]','','g')
        AND CASE WHEN upper(btrim(coalesce(state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(state,''))) END<>'' AND CASE WHEN upper(btrim(coalesce(state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(state,''))) END=CASE WHEN upper(btrim(coalesce(business_state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(business_state,''))) END
        AND CASE WHEN upper(btrim(coalesce(state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(state,''))) END=CASE WHEN upper(btrim(coalesce(proof->>'state','')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(proof->>'state',''))) END location_match,
      NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(website,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'') IS NOT NULL AND NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(website,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')=NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(website_domain,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')
        AND NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(website,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')=NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(proof->>'websiteDomain','')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')
        AND NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(website,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'') NOT IN ('instagram.com','facebook.com','waze.com','linktr.ee',
          'linkedin.com','google.com','maps.google.com','yelp.com','tiktok.com','bit.ly',
          'gmail.com','yahoo.com','outlook.com','hotmail.com')
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['instagram.com','facebook.com','google.com',
          'linkedin.com','yelp.com','tiktok.com']) host WHERE NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(website,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'') LIKE '%.'||host) domain_match,
      length(regexp_replace(coalesce(phone,''),'[^0-9]','','g'))>=10
        AND right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10)=right(regexp_replace(coalesce(main_phone,''),'[^0-9]','','g'),10) AND right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10)=right(regexp_replace(coalesce(proof->>'mainPhone',''),'[^0-9]','','g'),10) phone_match,
      EXISTS(SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=subject.id
        AND (ev.source_category IN ('ghl_sync','crm','crm_manual','manual_crm','csv_import','manual_import','apollo')
          OR ev.source_type IN ('google_maps_outscraper','apollo_lead_list'))
        AND ev.metadata->'businessEvidence'=subject.proof
        AND NOT EXISTS(SELECT 1 FROM contact_source_events newer
          WHERE newer.contact_id=ev.contact_id AND newer.id>ev.id
            AND newer.source_category=ev.source_category AND newer.source_type=ev.source_type
            AND newer.source_external_id IS NOT DISTINCT FROM ev.source_external_id
            AND jsonb_typeof(newer.metadata->'businessEvidence')='object')
        AND NOT(ev.metadata ? 'businessId' AND ev.metadata->>'businessId'<>subject.bid::text)) event_match
    FROM subject
  ) SELECT array_remove(ARRAY[
    CASE WHEN id IS NULL THEN 'contact_missing' END,
    CASE WHEN bid IS NULL THEN 'business_missing' END,
    CASE WHEN archived_at IS NOT NULL OR record_class IS NULL OR record_class IN ('test','demo','synthetic')
      OR business_class IS DISTINCT FROM 'canonical' THEN 'non_production_record_class' END,
    CASE WHEN business_id IS NOT NULL OR EXISTS(SELECT 1 FROM contact_business_link_decisions d
      WHERE d.contact_id=facts.id AND d.superseded_at IS NULL) THEN 'current_link_decision_exists' END,
    CASE WHEN sid IS NULL THEN 'independent_source_link_missing' END,
    CASE WHEN NOT coalesce(source_system IN ('crm','ghl','apollo','google_maps','google','outscraper'),FALSE)
      OR source_type NOT IN ('provider_import','organization','organization_location','crm_organization')
      THEN 'unsupported_identity_source' END,
    CASE WHEN NOT coalesce(name_match,FALSE) THEN 'company_or_trade_name_conflict' END,
    CASE WHEN NOT coalesce(event_match AND (location_match AND (domain_match OR phone_match)
      OR domain_match AND phone_match
        AND (SELECT count(*) FROM businesses other WHERE other.record_class='canonical'
          AND (NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(other.website_domain,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')=NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(facts.website,'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')
            OR right(regexp_replace(coalesce(other.main_phone,''),'[^0-9]','','g'),10)=right(regexp_replace(coalesce(facts.phone,''),'[^0-9]','','g'),10)))=1),FALSE)
      THEN 'independent_corroboration_required' END,
    CASE WHEN CASE WHEN upper(btrim(coalesce(state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(state,''))) END<>'' AND CASE WHEN upper(btrim(coalesce(business_state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(business_state,''))) END<>''
      AND CASE WHEN upper(btrim(coalesce(state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(state,''))) END<>CASE WHEN upper(btrim(coalesce(business_state,'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(business_state,''))) END THEN 'location_state_conflict' END,
    CASE WHEN regexp_replace(lower(btrim(coalesce(city,''))),'[^a-z0-9]','','g')<>'' AND regexp_replace(lower(btrim(coalesce(business_city,''))),'[^a-z0-9]','','g')<>''
      AND regexp_replace(lower(btrim(coalesce(city,''))),'[^a-z0-9]','','g')<>regexp_replace(lower(btrim(coalesce(business_city,''))),'[^a-z0-9]','','g') THEN 'location_city_conflict' END,
    CASE WHEN regexp_replace(lower(btrim(coalesce(address,''))),'[^a-z0-9]','','g')<>'' AND regexp_replace(lower(btrim(coalesce(street_address,''))),'[^a-z0-9]','','g')<>''
      AND regexp_replace(lower(btrim(coalesce(address,''))),'[^a-z0-9]','','g')<>regexp_replace(lower(btrim(coalesce(street_address,''))),'[^a-z0-9]','','g') THEN 'location_address_conflict' END
  ]::text[],NULL) FROM facts)
$$;
--> statement-breakpoint
DO $upgrade$
DECLARE body text; next_body text;
BEGIN
  SELECT prosrc INTO body FROM pg_proc WHERE oid='public.crm_automatic_relationship_reasons(integer,integer,uuid,integer)'::regprocedure;
  IF md5(body)<>'6868a6d639a3fd0af7a10346821dad19' THEN
    RAISE EXCEPTION 'CRM_RELATIONSHIP_UPSTREAM_GUARD_DRIFT';
  END IF;
  next_body:=replace(body,E'BEGIN\n  SELECT * INTO c',E'BEGIN\n  IF EXISTS(SELECT 1 FROM canonical_source_links family WHERE family.id=source_key AND family.business_id=business_key AND family.source_system IN (''crm'',''ghl'',''apollo'',''google_maps'',''google'',''outscraper'') AND family.source_type IN (''provider_import'',''organization'',''organization_location'',''crm_organization'')) THEN\n    RETURN crm_source_family_relationship_reasons(contact_key,business_key,source_key);\n  END IF;\n  SELECT * INTO c');
  next_body:=replace(next_body,'crm_identity_name(c.state)', '(CASE WHEN upper(btrim(coalesce(c.state,'''')))=''FLORIDA'' THEN ''FL'' ELSE upper(btrim(coalesce(c.state,''''))) END)');
  next_body:=replace(next_body,'crm_identity_name(e.principal_state)', '(CASE WHEN upper(btrim(coalesce(e.principal_state,'''')))=''FLORIDA'' THEN ''FL'' ELSE upper(btrim(coalesce(e.principal_state,''''))) END)');
  next_body:=replace(next_body,'crm_identity_name(oe.principal_state)', '(CASE WHEN upper(btrim(coalesce(oe.principal_state,'''')))=''FLORIDA'' THEN ''FL'' ELSE upper(btrim(coalesce(oe.principal_state,''''))) END)');
  next_body:=replace(next_body,'upper(btrim(c.state))<>upper(btrim(b.state))', '(CASE WHEN upper(btrim(coalesce(c.state,'''')))=''FLORIDA'' THEN ''FL'' ELSE upper(btrim(coalesce(c.state,''''))) END)<>(CASE WHEN upper(btrim(coalesce(b.state,'''')))=''FLORIDA'' THEN ''FL'' ELSE upper(btrim(coalesce(b.state,''''))) END)');
  IF next_body=body OR strpos(next_body,'crm_source_family_relationship_reasons')=0 THEN
    RAISE EXCEPTION 'CRM_RELATIONSHIP_GUARD_BOUNDARY_MISSING';
  END IF;
  IF md5(next_body)<>'3ee7b8798d9dce2f2c6e92ef91c51c7e' THEN
    RAISE EXCEPTION 'CRM_RELATIONSHIP_NATIVE_BODY_DRIFT';
  END IF;
  EXECUTE 'CREATE OR REPLACE FUNCTION public.crm_automatic_relationship_reasons(contact_key integer,business_key integer,source_key uuid,entity_key integer) RETURNS text[] LANGUAGE plpgsql STABLE AS '||quote_literal(next_body);
  SELECT prosrc INTO body FROM pg_proc WHERE oid='public.enforce_reviewed_contact_business_link()'::regprocedure;
  IF strpos(body,'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */')=0
    OR md5(replace(body,'AND po.subject_type IN (''business'',''contact'') /* canonical_address_receipt_v1 */',
      'AND po.subject_type=''business'' AND po.subject_id=NEW.business_id'))<>'46f89326f7c158ac739814ce343c2559' THEN
    RAISE EXCEPTION 'CRM_RELATIONSHIP_UPSTREAM_GUARD_DRIFT';
  END IF;
  next_body:=replace(body,'crm_evidence_identity_v2','crm_evidence_identity_v3');
  IF md5(next_body)<>'2d38f8614320afbf936c529662e2c684' THEN
    RAISE EXCEPTION 'CRM_RELATIONSHIP_NATIVE_BODY_DRIFT';
  END IF;
  EXECUTE 'CREATE OR REPLACE FUNCTION public.enforce_reviewed_contact_business_link() RETURNS trigger LANGUAGE plpgsql AS '||quote_literal(next_body);
END $upgrade$;
