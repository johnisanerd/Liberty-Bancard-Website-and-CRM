-- Blank-email correction requires a genuine absence value. Preserve the
-- unarchived-email unique index and all foreign keys; only missing mailboxes
-- become representable as NULL. Publish owns production schema delivery.
ALTER TABLE contacts ALTER COLUMN email DROP NOT NULL;
