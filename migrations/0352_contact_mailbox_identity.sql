-- Owner decision: distinct CRM contacts may share a delivery mailbox.
-- Login/user uniqueness and every provenance/relationship/FK guard are unchanged.
-- No contacts are merged, archived, normalized or otherwise rewritten here.
DROP INDEX IF EXISTS contacts_email_unique_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_active_email_idx ON contacts (email) WHERE archived_at IS NULL;
