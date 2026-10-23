-- Reviewed wording history for message templates. subject/body on message_templates remain the live, published
-- content; content_version names the published version they equal. A template has at most one editable draft.
-- Publishing content never changes is_active, workflow enablement, campaign state or any send capability.
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS message_template_versions (
  id serial PRIMARY KEY,
  template_id integer NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  version integer,
  base_version integer NOT NULL,
  state text NOT NULL,
  subject text,
  body text NOT NULL,
  author_id text,
  published_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  published_at timestamp,
  CONSTRAINT message_template_versions_state_chk CHECK (
    (state = 'draft' AND version IS NULL) OR (state = 'published' AND version IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS message_template_versions_draft_uidx ON message_template_versions (template_id) WHERE state = 'draft';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS message_template_versions_published_uidx ON message_template_versions (template_id, version) WHERE state = 'published';
