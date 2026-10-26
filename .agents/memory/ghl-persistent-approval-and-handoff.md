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

## GHL custom-field creation quirk
POST /locations/:id/customFields derives the key from `name` (lowercased, spaces to underscores) and prepends `contact.`; passing `fieldKey` with a `contact.` prefix yields a corrupted key (`contact.contactlb_...`). Create with name only: "LB Do Not Autocontact" gives `lb_do_not_autocontact` ("Auto Contact" gives `lb_do_not_auto_contact`, wrong). Verify keys from the inventory after creation.
**Also:** production `ghl-sync` and `ghl-enrollment-recovery` queues have automation_registry kill_switch_enabled=true; the sync tick (including convergence) does not run until the owner releases it, independent of the GHL control setting.

## Owner review prefill
Prepared review evidence is a typed data file plus a read-only compare route; the owner loads it in the existing form and submits under their own login. The form no longer asks the owner to claim a personal workflow inspection; it requires an acknowledgement of attributed evidence. A compare mismatch means inspect the change and prepare a new package; never substitute hashes. Prefill code needs a Publish before the owner can use it. Production admin scripts: CSRF endpoint returns `{token}`.
