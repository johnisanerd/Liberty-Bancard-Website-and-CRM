/**
 * MI-07: Pipeline Promotion Service
 *
 * Promotes a pipeline-staged master_lead to a canonical contact (local_only mode).
 *
 * Preconditions (all enforced server-side):
 *   1. master_leads.pipeline_origin = 'cro03_pipeline' AND status = 'staged'
 *   2. businesses.email_discovery_status = 'provider_valid' (re-verified at promotion time)
 *   3. canonical_business_id IS NOT NULL
 *   4. No open canonical_conflict_evidence for this business
 *   5. No existing contact with matching email token hash, phone, or domain+company
 *
 * Promotion effects (one atomic transaction, idempotency-key guarded):
 *   - contacts row (local_only mode, consent_tier='cold_no_consent', no outbound)
 *   - lead_sources row via createLeadSource()
 *   - master_leads.status = 'promoted', promoted_at, promoted_by
 *   - contact_source_events row
 *   - audit_log row
 *
 * No GHL, sequence enrollment, deal, or outbound effect — unconditionally.
 * Global outbound pause is NOT checked — promotion never creates outbound effects.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { sanitizeAuditPayload } from "../audit-sanitizer";
import { recordContactIdentityObservations } from "../contact-identity";
import { evaluateBusinessPromotionEligibility } from "../contactability";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PromoteOptions {
  masterLeadId: string;
  promotedBy: string; // user ID
}

export type PromoteResult =
  | { success: true; contactId: number; masterLeadId: string; canonicalBusinessId: number; alreadyPromoted?: boolean }
  | { success: false; code: PromotionBlockerCode; message: string };

export type PromotionBlockerCode =
  | "NOT_PIPELINE_ROW"
  | "NOT_STAGED"
  | "CANONICAL_BUSINESS_MISSING"
  | "EMAIL_NOT_VALID"
  | "OPEN_CANONICAL_CONFLICT"
  | "DUPLICATE_CONTACT"
  | "ALREADY_PROMOTED"
  | "DBPR_LINEAGE_EXCLUDED"
  | "EXISTING_CUSTOMER_EXCLUDED";

export interface PromotionPreviewRow {
  masterLeadId: string;
  company: string | null;
  blocker: PromotionBlockerCode | null;
  eligible: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rows<T>(result: { rows: T[] }): T[] {
  return result.rows ?? [];
}

function computeEmailTokenHash(email: string): string {
  // `require` doesn't exist in this ESM module — this threw ReferenceError on
  // every call. Use the top-of-file `createHash` import instead.
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** Coarse Jaccard-bigram similarity for company dedup (same as stager worker). */
function simpleCompanySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/\b(llc|inc|corp|ltd|co|dba|the)\b/g, "")
      .replace(/[^a-z0-9 ]/g, "")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = bigrams(na.replace(/\s/g, ""));
  const bb = bigrams(nb.replace(/\s/g, ""));
  let intersection = 0;
  for (const b of ba) if (bb.has(b)) intersection++;
  const union = ba.size + bb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***@***";
  const masked = local.length <= 1 ? "*" : local[0] + "***";
  return `${masked}@${domain}`;
}

// ── Precondition checker ──────────────────────────────────────────────────────

