---
name: Bounded recovery qualification
description: Treat incremental dates and historical receipts as optimizations/accounting, not substitutes for current eligibility or full-row fulfillment.
---

An incremental change window must not permanently exclude an independently
corroborated relationship that currently qualifies. Reconsider such relationships
within the already-bounded raw page; keep the saved cursor/window and all write
authority intact.

**Why:** Production qualification found old contacts that passed the live
relationship preview but could continue being skipped by a change-only window.
Rewinding the backfill was explicitly outside the authorized recovery scope.

**How to apply:** Separate eligibility from change detection and exclude
optimization-only fields from snapshot authority. Do not reinterpret inspection,
an old created receipt or matching historical pins as complete original-row
fulfillment.

Organization US-phone equivalence is narrowly ten digits versus those same ten
digits prefixed by country code 1, not arbitrary international last-ten matching.

**Why:** Current retained-row qualification distinguished formatting-only holds
from real phone/location conflicts. A broad suffix comparison would collapse
different international identities.

**How to apply:** Keep retrieval and decision normalization consistent while
preserving conflicting locations, names, stable ownership and competing candidates.
