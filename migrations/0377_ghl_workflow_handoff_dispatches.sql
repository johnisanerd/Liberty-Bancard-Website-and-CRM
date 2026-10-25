-- Durable dispatch ledger for the provider workflow-enrollment handoff. The provider endpoint is not documented as
-- idempotent, so a handoff is recorded as 'started' BEFORE the request. A later attempt with the same identity never
-- re-sends over a 'started' (outcome unknown) or 'accepted' row; only a definite refusal ('refused') may be re-sent.
-- Additive: 0374-0376 are applied and are not edited.
CREATE TABLE IF NOT EXISTS ghl_workflow_handoff_dispatches (
  idempotency_key text PRIMARY KEY,
  workflow_key text NOT NULL,
  ghl_contact_id text NOT NULL,
  state text NOT NULL DEFAULT 'started',
  attempt_count integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT ghl_workflow_handoff_dispatches_state_chk CHECK (state IN ('started', 'accepted', 'refused'))
);
