-- One durable, purpose-bound acknowledgement per inbound transactional_ack effect. The row binds recipient,
-- purpose, presentation version and exact content before dispatch; the SMTP transport re-verifies it before a
-- pause lease is granted. "uncertain" is never retried automatically. Publish owns production DDL.
CREATE TABLE IF NOT EXISTS inbound_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_id uuid NOT NULL REFERENCES inbound_request_effects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES inbound_requests(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'inbound_transactional_acknowledgement',
  source_class text NOT NULL,
  recipient_email text,
  recipient_contact_id integer REFERENCES contacts(id),
  template_key text NOT NULL,
  presentation_version text NOT NULL,
  subject text,
  html_body text,
  text_body text,
  content_hash text,
  state text NOT NULL DEFAULT 'prepared',
  blocked_reason text,
  attempt_token uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  transport_message_id text,
  attempted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_acknowledgements_state_chk CHECK (state IN ('prepared','blocked','attempting','accepted','uncertain','failed','suppressed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS inbound_acknowledgements_effect_uidx ON inbound_acknowledgements (effect_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inbound_acknowledgements_state_idx ON inbound_acknowledgements (state, created_at);
