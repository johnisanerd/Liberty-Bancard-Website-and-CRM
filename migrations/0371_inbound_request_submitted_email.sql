-- Immutable snapshot of the mailbox a request was submitted with, captured when the occurrence is first linked to its
-- contact. Acknowledgements bind to this value, never to a later CRM edit. Existing rows stay NULL (never emailed).
ALTER TABLE inbound_requests ADD COLUMN IF NOT EXISTS submitted_email text;
