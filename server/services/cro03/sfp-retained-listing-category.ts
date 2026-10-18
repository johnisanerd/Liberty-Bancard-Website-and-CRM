/**
 * Reader for the listing category the provider returned for an identity-matched listing and the paid
 * waterfall retained (sfp_paid_candidate_evidence, field listing_category). The acceptance policy
 * treats exactly these rows as the "listing category" source; their hashes are also part of the
 * classification input fingerprint (shared/sfp-input-fingerprint.ts), which keeps both in step.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { unseal } from "./candidate-evidence-service";
import type { RetainedListingCategory } from "./sfp-vertical-acceptance";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

export interface RetainedListingCategories {
  categories: RetainedListingCategory[];
  hashes: string[];
}

export async function loadRetainedListingCategories(businessId: number): Promise<RetainedListingCategories> {
  const result = rows(await db.execute(sql`
    SELECT pe.id, pe.provider, pe.provider_operation_id, pe.normalized_value_hash,
           pe.candidate_metadata->>'endpoint' AS endpoint,
           pe.envelope_ciphertext, pe.envelope_nonce, pe.envelope_tag, pe.envelope_key_version
      FROM sfp_paid_candidate_evidence pe
     WHERE pe.business_id=${businessId} AND pe.field='listing_category'
       AND pe.candidate_metadata->>'acceptedIdentityMatch'='true'
       AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q WHERE q.business_id=pe.business_id AND q.cleared_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM sfp_discredited_paid_evidence d WHERE d.evidence_id=pe.id)
     ORDER BY pe.normalized_value_hash COLLATE "C"
  `));
  const categories: RetainedListingCategory[] = result.map((row: any) => ({
    text: unseal("listing_category", {
      ciphertext: String(row.envelope_ciphertext), nonce: String(row.envelope_nonce),
      tag: String(row.envelope_tag), keyVersion: Number(row.envelope_key_version),
    }),
    sourceRef: {
      evidenceId: String(row.id), provider: String(row.provider),
      providerOperationId: row.provider_operation_id ? String(row.provider_operation_id) : null,
      endpoint: row.endpoint ? String(row.endpoint) : null,
    },
  }));
  return { categories, hashes: result.map((row: any) => String(row.normalized_value_hash)) };
}
