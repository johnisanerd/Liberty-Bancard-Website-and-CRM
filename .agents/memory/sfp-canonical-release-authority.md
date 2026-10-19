---
name: SFP canonical release authority and launch inventory
description: Narrow operator release for prepared SFP recipients, launch inventory gates, sender-identity readiness pitfall
---
- Promotional execution stays refused by the CR-06 lifecycle authority. The only exception is an enrollment released by an admin under a live, expiring, capped, revocable control record (system_settings key `sfp_canonical_release_control`). The sequence stays paused; the worker admits only marked enrollments at claim and email transport. SMS and enrollment boundaries are not covered. Releasing never lifts the global outbound pause.
- **Why:** audit demanded first-recipient launch without enabling legacy producers; real sending must wait for explicit operator action.
- **How to apply:** do not widen admission (no "sequence is canonical" shortcut); expiry/revoke re-pauses memberships; the preparation worker's retirement also cancels released active memberships.
- `sending_identities` has NO `status` column; readiness must use the shared helper (isActive + warm/warming). Earlier checks on `status==="active"` were always false.
- `business_locations.county_fips` is empty in production; territory comes from the TS zip/city resolver. Zip lists are ordering signals only.
- End-to-end proof of first step, reply-stop, unsubscribe, retry and follow-up needs real sends; it was not performed. Certified only with fixtures (canonical-release-authority cert).
