import {sql} from "drizzle-orm";
import {identityNameSql,identityDomainSql} from "../../shared/relationship-evidence-sql";

/** Every alternative is timestamp-qualified. Equality-first, parameterized
 * probes avoid scanning the registry/source universe for each inspected ID.
 * No record-class, source-family or filing-presence narrowing is allowed here.
 */
export function contactBusinessChangeFilter(since:string) {
  const name=(v:string)=>sql.raw(identityNameSql(v));
  const domain=(v:string)=>sql.raw(identityDomainSql(v));
  const retained=sql`SELECT retained.key FROM contact_source_events ev
    CROSS JOIN LATERAL (VALUES (ev.metadata->>'filingNumber'),(ev.metadata->>'filing_number'),
      (ev.metadata->>'place_id'),(ev.metadata->>'placeId'),(ev.metadata->>'google_place_id')) retained(key)
    WHERE ev.contact_id=c.id AND retained.key IS NOT NULL`;
  return sql`(
    c.updated_at>=${since}::timestamptz OR
    EXISTS(SELECT 1 FROM contact_source_events ev
      WHERE ev.contact_id=c.id AND ev.created_at>=${since}::timestamptz OFFSET 0) OR
    EXISTS(SELECT 1 FROM (
      SELECT b.id,b.updated_at FROM businesses b WHERE b.id=c.business_id
      UNION ALL
      SELECT b.id,b.updated_at FROM businesses b WHERE ${name("b.canonical_name")}=${name("c.company_name")}
      UNION ALL
      SELECT b.id,b.updated_at FROM businesses b WHERE ${domain("c.website")} IS NOT NULL
        AND ${domain("b.website_domain")}=${domain("c.website")}
      OFFSET 0
    ) matched JOIN LATERAL (
      SELECT sl.id FROM canonical_source_links sl WHERE sl.business_id=matched.id
        AND greatest(sl.created_at,sl.updated_at)>=${since}::timestamptz OFFSET 0
    ) changed_link ON TRUE) OR
    EXISTS(SELECT 1 FROM (${retained}) retained JOIN LATERAL (
      SELECT sl.id FROM canonical_source_links sl WHERE sl.stable_key=retained.key
        AND greatest(sl.created_at,sl.updated_at)>=${since}::timestamptz
        AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=sl.business_id)
      OFFSET 0
    ) changed_link ON TRUE) OR
    EXISTS(SELECT 1 FROM (
      SELECT se.updated_at FROM sunbiz_entities se
        WHERE ${name("se.entity_name")}=${name("c.company_name")}
          AND se.updated_at>=${since}::timestamptz
      UNION ALL
      SELECT se.updated_at FROM sunbiz_entities se
        WHERE ${name("se.dba")}=${name("c.company_name")}
          AND se.updated_at>=${since}::timestamptz
      UNION ALL
      SELECT se.updated_at FROM contact_source_events ev JOIN sunbiz_entities se
        ON se.filing_number IN (ev.metadata->>'filingNumber',ev.metadata->>'filing_number')
        WHERE ev.contact_id=c.id AND se.updated_at>=${since}::timestamptz
      OFFSET 0
    ) matched WHERE matched.updated_at>=${since}::timestamptz) OR
    EXISTS(SELECT 1 FROM businesses b WHERE ${name("b.canonical_name")}=${name("c.company_name")}
      AND b.updated_at>=${since}::timestamptz OFFSET 0)
  )`;
}
