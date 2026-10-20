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
- The owner attested a per-request maximum of 3 Serper credits for the unlabeled scope (2026-10-18). Production had no `sfp_serper_unlabeled_discovery` setting and an empty ledger at that time, so the scope was still closed; enabling needs perRunRequests and maxCreditsPerRequest; the owner said they do not need a daily limit, so dailyRequests/dailyCredits are optional (null = none; a malformed value still closes the gate; dailyCredits, when set, must be >= the per-request maximum). With no daily limit the bounds are the per-run limit, the one-in-flight ledger and the prepaid account balance.
**Why:** the user supplied the number in answer to the open request for one.
**How to apply:** never invent the other three limits; the cert fixtures (50/500/100) are test values only. Production is read-only for the agent, so the setting needs a sanctioned write path.
- The setting is written through the admin route `PUT /api/admin/serper/unlabeled-discovery-gate` (reason required, audited, validated with the runtime parser; GET shows gate and 24h ledger). The owner chose a per-run limit of 500 with the 3-credit maximum and no daily limits.
- `serper_control.local_budget` (50,000) and the `provider_controls` mirror are NOT enforced against calls or readiness (paid limits were removed); window_calls already exceeds it. Do not describe them as a blocking cap. The real stop is the prepaid Serper balance.
- Audit lesson: the 50,000 local cap displays as "nearly used" but blocks nothing, so never tell the owner their prepaid credits are unusable because of it. Spend is steered by which lanes run (Sunbiz website search is the largest consumer, thousands of calls a day) and by the prepaid balance. Serper email search has no stage in the governed paid waterfall, which only has identity/domain discovery, Outscraper email and Apollo.
