-- Development/disposable delivery only; Publish owns production schema changes.
-- These are generated read keys, not a second identity or relationship authority.
-- Preserve the prior coverage expressions exactly, including legal suffixes.
ALTER TABLE businesses
  ADD COLUMN coverage_name_key text GENERATED ALWAYS AS (
    btrim(regexp_replace(regexp_replace(lower(regexp_replace(coalesce(canonical_name,''),
    '[^a-zA-Z0-9]+',' ','g')),'\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M',
    ' ','g'),'\s+',' ','g'))) STORED,
  ADD COLUMN coverage_normalized_name_key text GENERATED ALWAYS AS (
    btrim(regexp_replace(regexp_replace(lower(regexp_replace(coalesce(normalized_name,''),
    '[^a-zA-Z0-9]+',' ','g')),'\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M',
    ' ','g'),'\s+',' ','g'))) STORED,
  ADD COLUMN coverage_domain_key text GENERATED ALWAYS AS (
    lower(regexp_replace(regexp_replace(regexp_replace(trim(website_domain),
    '^www[.]','','i'),':[0-9]+$',''),'[.]$',''))) STORED,
  ADD COLUMN coverage_count_domain_key text GENERATED ALWAYS AS (
    lower(regexp_replace(trim(website_domain),'^www[.]','','i'))) STORED,
  ADD COLUMN coverage_phone_key text GENERATED ALWAYS AS (
    regexp_replace(coalesce(main_phone,''),'[^0-9]','','g')) STORED,
  ADD COLUMN coverage_address_key text GENERATED ALWAYS AS (
    lower(regexp_replace(coalesce(street_address,'') || coalesce(city,'') || coalesce(state,''),
    '[^a-zA-Z0-9]','','g'))) STORED,
  ADD COLUMN coverage_street_key text GENERATED ALWAYS AS (
    lower(regexp_replace(coalesce(street_address,''),'[^a-zA-Z0-9]','','g'))) STORED;
--> statement-breakpoint
ALTER TABLE sunbiz_entities
  ADD COLUMN coverage_domain_key text GENERATED ALWAYS AS (
    lower(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    split_part(regexp_replace(trim(coalesce(website,'')),'^[a-zA-Z]+://','','i'),'/',1),
    '[?#].*$',''),'^www[.]','','i'),':[0-9]+$',''),'[.]$',''))) STORED,
  ADD COLUMN coverage_phone_key text GENERATED ALWAYS AS (
    regexp_replace(coalesce(phone,''),'[^0-9]','','g')) STORED,
  ADD COLUMN coverage_owner_phone_key text GENERATED ALWAYS AS (
    regexp_replace(coalesce(owner_phone,''),'[^0-9]','','g')) STORED,
  ADD COLUMN coverage_address_key text GENERATED ALWAYS AS (
    lower(regexp_replace(coalesce(principal_address,'') || coalesce(principal_city,'') ||
    coalesce(principal_state,''),'[^a-zA-Z0-9]','','g'))) STORED,
  ADD COLUMN coverage_street_key text GENERATED ALWAYS AS (
    lower(regexp_replace(coalesce(principal_address,''),'[^a-zA-Z0-9]','','g'))) STORED;
--> statement-breakpoint
CREATE INDEX businesses_coverage_name_key_idx ON businesses(coverage_name_key);
--> statement-breakpoint
CREATE INDEX businesses_coverage_normalized_name_key_idx ON businesses(coverage_normalized_name_key);
--> statement-breakpoint
CREATE INDEX businesses_coverage_domain_key_idx ON businesses(coverage_domain_key);
--> statement-breakpoint
CREATE INDEX businesses_coverage_count_domain_key_idx ON businesses(coverage_count_domain_key) WHERE record_class='canonical';
--> statement-breakpoint
CREATE INDEX businesses_coverage_phone_key_idx ON businesses(coverage_phone_key);
--> statement-breakpoint
CREATE INDEX businesses_coverage_address_key_idx ON businesses(coverage_address_key);
--> statement-breakpoint
CREATE INDEX businesses_coverage_street_key_idx ON businesses(coverage_street_key);
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_domain_key_idx ON sunbiz_entities(coverage_domain_key);
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_phone_key_idx ON sunbiz_entities(coverage_phone_key);
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_owner_phone_key_idx ON sunbiz_entities(coverage_owner_phone_key);
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_address_key_idx ON sunbiz_entities(coverage_address_key);
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_street_key_idx ON sunbiz_entities(coverage_street_key);
