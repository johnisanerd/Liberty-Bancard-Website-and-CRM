import { sql } from "drizzle-orm";
import { db } from "../db";
import { businesses, type InsertBusiness } from "@shared/schema";
import { hashCro03Evidence } from "./cro03/source-staging";
import { normalizeStateIdentity, stateIdentitySql } from "../../shared/state-identity";
import { decideOrganizationIdentity, normalOrganizationName, normalOrganizationValue,
  type OrganizationIdentity } from "./organization-resolution-policy";
type ResolutionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Business = typeof businesses.$inferSelect;
export type OrganizationResolution =
  | {kind: "created"; business: Business}
  | {kind: "matched"; business: Business}
  | {kind: "deferred"; reasonCode: "INSUFFICIENT_ORGANIZATION_EVIDENCE" | "AMBIGUOUS_ORGANIZATION_MATCH";
      candidateIds: number[]; snapshotHash?: string; candidateRevisions?: Array<{id:number;revision:string}>};
export type OrganizationPeekResult =
  | {kind: "would_create"} | {kind: "matched"; business: Business}
  | Extract<OrganizationResolution, {kind:"deferred"}>;
type Input = OrganizationIdentity & {
  create?: Omit<InsertBusiness, "canonicalName" | "normalizedName" | "websiteDomain" | "googlePlaceId" | "mainPhone">;
  authorityCheck?: (tx: any) => Promise<boolean>;
  transaction?: ResolutionTransaction;
};
function identity(input: Input) {
  return {...input, websiteDomain: normalOrganizationValue(input.websiteDomain),
    googlePlaceId: input.googlePlaceId?.trim() || null, mainPhone: input.mainPhone?.replace(/\D/g,"") || null,
    city: normalOrganizationValue(input.city), state: normalizeStateIdentity(input.state),
    streetAddress: input.streetAddress ?? input.create?.streetAddress ?? null};
}
async function readCandidates(executor: any, input: ReturnType<typeof identity>, lock: boolean) {
  const phoneKeys=[input.mainPhone,...(input.mainPhone?.length===10 ? [`1${input.mainPhone}`]
    : input.mainPhone?.length===11 && input.mainPhone.startsWith("1") ? [input.mainPhone.slice(1)] : [])];
  const sourceMatch = sql`EXISTS(SELECT 1 FROM canonical_source_links source_link
    WHERE source_link.business_id=businesses.id
      AND source_link.source_system=${input.sourceIdentity?.sourceSystem ?? null}::text
      AND source_link.source_type=${input.sourceIdentity?.sourceType ?? null}::text
      AND source_link.stable_key=${input.sourceIdentity?.stableKey ?? null}::text)`;
  const query = executor.select({business: businesses, exactSource: sourceMatch}).from(businesses).where(sql`
    ${sourceMatch}
    OR (${input.googlePlaceId}::text IS NOT NULL AND google_place_id=${input.googlePlaceId}::text)
    OR (${input.websiteDomain}::text IS NOT NULL AND lower(btrim(website_domain))=${input.websiteDomain}::text)
    OR (${input.mainPhone}::text IS NOT NULL
      AND regexp_replace(coalesce(main_phone,''),'[^0-9]','','g')
        IN (${sql.join(phoneKeys.map(value=>sql`${value}`),sql`,`)}))
    OR (${input.city}::text IS NOT NULL AND ${input.state}::text IS NOT NULL
      AND normalized_name=${normalOrganizationName(input.canonicalName)}
      AND lower(btrim(coalesce(city,'')))=${input.city}::text
      AND ${sql.raw(stateIdentitySql("state"))}=${input.state}::text)
  `).orderBy(businesses.id);
  return (lock ? query.for("update") : query) as Promise<Array<{business:Business;exactSource:boolean}>>;
}
function decision(input: ReturnType<typeof identity>, candidates: Awaited<ReturnType<typeof readCandidates>>) {
  return decideOrganizationIdentity(input, candidates.map(({business,exactSource})=>({...business,exactSource})));
}
function deferred(result: Extract<ReturnType<typeof decision>, {kind:"deferred"}>,
  candidates: Awaited<ReturnType<typeof readCandidates>>): OrganizationResolution {
  return {...result, snapshotHash:hashCro03Evidence(candidates),
    candidateRevisions:candidates.map(({business})=>({id:business.id,revision:hashCro03Evidence(business)}))};
}
/** Stable multi-identifier locking + re-read is the sole write authority. */
export async function resolveOrganization(raw: Input): Promise<OrganizationResolution> {
  const input = identity(raw);
  const lockKeys = [
    input.sourceIdentity ? `source:${input.sourceIdentity.sourceSystem}:${input.sourceIdentity.sourceType}:${input.sourceIdentity.stableKey}` : null,
    input.googlePlaceId ? `place:${input.googlePlaceId}` : null,
    input.websiteDomain ? `domain:${input.websiteDomain}` : null,
    input.mainPhone ? `phone:${input.mainPhone}` : null,
    input.city && input.state ? `name:${normalOrganizationName(input.canonicalName)}:${input.city}:${input.state}` : null,
  ].filter((key): key is string => !!key).sort();
  const resolve = async (tx:ResolutionTransaction):Promise<OrganizationResolution> => {
    const check = async () => {
      if (input.authorityCheck && !await input.authorityCheck(tx))
        throw new Error("ORGANIZATION_RESOLUTION_AUTHORITY_FENCE_LOST");
    };
    await check();
    for (const key of lockKeys) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text,1642))`);
    const candidates = await readCandidates(tx,input,true);
    const result = decision(input,candidates);
    if (result.kind==="deferred") return deferred(result,candidates);
    if (result.kind==="matched") return {kind:"matched",business:candidates.find(c=>c.business.id===result.id)!.business};
    await check();
    const [business] = await tx.insert(businesses).values({
      ...(input.create ?? {}),canonicalName:input.canonicalName,normalizedName:normalOrganizationName(input.canonicalName),
      websiteDomain:input.websiteDomain,googlePlaceId:input.googlePlaceId,mainPhone:input.mainPhone,
      city:raw.city ?? null,state:raw.state ?? null,streetAddress:input.streetAddress,
    }).returning();
    return {kind:"created",business};
  };
  return input.transaction ? resolve(input.transaction) : db.transaction(resolve);
}
/** Same retrieval and decision policy as writes; races remain transactionally revalidated. */
export async function peekOrganizationResolution(raw: OrganizationIdentity): Promise<OrganizationPeekResult> {
  const input=identity(raw);
  const candidates=await readCandidates(db,input,false);
  const result=decision(input,candidates);
  if(result.kind==="deferred")return deferred(result,candidates) as Extract<OrganizationPeekResult,{kind:"deferred"}>;
  return result.kind==="create" ? {kind:"would_create"} :
    {kind:"matched",business:candidates.find(c=>c.business.id===result.id)!.business};
}

/**
 * Mirror an ALREADY ESTABLISHED provider place identity onto the business row.
 * canonical_source_links is unique per (system,type,stable_key), so a place
 * link proves which single business owns that Google place. Businesses that
 * were matched (not created) by an earlier import carry the link but a NULL
 * google_place_id, which the relationship evaluator reads as "no stable
 * identifier". Writes only when the business owns the exact place link, the
 * column is blank, and no other business holds the identifier. Never overwrites.
 */
export async function mirrorEstablishedPlaceIdentity(tx: ResolutionTransaction, businessId: number, place: string | null | undefined):
  Promise<"mirrored" | "not_applicable"> {
  const key = place?.trim();
  if (!key) return "not_applicable";
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`place:${key}`}::text,1642))`);
  const result: any = await tx.execute(sql`UPDATE businesses b
    SET google_place_id=${key}::text, updated_at=clock_timestamp()
    WHERE b.id=${businessId} AND b.record_class='canonical' AND nullif(btrim(b.google_place_id),'') IS NULL
      AND EXISTS(SELECT 1 FROM canonical_source_links l WHERE l.business_id=b.id
        AND l.source_system IN ('outscraper','google_maps','google') AND l.source_type='place'
        AND l.stable_key=${key}::text)
      AND NOT EXISTS(SELECT 1 FROM businesses o WHERE o.id<>b.id AND o.google_place_id=${key}::text)
    RETURNING b.id`);
  return (result?.rows ?? result ?? []).length ? "mirrored" : "not_applicable";
}

/** Set-based, bounded form of mirrorEstablishedPlaceIdentity for businesses with exactly one place link. */
export async function mirrorEstablishedPlaceIdentities(tx: ResolutionTransaction, limit = 200): Promise<number> {
  const result: any = await tx.execute(sql`WITH one AS (
      SELECT business_id, min(stable_key) k FROM canonical_source_links
      WHERE source_system IN ('outscraper','google_maps','google') AND source_type='place' AND stable_key<>''
      GROUP BY business_id HAVING count(DISTINCT stable_key)=1),
    pick AS (
      SELECT b.id, one.k FROM businesses b JOIN one ON one.business_id=b.id
      WHERE b.record_class='canonical' AND nullif(btrim(b.google_place_id),'') IS NULL
        AND NOT EXISTS(SELECT 1 FROM businesses o WHERE o.id<>b.id AND o.google_place_id=one.k)
      ORDER BY b.id LIMIT ${limit} FOR UPDATE OF b SKIP LOCKED)
    UPDATE businesses b SET google_place_id=pick.k, updated_at=clock_timestamp()
    FROM pick WHERE b.id=pick.id AND nullif(btrim(b.google_place_id),'') IS NULL RETURNING b.id`);
  return (result?.rows ?? result ?? []).length;
}
