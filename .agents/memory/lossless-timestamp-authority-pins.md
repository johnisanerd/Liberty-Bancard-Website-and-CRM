---
name: Lossless timestamp authority pins
description: Preserve PostgreSQL microseconds across approval checks and timestamp-based pagination.
---

Treat an exact PostgreSQL timestamp authority pin as an opaque, lossless string. Compare it in PostgreSQL and persist the locked row's authoritative timestamp, not a JavaScript Date round-trip.

**Why:** JavaScript Date truncates PostgreSQL microseconds to milliseconds. A review API can appear to approve the current row while storing a rounded timestamp that immediately fails the downstream exact SQL approval pin.

**How to apply:** For timestamp-based review CAS, return a lossless database representation, pass it through unchanged in the client, and perform exact SQL equality under the row lock. Reject stale or rounded tokens rather than silently widening equality.

Preserve the same native precision in timestamp-based keyset cursors.

**Why:** Rounding the last row's timestamp down makes that row satisfy the next
page's greater-than predicate again, even when the cursor also carries its ID.
This can repeat pages indefinitely without throwing an error.

**How to apply:** Pass the database timestamp unchanged into the next-page
predicate; test several rows sharing a microsecond timestamp through an
authenticated request, including the final empty page.

For a date-only editor over an existing deadline instant, omit the deadline
field when its displayed day is unchanged. Only an explicit day change or clear
should replace the recorded instant; use the existing local-date validator and
label the editor's timezone.

**Why:** A subject-only edit can otherwise shift the stored deadline through
UTC/local reconstruction or discard native precision even though the user did
not change the date.

**How to apply:** Keep instant and date-only-carrier contracts distinct. Test
unchanged edits against exact PostgreSQL timestamp readback as well as a
non-UTC mounted editor; a JavaScript Date equality check is insufficient.

Read-only snapshot audits must use the same timestamp representation as the
snapshot producer, not merely another lossless rendering of the instant.

**Why:** Comparing PostgreSQL `timestamp::text` against a snapshot produced by
`to_jsonb(row)->>'updated_at'` falsely reported registry revision drift because
their date/time separators and timezone renderings differ.

**How to apply:** Reuse the producer's extractor for each pinned field.
Distinguish formatting differences, actual revision changes and complete
candidate-set requalification; matching recorded pins proves only the first
two have been checked.