export async function checkPromotionPreconditions(
  masterLeadId: string,
): Promise<{ blocker: PromotionBlockerCode; message: string } | { blocker: null; lead: any; biz: any }> {
  // Load master lead — use FOR UPDATE to prevent concurrent promotion races
  // NOTE: this function is called both inside and outside a transaction context.
  // When called from promoteMasterLead(), the outer transaction holds the lock.
  // When called as a preview (promotion-check endpoint), no lock is needed so we skip FOR UPDATE.
  const mlResult = rows<any>(await db.execute(sql`
    SELECT id, status, pipeline_origin, canonical_business_id, email_token_hash, phone, domain, company
    FROM master_leads
    WHERE id = ${masterLeadId}::uuid
    LIMIT 1
  `));

  if (mlResult.length === 0) {
    return { blocker: "NOT_PIPELINE_ROW", message: "Master lead not found" };
  }

  const lead = mlResult[0];

  if (lead.pipeline_origin !== "cro03_pipeline") {
    return { blocker: "NOT_PIPELINE_ROW", message: "Not a pipeline row — use the manual-import lifecycle" };
  }

  if (lead.status === "promoted") {
    return { blocker: "ALREADY_PROMOTED", message: "Already promoted" };
  }

  if (lead.status !== "staged") {
    return { blocker: "NOT_STAGED", message: `Status is '${lead.status}' — only staged rows can be promoted` };
  }

  if (!lead.canonical_business_id) {
    return { blocker: "CANONICAL_BUSINESS_MISSING", message: "canonical_business_id is NULL" };
  }

  // Task #1956 Step 8: DBPR-family lineage and existing-customer relationship
  // are both permanently excluded from promotion — routed through the shared
  // contactability promotion-eligibility dimension rather than a local check
  // (ingestion/storage/materialization stay allowed; this is the promotion boundary).
  const promotionEligibility = await evaluateBusinessPromotionEligibility(Number(lead.canonical_business_id));
  if (promotionEligibility.status === "blocked") {
    const code = promotionEligibility.reasonCodes.includes("EXISTING_CUSTOMER")
      ? "EXISTING_CUSTOMER_EXCLUDED"
      : "DBPR_LINEAGE_EXCLUDED";
    return { blocker: code as PromotionBlockerCode, message: promotionEligibility.reason ?? "Blocked by promotion eligibility authority" };
  }

  // Re-verify email_discovery_status from businesses (not from master_leads)
  const bizResult = rows<any>(await db.execute(sql`
    SELECT id, main_email, email_discovery_status, canonical_name, normalized_name,
           website_domain, main_phone, vertical
    FROM businesses
    WHERE id = ${Number(lead.canonical_business_id)}
    LIMIT 1
  `));

  if (bizResult.length === 0) {
    return { blocker: "CANONICAL_BUSINESS_MISSING", message: "Canonical business not found" };
  }

  const biz = bizResult[0];

  if (biz.email_discovery_status !== "provider_valid") {
    return { blocker: "EMAIL_NOT_VALID", message: `email_discovery_status is '${biz.email_discovery_status}' — must be provider_valid` };
  }

  if (!biz.main_email) {
    return { blocker: "EMAIL_NOT_VALID", message: "businesses.main_email is NULL" };
  }

  // Check for open canonical_conflict_evidence
  const conflictResult = rows<any>(await db.execute(sql`
    SELECT id FROM canonical_conflict_evidence
    WHERE (business_id_a = ${Number(lead.canonical_business_id)} OR business_id_b = ${Number(lead.canonical_business_id)})
      AND status = 'open'
    LIMIT 1
  `));

  if (conflictResult.length > 0) {
    return { blocker: "OPEN_CANONICAL_CONFLICT", message: "Open canonical conflict evidence — resolve before promoting" };
  }

  // Dedup check at promotion time
  const emailTokenHash = computeEmailTokenHash(biz.main_email);
  const normalizedPhone = biz.main_phone ? biz.main_phone.replace(/\D/g, "") : null;

  // Check by hash AND by normalized plaintext for legacy contacts with null email_token_hash
  const normalizedEmailPlain = biz.main_email ? biz.main_email.trim().toLowerCase() : null;
  const dupResult = rows<any>(await db.execute(sql`
    SELECT id FROM contacts
    WHERE email_token_hash = ${emailTokenHash}
       OR (email_token_hash IS NULL AND ${normalizedEmailPlain}::text IS NOT NULL
           AND lower(trim(email)) = ${normalizedEmailPlain ?? ""})
       OR (${normalizedPhone}::text IS NOT NULL AND regexp_replace(phone, '\D', '', 'g') = ${normalizedPhone ?? ""})
    LIMIT 1
  `));

  if (dupResult.length > 0) {
    return { blocker: "DUPLICATE_CONTACT", message: "Existing contact matches email or phone" };
  }

  return { blocker: null, lead, biz };
}

// ── Promote single ────────────────────────────────────────────────────────────

