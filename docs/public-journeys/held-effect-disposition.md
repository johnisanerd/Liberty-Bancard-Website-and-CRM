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
