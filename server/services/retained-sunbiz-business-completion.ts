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
import { sql } from "drizzle-orm";
import { db } from "../db";
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

export type RetainedSunbizCompletionOutcome =
  | { status: "created" | "matched"; entityId: number; businessId: number }
  | { status: "held" | "skipped"; entityId: number; reasonCode: string };

export interface RetainedSunbizCompletionResult {
  scanned: number; eligible: number; created: number; matched: number; held: number; skipped: number; failed: number;
  wrapped: boolean; lastEntityId: number;
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
           se.principal_state,se.principal_zip,se.source,se.score
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

export async function completeRetainedSunbizEntity(
  source: any,
  authorityCheck: (tx: any) => Promise<boolean | void> = async () => true,
): Promise<RetainedSunbizCompletionOutcome> {
  const entityId = Number(source.id);
  const fence = async (tx: any) => {
    if ((await authorityCheck(tx)) === false) throw new Error("RETAINED_SUNBIZ_COMPLETION_AUTHORITY_FENCE_LOST");
  };
  return runCanonicalTransaction("link_commit", () => db.transaction(async (tx): Promise<RetainedSunbizCompletionOutcome> => {
    await fence(tx);
    const resolution = await resolveOrganization({
      canonicalName: source.entity_name,
      websiteDomain: normalizeDomain(source.website),
      mainPhone: source.phone,
      streetAddress: source.principal_address,
      city: source.principal_city,
      state: source.principal_state,
      sourceIdentity: { sourceSystem: "sunbiz", sourceType: "sunbiz_entity", stableKey: source.filing_number },
      // Organization canonicality is resolver-owned, the same class the retained-contact path creates.
      create: { recordClass: "canonical", lastSourceType: "sunbiz" },
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
          (!compatibleCityState(candidate, resolution.business) ||
            namesClearlyConflict(candidate.entityName, resolution.business.canonicalName)))
        return { status: "held", entityId, reasonCode: "IDENTITY_REVIEW_REQUIRED" };
    }
    // Re-verify the original relationship under share locks, after the resolver's locks.
    const verified = rows(await tx.execute(sql`
      SELECT claim.id claim_id,p.id prospect_id FROM sunbiz_entities se
        JOIN prospects p ON p.id=se.prospect_id AND p.contact_id IS NULL
        JOIN sunbiz_bootstrap_claims claim ON claim.sunbiz_entity_id=se.id AND claim.filing_number=se.filing_number
       WHERE se.id=${entityId} AND se.filing_number=${String(source.filing_number)}
         AND claim.status='deferred_collision' AND claim.deferred_reason_code='legacy_sunbiz_promotion_exists'
         AND claim.business_id IS NULL
       FOR SHARE OF se,p,claim`))[0];
    if (!verified) return { status: "skipped", entityId, reasonCode: "RETAINED_EVIDENCE_CHANGED" };
    await fence(tx);
    const link = rows(await tx.execute(sql`
      INSERT INTO canonical_source_links (business_id,source_system,source_type,stable_key,raw_evidence)
      VALUES (${resolution.business.id},'sunbiz','sunbiz_entity',${String(source.filing_number)},
        ${JSON.stringify({ sourceEntityId: entityId, prospectId: verified.prospect_id, retainedClaimId: verified.claim_id,
          representation: "retained_legacy_business_completion_v1" })}::jsonb)
      ON CONFLICT (source_system,source_type,stable_key) DO UPDATE SET last_confirmed_at=clock_timestamp()
      RETURNING id,business_id`))[0];
    if (Number(link.business_id) !== resolution.business.id) throw new Error("RETAINED_REGISTRY_SOURCE_CONFLICT");
    await tx.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES('retained_sunbiz_business_completed','sunbiz_entity',${String(source.filing_number)},
        ${JSON.stringify({ businessId: resolution.business.id, sourceLinkId: link.id, sourceEntityId: entityId,
          prospectId: verified.prospect_id, retainedClaimId: verified.claim_id, outcome: resolution.kind,
          paidProviderCalls: 0, outboundChanges: 0 })}::jsonb,
        'system','system:retained-sunbiz-business-completion')`);
    return { status: resolution.kind === "created" ? "created" : "matched", entityId, businessId: resolution.business.id };
  }));
}

/** One bounded tick. Safe to run repeatedly: completed entities drop out through their source link. */
export async function processRetainedSunbizBusinessCompletionTick(
  opts: { limit?: number; authorityCheck?: (tx: any) => Promise<boolean | void>; complete?: typeof completeRetainedSunbizEntity } = {},
): Promise<RetainedSunbizCompletionResult> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? DEFAULT_LIMIT));
  const complete = opts.complete ?? completeRetainedSunbizEntity;
  const result: RetainedSunbizCompletionResult = {
    scanned: 0, eligible: 0, created: 0, matched: 0, held: 0, skipped: 0, failed: 0, wrapped: false, lastEntityId: 0,
  };
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
    lastEntityId = Number(source.id);
    if (!isSouthFloridaEligible({
      principalState: source.principal_state, principalCity: source.principal_city,
      principalZip: source.principal_zip ?? null,
    })) continue;
    result.eligible++;
    try {
      const outcome = await complete(source, opts.authorityCheck);
      if (outcome.status === "created") result.created++;
      else if (outcome.status === "matched") result.matched++;
      else if (outcome.status === "held") result.held++;
      else result.skipped++;
    } catch (error: any) {
      result.failed++;
      console.error(`[RetainedSunbizCompletion] entity ${source.id} failed: ${String(error?.message ?? error)}`);
    }
  }
  // Entities scanned but beyond the per-tick limit are not skipped: the cursor stops at the last one handled.
  await writeCursor(lastEntityId);
  result.lastEntityId = lastEntityId;
  return result;
}
