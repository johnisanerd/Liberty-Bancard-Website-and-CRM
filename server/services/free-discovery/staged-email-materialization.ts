/**
 * Staged-email materialization.
 *
 * "Staged" emails are rows in free_discovery_candidates (field='email',
 * disposition='staged'): addresses the first-party contact-page crawler and
 * JSON-LD reader found on a business's own website. They are encrypted
 * evidence, not contacts, so nothing downstream (link automation, canonical
 * preparation, validation) can see them.
 *
 * This service turns the safe subset into ordinary contacts through the
 * canonical writeContact() writer:
 *   - business is canonical, not do_not_visit, has a mapped vertical,
 *     has no DBPR lineage and has no open identity quarantine
 *   - address is not shared by candidates of different businesses
 *   - address is not already a contact and is not suppressed
 *   - at most MAX_CONTACTS_PER_BUSINESS contacts per business
 *
 * It spends nothing and sends nothing. Contacts are written with deferred
 * hooks (no validation intent, no readiness, no GHL projection). They carry the
 * business's canonical name as company_name so the existing link automation can
 * attach them; the canonical-preparation path then owns validation.
 * Candidate evidence rows are never mutated; replay safety comes from the
 * per-candidate source-event key.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { unseal } from "../cro03/candidate-evidence-service";
import { writeContact } from "../contact-writer";
import { hashEmailToken, normalizeEmailToken } from "../provider-readiness-control";
import { isCanonicallySuppressed } from "../cro03/sfp-outreach-policy";
import { businessLacksDbprLineageSql } from "../dbpr";
import { effectiveBusinessVerticalStatusSql } from "@shared/effective-vertical";

const rows = (result: any): any[] => result?.rows ?? result ?? [];

export const MAX_CONTACTS_PER_BUSINESS = 3;
export const STAGED_EMAIL_EVENT_PREFIX = "free_discovery_materialize:";
const EMAIL_SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Candidate rows that pass every database-side gate, ranked per business. */
function eligibleCandidatesSql(limit: number | null) {
  // Stage the (small) staged-email set first and evaluate the expensive
  // per-business gates once per distinct business, never per candidate row.
  return sql`
    WITH staged AS MATERIALIZED (
      SELECT f.id, f.business_id, f.normalized_value_hash, f.confidence, f.created_at,
             f.envelope_ciphertext, f.envelope_nonce, f.envelope_tag, f.envelope_key_version,
             f.source, f.attribution_scope
        FROM free_discovery_candidates f
       WHERE f.field = 'email' AND f.disposition = 'staged' AND f.subject_type = 'business'
         AND f.business_id IS NOT NULL AND f.promoted_at IS NULL AND f.contact_id IS NULL
    ), eligible_business AS MATERIALIZED (
      SELECT b.id,
             (SELECT count(*) FROM contacts c
               WHERE c.business_id = b.id AND c.archived_at IS NULL) AS existing_contacts
        FROM businesses b
       WHERE b.id IN (SELECT business_id FROM staged)
         AND b.record_class = 'canonical' AND COALESCE(b.do_not_visit, FALSE) = FALSE
         AND ${businessLacksDbprLineageSql(sql`b.id`)}
         AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q
                          WHERE q.business_id = b.id AND q.cleared_at IS NULL)
         AND ${sql.raw(effectiveBusinessVerticalStatusSql("b"))} = 'mapped'
    ), shared_hash AS MATERIALIZED (
      SELECT normalized_value_hash FROM staged
       GROUP BY normalized_value_hash HAVING count(DISTINCT business_id) > 1
    ), base AS (
      SELECT s.*, eb.existing_contacts
        FROM staged s
        JOIN eligible_business eb ON eb.id = s.business_id
       WHERE s.normalized_value_hash NOT IN (SELECT normalized_value_hash FROM shared_hash)
         AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.email_token_hash = s.normalized_value_hash)
         AND NOT EXISTS (SELECT 1 FROM contact_source_events e
                          WHERE e.event_key = ${STAGED_EMAIL_EVENT_PREFIX} || s.id::text)
    ), ranked AS (
      SELECT base.*,
             row_number() OVER (PARTITION BY business_id
               ORDER BY (attribution_scope = 'named') DESC, confidence DESC NULLS LAST,
                        created_at, id) AS rn
        FROM base
    )
    SELECT * FROM ranked
     WHERE rn <= GREATEST(0, ${MAX_CONTACTS_PER_BUSINESS} - existing_contacts)
     ORDER BY business_id, rn
     ${limit ? sql`LIMIT ${limit}` : sql``}
  `;
}

export interface StagedEmailMaterializationPreview {
  stagedBusinessEmailRows: number;
  eligibleRows: number;
  eligibleBusinesses: number;
  note: string;
}

