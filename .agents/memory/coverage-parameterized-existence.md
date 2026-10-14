---
name: Coverage parameterized existence
description: Nested source/business joins can rebuild full-universe hashes despite indexed outer page-key probes.
---

An indexed, parameterized outer key lookup does not by itself bound nested
source-namespace and business-existence joins. Preserve existence semantics,
but keep each nested probe parameterized rather than assuming an ordinary join
will use its available index.

**Why:** Production coverage timed out with idle pool capacity. An entity-first
rewrite still repeatedly hashed the entire business population; fencing the
business PK probe separately removed that executed access pattern.

**How to apply:** Inspect executed nested plans for a complete 500-contact
source-backed payload, not just a one-contact lookup or scalar count. Require
full result parity, retained missing-entity/filing semantics and actual index
execution. Large estimated costs are not runtime proof, and successful replica
queries are not primary request or committed-checkpoint acceptance.

An indexed smaller fixture can still hide a broad production hash join on a
different active branch. Require executed name, domain and alias branch plans
with realistic NULL/non-NULL key mixes; one branch's index assertion is not
evidence for the others.

**Why:** Active linking retained a small contact page and passed fixture index
checks while production still scanned the full canonical-business population.
