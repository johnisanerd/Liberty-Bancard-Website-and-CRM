-- #2105 GHL projection authority: one open desired projection per contact and provider, explicit generation
-- compare-and-swap, persisted export disposition, provider dispatch evidence and per-component receipts, plus durable
-- provider-event receipts and ordered appointment state. Everything is additive; nothing is deleted.
-- Order matters: columns, then audited duplicate disposition (superseded evidence), then the partial unique index.
-- The unique index is also scoped to authority_version IS NOT NULL so a schema-only delivery (no data steps) can never
-- fail on legacy duplicates; legacy rows are adopted by the idempotent convergence the worker runs.
ALTER TABLE contact_provider_projections
  ADD COLUMN IF NOT EXISTS authority_version integer,
  ADD COLUMN IF NOT EXISTS desired_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS claimed_generation bigint,
  ADD COLUMN IF NOT EXISTS settled_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS export_disposition text NOT NULL DEFAULT 'unclassified',
  ADD COLUMN IF NOT EXISTS export_reason text,
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS dispatch_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deferral_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispatch_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS dispatch_operation_id uuid,
  ADD COLUMN IF NOT EXISTS last_dispatch_at timestamp,
  ADD COLUMN IF NOT EXISTS component_receipts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS superseded_by uuid,
  ADD COLUMN IF NOT EXISTS superseded_at timestamp;
--> statement-breakpoint
INSERT INTO system_settings (key, value, updated_at)
VALUES ('ghl_export_policy', '{"version":1,"currentIntakeSince":"2026-10-23T04:00:00Z","basis":"owner approved GHL writes in chat on 2026-10-23; earlier open rows are historical bulk held until an explicit export scope","legacyPhases":{"deals":false,"tasks":false,"companies":false}}'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
UPDATE contact_provider_projections p
SET export_disposition = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'local_only'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'test_local_only'
      WHEN p.state IN ('pending', 'retry', 'processing')
        AND p.created_at >= (COALESCE((SELECT value->>'currentIntakeSince' FROM system_settings WHERE key = 'ghl_export_policy'), '2026-10-23T04:00:00Z')::timestamptz AT TIME ZONE 'UTC')
        THEN 'current_intake'
      WHEN p.state IN ('pending', 'retry', 'processing') THEN 'historical_hold'
      ELSE 'closed'
    END,
    export_reason = CASE
      WHEN p.terminal_reason = 'pipeline_local_only' THEN 'pipeline_local_only_fence'
      WHEN c.record_class IN ('test', 'demo', 'synthetic') THEN 'record_class_' || c.record_class
      WHEN p.state IN ('pending', 'retry', 'processing')
        AND p.created_at >= (COALESCE((SELECT value->>'currentIntakeSince' FROM system_settings WHERE key = 'ghl_export_policy'), '2026-10-23T04:00:00Z')::timestamptz AT TIME ZONE 'UTC')
        THEN 'created_on_or_after_policy_cutoff'
      WHEN p.state IN ('pending', 'retry', 'processing') THEN 'created_before_policy_cutoff_historical_bulk'
      ELSE 'not_open_work'
    END,
    source_kind = COALESCE(p.source_kind, 'legacy')
FROM contacts c
WHERE c.id = p.contact_id AND p.export_disposition = 'unclassified';
--> statement-breakpoint
WITH ranked AS (
  SELECT id,
         row_number() OVER w AS rn,
         first_value(id) OVER w AS survivor
  FROM contact_provider_projections
  WHERE provider = 'ghl' AND state IN ('pending', 'retry', 'processing')
  WINDOW w AS (PARTITION BY contact_id, provider
               ORDER BY (authority_version IS NOT NULL) DESC, (state = 'processing' AND lease_expires_at > now()) DESC, created_at DESC, id DESC)
)
UPDATE contact_provider_projections p
SET state = CASE WHEN r.rn = 1 THEN p.state ELSE 'superseded' END,
    authority_version = CASE WHEN r.rn = 1 THEN 1 ELSE p.authority_version END,
    terminal_reason = CASE WHEN r.rn = 1 THEN p.terminal_reason ELSE 'superseded_duplicate' END,
    superseded_by = CASE WHEN r.rn = 1 THEN NULL ELSE r.survivor END,
    superseded_at = CASE WHEN r.rn = 1 THEN NULL ELSE now() END,
    claim_token = CASE WHEN r.rn = 1 THEN p.claim_token ELSE NULL END,
    lease_expires_at = CASE WHEN r.rn = 1 THEN p.lease_expires_at ELSE NULL END,
    completed_at = CASE WHEN r.rn = 1 THEN p.completed_at ELSE now() END,
    updated_at = now()
FROM ranked r
WHERE p.id = r.id AND (r.rn > 1 OR p.authority_version IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contact_provider_projections_open_contact_uidx
  ON contact_provider_projections (contact_id, provider)
  WHERE state IN ('pending', 'retry', 'processing') AND authority_version IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_provider_projections_eligible_idx
  ON contact_provider_projections (provider, next_attempt_at, created_at)
  WHERE state IN ('pending', 'retry') AND export_disposition IN ('current_intake', 'linked_update');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_provider_projections_processing_lease_idx
  ON contact_provider_projections (provider, lease_expires_at)
  WHERE state = 'processing';
--> statement-breakpoint
-- Durable provider-event receipts: received -> claimed -> applied | failed. A retry after a handler failure
-- reclaims the same receipt; an applied receipt is the only thing that makes a duplicate harmless.
CREATE TABLE IF NOT EXISTS ghl_provider_event_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  event_type text NOT NULL,
  provider text NOT NULL DEFAULT 'ghl',
  state text NOT NULL DEFAULT 'received',
  claim_token uuid,
  lease_expires_at timestamp,
  delivery_count integer NOT NULL DEFAULT 1,
  attempt_count integer NOT NULL DEFAULT 0,
  location_id text,
  calendar_id text,
  remote_event_id text,
  appointment_id text,
  ghl_contact_id text,
  event_at timestamptz,
  received_at timestamp NOT NULL DEFAULT now(),
  claimed_at timestamp,
  applied_at timestamp,
  failed_at timestamp,
  last_error text,
  CONSTRAINT ghl_provider_event_receipts_state_chk CHECK (state IN ('received', 'claimed', 'applied', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ghl_provider_event_receipts_key_uidx ON ghl_provider_event_receipts (provider, event_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ghl_provider_event_receipts_open_idx ON ghl_provider_event_receipts (state, received_at) WHERE state IN ('received', 'claimed', 'failed');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ghl_appointment_state (
  appointment_id text PRIMARY KEY,
  ghl_contact_id text,
  calendar_id text,
  location_id text,
  status text NOT NULL,
  start_time timestamptz,
  end_time timestamptz,
  last_event_at timestamptz NOT NULL,
  last_receipt_id uuid,
  reschedule_count integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT ghl_appointment_state_status_chk CHECK (status IN ('booked', 'rescheduled', 'updated', 'showed', 'canceled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ghl_appointment_state_contact_idx ON ghl_appointment_state (ghl_contact_id);
