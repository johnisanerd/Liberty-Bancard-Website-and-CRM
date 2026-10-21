---
name: Contacts vs businesses counts
description: Count-unit pitfalls in the enrichment audits
---
Domain-match audit figures count contacts; many contacts share a business, so business counts are smaller (3,574 eligible contacts were 3,425 businesses in the sampled slices).

**Why:** A doc line said "matched businesses" for a contact count and overstated the population.
**How to apply:** Label every figure with its unit. The production SQL wrapper returns only `START TRANSACTION / ROLLBACK` when a query errored (replica conflict, un-inlined parameters); retry with inlined literals.
