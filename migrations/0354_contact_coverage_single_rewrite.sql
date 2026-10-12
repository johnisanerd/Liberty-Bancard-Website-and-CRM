-- Publish serializes scalar generated-column additions separately. Pack only
-- derived read keys so each populated table needs one rewrite, not one per key.
-- Historical migration 0350 remains unchanged. No source data is removed.
ALTER TABLE businesses ADD COLUMN coverage_keys text[] GENERATED ALWAYS AS (ARRAY[
  btrim(regexp_replace(regexp_replace(lower(regexp_replace(coalesce(canonical_name,''),
    '[^a-zA-Z0-9]+',' ','g')),'\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M',
    ' ','g'),'\s+',' ','g')),
  btrim(regexp_replace(regexp_replace(lower(regexp_replace(coalesce(normalized_name,''),
    '[^a-zA-Z0-9]+',' ','g')),'\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\M',
    ' ','g'),'\s+',' ','g')),
  lower(regexp_replace(regexp_replace(regexp_replace(trim(website_domain),
    '^www[.]','','i'),':[0-9]+$',''),'[.]$','')),
  lower(regexp_replace(trim(website_domain),'^www[.]','','i')),
  regexp_replace(coalesce(main_phone,''),'[^0-9]','','g'),
  lower(regexp_replace(coalesce(street_address,'') || coalesce(city,'') || coalesce(state,''),
    '[^a-zA-Z0-9]','','g')),
  lower(regexp_replace(coalesce(street_address,''),'[^a-zA-Z0-9]','','g'))
]) STORED;
--> statement-breakpoint
ALTER TABLE sunbiz_entities ADD COLUMN coverage_keys text[] GENERATED ALWAYS AS (ARRAY[
  lower(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    split_part(regexp_replace(trim(coalesce(website,'')),'^[a-zA-Z]+://','','i'),'/',1),
    '[?#].*$',''),'^www[.]','','i'),':[0-9]+$',''),'[.]$','')),
  regexp_replace(coalesce(phone,''),'[^0-9]','','g'),
  regexp_replace(coalesce(owner_phone,''),'[^0-9]','','g'),
  lower(regexp_replace(coalesce(principal_address,'') || coalesce(principal_city,'') ||
    coalesce(principal_state,''),'[^a-zA-Z0-9]','','g')),
  lower(regexp_replace(coalesce(principal_address,''),'[^a-zA-Z0-9]','','g'))
]) STORED;
--> statement-breakpoint
DO $parity$ BEGIN
  IF EXISTS(SELECT 1 FROM businesses WHERE coverage_keys IS DISTINCT FROM ARRAY[
    coverage_name_key,coverage_normalized_name_key,coverage_domain_key,coverage_count_domain_key,
    coverage_phone_key,coverage_address_key,coverage_street_key]) THEN
    RAISE EXCEPTION 'BUSINESS_COVERAGE_KEY_PARITY_FAILED';
  END IF;
  IF EXISTS(SELECT 1 FROM sunbiz_entities WHERE coverage_keys IS DISTINCT FROM ARRAY[
    coverage_domain_key,coverage_phone_key,coverage_owner_phone_key,coverage_address_key,coverage_street_key]) THEN
    RAISE EXCEPTION 'SOURCE_COVERAGE_KEY_PARITY_FAILED';
  END IF;
END $parity$;
--> statement-breakpoint
-- Dropping generated helpers also removes their old indexes. Base identity,
-- contact-identity NFKD keys, FKs, source evidence and relationship guards stay.
ALTER TABLE businesses
  DROP COLUMN coverage_name_key, DROP COLUMN coverage_normalized_name_key,
  DROP COLUMN coverage_domain_key, DROP COLUMN coverage_count_domain_key,
  DROP COLUMN coverage_phone_key, DROP COLUMN coverage_address_key, DROP COLUMN coverage_street_key;
--> statement-breakpoint
ALTER TABLE sunbiz_entities
  DROP COLUMN coverage_domain_key, DROP COLUMN coverage_phone_key,
  DROP COLUMN coverage_owner_phone_key, DROP COLUMN coverage_address_key, DROP COLUMN coverage_street_key;
--> statement-breakpoint
CREATE INDEX businesses_coverage_name_key_idx ON businesses ((coverage_keys[1]));
--> statement-breakpoint
CREATE INDEX businesses_coverage_normalized_name_key_idx ON businesses ((coverage_keys[2]));
--> statement-breakpoint
CREATE INDEX businesses_coverage_domain_key_idx ON businesses ((coverage_keys[3]));
--> statement-breakpoint
CREATE INDEX businesses_coverage_count_domain_key_idx ON businesses ((coverage_keys[4])) WHERE record_class='canonical';
--> statement-breakpoint
CREATE INDEX businesses_coverage_phone_key_idx ON businesses ((coverage_keys[5]));
--> statement-breakpoint
CREATE INDEX businesses_coverage_address_key_idx ON businesses ((coverage_keys[6]));
--> statement-breakpoint
CREATE INDEX businesses_coverage_street_key_idx ON businesses ((coverage_keys[7]));
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_domain_key_idx ON sunbiz_entities ((coverage_keys[1]));
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_phone_key_idx ON sunbiz_entities ((coverage_keys[2]));
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_owner_phone_key_idx ON sunbiz_entities ((coverage_keys[3]));
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_address_key_idx ON sunbiz_entities ((coverage_keys[4]));
--> statement-breakpoint
CREATE INDEX sunbiz_coverage_street_key_idx ON sunbiz_entities ((coverage_keys[5]));