export async function promoteMasterLead(options: PromoteOptions): Promise<PromoteResult> {
  const { masterLeadId, promotedBy } = options;

  // Pre-flight: fast fail for obviously invalid/non-pipeline rows before taking a DB lock.
  // These checks use stale reads; authoritative checks run inside the transaction below.
  //
  // Special case: ALREADY_PROMOTED must NOT block the idempotent success path.
  // A committed retry should return the original contactId, not 422.
  const preflight = await checkPromotionPreconditions(masterLeadId);
  if (preflight.blocker && preflight.blocker !== "ALREADY_PROMOTED") {
    return { success: false, code: preflight.blocker as PromotionBlockerCode, message: (preflight as any).message };
  }
  if (preflight.blocker === "ALREADY_PROMOTED") {
    // Look up the prior contact from the audit log and return idempotent success.
    const prior = rows<any>(await db.execute(sql`
      SELECT details->>'contactId' AS contact_id,
             details->>'canonicalBusinessId' AS canonical_business_id
      FROM audit_logs
      WHERE action = 'master_lead_promoted'
        AND entity_key = ${masterLeadId}
      ORDER BY created_at DESC
      LIMIT 1
    `));
    if (prior.length > 0 && prior[0].contact_id) {
      return {
        success: true,
        contactId: Number(prior[0].contact_id),
        masterLeadId,
        canonicalBusinessId: Number(prior[0].canonical_business_id) || 0,
        alreadyPromoted: true,
      };
    }
    // No audit record found — fall through to the transaction which will also handle this.
  }

  // Atomic promotion transaction.
  // All authoritative preconditions (email_discovery_status, canonical business linkage,
  // open conflicts, duplicate contacts) are re-verified INSIDE the transaction after
  // locking the lead row with FOR UPDATE, preventing concurrent promotion races.
  try {
    const result = await db.transaction(async (tx) => {
      // Lock the lead row first. Releases at transaction end.
      const lockedLead = rows<any>(await tx.execute(sql`
        SELECT id, status, pipeline_origin, canonical_business_id, domain, company
        FROM master_leads
        WHERE id = ${masterLeadId}::uuid
          AND pipeline_origin = 'cro03_pipeline'
        FOR UPDATE
        LIMIT 1
      `));

      if (lockedLead.length === 0) {
        throw Object.assign(new Error("Lead not found or not a pipeline row"), { code: "NOT_STAGED" });
      }
      const lockedRow = lockedLead[0];

      // ── Idempotency gate (inside tx, after lock) ────────────────────────────
      // If a prior committed transaction already promoted this lead, return its contactId.
      const existingPromotion = rows<any>(await tx.execute(sql`
        SELECT details->>'contactId' AS contact_id
        FROM audit_logs
        WHERE action = 'master_lead_promoted'
          AND entity_key = ${masterLeadId}
        LIMIT 1
      `));
      if (existingPromotion.length > 0 && existingPromotion[0].contact_id) {
        // Idempotent: a prior committed transaction already promoted this lead.
        // Read canonicalBusinessId from the locked row so the success result has a valid number.
        const cBizId = Number(lockedRow.canonical_business_id) || 0;
        return { contactId: Number(existingPromotion[0].contact_id), canonicalBusinessId: cBizId, alreadyPromoted: true as const };
      }

      // ── Status gate ─────────────────────────────────────────────────────────
      if (lockedRow.status === "promoted") {
        throw Object.assign(new Error("Already promoted"), { code: "ALREADY_PROMOTED" });
      }
      if (lockedRow.status !== "staged") {
        throw Object.assign(new Error(`Status is '${lockedRow.status}' — only staged rows can be promoted`), { code: "NOT_STAGED" });
      }

      // ── Authoritative canonical business re-fetch (inside tx) ───────────────
      const canonicalBusinessId = Number(lockedRow.canonical_business_id);
      if (!canonicalBusinessId) {
        throw Object.assign(new Error("canonical_business_id is NULL"), { code: "CANONICAL_BUSINESS_MISSING" });
      }

      const promotionEligibilityTx = await evaluateBusinessPromotionEligibility(canonicalBusinessId);
      if (promotionEligibilityTx.status === "blocked") {
        const code = promotionEligibilityTx.reasonCodes.includes("EXISTING_CUSTOMER")
          ? "EXISTING_CUSTOMER_EXCLUDED"
          : "DBPR_LINEAGE_EXCLUDED";
        throw Object.assign(
          new Error(promotionEligibilityTx.reason ?? "Blocked by promotion eligibility authority"),
          { code },
        );
      }

      const bizResult = rows<any>(await tx.execute(sql`
        SELECT id, main_email, email_discovery_status, canonical_name, normalized_name,
               website_domain, main_phone, vertical
        FROM businesses
        WHERE id = ${canonicalBusinessId}
        LIMIT 1
      `));
      if (bizResult.length === 0) {
        throw Object.assign(new Error("Canonical business not found"), { code: "CANONICAL_BUSINESS_MISSING" });
      }
      const biz = bizResult[0];

      // ── email_discovery_status re-verified inside tx ─────────────────────────
      if (biz.email_discovery_status !== "provider_valid") {
        throw Object.assign(
          new Error(`email_discovery_status is '${biz.email_discovery_status}' — must be provider_valid`),
          { code: "EMAIL_NOT_VALID" },
        );
      }
      if (!biz.main_email) {
        throw Object.assign(new Error("businesses.main_email is NULL"), { code: "EMAIL_NOT_VALID" });
      }

      // ── Open conflict check inside tx ────────────────────────────────────────
      const conflictResult = rows<any>(await tx.execute(sql`
        SELECT id FROM canonical_conflict_evidence
        WHERE (business_id_a = ${canonicalBusinessId} OR business_id_b = ${canonicalBusinessId})
          AND status = 'open'
        LIMIT 1
      `));
      if (conflictResult.length > 0) {
        throw Object.assign(
          new Error("Open canonical conflict evidence — resolve before promoting"),
          { code: "OPEN_CANONICAL_CONFLICT" },
        );
      }

      const email = String(biz.main_email);
      const emailTokenHash = computeEmailTokenHash(email);
      const normalizedPhone = (biz.main_phone as string | null)?.replace(/\D/g, "") ?? null;

      // ── Advisory locks to serialize concurrent promotions by dedup identity ──
      // Two concurrent promotion transactions for leads sharing an email or phone
      // will queue here; only the first will find no duplicate contact and proceed.
      // pg_advisory_xact_lock acquires a session-level lock scoped to the transaction.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(('x' || left(${emailTokenHash}, 16))::bit(64)::bigint)
      `);
      if (normalizedPhone) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(('x' || left(md5(${normalizedPhone}), 16))::bit(64)::bigint)
        `);
      }

      // ── Duplicate contact checks inside tx (after advisory lock) ─────────────
      // Cover both hash-matched contacts and legacy contacts where email_token_hash is null.
      const normalizedEmailPlainTx = email.trim().toLowerCase();
      const dupCheck = rows<any>(await tx.execute(sql`
        SELECT id FROM contacts
        WHERE email_token_hash = ${emailTokenHash}
           OR (email_token_hash IS NULL AND lower(trim(email)) = ${normalizedEmailPlainTx})
           OR (${normalizedPhone ?? ""}::text <> '' AND regexp_replace(phone, '\D', '', 'g') = ${normalizedPhone ?? ""})
        LIMIT 1
      `));
      if (dupCheck.length > 0) {
        throw Object.assign(new Error("Existing contact matches email or phone"), { code: "DUPLICATE_CONTACT" });
      }

      // Domain+company similarity check inside tx
      const domain = lockedRow.domain as string | null;
      if (domain) {
        const normDomain = domain.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
        if (normDomain) {
          const domainDups = rows<any>(await tx.execute(sql`
            SELECT id, company_name FROM contacts
            WHERE website IS NOT NULL
              AND lower(regexp_replace(website, '^https?://(www\.)?', '')) LIKE ${normDomain + "%"}
            LIMIT 20
          `));
          const companyA = String(lockedRow.company ?? "");
          for (const c of domainDups) {
            if (simpleCompanySimilarity(companyA, String(c.company_name ?? "")) >= 0.85) {
              throw Object.assign(new Error("Existing contact matches domain+company"), { code: "DUPLICATE_CONTACT" });
            }
          }
        }
      }

      const idempotencyKey = `pipeline_promotion:${masterLeadId}:${canonicalBusinessId}`;

      // ── Create contact (local_only mode) ─────────────────────────────────────
      // consent_tier = 'cold_no_consent', no GHL, no sequence enrollment, no deal.
      const contactRows = rows<any>(await tx.execute(sql`
        INSERT INTO contacts (
          first_name, last_name, email, phone,
          company_name, website, vertical,
          consent_tier,
          do_not_contact, consent_email, consent_sms,
          email_token_hash, email_status,
          lead_source, status, source_category,
          business_id,
          created_at, updated_at
        ) VALUES (
          '', '', ${email}, ${biz.main_phone ?? ''},
          ${biz.canonical_name ?? null}, ${biz.website_domain ?? null}, ${biz.vertical ?? null},
          'cold_no_consent',
          false, false, false,
          ${emailTokenHash}, 'unvalidated',
          'pipeline_master_lead', 'New', 'pipeline',
          ${canonicalBusinessId},
          NOW(), NOW()
        )
        RETURNING id
      `));

      if (contactRows.length === 0) throw new Error("Contact insert returned no rows");
      const contactId = Number(contactRows[0].id);
      await recordContactIdentityObservations(tx, {
        id: contactId,
        email,
        phone: biz.main_phone ?? "",
      }, "pipeline_promotion", masterLeadId);

      // ── GHL provider fence ────────────────────────────────────────────────
      // Insert a terminal contact_provider_projections row so the GHL sync worker
      // (both the projection processor and the legacy broad scan) never treats this
      // contact as a candidate for automatic export.  This is the durable local-only
      // signal — it must be written atomically with the contact row.
      await tx.execute(sql`
        INSERT INTO contact_provider_projections
          (contact_id, provider, projection_key, state, attempt_count, next_attempt_at, terminal_reason, created_at, updated_at,
           authority_version, export_disposition, export_reason, source_kind)
        VALUES
          (${contactId}, 'ghl', ${'pipeline_local_only:' + masterLeadId}, 'terminal', 0, NOW(), 'pipeline_local_only', NOW(), NOW(),
           1, 'local_only', 'pipeline_local_only_fence', 'pipeline_promotion')
        ON CONFLICT (contact_id, provider, projection_key) DO NOTHING
      `);

      // lead_sources row via createLeadSource pattern (direct insert inside tx)
      await tx.execute(sql`
        INSERT INTO lead_sources (business_id, contact_id, source_type, source_label, source_external_id, discovered_at)
        VALUES (${canonicalBusinessId}, ${contactId}, 'pipeline_master_lead', 'CRO-03 Pipeline', ${masterLeadId}, NOW())
      `);

      // contact_source_events row
      const eventKey = `pipeline:master_lead:${masterLeadId}`;
      await tx.execute(sql`
        INSERT INTO contact_source_events (
          contact_id, event_key, source_category, source_type,
          source_external_id, actor_type, actor_id, metadata, first_seen_at, last_seen_at, created_at
        ) VALUES (
          ${contactId}, ${eventKey}, 'pipeline', 'pipeline_master_lead',
          ${masterLeadId}, 'user', ${promotedBy},
          ${JSON.stringify({ masterLeadId, canonicalBusinessId, promotedBy })}::jsonb,
          NOW(), NOW(), NOW()
        )
        ON CONFLICT (contact_id, event_key) DO NOTHING
      `);

      // Update master_leads.status = 'promoted'
      await tx.execute(sql`
        UPDATE master_leads
           SET status = 'promoted',
               promoted_at = NOW(),
               promoted_by = ${promotedBy},
               promoted_contact_id = ${contactId},
               updated_at = NOW()
         WHERE id = ${masterLeadId}::uuid
      `);

      // Audit log
      await tx.execute(sql`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_key, details, actor_type, actor_id)
        VALUES (
          ${promotedBy},
          'master_lead_promoted',
          'master_lead',
          ${masterLeadId},
          ${JSON.stringify(sanitizeAuditPayload({ masterLeadId, contactId, canonicalBusinessId, promotedBy, idempotencyKey }))}::jsonb,
          'user',
          ${promotedBy}
        )
      `);

      return { contactId, canonicalBusinessId };
    });

    return {
      success: true,
      contactId: result.contactId,
      masterLeadId,
      canonicalBusinessId: result.canonicalBusinessId,
      alreadyPromoted: result.alreadyPromoted ?? false,
    };
  } catch (err: any) {
    const code = (err as any).code as string | undefined;
    if (code === "NOT_STAGED") {
      return { success: false, code: "NOT_STAGED", message: err.message ?? "Lead is no longer staged" };
    }
    if (code === "ALREADY_PROMOTED") {
      return { success: false, code: "ALREADY_PROMOTED", message: "Already promoted" };
    }
    if (code === "DUPLICATE_CONTACT") {
      return { success: false, code: "DUPLICATE_CONTACT", message: err.message ?? "Duplicate contact" };
    }
    if (code === "EMAIL_NOT_VALID") {
      return { success: false, code: "EMAIL_NOT_VALID", message: err.message ?? "Email not valid" };
    }
    if (code === "OPEN_CANONICAL_CONFLICT") {
      return { success: false, code: "OPEN_CANONICAL_CONFLICT", message: err.message ?? "Open canonical conflict" };
    }
    if (code === "CANONICAL_BUSINESS_MISSING") {
      return { success: false, code: "CANONICAL_BUSINESS_MISSING", message: err.message ?? "Canonical business missing" };
    }
    throw err;
  }
}

