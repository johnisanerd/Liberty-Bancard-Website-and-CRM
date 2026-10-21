/**
 * Business-only completion of legacy Sunbiz promotions.
 *
 * Background: the bootstrap engine defers any filing whose Sunbiz entity already has a prospect row
 * (`legacy_sunbiz_promotion_exists`). When that prospect has no contact and no business, nothing was ever
 * completed: the registry organization simply does not exist as a canonical business. This worker creates
 * (or matches) that business through the same resolver and source-link representation the retained-contact
 * path uses, and leaves the original terminal claim, prospect, ledger and accounting rows untouched.
 *
 * Local only: no provider call, no contact creation, no enrollment, no send. Entities are limited to the
 * South Florida territory. Ordering is a monotonic id cursor in system_settings, so an entity the resolver
 * holds (ambiguous organization, identity conflict) is revisited only when the cursor wraps.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { acquireJobLock, releaseJobLock, renewJobLock } from "./job-registry";
import { resolveOrganization } from "./organization-resolver";
import { runCanonicalTransaction } from "./canonical-transaction-retry";
import { normalizeDomain } from "./sdr/dedupe";
import {
  compatibleCityState, compatibleIdentityName, isSouthFloridaEligible, namesClearlyConflict,
} from "./sunbiz-bootstrap";

const rows = (r: any): any[] => r?.rows ?? r ?? [];
export const RETAINED_SUNBIZ_COMPLETION_CURSOR_KEY = "retained_sunbiz_business_completion_cursor";
const SCAN_PAGE = 400;
const DEFAULT_LIMIT = 25;

export const RETAINED_SUNBIZ_COMPLETION_JOB = "retained_sunbiz_business_completion";
const DISPOSITION_ACTION = "retained_sunbiz_business_completion_disposition";
const COMPLETED_ACTION = "retained_sunbiz_business_completed";

export type RetainedSunbizCompletionOutcome =
  | { status: "created" | "matched"; entityId: number; businessId: number; projected?: string[] }
  | { status: "held" | "skipped"; entityId: number; reasonCode: string };

export interface RetainedSunbizCompletionResult {
  scanned: number; eligible: number; created: number; matched: number; held: number; skipped: number; failed: number;
  wrapped: boolean; lastEntityId: number; lockStatus: string;
}

async function readCursor(): Promise<number> {
  const row = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key=${RETAINED_SUNBIZ_COMPLETION_CURSOR_KEY}`))[0];
  const value = row?.value;
  const parsed = typeof value === "number" ? value : Number((value as any)?.lastEntityId ?? value ?? 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function writeCursor(lastEntityId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO system_settings (key,value,updated_at)
    VALUES (${RETAINED_SUNBIZ_COMPLETION_CURSOR_KEY},${JSON.stringify({ lastEntityId })}::jsonb,NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`);
}

/** Candidate page: contactless legacy prospects whose original claim is still the terminal legacy deferral. */
async function scanCandidates(afterId: number): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT se.id,se.filing_number,se.entity_name,se.website,se.phone,se.principal_address,se.principal_city,
           se.principal_state,se.principal_zip,se.source,se.score,to_jsonb(se) AS source_snapshot
      FROM sunbiz_entities se
      JOIN prospects p ON p.id=se.prospect_id AND p.contact_id IS NULL
      JOIN sunbiz_bootstrap_claims claim ON claim.sunbiz_entity_id=se.id AND claim.filing_number=se.filing_number
     WHERE se.id>${afterId}
       AND claim.status='deferred_collision' AND claim.deferred_reason_code='legacy_sunbiz_promotion_exists'
       AND claim.business_id IS NULL
       AND se.source IN ('sunbiz','cordata','corevt') AND se.score IN ('hot','warm')
       AND NULLIF(btrim(se.entity_name),'') IS NOT NULL
       AND upper(btrim(COALESCE(se.principal_state,''))) IN ('FL','FLORIDA')
       AND NOT EXISTS (SELECT 1 FROM canonical_source_links l WHERE l.source_system='sunbiz'
         AND l.source_type='sunbiz_entity' AND l.stable_key=se.filing_number)
     ORDER BY se.id LIMIT ${SCAN_PAGE}`));
}

class RetainedEvidenceChanged extends Error {
  constructor() { super("RETAINED_EVIDENCE_CHANGED"); }
}

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const zip5 = (value: unknown) => { const m = /^\s*(\d{5})(?:-?\d{4})?\s*$/.exec(String(value ?? "")); return m ? m[1] : null; };
const snapshotHash = (snapshot: unknown) => createHash("sha256").update(JSON.stringify(snapshot ?? null)).digest("hex");

/**
 * Fill only absent, non-conflicting website/phone/ZIP facts on a matched canonical business and make a
 * newly usable domain eligible for the ordinary free crawl. Registry address fields are never copied onto
 * a matched business whose own location differs, and no existing value is overwritten.
 */
async function projectMissingFacts(tx: any, businessId: number, source: any): Promise<string[]> {
  const business = rows(await tx.execute(sql`
    SELECT website_domain,main_phone,postal_code,city,state,record_class FROM businesses WHERE id=${businessId} FOR UPDATE`))[0];
  if (!business || business.record_class !== "canonical") return [];
  const projected: string[] = [];
  const domain = normalizeDomain(source.website);
  const usableDomain = domain && domain.includes(".") && !/\s/.test(domain) ? domain : null;
  const currentDomain = String(business.website_domain ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const phone = digits(source.phone);
  const usablePhone = phone.length >= 10 ? String(source.phone).trim() : null;
  const currentPhone = digits(business.main_phone);
  const postal = zip5(source.principal_zip);
  const sameCity = !!business.city && String(business.city).trim().toLowerCase() === String(source.principal_city ?? "").trim().toLowerCase();
  let setDomain = false, setPhone = false, setPostal = false;
  if (usableDomain && !currentDomain) {
    const owner = rows(await tx.execute(sql`
      SELECT id FROM businesses WHERE id<>${businessId}
        AND regexp_replace(lower(regexp_replace(trim(website_domain),'^www\\.','')),'\\.$','')=${usableDomain} LIMIT 1`))[0];
    setDomain = !owner;
  }
  if (usablePhone && !currentPhone) {
    const owner = rows(await tx.execute(sql`
      SELECT id FROM businesses WHERE id<>${businessId}
        AND regexp_replace(coalesce(main_phone,''),'[^0-9]','','g')=${phone} LIMIT 1`))[0];
    setPhone = !owner;
  }
  if (postal && !String(business.postal_code ?? "").trim() && sameCity) setPostal = true;
  if (!setDomain && !setPhone && !setPostal) return [];
  await tx.execute(sql`
    UPDATE businesses SET
      website_domain=CASE WHEN ${setDomain} THEN ${usableDomain} ELSE website_domain END,
      main_phone=CASE WHEN ${setPhone} THEN ${usablePhone} ELSE main_phone END,
      postal_code=CASE WHEN ${setPostal} THEN ${postal} ELSE postal_code END,
      updated_at=now()
    WHERE id=${businessId} AND record_class='canonical'`);
  if (setDomain) {
    projected.push("website_domain");
    // A crawl state recorded without a domain cannot describe this domain; an in-flight crawl is left alone.
    await tx.execute(sql`
      UPDATE businesses SET free_enrichment_status=NULL,free_enrichment_completed_at=NULL,free_enrichment_last_error_code=NULL
      WHERE id=${businessId} AND record_class='canonical' AND free_enrichment_status IS DISTINCT FROM 'processing'`);
  }
  if (setPhone) projected.push("main_phone");
  if (setPostal) projected.push("postal_code");
  return projected;
}

export async function completeRetainedSunbizEntity(
  source: any,
  authorityCheck: (tx: any) => Promise<boolean | void> = async () => true,
): Promise<RetainedSunbizCompletionOutcome> {
  const entityId = Number(source.id);
  if (!source.source_snapshot) throw new Error("RETAINED_SUNBIZ_SOURCE_SNAPSHOT_REQUIRED");
  const fence = async (tx: any) => {
    if ((await authorityCheck(tx)) === false) throw new Error("RETAINED_SUNBIZ_COMPLETION_AUTHORITY_FENCE_LOST");
  };
  try {
    return await runCanonicalTransaction("link_commit", () => db.transaction(async (tx): Promise<RetainedSunbizCompletionOutcome> => {
    await fence(tx);
    const postalCode = zip5(source.principal_zip);
    const resolution = await resolveOrganization({
      canonicalName: source.entity_name,
      websiteDomain: normalizeDomain(source.website),
      mainPhone: source.phone,
      streetAddress: source.principal_address,
      city: source.principal_city,
      state: source.principal_state,
      sourceIdentity: { sourceSystem: "sunbiz", sourceType: "sunbiz_entity", stableKey: source.filing_number },
      // Organization canonicality is resolver-owned, the same class the retained-contact path creates.
      create: { recordClass: "canonical", lastSourceType: "sunbiz", ...(postalCode ? { postalCode } : {}) },
      transaction: tx,
      authorityCheck: async () => { await fence(tx); return true; },
    });
    if (resolution.kind === "deferred") return { status: "held", entityId, reasonCode: resolution.reasonCode };
    if (resolution.business.recordClass !== "canonical")
      return { status: "held", entityId, reasonCode: "RETAINED_REGISTRY_BUSINESS_NOT_CANONICAL" };
    if (resolution.kind === "matched") {
      const candidate = {
        id: entityId, filingNumber: String(source.filing_number), entityName: String(source.entity_name),
        website: source.website ?? null, phone: source.phone ?? null,
        principalCity: source.principal_city ?? null, principalState: source.principal_state ?? null,
      };
      // Same identity guard as the bootstrap engine: a domain/phone coincidence with an unrelated business
      // never lends it this filing's lineage.
      if (!compatibleIdentityName(candidate.entityName, resolution.business.canonicalName) &&
          (!compatibleCityState(candidate as any, resolution.business) ||
            namesClearlyConflict(candidate.entityName, resolution.business.canonicalName)))
        return { status: "held", entityId, reasonCode: "IDENTITY_REVIEW_REQUIRED" };
    }
    // Re-verify the exact source row the resolver used, under share locks taken after the resolver's locks.
    // Any difference throws, so a business the resolver just created is rolled back with this transaction.
    const verified = rows(await tx.execute(sql`
      SELECT claim.id claim_id,p.id prospect_id FROM sunbiz_entities se
        JOIN prospects p ON p.id=se.prospect_id AND p.contact_id IS NULL
        JOIN sunbiz_bootstrap_claims claim ON claim.sunbiz_entity_id=se.id AND claim.filing_number=se.filing_number
       WHERE se.id=${entityId} AND se.filing_number=${String(source.filing_number)}
         AND to_jsonb(se)=${JSON.stringify(source.source_snapshot)}::jsonb
         AND claim.status='deferred_collision' AND claim.deferred_reason_code='legacy_sunbiz_promotion_exists'
         AND claim.business_id IS NULL
       FOR SHARE OF se,p,claim`))[0];
    if (!verified) throw new RetainedEvidenceChanged();
    await fence(tx);
    const projected = resolution.kind === "matched" ? await projectMissingFacts(tx, resolution.business.id, source) : [];
    const link = rows(await tx.execute(sql`
      INSERT INTO canonical_source_links (business_id,source_system,source_type,stable_key,raw_evidence)
      VALUES (${resolution.business.id},'sunbiz','sunbiz_entity',${String(source.filing_number)},
        ${JSON.stringify({ sourceEntityId: entityId, prospectId: verified.prospect_id, retainedClaimId: verified.claim_id,
          representation: "retained_legacy_business_completion_v1",
          // Principal-address facts are registry facts; they prioritize discovery but are not a confirmed
          // operating location, which still needs first-party evidence.
          addressPurpose: "registered_principal_address", operatingLocationConfirmed: false,
          projectedFields: projected })}::jsonb)
      ON CONFLICT (source_system,source_type,stable_key) DO UPDATE SET last_confirmed_at=clock_timestamp()
      RETURNING id,business_id`))[0];
    if (Number(link.business_id) !== resolution.business.id) throw new Error("RETAINED_REGISTRY_SOURCE_CONFLICT");
    await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES(${COMPLETED_ACTION},'sunbiz_entity',${String(source.filing_number)},
        ${JSON.stringify({ businessId: resolution.business.id, sourceLinkId: link.id, sourceEntityId: entityId,
          prospectId: verified.prospect_id, retainedClaimId: verified.claim_id, outcome: resolution.kind,
          projectedFields: projected, postalCodeRetained: resolution.kind === "created" ? !!postalCode : undefined,
          addressPurpose: "registered_principal_address", operatingLocationConfirmed: false,
          paidProviderCalls: 0, outboundChanges: 0 })}::jsonb,
        'system','system:retained-sunbiz-business-completion')`);
    return { status: resolution.kind === "created" ? "created" : "matched", entityId,
      businessId: resolution.business.id, projected };
    }));
  } catch (error) {
    if (error instanceof RetainedEvidenceChanged || (error as any)?.cause instanceof RetainedEvidenceChanged)
      return { status: "skipped", entityId, reasonCode: "RETAINED_EVIDENCE_CHANGED" };
    throw error;
  }
}

