---
name: Mailbox lock before row lock and amount contract
description: Email-changing paths must take contact-mailbox advisory locks before contact row locks; shared stored-amount pattern avoids cooked-backslash regex bugs.
---
Every contact email change (updateContactLocalFirst, storage.updateContact, incoming GHL apply, Data Health apply, writeContact) takes sorted `contact-mailbox:<lower-trim email>` locks first, then row locks. Read the current email without a lock, lock both addresses, then re-read and lock the new address if it moved.

**Why:** a mailbox writer that locks the row first can interleave with a reconcile that decided on the old mailbox state.
**How to apply:** new email-writing paths use `lockContactMailboxes` before any `FOR UPDATE`; prove it with a holder connection plus a NOWAIT row probe.

Stored deal amounts: use `shared/amount-contract.ts` and `server/utils/amount-sql.ts`. In Drizzle/JS template strings a single backslash is cooked away, so `\.` becomes a wildcard dot; use `[.]`. Unknown amounts surface as partial/unavailable, never zero.

## Contact-count surfaces share one population reader
Dashboard stats, People facets and the Today lifecycle chart must derive from `contactReadPredicate` (readers in revenue-read-authority). A hand-written `record_class='production'` filter drifts by the synthetic-QA exclusion and agent ownership branch. **Why:** a one-contact production mismatch appeared when the lifecycle route kept its own filter. **How to apply:** any new contact count/chart goes through a shared reader; unavailable reads stay 503/null, never zero.
