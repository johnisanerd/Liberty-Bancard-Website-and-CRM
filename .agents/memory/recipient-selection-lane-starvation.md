---
name: Recipient-selection lane starvation and stalled projections
description: Why repeated priority runs did not reach newly uploaded high-ID contacts, and why classification/projection backlogs were not ID-order problems.
---
- Each preparation pass spends its time on the completion and stale-package lanes (tens of seconds of qualification each) before the population and priority lanes. Production showed priority pages 0 and the population cursor moving only dozens of contacts per half hour; repeated local-only priority runs did not move the priority cursor or prepare any new-upload contacts.
- Staged-email businesses without classification were not waiting in ID order: every one had a skipped geography_review item (unknown city/county), so ordering them first would not classify them. Geography resolution is the gate.
- The effective-vertical projection tick has been failing with SQLSTATE 57014 (statement timeout) since Oct 16; cursor stuck, stored vertical column stale.
**Why:** prevents repeating run loops and "classify staged-email businesses first" proposals that cannot work.
**How to apply:** verify per-cohort movement (cursor and prepared counts) after any run before repeating; check deployment logs for 57014 before blaming ordering.
