import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db";

const rows = (result: any): any[] => result?.rows ?? result ?? [];
const ORIGINAL_HASH = crypto.createHash("sha256").update(
  '{"version":1,"validation_ttl_days":30,"accepted_outcomes":["valid"],"retryable_outcomes":["failed","dns_indeterminate","unknown"]}',
).digest("hex");

/** Data-only convergence: immutable documents, no production DDL or send release. */
export async function convergeSfpRecipientPolicyV2(executor: any = db) {
  // Routine restarts must not exclusively lock an already-selected newer
  // policy while live consumers hold their authority-pinning SHARE locks.
  // Release this read transaction before acquiring any exclusive write lock.
  const needsUpgrade = await executor.transaction(async (tx: any) => {
    const current = rows(await tx.execute(sql`
      SELECT p.version FROM sfp_outreach_policy_control c
      JOIN sfp_outreach_policy_documents p ON p.id=c.active_policy_id
      WHERE c.singleton=TRUE FOR SHARE OF c
    `))[0];
    return !!current && Number(current.version) === 1;
  });
  if (!needsUpgrade) return { activated: false };

  return executor.transaction(async (tx: any) => {
    // Re-read and check the full original content under the exclusive lock.
    // A writer may have changed selection after the read transaction ended.
    const current = rows(await tx.execute(sql`
      SELECT p.* FROM sfp_outreach_policy_control c
      JOIN sfp_outreach_policy_documents p ON p.id=c.active_policy_id
      WHERE c.singleton=TRUE FOR UPDATE OF c
    `))[0];
    if (!current || Number(current.version) !== 1) return { activated: false };
    // Preserve custom policy selections. Only replace the known original seed.
    if (current.document_hash !== ORIGINAL_HASH
      || current.created_by !== "system:migration_0289"
      || Number(current.validation_ttl_days) !== 30
      || JSON.stringify(current.accepted_outcomes) !== '["valid"]'
      || Object.keys(current.role_inbox_policy ?? {}).length !== 2
      || current.role_inbox_policy?.named_or_unclassified_requires_review !== true
      || current.role_inbox_policy?.role_inbox_eligible_for_cold_b2b !== true) {
      return { activated: false,reason: "custom_policy_preserved" };
    }
    const rolePolicy = { ...current.role_inbox_policy,
      corroborated_business_contact_eligible: true,
      corroborated_named_business_contact_eligible: true };
    const reasonCodes = [...new Set([...current.reason_codes,
      "corroborated_business_contact_policy_eligible","corroborated_named_business_contact_policy_eligible"])];
    const body = { version: 2,validationTtlDays: Number(current.validation_ttl_days),
      acceptedOutcomes: current.accepted_outcomes,retryableOutcomes: current.retryable_outcomes,
      roleInboxPolicy: rolePolicy,consentTierPolicy: current.consent_tier_policy,reasonCodes };
    const documentHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await tx.execute(sql`INSERT INTO sfp_outreach_policy_documents
      (version,document_hash,validation_ttl_days,accepted_outcomes,retryable_outcomes,
        role_inbox_policy,consent_tier_policy,reason_codes,created_by)
      VALUES (2,${documentHash},${body.validationTtlDays},${JSON.stringify(body.acceptedOutcomes)}::jsonb,
        ${JSON.stringify(body.retryableOutcomes)}::jsonb,${JSON.stringify(rolePolicy)}::jsonb,
        ${JSON.stringify(body.consentTierPolicy)}::jsonb,${JSON.stringify(reasonCodes)}::jsonb,
        'system:crm_recipient_policy_v2')
      ON CONFLICT (version) DO NOTHING`);
    const desired = rows(await tx.execute(sql`SELECT id,document_hash
      FROM sfp_outreach_policy_documents WHERE version=2`))[0];
    if (desired?.document_hash !== documentHash) throw new Error("SFP_RECIPIENT_POLICY_V2_VERSION_CONFLICT");
    await tx.execute(sql`UPDATE sfp_outreach_policy_control SET active_policy_id=${desired.id}::uuid,
      activated_at=NOW(),activated_by='system:crm_recipient_policy_v2'
      WHERE singleton=TRUE AND active_policy_id=${current.id}::uuid`);
    return { activated: true,version: 2 };
  });
}