-- Sparse retained-source probes for bounded ordinary contact-link pages.
-- Publish owns production DDL; no runtime/startup index creation.
CREATE INDEX IF NOT EXISTS prospects_retained_contact_idx
  ON prospects(contact_id) WHERE contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sunbiz_entities_retained_prospect_idx
  ON sunbiz_entities(prospect_id) WHERE prospect_id IS NOT NULL;
