-- One bounded additional ZeroBounce attempt per address whose earlier call was dispatched and then
-- ended with an unknown billing/response outcome. One row per address, ever (UNIQUE), so a second
-- uncertainty on the additional attempt stays held. The original operations, attempts, observations
-- and billing facts are never modified; the row only names the superseded operations so the shared
-- address claim may be re-taken once. Publish owns production DDL.
CREATE TABLE IF NOT EXISTS zerobounce_ambiguous_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_token_hash text NOT NULL UNIQUE
    CONSTRAINT zerobounce_ambiguous_recoveries_hash_check CHECK (email_token_hash ~ '^[a-f0-9]{64}$'),
  superseded_operation_ids uuid[] NOT NULL
    CONSTRAINT zerobounce_ambiguous_recoveries_ops_check CHECK (cardinality(superseded_operation_ids) > 0),
  authorization_key text NOT NULL,
  authorized_by text,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'authorized'
    CONSTRAINT zerobounce_ambiguous_recoveries_state_check CHECK (state IN ('authorized','consumed','revoked')),
  consumed_at timestamptz,
  consumed_claim_token uuid,
  new_operation_id uuid REFERENCES provider_operations(id) ON DELETE RESTRICT,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT zerobounce_ambiguous_recoveries_consumed_check
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS zerobounce_ambiguous_recoveries_authorization_idx
  ON zerobounce_ambiguous_recoveries (authorization_key, state);
