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

## Launch repair (two-period lifecycle, binding, capacity)
- Journey authority is two separate periods: a short admission window (first touch only) and a finite journey period (follow-ups). Expired/content-held memberships are continued only by an explicit new admin release; revoked or `send_gate_stopped` journeys are never auto-extended.
- Release binds the exact recipient address/business/sequence/package hash; rechecked at execute and at final dispatch. The prep worker refreshes stale pins; a package hash change must not be bypassed by the explicit-sequence-binding branch of `preparedFactsCurrentSql` (that branch applies only when the sequence has no current package).
- One capacity definition (`sfp-sender-capacity.ts`: selected sender + global cold ceiling, counters are authority) is used by preview, execute, readiness and dispatch. Uncertain sends keep their reservation and hold the journey until an operator resolves it.
- nodemailer reports connection-lost-after-DATA as command "CONN"; classify as uncertain unless the message is a connect timeout/greeting failure or errno ECONNREFUSED/ENOTFOUND/EHOSTUNREACH/ENETUNREACH.
- Cert launcher `--only` takes the cert NAME (e.g. `sfp-launch-lifecycle-e2e`, `sfp-launch-release-ui`). Clock control = shifting persisted deadlines, not a fake clock.
- **Why:** these were the failure modes found while proving continuation, concurrency and capacity on disposable PostgreSQL.
- Continuation release sets `next_action_at` to max(release time, last confirmed send + next step delay); the controlled-clock helper must shift `outbound_send_log.sent_at` too. Hold resolution (uncertain delivery) runs in one transaction under the enrollment row lock: attempt update + capacity settlement + hold removal commit together; a non-reopenable attempt refuses and leaves everything held.
**Why:** reviewer reproduced early touch-2 sends after release and double capacity release under concurrent "not delivered".
