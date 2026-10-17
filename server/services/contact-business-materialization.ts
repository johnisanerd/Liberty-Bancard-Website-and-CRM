import {createHash} from "node:crypto";
import {sql} from "drizzle-orm";
import {db} from "../db";
import {resolveOrganization,mirrorEstablishedPlaceIdentity} from "./organization-resolver";
import {runCanonicalTransaction} from "./canonical-transaction-retry";
import {assertSystemLinkDatabaseGuard} from "./commercial-link-authority";
import {normalizeStateIdentity} from "../../shared/state-identity";
import {normalizeDomain,normalizePhoneE164} from "./sdr/dedupe";
import {normalOrganizationName,normalOrganizationValue} from "./organization-resolution-policy";
import {MATERIALIZATION_SOURCE_CATEGORIES,MATERIALIZATION_SOURCE_TYPES,retainedProviderPlaceId} from "./contact-business-materialization-policy";
import {materializeRetainedSunbizContact} from "./retained-sunbiz-contact-materialization";
import {loadLegacyOriginalRowEvidence} from "./legacy-source-business-evidence";

const rows=(result:any):any[]=>result?.rows ?? result ?? [];
const address=(value:unknown)=>String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g,"");
type BusinessEvidence={canonicalName:string;websiteDomain?:string|null;mainPhone?:string|null;
  streetAddress?:string|null;city?:string|null;state?:string|null};
export type ContactBusinessMaterializationOutcome =
  | {status:"materialized"|"matched";businessId:number;sourceLinkId:string;sourceEventId:number}
  | {status:"held"|"preserved";reasonCode:string;businessId?:number};

/** Extend the existing local linker with resolver/source-link materialization.
 * No contacts are created here, no candidate grants link authority, and the
 * ordinary audited relationship writer still performs the actual affiliation.
 */