/** Append one disposition per (entity, reason, source snapshot) so holds are explained without rework noise. */
async function recordDisposition(source: any, outcome: { status: string; reasonCode?: string }): Promise<void> {
  const hash = snapshotHash(source.source_snapshot);
  const key = String(source.filing_number);
  await db.execute(sql`
    INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
    SELECT ${DISPOSITION_ACTION},'sunbiz_entity',${key},
      ${JSON.stringify({ sourceEntityId: Number(source.id), status: outcome.status, reasonCode: outcome.reasonCode ?? null,
        sourceSnapshotHash: hash, paidProviderCalls: 0, outboundChanges: 0 })}::jsonb,
      'system','system:retained-sunbiz-business-completion'
    WHERE NOT EXISTS (
      SELECT 1 FROM (SELECT details FROM audit_logs WHERE action=${DISPOSITION_ACTION} AND entity_key=${key}
        ORDER BY id DESC LIMIT 1) latest
      WHERE latest.details->>'reasonCode' IS NOT DISTINCT FROM ${outcome.reasonCode ?? null}::text
        AND latest.details->>'sourceSnapshotHash'=${hash})`);
}

/**
 * One bounded tick. Safe to run repeatedly: completed entities drop out through their source link.
 * Runs as a singleton under the registry job lock; every entity transaction re-checks that this tick
 * still owns the lock and that the worker switch is on, so a stale or disabled worker writes nothing.
 */
