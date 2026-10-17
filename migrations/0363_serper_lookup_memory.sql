-- Serper lookup memory: one row per business and lookup purpose recording the last
-- lookup outcome, the input fingerprint and matcher rule version it was judged under,
-- and an expiry. A selector skips a business only while the row is unexpired AND the
-- fingerprint and rule version still match, so changed inputs or a corrected matcher
-- reopen the business. The same row carries a short-lived claim so two workers cannot
-- buy the same lookup. No provider payloads, names or addresses are stored.
-- Publish owns production DDL.
CREATE TABLE IF NOT EXISTS sfp_serper_lookup_memory (
  business_id integer NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  requested_evidence text NOT NULL,
  outcome_class text,
  rule_version integer,
  input_fingerprint text,
  reason_summary text,
  requests_used integer NOT NULL DEFAULT 0,
  observed_at timestamptz,
  expires_at timestamptz,
  claim_token uuid,
  claim_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, purpose),
  CONSTRAINT sfp_serper_lookup_memory_outcome_chk CHECK (outcome_class IS NULL OR outcome_class IN
    ('no_match','rejected','ambiguous','accepted_no_website','provider_failure')),
  CONSTRAINT sfp_serper_lookup_memory_recorded_chk CHECK (outcome_class IS NULL OR
    (rule_version IS NOT NULL AND input_fingerprint IS NOT NULL AND observed_at IS NOT NULL AND expires_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sfp_serper_lookup_memory_expiry_idx ON sfp_serper_lookup_memory (expires_at);
--> statement-breakpoint
-- Per-request accounting: credits the provider reported charging, and the matcher rule
-- version the request was judged under. NULL reported_credits means the provider did not
-- report one (never assume a per-call factor).
ALTER TABLE serper_lookup_attempts ADD COLUMN IF NOT EXISTS reported_credits integer;
--> statement-breakpoint
ALTER TABLE serper_lookup_attempts ADD COLUMN IF NOT EXISTS rule_version integer;
