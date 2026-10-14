---
name: Upload boundary verification
description: Certify real multipart admission separately from parser and native-persistence helpers.
---

Test the actual multipart admission policy with the original attachment bytes,
not just the workbook reader or materialization helper.

**Why:** Native workbook certificates passed while a shared CSV/ZIP admission
policy rejected XLSX before the intake handler ran. Parser success did not prove
that the production upload could reach it.

**How to apply:** Keep spreadsheet admission scoped to routes that own workbook
support. Verify the actual MIME/extension pair, original-byte hash, parser row
and coordinate counts, and rejected content/type behavior; preserve unrelated
CSV-only and CSV/ZIP boundaries. Never rename or convert an attachment merely
to evade admission, because that breaks its original-byte execution identity.

## Production gateway response loss

Treat a production gateway timeout as an unknown request outcome, not evidence
that no import occurred. Reconcile the exact file hash, durable execution,
retained original-row count and current primary ledger before any resend.

**Why:** The production proxy returned HTTP 504 after approximately 300 seconds
while the original execution and rows had committed and processing continued.
The live processor subsequently lost its own five-minute lease; the existing
resumer reclaimed the same execution, rather than requiring another upload.

**How to apply:** Keep transport acceptance separate from native fulfillment.
Do not turn an accepted/processing response or immutable row accounting into
completion. Slow native row work must remain covered by actual token-fenced
renewal; a batch count alone is not a duration guarantee.
