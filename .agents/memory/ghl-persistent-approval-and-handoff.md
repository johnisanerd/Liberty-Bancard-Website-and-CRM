---
name: GHL persistent approval and handoff durability
description: Lessons from making the native review approval non-expiring and the appointment handoff truthful
---
- Approval hashes stored in jsonb must use sorted-key stringification; JSON.stringify of a stored object differs after a jsonb round trip and silently makes every approval "unverified".
- Approval has no expiry: outage = hold (no failure budget), proven change = block + named facts, revoke = epoch bump. Public GHL workflows endpoint exposes metadata only, so definition edits without updatedAt/version movement are undetectable (document, do not claim otherwise).
- The provider workflow-enrollment endpoint is not documented idempotent: never auto-reassert an unknown/lost-response enrollment. Keep a dispatch ledger written before the request; only a definite refusal may be re-sent. enrollInGhlWorkflow itself must not defer ambiguous (timeout/socket) errors.
- A deferral helper must report whether a pending row exists (INSERT ... ON CONFLICT ... WHERE can change zero rows); only a verified row makes a handoff "durable".
- Cancel vs claimed recovery item: serialise with a per-obligation advisory lock and re-read the row under it right before dispatch; delete the row inside the same tx on success.
- scripts/test-ghl-enrollment-recovery.ts is a stale in-memory-store test (fails on HEAD too); the projection-authority cert is the real coverage.
**Why:** owner required persistent approval and no duplicate customer enrollments. **How to apply:** any new approval-bound hash or provider-effect handoff.
