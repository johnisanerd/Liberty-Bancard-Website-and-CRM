---
name: Acknowledgement override refusal and worker liveness
description: Receipt sends refuse an active email override and recheck capability at final dispatch; worker heartbeat in status.
---
smtp-email refuses ack delivery when an email override is active (`ACK_DELIVERY_OVERRIDE_ACTIVE`) and rechecks capability at the final dispatch boundary (refusal = wait, no attempt consumed). The sweep writes `inbound_ack_worker_heartbeat` each tick; the status route reports reporting/stale/never_reported.
**Why:** an override would redirect a receipt to a non-recipient; liveness was previously invisible.
**How to apply:** new certs (convergence, outbox handoff, partner resume, template final preview) are selected fixture suites only, not default pre-deploy.
