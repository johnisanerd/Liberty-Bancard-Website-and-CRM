-- Publish does not alter an existing check constraint when only its definition changes, so production
-- kept the pre-policy admission_tier list and rejected every policy_accepted row. The corrected list
-- is published under a new name so the schema diff adds it and drops the old one. Publish owns production DDL.
ALTER TABLE sfp_classification_evidence DROP CONSTRAINT IF EXISTS sfp_classification_evidence_admission_tier_chk;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence DROP CONSTRAINT IF EXISTS sfp_classification_evidence_admission_tier_v2_chk;
--> statement-breakpoint
ALTER TABLE sfp_classification_evidence ADD CONSTRAINT sfp_classification_evidence_admission_tier_v2_chk
  CHECK (admission_tier IS NULL OR admission_tier IN ('resolved_high', 'resolved_medium', 'policy_accepted'));
