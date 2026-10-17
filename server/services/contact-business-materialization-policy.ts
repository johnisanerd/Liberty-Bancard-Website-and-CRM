/** The read preflight and transactional materializer share the exact same
 * retained-source admission predicate. This is not relationship authority. */
export const MATERIALIZATION_SOURCE_CATEGORIES = [
  "ghl_sync","crm","crm_manual","manual_crm","csv_import","manual_import","apollo",
] as const;
export const MATERIALIZATION_SOURCE_TYPES = [
  "google_maps_outscraper","apollo_lead_list",
] as const;

/** Provider import events written before `businessEvidence` was recorded. Their
 * original provider row is retained at an exact execution/row coordinate and can
 * still be read as independent source evidence (never the contact's own fields). */
export const LEGACY_ORIGINAL_ROW_SOURCE_TYPES = ["outscraper","apollo"] as const;
export function isLegacyOriginalRowEvent(event:any):boolean {
  return event?.source_category==="csv_import" &&
    LEGACY_ORIGINAL_ROW_SOURCE_TYPES.some(type=>type===event.source_type) &&
    event.import_execution_id!=null && event.source_row_number!=null && event.row_fingerprint!=null &&
    !(event.metadata?.businessEvidence!==null && typeof event.metadata?.businessEvidence==="object");
}

export function hasMaterializableSourceEvidence(events:unknown):boolean {
  if(!Array.isArray(events))throw new Error("CONTACT_MATERIALIZATION_SOURCE_SNAPSHOT_UNAVAILABLE");
  if(events.some(isLegacyOriginalRowEvent))return true;
  return events.some(event=>{
    const proof=event?.metadata?.businessEvidence;
    return proof!==null && typeof proof==="object" && !Array.isArray(proof) &&
      (MATERIALIZATION_SOURCE_CATEGORIES.some(category=>category===event.source_category) ||
       MATERIALIZATION_SOURCE_TYPES.some(type=>type===event.source_type));
  });
}

/** Bump when materializer decisions are repaired. Outcome rows recorded by an
 * older rule never defer re-evaluation, so a policy repair reaches previously
 * held contacts through the ordinary worker without a manual reset. */
export const MATERIALIZATION_RULE_VERSION="source_family_identity_v4";

/** The provider place identifier retained on the ORIGINAL source event. This is
 * the same value the ordinary provider import passes to the organization resolver. */
export function retainedProviderPlaceId(metadata:unknown):string|null {
  const m=metadata as Record<string,unknown>|null;
  if(!m || typeof m!=="object" || Array.isArray(m))return null;
  for(const key of ["place_id","placeId","google_place_id"]) {
    const value=m[key];
    if(typeof value==="string" && value.trim())return value.trim();
  }
  return null;
}
