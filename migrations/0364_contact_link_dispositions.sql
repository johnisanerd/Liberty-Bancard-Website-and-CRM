-- Durable per-contact business-assignment disposition. One current row per contact
-- recording WHAT evidence was evaluated (fingerprint + references), under which rule
-- version, the outcome, the specific reason and the automatic retry trigger. This is
-- observation only: it never grants relationship authority (the audited relationship
-- writer still performs every link) and stores no names, emails, phones or payloads.
-- Publish owns production DDL.
CREATE TABLE IF NOT EXISTS contact_business_link_dispositions (
  contact_id integer PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  rule_version text NOT NULL,
  evidence_fingerprint text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_retry_trigger text,
  next_retry_at timestamptz,
  business_id integer REFERENCES businesses(id) ON DELETE SET NULL,
  run_id text,
  evaluation_count integer NOT NULL DEFAULT 1,
  first_evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_business_link_dispositions_outcome_chk CHECK (outcome IN
    ('linked','unsupported','awaiting_review','retryable')),
  CONSTRAINT contact_business_link_dispositions_retry_chk CHECK (
    (outcome = 'linked' AND next_retry_trigger IS NULL) OR
    (outcome <> 'linked' AND next_retry_trigger IS NOT NULL)),
  CONSTRAINT contact_business_link_dispositions_retryable_at_chk CHECK (
    outcome <> 'retryable' OR next_retry_at IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_business_link_dispositions_outcome_idx
  ON contact_business_link_dispositions (outcome, reason_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_business_link_dispositions_retry_idx
  ON contact_business_link_dispositions (next_retry_at) WHERE outcome = 'retryable';
--> statement-breakpoint
-- Dated acceptance population: the exact set of contacts that must each carry an
-- evidence-backed disposition. New intake after capture is reported separately.
CREATE TABLE IF NOT EXISTS contact_link_acceptance_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  rule_version text NOT NULL,
  contact_count integer NOT NULL,
  population jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contact_link_acceptance_members (
  baseline_id uuid NOT NULL REFERENCES contact_link_acceptance_baselines(id) ON DELETE CASCADE,
  contact_id integer NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  record_class text NOT NULL,
  linked_at_capture boolean NOT NULL,
  PRIMARY KEY (baseline_id, contact_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_link_acceptance_members_contact_idx
  ON contact_link_acceptance_members (contact_id);
