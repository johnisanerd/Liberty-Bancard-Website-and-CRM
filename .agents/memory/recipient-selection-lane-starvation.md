---
name: Recipient-selection lane starvation and stalled projections
description: Why repeated priority runs did not reach newly uploaded high-ID contacts, and why classification/projection backlogs were not ID-order problems.
---
- Each preparation pass spends its time on the completion and stale-package lanes (tens of seconds of qualification each) before the population and priority lanes. Production showed priority pages 0 and the population cursor moving only dozens of contacts per half hour; repeated local-only priority runs did not move the priority cursor or prepare any new-upload contacts.
- Staged-email businesses without classification were not waiting in ID order: every one had a skipped geography_review item (unknown city/county), so ordering them first would not classify them. Geography resolution is the gate.
- The effective-vertical projection tick has been failing with SQLSTATE 57014 (statement timeout) since Oct 16; cursor stuck, stored vertical column stale.
**Why:** prevents repeating run loops and "classify staged-email businesses first" proposals that cannot work.
**How to apply:** verify per-cohort movement (cursor and prepared counts) after any run before repeating; check deployment logs for 57014 before blaming ordering.

## Resolution notes
- Projection timeout root cause: each contact with a verified relationship costs ~100ms in the relationship-evidence SQL (domain-expression predicate misses the native-function index), so a 2,500-row contact page exceeds 30s. Fix was savepointed, adaptive slices with a per-slice timeout, not a larger timeout; an expression index is a possible later optimization.
- Staged-email businesses are mostly national/out-of-territory domains: only ~14 of ~3,180 carry a retained address that resolves to a South Florida ZIP. Recovery (retained provider address strings, contact address, first-party JSON-LD) writes location rows only when the existing resolver gives a definite answer; never a county guess, phone area code, or Sunbiz registry address. Unresolved stays geography_review, distinct from vertical evidence.
- Ordinary free sweep now reads the business's own website (free); window shrank to 100 and run-key tag web1 avoids replay hash conflicts with earlier runs.
- Known baseline failures (also fail without these changes): canonical-flow-progression deadlock check, automatic-continuity discovery admission.
- Geography recovery ownership rule (review finding): an address counts only if tied to the business itself. Website JSON-LD is grouped per entity and accepted only when the entity's url is the business domain or its name matches (a publisher/partner on the same page is a different entity); a contact's address counts only when the contact's company name matches the business, because business_id alone links contacts carrying other companies' addresses. Each recorded location writes an audit_logs row with the supporting reference.
- Retry checkpoints must be business-level: select the newest item per business first, then apply the 7-day window against the newest stamp across all its items, or older unmarked historical holds re-select the business every tick.
- Resolution of the post-publish throughput finding: the priority lane now selects only contacts with no live pending_validation/ready_held intent (prepared ones belong to completion/stale/population lanes), its default reserve is 75s, and scheduled ticks run up to 4 preparation passes / 6 minutes while the priority lane keeps examining. **Why:** it re-qualified prepared contacts at 2-5s each and advanced ~5 contacts per 30-minute tick. Geography recovery handles 15 businesses per 5-minute tick against ~12.6k parked; that pace is unchanged.

## Upload-cohort lane and path cost
- The five-upload "1,444 no preparation row" figure overstated work: only ~712 of them had any current program/sequence binding (checked against production with the effective-vertical expression); the rest end at the cheap no-binding hold. Estimate remaining work from the bound candidate count, never an ID gap.
- Writer cost is round trips, not DB time: ~84 queries to reach a geography hold, ~139 for a prepared recipient (67 in qualification, ~28 in writes). A page-level read-only pre-screen (relationship, geography, email) returns the same no-write holds at ~3 queries/contact.
- Do not parallelize qualification reads: contactability calls commercial authorization itself and persists snapshots, so concurrent calls risk racing.
- Cohort lane has its own cursor and 6h revisit cooldown, runs in the local canonical-import-recovery job (serial continuation) and first in the normal tick; holds are recorded in audit_logs (24h dedupe) because held contacts have no preparation row.
