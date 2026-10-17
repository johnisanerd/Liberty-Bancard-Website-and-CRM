---
name: Contact business-link dispositions and legacy original-row adapter
description: Durable per-contact link outcome table, dated acceptance baseline, and why legacy provider rows append a derived source event
---
- `contact_business_link_dispositions` (one row per contact) is observation only; only the audited relationship writer links. Outcomes: linked / unsupported / awaiting_review / retryable, each with reason code, rule version, evidence fingerprint, retry trigger. Temporary failures are retryable (auto retry time); awaiting_review only for concrete conflicts.
- Rule change = new `PROGRAM_RULE_VERSION` string; the worker resets its cursor and re-evaluates earlier holds through the normal bounded pages, preserving run id, counters, operator hold.
- Acceptance baseline is captured once (all active non-test contacts, production vs other non-test reported separately); new intake is reported apart from it.
- Legacy provider imports without `businessEvidence`: adapter reads the hash-verified ORIGINAL retained row (never the contact's own fields). **Why:** the pinned native relationship function (md5-fingerprinted) re-proves corroboration only from a contact source event whose `metadata.businessEvidence` equals the source link's proof, so the materializer appends a derived event (coordinates in metadata only, not import_execution_id/row columns, so no second row receipt). Changing the native function would need a new migration and manifest hash churn.
- Existing source events are immutable (update/delete guard): cert fixtures must insert the final values, not patch them.
- Contact commit trigger takes one advisory lock per inserted row; bulk fixture inserts above ~1000 rows per statement hit "out of shared memory". Chunk them.
- Test-class contacts still get dispositions rows from the loader; they are excluded from baseline and reports.
