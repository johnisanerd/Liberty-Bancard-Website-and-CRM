-- A website domain can identify a brand, not a unique operating location.
-- Exact source/place identity, native relationship guards and resolver locks
-- remain authoritative. This migration preserves every business and link.
DO $contract$
BEGIN
  IF to_regclass('public.businesses_website_domain_unique_idx') IS NOT NULL
     AND pg_get_indexdef(to_regclass('public.businesses_website_domain_unique_idx'))
       <> 'CREATE UNIQUE INDEX businesses_website_domain_unique_idx ON public.businesses USING btree (website_domain) WHERE (website_domain IS NOT NULL)' THEN
    RAISE EXCEPTION 'BUSINESS_SHARED_DOMAIN_UPSTREAM_INDEX_DRIFT';
  END IF;
END $contract$;
--> statement-breakpoint
DROP INDEX IF EXISTS public.businesses_website_domain_unique_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS businesses_website_domain_idx ON public.businesses (website_domain);