export async function processRetainedSunbizBusinessCompletionTick(
  opts: { limit?: number; authorityCheck?: (tx: any) => Promise<boolean | void>; complete?: typeof completeRetainedSunbizEntity } = {},
): Promise<RetainedSunbizCompletionResult> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? DEFAULT_LIMIT));
  const complete = opts.complete ?? completeRetainedSunbizEntity;
  const result: RetainedSunbizCompletionResult = {
    scanned: 0, eligible: 0, created: 0, matched: 0, held: 0, skipped: 0, failed: 0, wrapped: false, lastEntityId: 0,
    lockStatus: "acquired",
  };
  const lock = await acquireJobLock(RETAINED_SUNBIZ_COMPLETION_JOB);
  if (lock.status !== "acquired") { result.lockStatus = lock.status; return result; }
  let success = true, failure: string | undefined;
  try {
    const authorityCheck = opts.authorityCheck ?? (async (tx: any) => {
      if (process.env.RETAINED_SUNBIZ_BUSINESS_COMPLETION_ENABLED === "false") return false;
      const owner = rows(await tx.execute(sql`SELECT 1 FROM background_jobs
        WHERE job_name=${RETAINED_SUNBIZ_COMPLETION_JOB} AND lock_token=${lock.lockToken} AND status='running'`))[0];
      return !!owner;
    });
    const cursor = await readCursor();
    const page = await scanCandidates(cursor);
    result.scanned = page.length;
    if (page.length === 0) {
      // End of the pass: wrap so held entities are reconsidered under any newer evidence or rules.
      await writeCursor(0);
      result.wrapped = cursor > 0;
      return result;
    }
    let lastEntityId = cursor;
    for (const source of page) {
      if (result.eligible >= limit) break;
      if (!(await renewJobLock(RETAINED_SUNBIZ_COMPLETION_JOB, lock.lockToken))) { result.lockStatus = "lost"; break; }
      lastEntityId = Number(source.id);
      if (!isSouthFloridaEligible({
        principalState: source.principal_state, principalCity: source.principal_city,
        principalZip: source.principal_zip ?? null,
      })) continue;
      result.eligible++;
      try {
        const outcome = await complete(source, authorityCheck);
        if (outcome.status === "created") result.created++;
        else if (outcome.status === "matched") result.matched++;
        else {
          if (outcome.status === "held") result.held++; else result.skipped++;
          await recordDisposition(source, outcome);
        }
      } catch (error: any) {
        result.failed++;
        const message = String(error?.message ?? error);
        console.error(`[RetainedSunbizCompletion] entity ${source.id} failed: ${message}`);
        if (message.includes("AUTHORITY_FENCE_LOST")) {
          // Lost authority is not an entity outcome: retry this entity under the next owner.
          lastEntityId = Math.max(cursor, Number(source.id) - 1);
          result.lockStatus = "lost";
          break;
        }
      }
    }
    // Entities scanned but beyond the per-tick limit are not skipped: the cursor stops at the last one handled.
    await writeCursor(lastEntityId);
    result.lastEntityId = lastEntityId;
    return result;
  } catch (error: any) {
    success = false; failure = String(error?.message ?? error).slice(0, 500);
    throw error;
  } finally {
    await releaseJobLock(RETAINED_SUNBIZ_COMPLETION_JOB, success, failure, lock.lockToken);
  }
}
