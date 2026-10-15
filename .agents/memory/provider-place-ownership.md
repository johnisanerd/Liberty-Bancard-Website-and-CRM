---
name: Provider place identity ownership
description: Cross-provider namespace identity and lock-order requirements for place repairs
---

Treat a Google place ID as one shared identity across Outscraper, Google Maps, and Google namespaces.
Namespace-local source-link uniqueness is not proof that one business owns the identifier.

**Why:** A blank-field repair can otherwise assign the same place ID to two businesses in a single batch,
even when each business has exactly one source key. Resolver and mirror races require the same key lock and
a fresh ownership read after waiting, not only a candidate-time absence check.

**How to apply:** Preserve cross-namespace conflicting evidence rather than choosing an owner. Acquire shared
place advisory keys before business/source row locks, revalidate transactionally, and retain per-identity audit
receipts. A batch count alone is not proof of which identities changed.
