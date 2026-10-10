import {stateIdentitySql} from "./state-identity";

/** Additive source-family authority. A lineage key alone never proves affiliation.
 * Expressions are trusted SQL identifiers; never interpolate request values.
 */
export function sourceFamilyRelationshipReasonsSql(contact:string,business:string,source:string):string {
  const normal=(value:string)=>`regexp_replace(lower(btrim(coalesce(${value},''))),'[^a-z0-9]','','g')`;
  const name=(value:string)=>`regexp_replace(regexp_replace(lower(normalize(coalesce(${value},''),NFKD)),
    '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M','','g'),'[^a-z0-9]','','g')`;
  const phone=(value:string)=>`right(regexp_replace(coalesce(${value},''),'[^0-9]','','g'),10)`;
  const domain=(value:string)=>`NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(${value},'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')`;
  return `(WITH subject AS MATERIALIZED (
    SELECT c.*,b.id bid,b.record_class business_class,b.canonical_name,b.city business_city,
      b.state business_state,b.street_address,b.main_phone,b.website_domain,
      s.id sid,s.source_system,s.source_type,s.stable_key,s.raw_evidence->'businessEvidence' proof
    FROM (SELECT ${contact}::integer cid,${business}::integer biz,${source}::uuid src) keys
    LEFT JOIN contacts c ON c.id=keys.cid LEFT JOIN businesses b ON b.id=keys.biz
    LEFT JOIN canonical_source_links s ON s.id=keys.src AND s.business_id=b.id
  ), facts AS MATERIALIZED (
    SELECT subject.*,
      ${name("company_name")}<>'' AND ${name("company_name")}=${name("canonical_name")}
        AND ${name("company_name")}=${name("proof->>'canonicalName'")} name_match,
      ${normal("address")}<>'' AND ${normal("address")}=${normal("street_address")}
        AND ${normal("address")}=${normal("proof->>'streetAddress'")}
        AND ${normal("city")}<>'' AND ${normal("city")}=${normal("business_city")}
        AND ${normal("city")}=${normal("proof->>'city'")}
        AND ${stateIdentitySql("state")}<>'' AND ${stateIdentitySql("state")}=${stateIdentitySql("business_state")}
        AND ${stateIdentitySql("state")}=${stateIdentitySql("proof->>'state'")} location_match,
      ${domain("website")} IS NOT NULL AND ${domain("website")}=${domain("website_domain")}
        AND ${domain("website")}=${domain("proof->>'websiteDomain'")}
        AND ${domain("website")} NOT IN ('instagram.com','facebook.com','waze.com','linktr.ee',
          'linkedin.com','google.com','maps.google.com','yelp.com','tiktok.com','bit.ly',
          'gmail.com','yahoo.com','outlook.com','hotmail.com')
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['instagram.com','facebook.com','google.com',
          'linkedin.com','yelp.com','tiktok.com']) host WHERE ${domain("website")} LIKE '%.'||host) domain_match,
      length(regexp_replace(coalesce(phone,''),'[^0-9]','','g'))>=10
        AND ${phone("phone")}=${phone("main_phone")} AND ${phone("phone")}=${phone("proof->>'mainPhone'")} phone_match,
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
          AND (${domain("other.website_domain")}=${domain("facts.website")}
            OR ${phone("other.main_phone")}=${phone("facts.phone")}))=1),FALSE)
      THEN 'independent_corroboration_required' END,
    CASE WHEN ${stateIdentitySql("state")}<>'' AND ${stateIdentitySql("business_state")}<>''
      AND ${stateIdentitySql("state")}<>${stateIdentitySql("business_state")} THEN 'location_state_conflict' END,
    CASE WHEN ${normal("city")}<>'' AND ${normal("business_city")}<>''
      AND ${normal("city")}<>${normal("business_city")} THEN 'location_city_conflict' END,
    CASE WHEN ${normal("address")}<>'' AND ${normal("street_address")}<>''
      AND ${normal("address")}<>${normal("street_address")} THEN 'location_address_conflict' END
  ]::text[],NULL) FROM facts)`;
}
