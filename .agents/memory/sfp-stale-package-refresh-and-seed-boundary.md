---
name: Stale-package refresh lane and seed-test boundary
description: Why republished packages strand prepared recipients, how preview cost is bounded, and why a real-path seed send cannot use a test contact.
---
- Keyset cursors (population and priority) do not target contacts whose preparation pins a superseded package; running "local_only" after a republish barely changes the stale count. A dedicated stale-package lane (bounded slice, rotating, updates intents in place, touches no cursor) is the fix. Judge it by stale count before/after, not by "processed".
**Why:** a republish made ~600 recipients unreleasable and a cursor pass moved the count 607→606.
**How to apply:** after any package republish, compare stale vs current intents before claiming recovery.
- Per-recipient contact-policy evaluation costs ~0.25s each; release selection applies it lazily only to recipients considered (full inventory count still evaluates all rows), so preview cost follows release size.
- Seed test: transport refuses marketing sends to anything but a production-class, business-linked contact (test class is blocked; no-contact exceptions exclude cold_outreach). A real-path seed send to the operator mailbox therefore needs an explicit design decision (e.g. a dedicated seed category), not a test contact or the global delivery redirect setting. Read-only seed rendering exists and shares the worker's renderer.
- UI cert needs the client built to generated-artifacts/ui-verify-public at repo root (vite outDir defaults under client/).
