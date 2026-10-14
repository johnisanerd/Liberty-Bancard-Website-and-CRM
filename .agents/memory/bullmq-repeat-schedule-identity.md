---
name: BullMQ repeat schedule identity
description: Installed repeat registry, not effective interval telemetry, proves removal of obsolete periodic schedules.
---

Recognize repeatable schedule ownership by the exact stable-ID descriptor/hash,
not only the returned ID, queue name or a substring. Preserve unrelated named
schedules and retained one-off work.

**Why:** Installed BullMQ v5 returned modern repeat metadata with no original ID.
After a cadence publication, the new intervals appeared in telemetry while the
old Sunbiz and free-enrichment repeat schedules remained installed alongside
them. An ID-only filter silently matched nothing.

**How to apply:** Use the actual installed BullMQ contract and private Redis
regression when changing schedule replacement. After publication, verify the
installed repeat registry separately from configuration telemetry. Old
generation-scoped namespaces may be historical; do not blanket-delete them or
infer that every retained schedule is currently executing.
