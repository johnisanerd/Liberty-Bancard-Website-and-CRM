---
name: Serper credit ledger and pinned claim fingerprint
description: Durable reservation ledger for the unlabeled Serper scope, claim-time input pinning, and allowance-deferred settlement rules
---
- Lookup memory pins the input fingerprint at claim time (from the selected target's inputs); the outcome is stored under the pin, never re-read from the business at settlement.
- The unlabeled credit cap is enforced only by the durable ledger (reserve worst case under an advisory lock before each physical request, settle to reported charge, unknown stays at the bound, fail closed). Telemetry is diagnostic and only raises the per-request bound.
- An allowance-stopped lookup records no memory, releases its claim, settles the provider op as failed/transport, and the run is `partial` with a stop reason; processed excludes deferred work.

**Why:** an external audit found a settlement-time fingerprint race, a non-hard credit cap, and overstated work counts when an allowance stopped a run.
**How to apply:** any new paid-request path in this scope must call authorizeRequest/onRequestSettled/onRequestNotSent; wiring a callback into the waterfall is easy to drop silently, so check the call site. The existing 24h provider-operation cooldown still holds the one business stopped mid-lookup.
