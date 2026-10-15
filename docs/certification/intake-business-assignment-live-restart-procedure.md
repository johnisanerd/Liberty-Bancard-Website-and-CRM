# Intake and Business Assignment: controlled live restart/replay procedure

**Current disposition:** the owner requested task closure on 2026-10-14 with
remaining contacts, results reconciliation and production acceptance deferred.
This procedure is retained for a later resumption; task closure does not execute
or certify it.

## Authorization and limits

The owner authorized the controlled production restart/replay test **once the
current runs settle**. This authorization is recorded here; it has not yet been
exercised. It does not authorize changing provider/outbound controls, resetting
the population cursor, weakening native guards, modifying production leases or
work-item states directly, or resending the October workbooks.

Use the existing ordinary CSV upload, persisted execution processor, native
relationship authorities and existing production deployment. Do not introduce a
replacement recovery service or an additional approval gate.

## Before the controlled upload

1. Reconcile the normal production runs and the full production-contact pass.
   A full-pass notification requires disposition reconciliation; it is not
   automatic acceptance. Preserve original fingerprints, protected relationships,
   current holds and outstanding source coordinates.
2. Pin the served build, native bridge/body/trigger verifier and relationship
   fingerprints. Record the current source-scoped baseline and relevant native
   records, not just global counters.
3. Arrange a supported **physical production process restart** through Publishing.
   This session has no production-restart callback. A workspace/workflow restart
   is not a production restart. The public Admin API contract inspected for this
   work exposes deployment reads, not a deployment restart operation.
4. Select and revalidate the exact controlled input and its expected mailbox,
   business and source identities. A read-only preflight found existing canonical
   Outscraper-place businesses with at least three distinct, currently verified
   genuine mailboxes. This is inventory for a possible matched-person scenario,
   not proof of an upload or of created-person coverage. Preserve existing
   restrictive contact/channel facts; do not fabricate consent or positive
   validation evidence. Keep private source values in ignored evidence.

## Ordinary upload and actual interruption

1. Submit the controlled new file through the authenticated admin/manager
   multipart `POST /api/leads/import-csv` boundary, including CSRF. Retain its
   exact byte hash, execution identity, source coordinates and expected mailbox
   set. Do not invoke a disposable harness against production.
2. Observe physical fingerprint-bound source events and pending mailbox
   fulfillment through bounded reads. Identify an actually unfinished
   multi-mailbox row with at least one committed mailbox.
3. Perform the supported physical restart. Record the interruption and serving
   process transition. Reconcile the last committed mailbox state afterward.
   If the row completed before interruption, the attempt is inconclusive for
   partial-mailbox restart; do not manufacture a partial state afterward.
4. Allow the original five-minute execution lease to expire naturally. The
   existing startup/ordinary resumer must reclaim the same execution and process
   its retained source payload without a request object. Do not expire a lease
   manually, alter accounting, or convert the row into a deferred-item fixture.
5. Verify that immutable row accounting did not complete the execution while
   retained mailbox work remained pending. Then reconcile every expected mailbox,
   original fingerprint-bound source event and approved business affiliation.
   Verify no extra people/businesses, loss of restrictive facts, protected
   relationship changes, provider dispatches or outbound effects attributable to
   the test. Keep created-primary and matched-primary coverage distinct.

`POST /api/csv-imports/:id/mark-interrupted` changes a UI projection only.
It is **not** an interruption or physical restart test.

## Retained replay is a separate obligation

An identical completed-file upload returns `replayed: true` and the existing
summary without reprocessing. It proves request-level deduplication, not a full
native retained-materialization replay.

The existing canonical recovery worker now supports explicit original-row
selection through admin-only, CSRF-protected
`POST /api/import-executions/:executionId/replay-retained`. This implementation
is verified locally but **not yet published or exercised in production**.
Its body is `{"sourceRowNumbers":[1,2,3]}`: one completed execution, at most
250 distinct positive PostgreSQL integer row numbers. The original recoverable
accounting and native provider-source restrictions remain in place.

Local evidence now includes nine focused database/real-authenticated HTTP checks,
157 passing HTTP
role/boundary checks, and the complete 1,472-row native-topology recovery/replay
run (runner exit 0). Full native replay preserved relationships and original
accounting, created no duplicates and made no provider/outbound/nonselective
validation attempts. These results do not constitute production execution.

Selection includes current fulfilled rows and future-scheduled holds without
manually rearming work items or reopening completed executions. Each selected
row still uses the existing owner, native claim, immutable identity, materializer,
relationship and finalization fences. Another live claim cannot be taken.
The full-workload disposable replay phase now uses this boundary's worker mode,
not direct state resets or forced lease expiry.

After publication and once the authorized settlement condition is met:

1. Pin the served build and exact original source-row population, mailbox,
   business, source-event and immutable accounting baselines.
2. Submit bounded scopes through the authenticated API. Record each returned
   row outcome and `remainingSourceRowNumbers`; retry only outstanding original
   coordinates through that same worker. `scopeAttempted` means selection was
   attempted, **not** that rows fulfilled or production acceptance passed.
3. Independently reconcile the entire population and protected relationships.
   Holds need current evidence and decisions, not merely unchanged terminal labels.
   Verify no extra records, provider dispatches, nonselective validation admissions
   or outbound effects attributable to replay.

Unchanged counters and immutable receipts alone are insufficient. Disposable
fault injection is not a supported production substitute for a physical restart.

## Current verdict

Replay implementation and local verification, plus live read-only inventory.
No controlled live upload,
physical restart or full retained replay has been performed. The original
production acceptance remains unverified; the task is closed at the owner's
request with those obligations explicitly deferred.
