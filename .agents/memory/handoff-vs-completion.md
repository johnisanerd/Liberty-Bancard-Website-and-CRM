---
name: Handoff versus provider completion
description: Local intake makes durable consumable handoffs; provider completion is a separate companion scope.
---
Merchant/statement outbox `ghl_sync` records a pending contact projection (enqueueGhlContactProjection) and never asserts pause; approval/decline wait with OutboxWaitError("ghl_contact_pending") when no GHL contact id (no attempt consumed, not completed). `no_recipient` stays a terminal skip.
**Why:** handoff, provider completion and message completion must stay separate truths; provider side belongs to the GHL companion work.
**How to apply:** never mark a waiting item skipped/complete because the GHL id is missing.
