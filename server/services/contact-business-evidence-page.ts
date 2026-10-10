import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { SystemLinkFacts } from "./contact-business-system-link-policy";
import { identityNameSql, identityDomainSql, relationshipReasonsSql } from "../../shared/relationship-evidence-sql";
import { evidenceRelationshipCandidateCte } from "./contact-business-evidence-candidates";

const rows = (result: any): any[] => result?.rows ?? result ?? [];
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Match generation uses the read-only equivalent of the native write evaluator.
 * A candidate or a matching company name alone is never relationship authority.
 */
export async function loadEvidenceRelationshipPage(
  executor: any, afterContactId: number, limit: number, onlyContactId?: number, changedSince?: string,
) {
  const contacts = rows(await executor.execute(sql`
    SELECT c.id contact_id,c.company_name,c.website contact_website,c.email contact_email,
      c.record_class contact_record_class,c.email_status,c.archived_at,c.address,c.city,c.state,c.phone,
      c.updated_at::text AS contact_revision,c.business_id projected_business_id,
      c.existing_merchant_customer,c.do_not_contact,c.do_not_auto_contact,c.opted_out_email,
      c.opt_out_status,c.unsubscribe_status,c.bounce_status,c.complaint_status,c.suppression_reason,
      (SELECT coalesce(jsonb_agg(to_jsonb(ev)-'last_seen_at' ORDER BY ev.id),'[]'::jsonb)
        FROM contact_source_events ev WHERE ev.contact_id=c.id) source_event_revisions,
      d.id current_decision_id,d.decision current_decision
    FROM contacts c LEFT JOIN contact_business_link_decisions d
      ON d.contact_id=c.id AND d.superseded_at IS NULL
    WHERE ${onlyContactId === undefined ? sql`c.id>${afterContactId}` : sql`c.id=${onlyContactId}`}
      AND ${changedSince && onlyContactId === undefined ? sql`(c.updated_at>=${changedSince}::timestamptz OR
        EXISTS (SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=c.id
          AND ev.created_at>=${changedSince}::timestamptz) OR
        EXISTS (SELECT 1 FROM canonical_source_links changed_link
          JOIN businesses changed_business ON changed_business.id=changed_link.business_id
          WHERE greatest(changed_link.created_at,changed_link.updated_at)>=${changedSince}::timestamptz
            AND (changed_business.id=c.business_id
              OR ${sql.raw(identityNameSql("changed_business.canonical_name"))}=${sql.raw(identityNameSql("c.company_name"))}
              OR (${sql.raw(identityDomainSql("c.website"))} IS NOT NULL
                AND ${sql.raw(identityDomainSql("changed_business.website_domain"))}=${sql.raw(identityDomainSql("c.website"))})
              OR EXISTS(SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=c.id
                AND changed_link.stable_key IN (ev.metadata->>'filingNumber',ev.metadata->>'filing_number',
                  ev.metadata->>'place_id',ev.metadata->>'placeId',ev.metadata->>'google_place_id')))) OR
        EXISTS (SELECT 1 FROM sunbiz_entities changed_entity
          WHERE (to_jsonb(changed_entity)->>'updated_at')::timestamptz>=${changedSince}::timestamptz
            AND (${sql.raw(identityNameSql("c.company_name"))} IN (
              ${sql.raw(identityNameSql("changed_entity.entity_name"))},${sql.raw(identityNameSql("changed_entity.dba"))})
              OR EXISTS(SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=c.id
                AND changed_entity.filing_number IN (ev.metadata->>'filingNumber',ev.metadata->>'filing_number')))) OR
        EXISTS (SELECT 1 FROM businesses changed WHERE changed.updated_at>=${changedSince}::timestamptz
          AND ${sql.raw(identityNameSql("changed.canonical_name"))}=${sql.raw(identityNameSql("c.company_name"))}))` : sql`TRUE`}
    ORDER BY c.id LIMIT ${limit + (onlyContactId === undefined ? 1 : 0)}
  `));
  const page = contacts.slice(0, limit);
  const ids = page.map((c: any) => Number(c.contact_id));
  const matches = ids.length ? rows(await executor.execute(sql`
    ${evidenceRelationshipCandidateCte(ids)}
    SELECT c.id contact_id,b.id business_id,b.canonical_name,b.website_domain business_domain,
      b.record_class business_record_class,b.do_not_visit,b.updated_at::text business_revision,
      sl.id source_link_id,sl.source_system,sl.source_type,sl.stable_key source_stable_key,
      sl.updated_at::text source_revision,se.id source_entity_id,se.entity_name sunbiz_name,
      se.dba sunbiz_dba,se.principal_address,se.principal_city,se.principal_state,
      to_jsonb(se)->>'updated_at' entity_revision,
      se.website sunbiz_website,se.source sunbiz_entity_source,se.filing_number,
      ${sql.raw(relationshipReasonsSql("c.id","b.id","sl.id","se.id"))} relationship_reasons
    FROM candidate_business_keys candidate
    JOIN contacts c ON c.id=candidate.contact_id
    JOIN businesses b ON b.id=candidate.business_id AND b.record_class='canonical'
    JOIN canonical_source_links sl ON sl.business_id=b.id
    LEFT JOIN sunbiz_entities se ON sl.source_system='sunbiz' AND sl.source_type='sunbiz_entity'
      AND se.filing_number=sl.stable_key AND se.source IN ('sunbiz','cordata','corevt')
    WHERE c.id=ANY(ARRAY[${sql.join(ids.map((id: number) => sql`${id}`),sql`, `)}]::integer[])
      AND (${sql.raw(identityNameSql("c.company_name"))}<>'' AND
        ${sql.raw(identityNameSql("c.company_name"))} IN (${sql.raw(identityNameSql("b.canonical_name"))},
          ${sql.raw(identityNameSql("se.entity_name"))},${sql.raw(identityNameSql("se.dba"))})
        OR ${sql.raw(identityDomainSql("c.website"))} IS NOT NULL
          AND ${sql.raw(identityDomainSql("c.website"))}=${sql.raw(identityDomainSql("b.website_domain"))}
        OR EXISTS (SELECT 1 FROM contact_source_events ev WHERE ev.contact_id=c.id
          AND (ev.metadata->>'filingNumber'=sl.stable_key OR ev.metadata->>'filing_number'=sl.stable_key
            OR ev.metadata->>'place_id'=sl.stable_key OR ev.metadata->>'placeId'=sl.stable_key
            OR ev.metadata->>'google_place_id'=sl.stable_key)))
    ORDER BY c.id,b.id,sl.source_system,sl.id,se.id
  `)) : [];
  const selected: SystemLinkFacts[] = [];
  const previews = page.map((c: any) => {
    const alternatives = matches.filter((m: any) => Number(m.contact_id) === Number(c.contact_id));
    const eligible = alternatives.filter((m: any) => m.relationship_reasons?.length === 0);
    const eligibleBusinesses = new Set(eligible.map((m: any) => Number(m.business_id)));
    const winner = eligibleBusinesses.size === 1 ? eligible[0] : undefined;
    const reasons = winner ? [] : eligibleBusinesses.size > 1 ? ["competing_corroborated_businesses"]
      : alternatives.length ? [...new Set(alternatives.flatMap((m: any) => m.relationship_reasons))]
        : ["independent_business_identity_not_found"];
    const facts = winner ? {
      ...c,...winner,contactId: Number(c.contact_id),businessId: Number(winner.business_id),
      sourceLinkId: String(winner.source_link_id),
      sourceEntityId: winner.source_entity_id == null ? null : Number(winner.source_entity_id),
      companyName: c.company_name,contactWebsite: c.contact_website,contactEmail: c.contact_email,
      canonicalName: winner.canonical_name,businessDomain: winner.business_domain,
      sourceSystem: winner.source_system,sourceType: winner.source_type,
      sourceStableKey: winner.source_stable_key,filingNumber: winner.filing_number,
      relationshipReasons: reasons,
      identityRevision: hash([c.contact_revision,winner.business_revision,winner.source_revision,
        c.source_event_revisions,
        c.company_name,c.address,c.city,c.state,c.phone,winner.source_entity_id,winner.entity_revision,
        winner.sunbiz_name,winner.sunbiz_dba,winner.principal_address,winner.principal_city,winner.principal_state]),
    } as SystemLinkFacts : undefined;
    if (facts) selected.push(facts);
    return {
      contactId: Number(c.contact_id),businessId: winner ? Number(winner.business_id) : null,
      companyName: c.company_name ?? null,sourceLinkId: facts?.sourceLinkId ?? null,
      sourceEntityId: facts?.sourceEntityId ?? null,eligible: !!winner,reasons,
      // Negative and positive snapshots pin ALL competing evidence and revisions.
      // An unchanged reason string does not prove an unchanged native decision.
      snapshotHash: hash([c,alternatives,reasons]),
      contactRevision:c.contact_revision,currentDecisionId:c.current_decision_id ?? null,
      projectedBusinessId:c.projected_business_id ?? null,
      candidateEvidence:alternatives.map((m:any)=>({businessId:Number(m.business_id),
        sourceLinkId:String(m.source_link_id),sourceEntityId:m.source_entity_id ?? null,
        businessRevision:m.business_revision,sourceRevision:m.source_revision,
        entityRevision:m.entity_revision,reasons:m.relationship_reasons})),
    };
  });
  return { previews,selectedFacts: onlyContactId === undefined ? undefined : selected[0],
    selectedFactsForPage: selected,lastContactId: page.length ? Number(page.at(-1).contact_id) : afterContactId,
    hasMore: contacts.length > limit };
}