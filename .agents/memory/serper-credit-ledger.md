---
name: Serper credit ledger and pinned claim fingerprint
description: Durable reservation ledger for the unlabeled Serper scope, attested-maximum bound, claim-time input pinning, canonical replay hash
---
- Lookup memory pins the input fingerprint at claim time (from the selected target's inputs); the outcome is stored under the pin, never re-read from the business at settlement.
- The unlabeled scope is a RESERVED-credit cap under an operator-attested per-request maximum, not a guaranteed actual-credit cap. Only one request is in flight across all runs; any settled or telemetry charge above the attested maximum closes the scope (`bound_exceeded`) until the operator re-attests a larger value. Worst case is one request's excess. Keep the scope disabled until the owner supplies a defensible numeric maximum (Serper publishes none; it is prepaid, so the account balance is the true hard stop).
- An allowance-stopped lookup records no memory, releases its claim, settles the provider op as failed/transport, and the run is `partial` with a stop reason; processed excludes deferred work.
- Serper discovery payload hashing uses canonical (key-sorted) JSON. Plain JSON.stringify broke completed-key replay because JSONB reorders stored snapshot keys. The sibling person/identity waterfall still uses plain hashing and likely has the same replay bug.

**Why:** audits found a settlement-time fingerprint race, a non-hard cap (six concurrent reservations each charged 5 against a bound of 1), overstated work counts, and replay mismatches.
**How to apply:** any new paid-request path in this scope must call authorizeRequest/onRequestSettled/onRequestNotSent; wiring a callback into the waterfall is easy to drop silently, so check the call site. Never describe the cap as a hard actual-credit cap. The existing 24h provider-operation cooldown still holds the one business stopped mid-lookup.

## Owner attestation
- The owner attested a per-request maximum of 3 Serper credits for the unlabeled scope (2026-10-18). Production had no `sfp_serper_unlabeled_discovery` setting and an empty ledger at that time, so the scope was still closed; enabling also needs perRunRequests, dailyRequests and dailyCredits (all required, and maxCreditsPerRequest must not exceed dailyCredits).
**Why:** the user supplied the number in answer to the open request for one.
**How to apply:** never invent the other three limits; the cert fixtures (50/500/100) are test values only. Production is read-only for the agent, so the setting needs a sanctioned write path.
