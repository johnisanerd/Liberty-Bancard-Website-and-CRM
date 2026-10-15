import {sql} from "drizzle-orm";
import {identityNameSql} from "../../shared/relationship-evidence-sql";
import {normalizeStateIdentity} from "../../shared/state-identity";
import {normalOrganizationValue} from "./organization-resolution-policy";
import {normalizeDomain} from "./sdr/dedupe";
import {resolveOrganization} from "./organization-resolver";
import type {ContactBusinessMaterializationOutcome} from "./contact-business-materialization";

const rows=(r:any):any[]=>r.rows ?? r;
/** Bounded admission hint only. A retained prospect is not proof of completion.
 * The writer below independently locks/rechecks the exact source chain. */
export function retainedSunbizCompletionExistsSql(contact:any){
  return sql`EXISTS(SELECT 1 FROM prospects p JOIN sunbiz_entities se ON se.prospect_id=p.id
    JOIN sunbiz_bootstrap_claims claim ON claim.sunbiz_entity_id=se.id AND claim.filing_number=se.filing_number
    WHERE p.contact_id=${contact} AND claim.status='deferred_collision'
      AND claim.deferred_reason_code='legacy_sunbiz_promotion_exists' AND claim.business_id IS NULL)`;
}

/** Complete the BUSINESS side of a legacy prospect promotion, without updating
 * its terminal claim, original ledger, accounting, or contact identity fields.
 * Must run inside the materializer's guarded canonical transaction. */
