---
name: Validation legacyInFlight hold
description: Why addresses wait forever as shared_address_validation_in_flight
---
Addresses whose earlier completed ZeroBounce operation has a retryable `unknown`/`risky` observation, and whose claim has moved to a newer operation, count as "legacy in flight" in the claim guard and never clear.
**Why:** loosening the guard causes more paid retries; owner decision, so it was only reported.
**How to apply:** when counting pending validation, separate these from real in-flight work; do not change the guard without owner approval.
