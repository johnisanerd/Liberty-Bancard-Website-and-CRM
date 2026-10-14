---
name: Durable command lease cleanup
description: Token-fenced lease ownership rules for durable command workers.
---

Every durable command worker must release its lease on every terminal path, including validation and file-read failures before the main execution `try/finally`. Release, checkpoint, and terminal mutations must be fenced by the exact lease token; unleased request-side setup may mutate only a still-unleased in-progress command.

**Why:** An early worker return can leave a terminal row with a stale lease, while an unfenced route or stale worker can overwrite a command taken over by a new executor.

Validate a terminalizing claim immediately before its fenced transition releases
the token. Do not apply an ordinary write wrapper's post-callback check to the
same intentionally released claim; separate still-live owner fences still apply.

**Why:** A successful terminal transition invalidates its own item claim. A
generic post-write check then rejects and rolls back authorized completion.

**How to apply:** Distinguish ongoing writes from claim-releasing transitions
when reusing transaction wrappers, and test committed terminal state together
with stale/competing-owner rejection.

**How to apply:** When adding a claimed-command worker, test missing prerequisites, duplicate delivery, expired-lease takeover, and an active competing lease. Treat a queue as transport only; the command row remains lifecycle authority. This applies to any durable claim table, not just BullMQ-style command workers — a "claimed" status with no staleness window and no reclaim path is the same bug wearing a different name (see sunbiz-bootstrap-claim-idempotency.md, the lease-fencing/CAS section, for a concrete instance and fix pattern).

Shared active-command authority must take precedence over legacy per-kind pointers. Legacy lookup is a fallback only when the shared authority is absent; it must not revive a competing historical command.

**Why:** Compatibility with older command pointers must not reintroduce concurrent per-kind execution after adopting a single shared active-command boundary.

**How to apply:** Test the actual database selector with both current and legacy pointers present, not just mocked command stepping. Include expired running leases and live-owner exclusions in recovery tests.