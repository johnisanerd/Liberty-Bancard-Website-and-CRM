import { sql } from "drizzle-orm";
import { identityNameSql, identityDomainSql } from "../../shared/relationship-evidence-sql";

/**
 * Candidate retrieval only, never relationship authority. Separate equality
 * branches let PostgreSQL hash/index join before evaluating retained evidence.
 * Do not cap alternatives: competing corroborated identities must remain visible.
 */
export function evidenceRelationshipCandidateCte(contactIds: number[]) {
  return sql`WITH contact_page AS MATERIALIZED (
    SELECT c.id,${sql.raw(identityNameSql("c.company_name"))} name_key,
      ${sql.raw(identityDomainSql("c.website"))} domain_key
    FROM contacts c WHERE c.id=ANY(ARRAY[
      ${sql.join(contactIds.map(id=>sql`${id}`),sql`, `)}
    ]::integer[])
  ), candidate_business_keys AS MATERIALIZED (
    SELECT c.id contact_id,b.id business_id FROM contact_page c
      JOIN LATERAL (
        SELECT b.id FROM businesses b
        WHERE c.name_key<>'' AND b.record_class='canonical'
          AND ${sql.raw(identityNameSql("b.canonical_name"))}=c.name_key
        OFFSET 0
      ) b ON TRUE
    UNION
    SELECT c.id,b.id FROM contact_page c
      JOIN LATERAL (
        SELECT b.id FROM businesses b
        WHERE c.domain_key IS NOT NULL AND b.record_class='canonical'
          AND ${sql.raw(identityDomainSql("b.website_domain"))}=c.domain_key
        OFFSET 0
      ) b ON TRUE
    UNION
    SELECT c.id,sl.business_id FROM contact_page c
      JOIN LATERAL (
        SELECT se.filing_number FROM sunbiz_entities se
        WHERE c.name_key<>'' AND ${sql.raw(identityNameSql("se.entity_name"))}=c.name_key
          AND se.filing_number IS NOT NULL AND se.source IN ('sunbiz','cordata','corevt')
        OFFSET 0
      ) matched ON TRUE
      JOIN canonical_source_links sl ON sl.stable_key=matched.filing_number
        AND sl.source_system='sunbiz' AND sl.source_type='sunbiz_entity'
    UNION
    SELECT c.id,sl.business_id FROM contact_page c
      JOIN LATERAL (
        SELECT se.filing_number FROM sunbiz_entities se
        WHERE c.name_key<>'' AND ${sql.raw(identityNameSql("se.dba"))}=c.name_key
          AND se.filing_number IS NOT NULL AND se.dba IS NOT NULL
          AND se.source IN ('sunbiz','cordata','corevt')
        OFFSET 0
      ) matched ON TRUE
      JOIN canonical_source_links sl ON sl.stable_key=matched.filing_number
        AND sl.source_system='sunbiz' AND sl.source_type='sunbiz_entity'
    UNION
    SELECT c.id,sl.business_id FROM contact_page c
      JOIN contact_source_events ev ON ev.contact_id=c.id
      CROSS JOIN LATERAL (VALUES
        (ev.metadata->>'filingNumber'),(ev.metadata->>'filing_number'),
        (ev.metadata->>'place_id'),(ev.metadata->>'placeId'),
        (ev.metadata->>'google_place_id')
      ) retained(stable_key)
      JOIN canonical_source_links sl ON sl.stable_key=retained.stable_key
  )`;
}