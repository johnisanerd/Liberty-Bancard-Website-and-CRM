-- Development/native delivery only. Production installation requires the
-- separately authorized supported schema/owner path, never runtime DDL.
-- Restore the original exact body; do not broaden the verifier allowlist.
CREATE OR REPLACE FUNCTION public.cro03_immutable_row_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cro03_source_observation_immutable ON public.cro03_source_observations;
CREATE TRIGGER cro03_source_observation_immutable
  BEFORE UPDATE OR DELETE ON public.cro03_source_observations
  FOR EACH ROW EXECUTE FUNCTION public.cro03_immutable_row_guard();
--> statement-breakpoint
DO $verify$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.cro03_source_observations'::regclass
      AND t.tgname='cro03_source_observation_immutable' AND t.tgtype=27
      AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL
      AND p.proname='cro03_immutable_row_guard' AND p.pronamespace='public'::regnamespace
      AND md5(p.prosrc)='f0c933f2b332d19ec7d51866e2ad5a7b') THEN
    RAISE EXCEPTION 'PROVIDER_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING';
  END IF;
END $verify$;
