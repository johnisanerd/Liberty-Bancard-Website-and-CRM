-- Serper contact-page stage: one durable row per business lookup attempt. The row is the claim (one
-- active claim per business), the idempotency identity (operation_key), the retained provider evidence
-- (query pin, result URLs, returned field names, retrieval time), the request/credit accounting
-- (requests_used vs reported_credits; NULL credits means the provider did not report any), and the
-- remembered outcome (expires_at) so unchanged inputs are never bought twice. No page bodies, snippets,
-- email addresses or personal names are stored; staged addresses live only in free_discovery_candidates.
-- Publish owns production DDL.
CREATE TABLE IF NOT EXISTS serper_contact_page_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id integer NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  domain text NOT NULL,
  input_fingerprint text NOT NULL,
  rule_version integer NOT NULL,
  status text NOT NULL DEFAULT 'claimed',
  claim_token uuid NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  endpoint text NOT NULL DEFAULT '/search',
  query_text text,
  requested_at timestamptz,
  retrieved_at timestamptz,
  http_status integer,
  requests_used integer NOT NULL DEFAULT 0,
  reported_credits integer,
  returned_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  pages_read jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_class text,
  candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  generation_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT serper_contact_page_lookups_status_chk CHECK (status IN ('claimed','completed','provider_failure','abandoned')),
  CONSTRAINT serper_contact_page_lookups_outcome_chk CHECK (outcome_class IS NULL OR outcome_class IN
    ('candidate_staged','no_result','no_first_party_url','pages_unreadable','pages_no_email','no_role_email','provider_failure')),
  CONSTRAINT serper_contact_page_lookups_done_chk CHECK (status = 'claimed' OR (outcome_class IS NOT NULL AND completed_at IS NOT NULL AND expires_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS serper_contact_page_lookups_operation_key_uidx ON serper_contact_page_lookups (operation_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS serper_contact_page_lookups_one_claim_uidx ON serper_contact_page_lookups (business_id) WHERE status = 'claimed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS serper_contact_page_lookups_business_idx ON serper_contact_page_lookups (business_id, created_at DESC);