// ── Bulk preview ──────────────────────────────────────────────────────────────

export async function previewGenerationPromotion(
  generationId: string,
): Promise<{ rows: PromotionPreviewRow[]; eligibleCount: number; blockedCount: number }> {
  // Fetch all staged pipeline rows for this generation
  const leads = rows<any>(await db.execute(sql`
    SELECT id, company, status, pipeline_origin, canonical_business_id
    FROM master_leads
    WHERE cro03_generation_id = ${generationId}::uuid
      AND pipeline_origin = 'cro03_pipeline'
      AND status = 'staged'
  `));

  const previewRows: PromotionPreviewRow[] = [];

  for (const lead of leads) {
    const check = await checkPromotionPreconditions(String(lead.id));
    previewRows.push({
      masterLeadId: String(lead.id),
      company: lead.company ?? null,
      blocker: check.blocker as PromotionBlockerCode | null,
      eligible: check.blocker === null,
    });
  }

  const eligibleCount = previewRows.filter(r => r.eligible).length;
  const blockedCount = previewRows.filter(r => !r.eligible).length;

  return { rows: previewRows, eligibleCount, blockedCount };
}

// ── Bulk promote ──────────────────────────────────────────────────────────────

export async function promoteGenerationEligible(
  generationId: string,
  promotedBy: string,
): Promise<{
  promoted: Array<{ masterLeadId: string; contactId: number }>;
  blocked: Array<{ masterLeadId: string; code: string; message: string }>;
}> {
  const leads = rows<any>(await db.execute(sql`
    SELECT id FROM master_leads
    WHERE cro03_generation_id = ${generationId}::uuid
      AND pipeline_origin = 'cro03_pipeline'
      AND status = 'staged'
  `));

  const promoted: Array<{ masterLeadId: string; contactId: number }> = [];
  const blocked: Array<{ masterLeadId: string; code: string; message: string }> = [];

  for (const lead of leads) {
    const result = await promoteMasterLead({ masterLeadId: String(lead.id), promotedBy });
    if (result.success) {
      promoted.push({ masterLeadId: String(lead.id), contactId: result.contactId });
    } else {
      blocked.push({ masterLeadId: String(lead.id), code: result.code, message: result.message });
    }
  }

  return { promoted, blocked };
}
