# Held-effect disposition and blocker counts

Measured 2026-10-23 16:52Z (production, read-only): 23 held and 8 sent effects across 6 inbound requests; 6 of the
held effects are `transactional_ack` (created 2026-10-01 to 10-15). The production re-read was not available in the
last session of this work, so these counts are the earlier measurement, not a fresh one.

| Class | Disposition |
|---|---|
| Held `transactional_ack` older than the acknowledgement owner's start | **Never emailed.** The owner only prepares requests received after it first runs, and the capability only covers requests received after activation. No readdressing to edited contacts |
| Held internal effects (assignment, task, SLA, scoring, enrichment) | Not closed because a record exists. Each must be traced individually before marking; not done in this change |
| New requests while capability is closed | Local work progresses; acknowledgement shows `blocked / capability_closed`; the effect stays `held` |
| Delivery uncertain | Stays `attempting` with `delivery_uncertain`; never resent automatically |

## Recipient and sweep rules (added after review)
- The receipt recipient is the mailbox captured on the request (`inbound_requests.submitted_email`, snapshot at first contact link, never overwritten). If the CRM contact address no longer matches, the receipt is blocked as `recipient_changed_since_submission` and nothing is sent. The transport re-checks this before any lease.
- Requests without a captured mailbox (all pre-existing requests) are blocked `no_submitted_email_on_request`: never emailed.
- Blocked reasons that cannot clear (`capability_closed`, `capability_expired`, `source_class_not_enabled`, `request_before_eligibility_window`, no/changed recipient) are not revisited by the sweep, so a backlog cannot starve new requests. Activation is never backdated. Waits (pause, unreadable state/capability, retryable failures) rotate least-recently-touched first.
