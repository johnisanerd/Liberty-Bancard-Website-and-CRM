---
name: Partner response allowlist and mailbox lock order
description: Partner HTTP responses use an explicit allowlist DTO; contact email mutations take the mailbox lock first.
---
Partner HTTP responses are built from the explicit allowlist in shared/partner-response.ts, never by spreading a storage row (partners table stores password hash, reset and invite tokens).
**Why:** a published route returned credential fields from raw storage rows; blacklists miss future columns.
**How to apply:** any new partner route serializes through server/utils/partner-response.ts; error JSON must not echo DB error text; internal auth storage still reads full rows.

Every contact email mutation (writeContact, storage create/update, Data Health apply) takes `contact-mailbox:<email>` advisory lock first, sorted when several, before row/graph locks.
**Why:** otherwise a generic updater can change a mailbox under a reconcile that already checked uniqueness.
