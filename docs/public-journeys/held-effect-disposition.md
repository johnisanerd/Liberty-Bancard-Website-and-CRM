# Held-effect disposition and blocker counts

Re-read 2026-10-23 (production, read-only): 23 held and 8 sent effects across 6 inbound requests. This matches the
earlier 16:52Z measurement. All 8 sent effects are internal (`INTERNAL_AUTHORITY_COMPLETED`): the task and SLA effects
of 3 callback requests and the ticket and SLA effects of 1 support request. No acknowledgement row exists in
production yet, and production does not yet have the `inbound_requests.submitted_email` column (it arrives with the
next publish), so none of these requests can ever be prepared for a receipt.

## Per-effect trace (all 23 held effects)

| Request (id prefix) | Source, lifecycle | Effect | Evidence found | Disposition |
|---|---|---|---|---|
| 78966735 | callback_form, review_required | assignment | Pending task exists with due date, unassigned; assignment decision `UNASSIGNED_POLICY_MISSING` | Stays held. Needs an assignment policy (owner decision); a task existing is not an assignment |
| 78966735 | | transactional_ack | No acknowledgement row | Never emailed (historical) |
| 50627587 | callback_form, review_required | assignment | Same as above | Stays held, same reason |
| 50627587 | | transactional_ack | No acknowledgement row | Never emailed (historical) |
| db12c287 | callback_form, review_required | assignment | Same as above | Stays held, same reason |
| db12c287 | | transactional_ack | No acknowledgement row | Never emailed (historical) |
| 7bf25c5d | statement_upload, failed | assignment, sales_sla, sales_work, statement_review | Request failed before any contact, deal or work link existed | Not completable and not closed: no record backs them. The request stays `failed` as evidence |
| 7bf25c5d | | transactional_ack | No contact, no mailbox | Never emailed |
| 4a2883ec | free_analysis, review_required | assignment, sales_work, sales_sla, lead_scoring, business_enrichment, deal_blueprint, referral_attribution, workflow_dispatch, provider_sync, inbound_confirmation | No contact, deal, task or work link | Held. Each of these is a provider, enrichment or workflow action that stays paused; none may be marked complete without the real action |
| 4a2883ec | | transactional_ack | No contact, no mailbox | Never emailed |
| 62193b45 | support_form, accepted | transactional_ack | Ticket and SLA effects sent; no acknowledgement row | Never emailed (historical) |

Nothing in this table is closed, resent or emailed by this change, and no production row was written.

| Class | Disposition |
|---|---|
| Held `transactional_ack` older than the acknowledgement owner's start | **Never emailed.** The owner only prepares requests received after it first runs, and the capability only covers requests received after activation. No readdressing to edited contacts |
| Held internal effects (assignment, task, SLA, scoring, enrichment) | Traced individually in the table above; none closed |
| New requests while capability is closed | Local work progresses; acknowledgement shows `blocked / capability_closed`; the effect stays `held` |
| Delivery uncertain | Stays `attempting` with `delivery_uncertain`; never resent automatically |
| Interrupted attempt (process died mid-send) | After 10 minutes the acknowledgement becomes `uncertain / attempt_interrupted` and is never resent. An effect claimed without an acknowledgement claim (nothing was sent) returns to `held` |

## New request classes
- `partner_application_request` and `privacy_request` have a review notification effect (admin-only) and a receipt effect. Neither has an SLA or promises a response time. Both stay closed until an admin adds the class to the receipt capability.
- Privacy receipts are contactless: sent only to the mailbox captured on the request, as a transactional support message with no contact binding, no personal details and no timing promise.
- The co-branded partner lead form is a sales request (`partner_referral / partner_portal`) on the same authority as other website leads; it no longer scores, routes, enrolls or fires workflows directly.

## Recipient and sweep rules (added after review)
- The receipt recipient is the mailbox captured on the request (`inbound_requests.submitted_email`, snapshot at first contact link, never overwritten). If the CRM contact address no longer matches, the receipt is blocked as `recipient_changed_since_submission` and nothing is sent. The transport re-checks this before any lease.
- Requests without a captured mailbox (all pre-existing requests) are blocked `no_submitted_email_on_request`: never emailed.
- Blocked reasons that cannot clear (`capability_closed`, `capability_expired`, `source_class_not_enabled`, `request_before_eligibility_window`, no/changed recipient) are not revisited by the sweep, so a backlog cannot starve new requests. Activation is never backdated. Waits (pause, unreadable state/capability, retryable failures) rotate least-recently-touched first.
