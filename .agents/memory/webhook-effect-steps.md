---
name: Webhook effect steps
description: durable per-effect steps for GHL webhook handlers; what is and is not exactly-once
---
Local DB effects complete their step in the same transaction as the step marker; external effects are leased steps with stable keys. Handlers not split into steps remain at-least-once, and an external call that reached the provider before its marker committed can repeat once.

**Why:** a response-time "effect applied" marker cannot make a handler exactly-once; claiming it did hid replay risk.

**How to apply:** split a handler into steps before claiming idempotency; document unsplit handlers as at-least-once; keep appointment events serialized per appointment with the booked effect owned once.

Receipt-step fencing: external-step completion is fenced by the step token AND the receipt claim (FOR SHARE), a lost/failed completion releases only its own step lease so the next claimant re-runs with attempt+1 and the same {receiptId, stepKey} identity, and a cancellation deletes the still-owed booking_confirmation deferred enrollment in its local transaction. Still at-least-once: communication-event processing, statement request, lifecycle transitions, stage-change chains, opt-out, bounce.
