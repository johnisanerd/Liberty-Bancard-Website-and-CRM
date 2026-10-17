/**
 * Serper lookup memory.
 *
 * Remembers the last outcome of a paid official-domain lookup so unchanged requests stop
 * being purchased again, while keeping every exclusion finite and reopenable:
 *  - an entry only excludes a business while it is unexpired AND the business's input
 *    fingerprint AND the matcher rule version still equal the ones it was recorded under;
 *  - a changed name/address or a bumped SERPER_MATCHER_RULE_VERSION reopens the business;
 *  - a provider failure is never a negative result: it expires in an hour and is recorded
 *    as its own class;
 *  - a short claim on the same row prevents two workers from buying the same lookup.
 *
 * The selector applies `serperLookupExclusionSql` inside the candidate query, so excluded
 * businesses never occupy the bounded batch.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import type { LookupOutcome } from "../serper-business-identity";
import { SERPER_MATCHER_RULE_VERSION } from "../serper-business-identity";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

export const SERPER_LOOKUP_PURPOSE = "official_domain_discovery";
/** The evidence the lookup is asked to find; a different request is a different memory. */
export const SERPER_LOOKUP_REQUESTED_EVIDENCE = "website_domain";

export type SerperLookupMemoryClass =
  | "no_match"
  | "rejected"
  | "ambiguous"
  | "accepted_no_website"
  | "provider_failure";

/** Expiry per outcome. Every entry is finite; none is a permanent exclusion. */
export const SERPER_LOOKUP_MEMORY_TTL_HOURS: Record<SerperLookupMemoryClass, number> = {
  /** Provider returned no listing: a new listing can appear, so revisit monthly. */
  no_match: 24 * 30,
  /** Listings were returned and none matched: revisit monthly (or sooner if inputs/rules change). */
  rejected: 24 * 30,
  /** Two plausible listings: revisit sooner than a clean miss. */
  ambiguous: 24 * 14,
  /** Identity matched but the listing has no website: sites get added, revisit every three weeks. */
  accepted_no_website: 24 * 21,
  /** Transient failure, not a result: retry soon, never excluded for long. */
  provider_failure: 1,
};

/** A claim outlives one lookup (up to four requests plus settlement) and then lapses. */
export const SERPER_LOOKUP_CLAIM_MINUTES = 10;

/**
 * SQL fingerprint of the business inputs that shape the lookup (name, street, city, state
 * normalized so FL and Florida match, five-digit ZIP). Computed in SQL so the selector and
 * the writer can never disagree.
 */
export function serperLookupInputFingerprintSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("SERPER_LOOKUP_ALIAS_INVALID");
  const state = `lower(btrim(COALESCE(${alias}.state,'')))`;
  return `md5(concat_ws('|',
    lower(btrim(COALESCE(${alias}.canonical_name,''))),
    lower(btrim(COALESCE(${alias}.street_address,''))),
    lower(btrim(COALESCE(${alias}.city,''))),
    CASE WHEN ${state}='florida' THEN 'fl' ELSE ${state} END,
    left(regexp_replace(COALESCE(${alias}.postal_code,''),'\\D','','g'),5)))`;
}

/**
 * Predicate that is TRUE when the business must not be looked up now: an unexpired outcome
 * recorded under the current inputs and rule version, or a live claim by another worker.
 * Use as `AND NOT (${...})` / inside NOT EXISTS; it is a complete EXISTS expression.
 */
export function serperLookupExclusionSql(alias: string) {
  const fingerprint = serperLookupInputFingerprintSql(alias);
  return sql.raw(`EXISTS (SELECT 1 FROM sfp_serper_lookup_memory m
    WHERE m.business_id=${alias}.id AND m.purpose='${SERPER_LOOKUP_PURPOSE}'
      AND ((m.outcome_class IS NOT NULL AND m.expires_at>NOW()
            AND m.requested_evidence='${SERPER_LOOKUP_REQUESTED_EVIDENCE}'
            AND m.rule_version=${SERPER_MATCHER_RULE_VERSION}
            AND m.input_fingerprint=${fingerprint})
        OR m.claim_expires_at>NOW()))`);
}

/** Map a lookup outcome to a memory class; null means nothing should be remembered. */
export function classifySerperLookupOutcome(
  outcome: Pick<LookupOutcome, "kind">,
  discoveredDomain: boolean,
): SerperLookupMemoryClass | null {
  switch (outcome.kind) {
    case "accepted_match":
      // A discovered domain removes the business from selection by itself.
      return discoveredDomain ? null : "accepted_no_website";
    case "ambiguous": return "ambiguous";
    case "identity_rejected": return "rejected";
    case "no_result": return "no_match";
    case "provider_failure": return "provider_failure";
    // Blocked by a control: nothing was asked of the provider, so nothing is learned.
    case "blocked": return null;
  }
}

