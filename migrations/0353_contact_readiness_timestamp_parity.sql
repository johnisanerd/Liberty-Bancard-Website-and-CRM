-- Repair fresh-snapshot drift from 0057. Existing production columns already
-- use timestamptz; leave them untouched. The canonical 0109 empty-DB snapshot
-- used timestamp without time zone instead. Its recorded values are UTC.
-- Preserve instants and microseconds; never rewrite source timestamps.
DO $parity$
DECLARE field text; native_type oid;
BEGIN
  FOREACH field IN ARRAY ARRAY['readiness_updated_at','last_meaningful_contact_mutation_at'] LOOP
    SELECT atttypid INTO native_type FROM pg_attribute
      WHERE attrelid='public.contacts'::regclass AND attname=field AND NOT attisdropped;
    IF native_type='timestamp without time zone'::regtype THEN
      EXECUTE format('ALTER TABLE public.contacts ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',field,field);
    ELSIF native_type IS DISTINCT FROM 'timestamp with time zone'::regtype THEN
      RAISE EXCEPTION 'CONTACT_READINESS_TIMESTAMP_TYPE_DRIFT';
    END IF;
  END LOOP;
END $parity$;
