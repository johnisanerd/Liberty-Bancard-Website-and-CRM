import {sql} from "drizzle-orm";
import {mapProviderCsvRow} from "./provider-import-columns";
import {normalizeDomain,normalizePhoneE164} from "./sdr/dedupe";
import {hashCro03Evidence} from "./cro03/source-staging";
import {isLegacyOriginalRowEvent} from "./contact-business-materialization-policy";

const rows=(result:any):any[]=>result?.rows ?? result ?? [];
const PLACE_KEYS=["place_id","google_place_id","placeid"];

export const LEGACY_ORIGINAL_ROW_ADAPTER="original_import_row_v1";

export type LegacyBusinessEvidence =
  | {status:"found";event:{id:number;source_category:string;source_type:string;source_external_id:string|null;
      proof:{canonicalName:string;websiteDomain:string|null;mainPhone:string|null;streetAddress:string|null;
        city:string|null;state:string|null};event_metadata:Record<string,unknown>;adapter:string}}
  | {status:"unavailable";reasonCode:string}
  | {status:"none"};

/**
 * Adapter for provider-import events written before `businessEvidence` was
 * recorded. The evidence is the ORIGINAL retained provider row at its exact
 * execution/row coordinate (hash- and fingerprint-verified), mapped with the same
 * column map as the ordinary import. It is never built from the contact's own
 * fields, so it cannot manufacture independent corroboration. Source attribution
 * stays with the provider (outscraper/apollo); it is not registry-verified.
 */
export async function loadLegacyOriginalRowEvidence(tx:any,contactId:number):Promise<LegacyBusinessEvidence> {
  const events=rows(await tx.execute(sql`SELECT * FROM contact_source_events
    WHERE contact_id=${contactId} AND source_category='csv_import' AND source_type IN ('outscraper','apollo')
    ORDER BY id DESC`)).filter(event=>isLegacyOriginalRowEvent({...event,metadata:event.metadata}));
  if(!events.length)return {status:"none"};
  let unavailable="LEGACY_ORIGINAL_ROW_NOT_RETAINED";
  for(const event of events) {
    const exec=String(event.import_execution_id),row=Number(event.source_row_number);
    const raw=rows(await tx.execute(sql`SELECT raw.payload,raw.provenance,raw.payload_hash
      FROM cro03_enrichment_batches batch
      JOIN cro03_batch_memberships member ON member.batch_id=batch.id
      JOIN cro03_source_observations raw ON raw.id=member.source_observation_id
      WHERE batch.idempotency_key IN (${`csv-source-raw-v2:${exec}:${row}`},${`csv-source-raw-v3:${exec}:${row}`})
        AND jsonb_typeof(raw.payload->'rawSourceRow')='object'
      ORDER BY batch.idempotency_key DESC LIMIT 1`))[0];
    if(!raw)continue;
    const payload=raw.payload;
    if(raw.provenance?.importExecutionId!==exec || Number(raw.provenance?.sourceRowNumber)!==row ||
       Number(payload?.sourceRowNumber)!==row || hashCro03Evidence(payload)!==raw.payload_hash ||
       payload?.rowFingerprint!==event.row_fingerprint) {
      unavailable="LEGACY_ORIGINAL_ROW_EVIDENCE_MISMATCH";continue;
    }
    const sourceFormat=String(payload?.sourceFormat ?? "");
    if(!["google_maps_outscraper","apollo_lead_list"].includes(sourceFormat)) {
      unavailable="LEGACY_ORIGINAL_ROW_FORMAT_UNSUPPORTED";continue;
    }
    const mapped=mapProviderCsvRow(payload.rawSourceRow,sourceFormat);
    const name=mapped.companyName?.trim();
    if(!name){unavailable="LEGACY_ORIGINAL_ROW_NAME_MISSING";continue;}
    const place=Object.entries(payload.rawSourceRow as Record<string,unknown>)
      .filter(([key,value])=>typeof value==="string" && value.trim() &&
        PLACE_KEYS.includes(key.toLowerCase().trim().replace(/\s+/g,"_")))
      .map(([,value])=>(value as string).trim())[0] ?? null;
    return {status:"found",event:{
      id:Number(event.id),source_category:event.source_category,
      // The sourceFormat decides the provider family, exactly as the ordinary import.
      source_type:sourceFormat,source_external_id:event.source_external_id ?? null,
      proof:{canonicalName:name,websiteDomain:normalizeDomain(mapped.website) ?? null,
        mainPhone:normalizePhoneE164(mapped.phone) ?? null,streetAddress:mapped.address ?? null,
        city:mapped.city ?? null,state:mapped.state ?? null},
      event_metadata:place?{place_id:place}:{},adapter:LEGACY_ORIGINAL_ROW_ADAPTER}};
  }
  return {status:"unavailable",reasonCode:unavailable};
}
