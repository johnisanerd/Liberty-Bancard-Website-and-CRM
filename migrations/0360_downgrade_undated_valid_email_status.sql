-- Legacy cleanup: contacts marked email_status='valid' with no validation date
-- have no provider evidence behind them (no token hash, no validation intent,
-- no ZeroBounce record). Return them to 'unvalidated' so every
-- "needs validation" path picks them up. Idempotent; touches no dated rows.
UPDATE contacts
   SET email_status = 'unvalidated'
 WHERE email_status = 'valid'
   AND email_validation_updated_at IS NULL;
