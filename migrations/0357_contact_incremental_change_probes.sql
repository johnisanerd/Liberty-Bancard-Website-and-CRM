-- Dev/disposable only. Production delivery is the managed Publish schema diff.
-- Unlike relationship candidates, change detection must preserve noncanonical,
-- unknown-source and missing-filing matches. Partial indexes cannot cover those.
CREATE INDEX IF NOT EXISTS contact_change_business_name_idx ON businesses (crm_identity_name(canonical_name));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_change_business_domain_idx ON businesses (crm_identity_domain(website_domain));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_change_registry_name_idx ON sunbiz_entities (crm_identity_name(entity_name),updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_change_registry_dba_idx ON sunbiz_entities (crm_identity_name(dba),updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_change_source_key_idx ON canonical_source_links (stable_key);
