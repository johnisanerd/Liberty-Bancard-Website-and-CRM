-- Policy-owned vertical acceptance. A classification result (AI or deterministic) and the decision
-- to rely on it are separate facts: an accepted row records the basis, the policy version and the
-- supporting facts (source reference, service description or category, content fingerprint) on the
-- same insert-only evidence row, and input_fingerprint records the stored business facts the row
-- was made from so a later change to them is detectable. Publish owns production DDL.
ALTER TABLE sfp_classification_evidence ADD COLUMN IF NOT EXISTS acceptance_basis text;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence ADD COLUMN IF NOT EXISTS acceptance_policy_version integer;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence ADD COLUMN IF NOT EXISTS acceptance_facts jsonb;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence ADD COLUMN IF NOT EXISTS input_fingerprint text;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence ADD COLUMN IF NOT EXISTS website_content_hash text;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence DROP CONSTRAINT IF EXISTS sfp_classification_evidence_admission_tier_chk;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence ADD CONSTRAINT sfp_classification_evidence_admission_tier_chk
  CHECK (admission_tier IS NULL OR admission_tier IN ('resolved_high', 'resolved_medium', 'policy_accepted'));
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence DROP CONSTRAINT IF EXISTS sfp_classification_evidence_policy_acceptance_chk;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence ADD CONSTRAINT sfp_classification_evidence_policy_acceptance_chk CHECK (
  (admission_tier IS NOT DISTINCT FROM 'policy_accepted') = (acceptance_basis IS NOT NULL)
  AND (acceptance_basis IS NULL OR acceptance_basis IN ('website_services','listing_category','website_and_listing','ai_cited'))
  AND (admission_tier IS DISTINCT FROM 'policy_accepted' OR (
    outcome = 'target' AND resolved_vertical_id IS NOT NULL AND acceptance_policy_version IS NOT NULL
    AND acceptance_facts IS NOT NULL AND input_fingerprint IS NOT NULL))
);
