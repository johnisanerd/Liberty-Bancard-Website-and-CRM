---
name: executeSql DDL timeout + migration lock contention
description: Large-table changes and lock evidence must respect managed production schema ownership.
---

Large-table DDL and unindexed FK checks can exceed a short query budget or wait
behind long transactions. An empty activity query on a production read replica
does not establish that the live primary has no blockers.

**Why:** Replit production SQL access is read-only and replica-backed. Historical
advice in this note incorrectly recommended production DDL, terminating sessions
and fabricating migration-ledger rows. That advice conflicts with current
managed-database rules and must not be followed.

**How to apply:** Inspect deployment logs and the actual managed schema diff.
Use existing authorized primary diagnostics when available; label replica
observations explicitly. Optimize and verify the development schema, then use
Publish for production delivery. Do not terminate production sessions, issue
production DDL, replay the development journal at startup, or invent ledger
hashes to bypass missing migration evidence. See
[production schema ownership](production-schema-ownership.md) and
[Publish index serialization](publish-nested-expression-indexes.md).
