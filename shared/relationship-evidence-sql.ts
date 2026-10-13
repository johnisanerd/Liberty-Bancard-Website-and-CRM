import { stateIdentitySql } from "./state-identity";
import { sourceFamilyRelationshipReasonsSql } from "./source-family-relationship-sql";
/**
 * Read-only equivalent of the crm_evidence_identity_v3 native evaluator.
 * Publish does not reliably transfer native functions. Reads must not depend
 * on their presence; writes still require the native, fingerprinted fence.
 * Arguments are trusted SQL expressions, never request values.
 */
export function identityNameSql(value: string): string {
  return `regexp_replace(regexp_replace(lower(normalize(coalesce(${value},''),NFKD)),
    '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M','','g'),'[^a-z0-9]','','g')`;
}
export function identityDomainSql(value: string): string {
  return `NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(
    btrim(coalesce(${value},'')),'^[a-zA-Z]+://',''), '/',1),':',1),'^www[.]','','i')),'')`;
}
export function relationshipReasonsSql(contact: string, business: string, source: string, entity: string): string {
  const name = identityNameSql;
  const domain = identityDomainSql;
  const phone = (v: string) => `right(regexp_replace(coalesce(${v},''),'[^0-9]','','g'),10)`;
  const sharedHosts = "'instagram.com','facebook.com','waze.com','linktr.ee','linkedin.com','google.com','yelp.com','tiktok.com','bit.ly'";
  return `(CASE WHEN EXISTS(SELECT 1 FROM canonical_source_links family
    WHERE family.id=${source}::uuid AND family.business_id=${business}::integer
      AND family.source_system IN ('crm','ghl','apollo','google_maps','google','outscraper')
      AND family.source_type IN ('provider_import','organization','organization_location','crm_organization'))
    THEN ${sourceFamilyRelationshipReasonsSql(contact,business,source)}
    ELSE (WITH subject AS MATERIALIZED (
    SELECT c.*,b.id bid,b.canonical_name,b.record_class business_class,
      b.street_address,b.state business_state,b.main_phone,b.website_domain,b.google_place_id,
      s.id sid,s.source_system,s.source_type,s.stable_key,
      e.id eid,e.entity_name,e.dba,e.principal_address,e.principal_city,e.principal_state,
      e.website registry_website,to_jsonb(e) entity_json
    FROM (SELECT ${contact}::integer cid,${business}::integer biz) keys
    LEFT JOIN contacts c ON c.id=keys.cid
    LEFT JOIN businesses b ON b.id=keys.biz
    LEFT JOIN canonical_source_links s ON s.id=${source}::uuid AND s.business_id=b.id
    LEFT JOIN sunbiz_entities e ON e.id=${entity}::integer AND e.filing_number=s.stable_key
      AND e.source IN ('cordata','corevt','sunbiz')
  ), facts AS MATERIALIZED (
    SELECT s.*,
      (s.source_system='sunbiz' AND s.source_type='sunbiz_entity') registry,
      (s.source_system IN ('google_maps','google','outscraper') AND ${entity}::integer IS NULL) maps,
      EXISTS(SELECT 1 FROM contact_business_link_decisions d
        WHERE d.contact_id=s.id AND d.superseded_at IS NULL) has_decision,
      CASE WHEN s.source_system='sunbiz' AND s.source_type='sunbiz_entity'
        THEN ${name("s.company_name")}<>'' AND ${name("s.company_name")}
          IN (${name("s.entity_name")},${name("s.dba")})
        ELSE ${name("s.company_name")}<>'' AND ${name("s.company_name")}=${name("s.canonical_name")} END name_match,
      CASE WHEN s.source_system='sunbiz' AND s.source_type='sunbiz_entity' THEN EXISTS(
        SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=s.id
          AND (ev.metadata->>'filingNumber'=s.stable_key OR ev.metadata->>'filing_number'=s.stable_key)
          AND NOT(ev.metadata ? 'businessId' AND ev.metadata->>'businessId'<>s.bid::text))
        ELSE s.google_place_id IS NOT NULL AND s.stable_key<>'' AND s.stable_key=s.google_place_id AND EXISTS(
          SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=s.id
            AND (ev.metadata->>'place_id'=s.stable_key OR ev.metadata->>'placeId'=s.stable_key
              OR ev.metadata->>'google_place_id'=s.stable_key)
            AND NOT(ev.metadata ? 'businessId' AND ev.metadata->>'businessId'<>s.bid::text))
        END stable_match,
      ${name("s.address")}<>'' AND ${name("s.address")}=${name("s.principal_address")}
        AND ${name("s.city")}<>'' AND ${name("s.city")}=${name("s.principal_city")}
        AND ${stateIdentitySql("s.state")}<>'' AND ${stateIdentitySql("s.state")}=${stateIdentitySql("s.principal_state")}
        AND (NULLIF(s.street_address,'') IS NULL OR ${name("s.street_address")}=${name("s.address")}) address_match,
      length(regexp_replace(coalesce(s.phone,''),'[^0-9]','','g'))>=10
        AND ${phone("s.phone")}=${phone("coalesce(nullif(s.entity_json->>'phone',''),s.entity_json->>'owner_phone','')")}
        AND ${phone("s.phone")}=${phone("s.main_phone")}
        AND (SELECT count(*) FROM businesses ob WHERE ob.record_class='canonical'
          AND ${phone("ob.main_phone")}=${phone("s.phone")})=1 phone_match,
      ${domain("s.website")} contact_domain,${domain("s.website_domain")} canonical_domain
    FROM subject s
  ), evaluated AS (
    SELECT f.*,
      contact_domain IS NOT NULL AND canonical_domain IS NOT NULL AND contact_domain=canonical_domain
        AND coalesce((registry AND ${domain("f.registry_website")}=contact_domain)
          OR (maps AND stable_match),FALSE)
        AND contact_domain NOT IN (${sharedHosts},'maps.google.com')
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[${sharedHosts}]) host
          WHERE contact_domain LIKE '%.'||host)
        AND (SELECT count(*) FROM businesses ob WHERE ob.record_class='canonical'
          AND ${domain("ob.website_domain")}=contact_domain)=1 domain_match
    FROM facts f
  ) SELECT CASE
    WHEN id IS NULL THEN ARRAY['contact_missing']::text[]
    WHEN bid IS NULL THEN ARRAY['business_missing']::text[]
    ELSE array_remove(ARRAY[
      CASE WHEN archived_at IS NOT NULL OR record_class IS NULL OR record_class IN ('test','demo','synthetic')
        OR business_class IS DISTINCT FROM 'canonical' THEN 'non_production_record_class' END,
      CASE WHEN business_id IS NOT NULL OR has_decision THEN 'current_link_decision_exists' END,
      CASE WHEN sid IS NULL THEN 'independent_source_link_missing' END,
      CASE WHEN sid IS NOT NULL AND registry AND eid IS NULL THEN 'independent_registry_identity_missing' END,
      CASE WHEN sid IS NOT NULL AND NOT coalesce(registry OR maps,FALSE) THEN 'unsupported_identity_source' END,
      CASE WHEN sid IS NOT NULL AND (maps OR (registry AND eid IS NOT NULL))
        AND registry AND ${name("canonical_name")} NOT IN (${name("entity_name")},${name("dba")})
        THEN 'canonical_registry_name_conflict' END,
      CASE WHEN sid IS NOT NULL AND (maps OR (registry AND eid IS NOT NULL))
        AND NOT name_match THEN 'company_or_trade_name_conflict' END,
      CASE WHEN sid IS NOT NULL AND (maps OR (registry AND eid IS NOT NULL))
        AND NOT(stable_match OR (registry AND (address_match OR phone_match)) OR domain_match)
        THEN 'independent_corroboration_required' END,
      CASE WHEN registry AND eid IS NOT NULL AND address_match AND NOT stable_match AND EXISTS(
        SELECT 1 FROM (
          SELECT oe.filing_number,oe.principal_address,oe.principal_city,oe.principal_state
          FROM sunbiz_entities oe
          WHERE oe.filing_number IS NOT NULL AND oe.source IN ('cordata','corevt','sunbiz')
            AND ${name("oe.entity_name")}=${name("evaluated.company_name")}
          UNION ALL
          SELECT oe.filing_number,oe.principal_address,oe.principal_city,oe.principal_state
          FROM sunbiz_entities oe
          WHERE oe.filing_number IS NOT NULL AND oe.source IN ('cordata','corevt','sunbiz')
            AND oe.dba IS NOT NULL AND ${name("oe.dba")}=${name("evaluated.company_name")}
          UNION ALL
          -- The old coalesce(dba,'') could match an empty contact-name key.
          -- Preserve that case exactly rather than narrowing conflict evidence.
          SELECT oe.filing_number,oe.principal_address,oe.principal_city,oe.principal_state
          FROM sunbiz_entities oe
          WHERE oe.filing_number IS NOT NULL AND oe.source IN ('cordata','corevt','sunbiz')
            AND oe.dba IS NULL AND ${name("evaluated.company_name")}=''
        ) oe
        CROSS JOIN LATERAL (
          SELECT os.business_id FROM canonical_source_links os
          WHERE os.source_system='sunbiz' AND os.source_type='sunbiz_entity'
            AND os.stable_key=oe.filing_number
          OFFSET 0
        ) os
        JOIN businesses ob ON ob.id=os.business_id AND ob.record_class='canonical'
        WHERE ob.id<>bid
          AND ${name("evaluated.address")}=${name("oe.principal_address")}
          AND ${name("evaluated.city")}=${name("oe.principal_city")}
          AND ${stateIdentitySql("evaluated.state")}=${stateIdentitySql("oe.principal_state")}) THEN 'address_competing_businesses' END,
      CASE WHEN sid IS NOT NULL AND (maps OR (registry AND eid IS NOT NULL)) AND EXISTS(
        SELECT 1 FROM canonical_source_links os
        JOIN businesses ob ON ob.id=os.business_id AND ob.record_class='canonical'
        WHERE os.source_system=evaluated.source_system AND os.source_type=evaluated.source_type
          AND os.stable_key=evaluated.stable_key AND os.business_id<>evaluated.bid)
        THEN 'stable_identifier_competing_businesses' END,
      CASE WHEN sid IS NOT NULL AND (maps OR (registry AND eid IS NOT NULL))
        AND state IS NOT NULL AND business_state IS NOT NULL
        AND ${stateIdentitySql("state")}<>${stateIdentitySql("business_state")} THEN 'location_state_conflict' END
    ]::text[],NULL) END FROM evaluated) END)`;
}