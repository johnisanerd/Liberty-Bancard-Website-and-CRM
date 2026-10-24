-- #2105 R1/R2: durable per-operation dispatch records (appended before each provider mutation) and removal of
-- creation-time authority from legacy rows. Additive; nothing is deleted. Legacy open rows that were classified as current
-- intake only because they were created after the policy cutoff are returned to the historical hold unless the contact has
-- real current-intake evidence (a website/partner/merchant/manual source event on or after the cutoff).
CREATE TABLE IF NOT EXISTS ghl_projection_operations (
  id uuid PRIMARY KEY,
  projection_id uuid NOT NULL,
  contact_id integer NOT NULL,
  claim_token uuid,
  generation bigint,
  operation_class text NOT NULL,
  method text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  http_status integer,
  identity jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  settled_at timestamp,
  CONSTRAINT ghl_projection_operations_state_chk CHECK (state IN ('reserved', 'ok', 'http_error', 'ambiguous'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ghl_projection_operations_projection_idx ON ghl_projection_operations (projection_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ghl_projection_operations_contact_idx ON ghl_projection_operations (contact_id, created_at);
--> statement-breakpoint
UPDATE contact_provider_projections p
SET export_disposition = 'historical_hold',
    export_reason = 'no_current_intake_evidence',
    updated_at = now()
WHERE p.provider = 'ghl'
  AND p.state IN ('pending', 'retry')
  AND p.export_disposition = 'current_intake'
  AND p.source_kind = 'legacy'
  AND p.dispatch_count = 0
  AND NOT EXISTS (
    SELECT 1 FROM contact_source_events e
    WHERE e.contact_id = p.contact_id
      AND e.source_category IN ('website_form', 'partner_referral', 'merchant_application', 'manual_crm')
      AND e.created_at >= (COALESCE((SELECT value->>'currentIntakeSince' FROM system_settings WHERE key = 'ghl_export_policy'), '2026-10-23T04:00:00Z')::timestamptz AT TIME ZONE 'UTC'));
--> statement-breakpoint
ALTER TABLE ghl_provider_event_receipts ADD COLUMN IF NOT EXISTS payload_fingerprint text;
--> statement-breakpoint
ALTER TABLE ghl_provider_event_receipts ADD COLUMN IF NOT EXISTS effect_applied_at timestamp;
