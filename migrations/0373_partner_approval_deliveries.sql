-- Durable executable work for partner approval invites/welcomes and affiliate welcomes. A row is written in the same
-- transaction as the approval (or account creation) it follows, so a crash can never lose the intent. State records
-- what is known: waiting (prerequisite not met, no attempt consumed), attempting (claimed), sent, failed (retry budget
-- spent), ambiguous (dispatch may have happened; never auto-resent) or no_recipient/superseded (terminal, truthful).
CREATE TABLE IF NOT EXISTS partner_approval_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id integer NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  generation integer NOT NULL,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  wait_reason text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  dispatch_started_at timestamptz,
  auth_action_id uuid,
  terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_approval_deliveries_kind_chk CHECK (kind IN ('invite', 'welcome', 'affiliate_welcome')),
  CONSTRAINT partner_approval_deliveries_state_chk CHECK (state IN ('pending', 'waiting', 'attempting', 'sent', 'failed', 'ambiguous', 'no_recipient', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS partner_approval_deliveries_partner_generation_uidx ON partner_approval_deliveries (partner_id, generation);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS partner_approval_deliveries_due_idx ON partner_approval_deliveries (next_attempt_at) WHERE state IN ('pending', 'waiting');
