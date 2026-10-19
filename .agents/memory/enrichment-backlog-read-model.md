---
name: Unified enrichment backlog read model
description: Lessons from building the cross-family backlog view and priority action in Canonical Enrichment
---
- Every blocker count must mirror the worker's own gate; a hand-rolled copy gave bogus "no active sequence" holds until it was computed once per vertical and checked against production.
- Territory/geography is the dominant blocker for already-bound contacts; legacy-only uploaded contacts (no independent business evidence) are the largest held group. Do not force links; the broad contact-to-business assignment task owns that.
- Preparation advances a pending recipient only when it revisits the contact. The keyset cursors take days to wrap, so answered validations sat pending; a bounded rotating "completion lane" now revisits contacts with a stored definite answer first.
- Stuck ZeroBounce operations (provider outcome unconfirmed) are intentionally held, never blind-replayed; the backlog shows them as held.
- The optional priority action only enlarges local staged-email budget, repeats preparation, and wakes already-governed ticks (job data `priorityRequest`, ignored when malformed). It adds no spend/send path.
- executeSql in the sandbox reports 0 ms; use EXPLAIN ANALYZE for timing. Production backlog query is ~33 s under a 60 s timeout, cached 5 min.
**Why:** user wants flow to progress automatically and blockers named specifically.
**How to apply:** after publish, compare production funnel counts over time before claiming progression.
