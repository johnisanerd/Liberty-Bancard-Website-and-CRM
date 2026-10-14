/** The read preflight and transactional materializer share the exact same
 * retained-source admission predicate. This is not relationship authority. */
export const MATERIALIZATION_SOURCE_CATEGORIES = [
  "ghl_sync","crm","crm_manual","manual_crm","csv_import","manual_import","apollo",
] as const;
export const MATERIALIZATION_SOURCE_TYPES = [
  "google_maps_outscraper","apollo_lead_list",
] as const;

export function hasMaterializableSourceEvidence(events:unknown):boolean {
  if(!Array.isArray(events))throw new Error("CONTACT_MATERIALIZATION_SOURCE_SNAPSHOT_UNAVAILABLE");
  return events.some(event=>{
    const proof=event?.metadata?.businessEvidence;
    return proof!==null && typeof proof==="object" && !Array.isArray(proof) &&
      (MATERIALIZATION_SOURCE_CATEGORIES.some(category=>category===event.source_category) ||
       MATERIALIZATION_SOURCE_TYPES.some(type=>type===event.source_type));
  });
}