export interface SerperLookupInputs {
  canonicalName?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

/** Fingerprint of explicit lookup inputs, computed by the same SQL as the selector and writer. */
export async function serperLookupInputsFingerprint(inputs: SerperLookupInputs): Promise<string> {
  const row = rows(await db.execute(sql`
    SELECT ${sql.raw(serperLookupInputFingerprintSql("x"))} AS fingerprint
      FROM (SELECT ${inputs.canonicalName ?? null}::text AS canonical_name,
                   ${inputs.streetAddress ?? null}::text AS street_address,
                   ${inputs.city ?? null}::text AS city,
                   ${inputs.state ?? null}::text AS state,
                   ${inputs.postalCode ?? null}::text AS postal_code) x
  `))[0];
  return String(row.fingerprint);
}

/**
 * Atomically claim a business's lookup and PIN the fingerprint of the inputs the lookup
 * will be sent with (pass the exact selected inputs). Returns true only for the single
 * winning worker, and only when the business still has those inputs: if they changed
 * between selection and claim, the stale selection is skipped and the business reopens
 * on its next selection under its new inputs. Without `inputs` the pin is the business's
 * current fingerprint at claim time.
 */
export async function claimSerperLookup(
  businessId: number, claimToken: string, inputs?: SerperLookupInputs,
): Promise<boolean> {
  const pinned = inputs ? await serperLookupInputsFingerprint(inputs) : null;
  const claimed = rows(await db.execute(sql`
    INSERT INTO sfp_serper_lookup_memory (business_id, purpose, requested_evidence, claim_token, claim_expires_at, claim_input_fingerprint)
    SELECT b.id, ${SERPER_LOOKUP_PURPOSE}, ${SERPER_LOOKUP_REQUESTED_EVIDENCE},
           ${claimToken}::uuid, NOW() + make_interval(mins => ${SERPER_LOOKUP_CLAIM_MINUTES}),
           COALESCE(${pinned}::text, ${sql.raw(serperLookupInputFingerprintSql("b"))})
      FROM businesses b WHERE b.id=${businessId}
    ON CONFLICT (business_id, purpose) DO UPDATE
      SET claim_token = EXCLUDED.claim_token, claim_expires_at = EXCLUDED.claim_expires_at,
          claim_input_fingerprint = EXCLUDED.claim_input_fingerprint, updated_at = NOW()
      WHERE sfp_serper_lookup_memory.claim_expires_at IS NULL OR sfp_serper_lookup_memory.claim_expires_at < NOW()
    RETURNING claim_token
  `));
  if (claimed.length === 0) return false;
  // The inputs must still be the ones the lookup will be sent with, and another worker may
  // have finished between selection and this claim. Honour both; nothing was purchased.
  const check = rows(await db.execute(sql`
    SELECT (${sql.raw(serperLookupInputFingerprintSql("b"))} = m.claim_input_fingerprint) AS inputs_unchanged,
           (m.outcome_class IS NOT NULL AND m.expires_at>NOW()
            AND m.requested_evidence=${SERPER_LOOKUP_REQUESTED_EVIDENCE}
            AND m.rule_version=${SERPER_MATCHER_RULE_VERSION}
            AND m.input_fingerprint=m.claim_input_fingerprint) AS fresh_outcome
      FROM sfp_serper_lookup_memory m JOIN businesses b ON b.id=m.business_id
     WHERE m.business_id=${businessId} AND m.purpose=${SERPER_LOOKUP_PURPOSE}
  `))[0];
  if (!check || check.inputs_unchanged !== true || check.fresh_outcome === true) {
    await releaseSerperLookupClaim(businessId, claimToken);
    return false;
  }
  return true;
}

export async function releaseSerperLookupClaim(businessId: number, claimToken: string): Promise<void> {
  await db.execute(sql`
    UPDATE sfp_serper_lookup_memory SET claim_token=NULL, claim_expires_at=NULL, claim_input_fingerprint=NULL, updated_at=NOW()
     WHERE business_id=${businessId} AND purpose=${SERPER_LOOKUP_PURPOSE} AND claim_token=${claimToken}::uuid
  `);
}

/**
 * Record the outcome under the inputs PINNED at claim time (never re-read from the
 * business, which may have changed while the lookup ran) and the current rule version,
 * and release the claim. A changed business therefore fails the selector's fingerprint
 * comparison and is reopened. Only the claim holder can write, and only a claim that
 * carries a pinned fingerprint. Returns the class stored, or null when nothing was
 * remembered (the claim is still released).
 */
export async function recordSerperLookupOutcome(input: {
  businessId: number;
  claimToken: string;
  outcome: Pick<LookupOutcome, "kind" | "rejectionSummary" | "reason" | "requestsUsed">;
  discoveredDomain: boolean;
}): Promise<SerperLookupMemoryClass | null> {
  const memoryClass = classifySerperLookupOutcome(input.outcome, input.discoveredDomain);
  if (!memoryClass) {
    await releaseSerperLookupClaim(input.businessId, input.claimToken);
    return null;
  }
  const reason = (input.outcome.rejectionSummary ?? input.outcome.reason ?? "").slice(0, 200) || null;
  const updated = rows(await db.execute(sql`
    UPDATE sfp_serper_lookup_memory m
       SET outcome_class=${memoryClass}, rule_version=${SERPER_MATCHER_RULE_VERSION},
           input_fingerprint=m.claim_input_fingerprint,
           reason_summary=${reason}, requests_used=${Math.max(0, Math.round(input.outcome.requestsUsed ?? 0))},
           observed_at=NOW(),
           expires_at=NOW() + make_interval(hours => ${SERPER_LOOKUP_MEMORY_TTL_HOURS[memoryClass]}),
           claim_token=NULL, claim_expires_at=NULL, claim_input_fingerprint=NULL, updated_at=NOW()
     WHERE m.business_id=${input.businessId} AND m.claim_input_fingerprint IS NOT NULL
       AND m.purpose=${SERPER_LOOKUP_PURPOSE} AND m.claim_token=${input.claimToken}::uuid
    RETURNING m.outcome_class
  `));
  return updated.length ? memoryClass : null;
}