/** Read-only: how many staged rows would be materialized right now. */
export async function previewStagedEmailMaterialization(): Promise<StagedEmailMaterializationPreview> {
  const total = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM free_discovery_candidates
     WHERE field='email' AND disposition='staged' AND subject_type='business' AND business_id IS NOT NULL
  `))[0];
  const eligible = rows(await db.execute(sql`
    SELECT count(*)::int AS n, count(DISTINCT business_id)::int AS businesses
      FROM (${eligibleCandidatesSql(null)}) e
  `))[0];
  return {
    stagedBusinessEmailRows: Number(total?.n ?? 0),
    eligibleRows: Number(eligible?.n ?? 0),
    eligibleBusinesses: Number(eligible?.businesses ?? 0),
    note: "Database-side gates only; suppression and per-address syntax are re-checked per row at write time.",
  };
}

export interface StagedEmailMaterializationResult {
  examined: number;
  created: number;
  matchedExisting: number;
  skipped: Record<string, number>;
  failed: number;
  contactIds: number[];
}

export async function runStagedEmailMaterialization(input: {
  limit: number;
  actorId: string;
}): Promise<StagedEmailMaterializationResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const candidates = rows(await db.execute(eligibleCandidatesSql(limit)));
  const result: StagedEmailMaterializationResult = {
    examined: candidates.length, created: 0, matchedExisting: 0, skipped: {}, failed: 0, contactIds: [],
  };
  const skip = (reason: string) => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1; };

  for (const candidate of candidates) {
    try {
      let email: string;
      try {
        email = unseal("email", {
          ciphertext: String(candidate.envelope_ciphertext),
          nonce: String(candidate.envelope_nonce),
          tag: String(candidate.envelope_tag),
          keyVersion: Number(candidate.envelope_key_version ?? 1),
        }).trim().toLowerCase();
      } catch {
        skip("decryption_failed");
        continue;
      }
      if (!EMAIL_SYNTAX.test(email) || !normalizeEmailToken(email)) { skip("email_unusable"); continue; }
      const tokenHash = hashEmailToken(email);
      if (!tokenHash) { skip("email_unusable"); continue; }

      const existing = rows(await db.execute(sql`
        SELECT 1 FROM contacts WHERE archived_at IS NULL AND lower(btrim(email)) = ${email} LIMIT 1
      `))[0];
      if (existing) { skip("already_a_contact"); continue; }
      if (await isCanonicallySuppressed([tokenHash], db, [email])) { skip("suppressed"); continue; }

      const business = rows(await db.execute(sql`
        SELECT canonical_name, vertical FROM businesses WHERE id = ${Number(candidate.business_id)}
      `))[0];
      const companyName = String(business?.canonical_name ?? "").trim();
      if (!companyName) { skip("business_name_missing"); continue; }

      const candidateId = String(candidate.id);
      const created = await writeContact({
        mode: "local_only",
        hookPolicy: {
          source: "cro03", deferValidation: true, deferReadiness: true,
          deferLeadScoring: true, suppressProviderProjection: true,
          // Re-verify under the write transaction that the evidence row is
          // still an unpromoted staged email and the address is still unowned.
          authorityCheck: async (tx: any) => {
            const current = rows(await tx.execute(sql`
              SELECT 1 FROM free_discovery_candidates
               WHERE id = ${candidateId}::uuid AND disposition = 'staged' AND promoted_at IS NULL
                 AND contact_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.email_token_hash = ${tokenHash})
               FOR SHARE
            `))[0];
            return Boolean(current);
          },
        },
        mutation: {
          firstName: companyName.slice(0, 60),
          lastName: "Contact",
          email,
          phone: "",
          companyName,
          vertical: business?.vertical ?? null,
          status: "New",
        } as any,
        provenance: {
          sourceCategory: "discovery",
          sourceType: "cro03",
          eventKey: `${STAGED_EMAIL_EVENT_PREFIX}${candidateId}`,
          actorType: "system",
          actorId: input.actorId,
          metadata: {
            origin: "free_discovery_staged_email_materialization",
            candidateId,
            businessId: Number(candidate.business_id),
            candidateSource: candidate.source,
            attributionScope: candidate.attribution_scope,
          },
        },
        actor: { actorType: "system", actorId: input.actorId },
      });
      if (created._intakeOutcome === "created") {
        result.created += 1;
        result.contactIds.push(created.id);
      } else {
        result.matchedExisting += 1;
      }
    } catch (error: any) {
      if (String(error?.message ?? "").includes("CONTACT_WRITE_AUTHORITY_FENCE_LOST")) {
        skip("evidence_changed");
        continue;
      }
      result.failed += 1;
      console.error("[StagedEmailMaterialization] candidate failed:", error?.cause?.message ?? error?.message);
    }
  }

  await db.execute(sql`
    INSERT INTO audit_logs(user_id, action, entity_type, entity_key, details, actor_type, actor_id)
    VALUES (${input.actorId}, 'staged_email_materialization_run', 'free_discovery_candidates',
            ${`run:${Date.now()}`},
            ${JSON.stringify({
              examined: result.examined, created: result.created, matchedExisting: result.matchedExisting,
              skipped: result.skipped, failed: result.failed, paidProviderCalls: 0, outboundChanges: 0,
            })}::jsonb, 'user', ${input.actorId})
  `).catch((error: any) => console.error("[StagedEmailMaterialization] audit write failed:", error?.message));
  return result;
}
