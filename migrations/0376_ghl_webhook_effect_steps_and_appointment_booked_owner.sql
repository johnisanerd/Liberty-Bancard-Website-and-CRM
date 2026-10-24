-- Durable per-effect ledger for GHL webhook handlers. A step is claimed, run and completed under the receipt's claim;
-- local database effects complete the step in the SAME transaction as the effect, so a retry never repeats a
-- completed effect and a lost settlement cannot cause a duplicate. 0374/0375 are applied and are not edited.
CREATE TABLE IF NOT EXISTS ghl_webhook_effect_steps (
  receipt_id uuid NOT NULL REFERENCES ghl_provider_event_receipts(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  state text NOT NULL DEFAULT 'running',
  step_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 1,
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ghl_webhook_effect_steps_pk PRIMARY KEY (receipt_id, step_key),
  CONSTRAINT ghl_webhook_effect_steps_state_chk CHECK (state IN ('running', 'done'))
);
--> statement-breakpoint
ALTER TABLE ghl_provider_event_receipts ADD COLUMN IF NOT EXISTS collision_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ghl_provider_event_receipts ADD COLUMN IF NOT EXISTS last_collision_fingerprint text;
--> statement-breakpoint
ALTER TABLE ghl_provider_event_receipts ADD COLUMN IF NOT EXISTS last_collision_at timestamptz;
--> statement-breakpoint
-- The one-time booked effect for an appointment has its own identity, independent of the latest lifecycle state.
ALTER TABLE ghl_appointment_state ADD COLUMN IF NOT EXISTS booked_effect_receipt_id uuid;
--> statement-breakpoint
UPDATE ghl_appointment_state SET booked_effect_receipt_id = last_receipt_id
 WHERE status = 'booked' AND booked_effect_receipt_id IS NULL AND last_receipt_id IS NOT NULL;
