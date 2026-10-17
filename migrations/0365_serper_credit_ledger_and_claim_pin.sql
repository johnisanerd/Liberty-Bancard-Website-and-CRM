-- Serper allowance hardening.
-- 1) The lookup claim pins the exact input fingerprint the lookup was sent with, so an
--    outcome is recorded against what was actually asked, never against inputs that
--    changed while the lookup was in flight.
-- 2) A durable, shared credit ledger: every physical Serper request in the unlabeled
--    scope reserves its worst-case charge before it is sent, and settles to the reported
--    charge (or stays at the worst case when the charge is unknown). No provider payloads
--    are stored. Publish owns production DDL.
ALTER TABLE sfp_serper_lookup_memory ADD COLUMN IF NOT EXISTS claim_input_fingerprint text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sfp_serper_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allowance_key text NOT NULL,
  run_token uuid NOT NULL,
  endpoint text NOT NULL,
  reserved_credits integer NOT NULL,
  settled_credits integer,
  state text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT sfp_serper_credit_ledger_state_chk CHECK (state IN ('reserved','settled','settled_unknown','not_sent')),
  CONSTRAINT sfp_serper_credit_ledger_reserved_chk CHECK (reserved_credits > 0),
  CONSTRAINT sfp_serper_credit_ledger_settled_chk CHECK (settled_credits IS NULL OR settled_credits >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sfp_serper_credit_ledger_window_idx ON sfp_serper_credit_ledger (allowance_key, created_at);
