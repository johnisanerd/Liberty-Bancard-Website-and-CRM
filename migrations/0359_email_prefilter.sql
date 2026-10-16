-- Free email prefilter results. Publish owns production DDL.
CREATE TABLE IF NOT EXISTS email_domain_checks (
  domain text PRIMARY KEY,
  status text NOT NULL,
  mx_host_count integer NOT NULL DEFAULT 0,
  detail text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contact_email_prefilter (
  contact_id integer PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  email_token_hash text NOT NULL,
  domain text,
  status text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_email_prefilter_status_idx ON contact_email_prefilter (status);
