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