export async function materializeSupportedContactBusiness(contactId:number,
  authorityCheck:(tx:any)=>Promise<void|boolean>):Promise<ContactBusinessMaterializationOutcome> {
  const assertAuthority=async(tx:any)=>{
    if(await authorityCheck(tx)===false)throw new Error("CONTACT_BUSINESS_MATERIALIZATION_AUTHORITY_FENCE_LOST");
  };
  return runCanonicalTransaction("link_commit",()=>db.transaction(async tx=>{
    await assertAuthority(tx);
    await assertSystemLinkDatabaseGuard(tx);
    // Read first, resolve with stable multi-key locks, then pin/recheck contact.
    // Taking a contact row lock before a business resolver lock inverts intake.
    const contact=rows(await tx.execute(sql`SELECT * FROM contacts WHERE id=${contactId}`))[0];
    if(!contact || contact.archived_at || !contact.record_class ||
      ["test","demo","synthetic"].includes(contact.record_class))
      return {status:"held",reasonCode:"NON_PRODUCTION_CONTACT"};
    if(contact.business_id!=null)
      return {status:"preserved",reasonCode:"EXISTING_BUSINESS_ASSIGNMENT",businessId:Number(contact.business_id)};
    const events=rows(await tx.execute(sql`SELECT * FROM (
      SELECT DISTINCT ON (source_category,source_type,coalesce(source_external_id,''))
        id,source_category,source_type,source_external_id,
        metadata->'businessEvidence' proof,metadata event_metadata FROM contact_source_events
      WHERE contact_id=${contactId} AND jsonb_typeof(metadata->'businessEvidence')='object'
        AND (source_category IN (${sql.join(MATERIALIZATION_SOURCE_CATEGORIES.map(value=>sql`${value}`),sql`, `)})
          OR source_type IN (${sql.join(MATERIALIZATION_SOURCE_TYPES.map(value=>sql`${value}`),sql`, `)}))
      ORDER BY source_category,source_type,coalesce(source_external_id,''),id DESC
      ) latest ORDER BY id DESC`));
    let adapter:string|null=null;
    if(!events.length) {
      // Legacy provider imports that predate businessEvidence: read the ORIGINAL
      // retained provider row (never the contact's own fields) before the registry path.
      const legacy=await loadLegacyOriginalRowEvidence(tx,contactId);
      if(legacy.status==="unavailable")return {status:"held",reasonCode:legacy.reasonCode};
      if(legacy.status==="none")return materializeRetainedSunbizContact(tx,contact,assertAuthority);
      adapter=legacy.event.adapter;
      events.push({id:legacy.event.id,source_category:legacy.event.source_category,
        source_type:legacy.event.source_type,source_external_id:legacy.event.source_external_id,
        proof:legacy.event.proof,event_metadata:legacy.event.event_metadata});
    }
    const event=events[0],proof=event.proof as BusinessEvidence;
    const place=retainedProviderPlaceId(event.event_metadata);
    const domain=normalizeDomain(proof.websiteDomain),phone=normalizePhoneE164(proof.mainPhone);
    const name=normalOrganizationName(proof.canonicalName ?? "");
    const location=!!(address(proof.streetAddress) && proof.city?.trim() && normalizeStateIdentity(proof.state));
    const contactDomain=normalizeDomain(contact.website),contactPhone=normalizePhoneE164(contact.phone);
    const agrees=name!=="" && name===normalOrganizationName(contact.company_name ?? "") &&
      (!proof.city || !contact.city || normalOrganizationValue(proof.city)===normalOrganizationValue(contact.city)) &&
      (!proof.state || !contact.state || normalizeStateIdentity(proof.state)===normalizeStateIdentity(contact.state)) &&
      (!proof.streetAddress || !contact.address || address(proof.streetAddress)===address(contact.address));
    const domainMatch=!!domain && domain===contactDomain &&
      !/(^|\.)(gmail|yahoo|outlook|hotmail|facebook|instagram|linkedin|google|yelp|tiktok)\.com$/.test(domain);
    const phoneMatch=!!phone && phone===contactPhone;
    const locationMatch=location && address(contact.address)===address(proof.streetAddress) &&
      normalOrganizationValue(contact.city)===normalOrganizationValue(proof.city) &&
      normalizeStateIdentity(contact.state)===normalizeStateIdentity(proof.state);
    if(!agrees || !(locationMatch && (domainMatch || phoneMatch) || domainMatch && phoneMatch))
      return {status:"held",reasonCode:"INDEPENDENT_ORGANIZATION_CORROBORATION_REQUIRED"};
    // Conflicting latest observations for the same retained source relationship
    // cannot be hidden by choosing an older, more convenient source snapshot.
    if(events.some(other=>other.source_category!==event.source_category &&
      other.id!==event.id &&
      other.proof?.canonicalName && normalOrganizationName(other.proof.canonicalName)!==name))
      return {status:"held",reasonCode:"RETAINED_ORGANIZATION_IDENTITY_CONFLICT"};
    const sourceSystem=event.source_category==="ghl_sync" ? "ghl" :
      event.source_type==="apollo_lead_list" || event.source_category==="apollo" ? "apollo" :
      event.source_type==="google_maps_outscraper" ? "outscraper" : "crm";
    const stableKey=`organization-location-v1:${createHash("sha256").update(JSON.stringify([
      name,domain,phone,address(proof.streetAddress),normalOrganizationValue(proof.city),
      normalizeStateIdentity(proof.state),
    ])).digest("hex")}`;
    const sourceIdentity={sourceSystem,sourceType:"organization_location",stableKey};
    const resolution=await resolveOrganization({canonicalName:proof.canonicalName,websiteDomain:domain,
      googlePlaceId:place,mainPhone:phone,streetAddress:proof.streetAddress,city:proof.city,state:proof.state,sourceIdentity,
      create:{recordClass:"canonical",lastSourceType:sourceSystem},transaction:tx,
      authorityCheck:async()=>{await assertAuthority(tx);return true;}});
    if(resolution.kind==="deferred")return {status:"held",reasonCode:resolution.reasonCode};
    const pinned=rows(await tx.execute(sql`SELECT * FROM contacts WHERE id=${contactId} FOR UPDATE`))[0];
    if(!pinned || pinned.business_id!=null ||
      JSON.stringify(pinned)!==JSON.stringify(contact))throw new Error("CONTACT_BUSINESS_MATERIALIZATION_EVIDENCE_CHANGED");
    await assertAuthority(tx);
    const placeMirror=await mirrorEstablishedPlaceIdentity(tx,resolution.business.id,place);
    const link=rows(await tx.execute(sql`INSERT INTO canonical_source_links
      (business_id,source_system,source_type,stable_key,raw_evidence)
      VALUES(${resolution.business.id},${sourceSystem},'organization_location',${stableKey},
        ${JSON.stringify({businessEvidence:proof,sourceEventId:event.id,representation:"source_family_identity_v1",
          ...(adapter?{adapter}:{})})}::jsonb)
      ON CONFLICT(source_system,source_type,stable_key) DO UPDATE SET last_confirmed_at=clock_timestamp()
      RETURNING id,business_id`))[0];
    if(Number(link.business_id)!==resolution.business.id)
      throw new Error("CONTACT_BUSINESS_MATERIALIZATION_SOURCE_CONFLICT");
    if(adapter) {
      // The relationship authority independently re-proves the corroboration from a
      // contact source event carrying the same businessEvidence. Append (never edit)
      // that event from the verified ORIGINAL row. Execution/row coordinates stay in
      // metadata only, so this is not a second row receipt or fulfillment record.
      await tx.execute(sql`INSERT INTO contact_source_events
        (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
        VALUES(${contactId},${`legacy-original-row-v1:${event.id}:${contactId}`},${event.source_category},
          ${event.source_type},${`legacy-original-row:${event.id}`},'system','system:contact-link-automation',
          ${JSON.stringify({...event.event_metadata,businessEvidence:proof,adapter,
            representation:"legacy_original_row_businessEvidence_v1",derivedFromSourceEventId:event.id})}::jsonb)
        ON CONFLICT(contact_id,event_key) DO NOTHING`);
    }
    await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES('contact_business_source_materialized','contact',${String(contactId)},
        ${JSON.stringify({businessId:resolution.business.id,sourceLinkId:link.id,sourceEventId:event.id,
           outcome:resolution.kind,rule:"source_family_identity_v1",adapter,placeIdentity:placeMirror,paidProviderCalls:0,outboundChanges:0})}::jsonb,
        'system','system:contact-link-automation')`);
    return {status:resolution.kind==="created" ? "materialized" : "matched",
      businessId:resolution.business.id,sourceLinkId:String(link.id),sourceEventId:Number(event.id)};
  }));
}