export async function materializeRetainedSunbizContact(tx:any,contact:any,authority:(tx:any)=>Promise<void>):
  Promise<ContactBusinessMaterializationOutcome>{
  const candidates=rows(await tx.execute(sql`SELECT se.*,to_jsonb(se) source_snapshot,p.id retained_prospect_id,
    claim.id retained_claim_id,
    (${sql.raw(identityNameSql("se.entity_name"))}<>'' AND
      ${sql.raw(identityNameSql("contact.company_name"))} IN (
        ${sql.raw(identityNameSql("se.entity_name"))},${sql.raw(identityNameSql("se.dba"))})) name_agrees
    FROM contacts contact JOIN prospects p ON p.contact_id=contact.id
    JOIN sunbiz_entities se ON se.prospect_id=p.id
    JOIN sunbiz_bootstrap_claims claim ON claim.sunbiz_entity_id=se.id AND claim.filing_number=se.filing_number
    WHERE contact.id=${contact.id} AND claim.status='deferred_collision'
      AND claim.deferred_reason_code='legacy_sunbiz_promotion_exists' AND claim.business_id IS NULL
    ORDER BY se.id`));
  if(!candidates.length)return {status:"held",reasonCode:"RETAINED_ORGANIZATION_EVIDENCE_MISSING"};
  // Do not silently choose one filing when the retained source chain is plural.
  if(candidates.length!==1)return {status:"held",reasonCode:"RETAINED_REGISTRY_SOURCE_AMBIGUOUS"};
  const source=candidates[0];
  if(!source.name_agrees || !["sunbiz","cordata","corevt"].includes(source.source) ||
    !["hot","warm"].includes(source.score) ||
    !(source.website || source.phone || source.principal_city && source.principal_state))
    return {status:"held",reasonCode:"RETAINED_REGISTRY_IDENTITY_UNSUPPORTED"};
  if(contact.state && source.principal_state &&
    normalizeStateIdentity(contact.state)!==normalizeStateIdentity(source.principal_state) ||
    contact.city && source.principal_city &&
    normalOrganizationValue(contact.city)!==normalOrganizationValue(source.principal_city))
    return {status:"held",reasonCode:"RETAINED_REGISTRY_LOCATION_CONFLICT"};
  await authority(tx);
  const resolution=await resolveOrganization({
    canonicalName:source.entity_name,websiteDomain:normalizeDomain(source.website),mainPhone:source.phone,
    streetAddress:source.principal_address,city:source.principal_city,state:source.principal_state,
    sourceIdentity:{sourceSystem:"sunbiz",sourceType:"sunbiz_entity",stableKey:source.filing_number},
    // Organization canonicality is the same resolver-owned class used by the
    // ordinary contact/provider materializers. Commercial "production" is a
    // different value and is not accepted by the native relationship writer.
    create:{recordClass:"canonical",lastSourceType:"sunbiz"},
    transaction:tx,authorityCheck:async()=>{await authority(tx);return true;},
  });
  if(resolution.kind==="deferred")return {status:"held",reasonCode:resolution.reasonCode};
  if(resolution.business.recordClass!=="canonical")
    return {status:"held",reasonCode:"RETAINED_REGISTRY_BUSINESS_NOT_CANONICAL",businessId:resolution.business.id};
  // The resolver's source/identity locks precede source/claim/contact row locks.
  const pinned=rows(await tx.execute(sql`SELECT c.* FROM contacts c WHERE c.id=${contact.id} FOR UPDATE`))[0];
  if(!pinned || JSON.stringify(pinned)!==JSON.stringify(contact))
    throw new Error("CONTACT_BUSINESS_MATERIALIZATION_EVIDENCE_CHANGED");
  const verified=rows(await tx.execute(sql`SELECT se.id FROM sunbiz_entities se
    JOIN prospects p ON p.id=se.prospect_id JOIN sunbiz_bootstrap_claims claim ON claim.sunbiz_entity_id=se.id
    WHERE se.id=${source.id} AND p.id=${source.retained_prospect_id} AND p.contact_id=${contact.id}
      AND claim.id=${source.retained_claim_id} AND claim.filing_number=${source.filing_number}
      AND claim.status='deferred_collision' AND claim.deferred_reason_code='legacy_sunbiz_promotion_exists'
      AND claim.business_id IS NULL
      AND to_jsonb(se)=${JSON.stringify(source.source_snapshot)}::jsonb
    FOR SHARE OF se,p,claim`));
  if(!verified.length)throw new Error("CONTACT_BUSINESS_MATERIALIZATION_EVIDENCE_CHANGED");
  await authority(tx);
  const link=rows(await tx.execute(sql`INSERT INTO canonical_source_links
    (business_id,source_system,source_type,stable_key,raw_evidence)
    VALUES(${resolution.business.id},'sunbiz','sunbiz_entity',${source.filing_number},
      ${JSON.stringify({sourceEntityId:source.id,prospectId:source.retained_prospect_id,
        retainedClaimId:source.retained_claim_id,representation:"retained_legacy_completion_v1"})}::jsonb)
    ON CONFLICT(source_system,source_type,stable_key) DO UPDATE SET last_confirmed_at=clock_timestamp()
    RETURNING id,business_id`))[0];
  if(Number(link.business_id)!==resolution.business.id)throw new Error("RETAINED_REGISTRY_SOURCE_CONFLICT");
  // Provenance is derived from the ORIGINAL source relationship, not contact fields.
  const event=rows(await tx.execute(sql`INSERT INTO contact_source_events
    (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
    VALUES(${contact.id},${`retained-sunbiz:${source.id}:prospect:${source.retained_prospect_id}`},
      'sunbiz','retained_prospect_completion',${source.filing_number},'system','system:contact-link-automation',
      ${JSON.stringify({filingNumber:source.filing_number,sourceEntityId:source.id,
        prospectId:source.retained_prospect_id,retainedClaimId:source.retained_claim_id,
        representation:"retained_legacy_completion_v1"})}::jsonb)
    ON CONFLICT(contact_id,event_key) DO NOTHING RETURNING id`))[0] ??
    rows(await tx.execute(sql`SELECT id FROM contact_source_events WHERE contact_id=${contact.id}
      AND event_key=${`retained-sunbiz:${source.id}:prospect:${source.retained_prospect_id}`}`))[0];
  await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
    VALUES('retained_sunbiz_business_completed','contact',${String(contact.id)},
      ${JSON.stringify({businessId:resolution.business.id,sourceLinkId:link.id,sourceEventId:event.id,
        sourceEntityId:source.id,prospectId:source.retained_prospect_id,retainedClaimId:source.retained_claim_id,
        outcome:resolution.kind,paidProviderCalls:0,outboundChanges:0})}::jsonb,
      'system','system:contact-link-automation')`);
  return {status:resolution.kind==="created" ? "materialized" : "matched",businessId:resolution.business.id,
    sourceLinkId:String(link.id),sourceEventId:Number(event.id)};
}
