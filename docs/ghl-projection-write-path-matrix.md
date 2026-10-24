# GHL projection: write-path and ownership matrix

Authority for outgoing contact export to GoHighLevel (GHL). Incoming sync, webhooks and native GHL workflows are
listed so each lane has exactly one owner. Nothing here changes native GHL configuration.

## Single-owner rules

- One open desired projection per contact and provider. Every producer calls `enqueueContactProjection`
  (`server/services/ghl-projection-authority.ts`). No other code inserts or updates projection rows for an enqueue.
- One executor claims and settles: `processEligibleContactProjections` (`server/services/ghl-sync.ts`).
  `processPendingContactProviderProjections` is a compatibility wrapper around it.
- Settlement is a generation compare-and-swap fenced by the claim token. An edit made while a row is in flight
  advances `desired_generation`; success for an older generation returns the row to pending.
- Counters: `attempt_count` = provider dispatch attempts (the only failure budget, max 8); `deferral_count` = local
  deferrals (never consume budget); `dispatch_count` = lifetime provider mutations.
- Provider accepted is never shown as verified. There is no provider read-back.

## Producers (queue a projection)

| Producer | File | Source kind |
|---|---|---|
| Contact writer (intake matched/created, profile update) | `server/services/contact-writer.ts` | intake_matched / intake_created / profile_update |
| Form sync and handoff helper `enqueueGhlContactProjection` | `server/services/ghl-form-sync.ts` | form_submission / handoff |
| Statement upload chain | `server/services/statement-upload-chain.ts` (through the helper above) | handoff |
| Master-lead pipeline promotion | `server/services/master-leads/pipeline-promotion.ts` | writes the local-only fence row (never exported), not a queue entry |

## Export dispositions

| Disposition | Exportable | Notes |
|---|---|---|
| current_intake, linked_update | yes, only while the contact has current-intake evidence | new desired state on a contact without / with a GHL id. Final eligibility re-proves the evidence, so a persisted disposition alone never authorizes export |
| historical_hold | no | no current-intake evidence (linked or not). Waits for an explicit, optional owner-scope release; current intake does not depend on it |
| local_only | no | pipeline local-only fence; never reopened |
| test_local_only | no | record class test/demo/synthetic; also rechecked at claim time and in `syncContactToGhl` |
| closed | no | archived or missing contact |

Linked-contact policy: a contact that already has a `ghlContactId` but no current-intake evidence is historical; its
edits are held exactly like any other historical contact, whether or not an open row exists. Evidence is a source event of
category website_form, partner_referral, merchant_application or manual_crm on or after `ghl_export_policy.currentIntakeSince`.
Runtime convergence returns any open exportable row without evidence to the hold, whatever its `source_kind` or dispatch
history, and never touches rows a worker currently leases or another provider's rows.

Rows that must never reopen: `pipeline_local_only`, `superseded_by_merge`, `DISPATCH_AMBIGUOUS_UNRESOLVED`.
`enqueueContactProjection` reports these as `not_exported` instead of throwing.

## Executor lanes

| Lane | Reads | Writes to GHL | Gate |
|---|---|---|---|
| Closed-circuit tick | claims eligible projections (limit 10) | yes, through `syncContactToGhl` | control enabled, selected runtime, current native review for the operation, outbound pause authority |
| Half-open probe | one eligible projection, or read-only health check when none | one eligible projection | same; never held, test or local-only rows |
| Specialized commands | read-only identity backfill while the circuit is not closed | only when closed | same |
| Legacy deals/tasks/companies phases | no | contained: off unless `ghl_export_policy.legacyPhases` is set | recorded as `contained` on each tick |
| `fullSyncToGhl` | no | retired no-op | cannot create records |
| Delete detection | yes | deletes stay disabled | |

Components per contact, in order: (1) identity + profile + any true suppression, (2) permissions, (3) parent/pipeline
fields, then owned-tag deltas. Tags are never part of the first write and never part of any `PUT`. The CRM owns only
`LB-ACTIVE-PIPELINE` and `lb_parent_account`; it sends add/remove deltas for those two through
`POST`/`DELETE /contacts/:id/tags`, so every GHL-native tag is preserved. A transient tag failure fails the projection (local
tags change only after provider success, and the retry is idempotent); an unreviewed operation or a provider rejection is a
held component. A missing `lb_location_of` is reported as a held component.

Scope: the ordinary workers cover the existing CRM population under a durable code-defined scope (linked production
contacts for updates; unlinked CRM-source contacts for creates; discovery, registry, imports, identity matching, inbound
sync, test/demo/synthetic and archived records excluded), narrowable through `ghl_export_policy.existingPopulation`.

Ambiguous creates (response lost on POST): never retried blindly. The next claim reconciles with a read-only lookup using
the identity pinned on the original create: an email-bearing create is linked only to a record stating the same email;
phone-only creates and records without an email are held for review; absent → one new create; an unsupported lookup
answer or a failed lookup → deferred. Every fence (runtime ownership, claim, lease, generation) is re-checked before the
link is written. Unresolved ambiguity ends in terminal `DISPATCH_AMBIGUOUS_UNRESOLVED` after the budget.

A payload that names a custom field the provider inventory does not verify (`GHL_CUSTOM_FIELD_ID_UNVERIFIED`) defers
for 15 minutes with code `GHL_CUSTOM_FIELD_CONTRACT_BLOCKED`, consumes no budget, and is never weakened.

## Tick lifecycle

`runGhlFullSyncTick` takes the job lock and the runtime lease. A single `finally` stops heartbeats, releases the lease,
releases the lock and records `system_settings.ghl_sync_last_tick`. Healthy idle (no eligible work) refreshes the
success clock and never opens or half-opens the circuit. Deferrals, skips, terminal results and lost claims never touch
circuit counters; auth failures trip the circuit; other failures and ambiguous results count toward the threshold.

## Incoming (not changed by this work)

| Event | Handler | Idempotency |
|---|---|---|
| Contact created, notes, tasks, opportunities | existing handlers in `server/routes/sdr.ts` | #2096 explicit occurrence claims |
| Appointment booked / canceled | `sdr/scheduling.ts` + `sdr/webhook-handlers.ts` | local effects commit with their step record in one transaction; external effects are leased steps completed only while the receipt claim is held. The booking handoff (SDR merchant and CRM contact share one implementation and one `booking_confirmation` workflow) returns enrolled/skipped/held/failed/unknown with a durable owner (`deferred_ghl_enrollments`) for pause, quiet-hours and transient/lost-response outcomes, carries the stable `{receiptId, stepKey, attempt}` identity, and a cancellation withdraws a still-owed confirmation. No CRM-side reminder timer or fallback email exists; confirmations and reminders belong to the native workflows. |
| Contact updated, inbound message, call outcome (local effects) | `sdr/webhook-handlers.ts` | local rows are transactional steps of the receipt |
| Other handlers (opt-out, bounce, statement request, lifecycle transitions, stage-change chains, communication-event processing) | existing handlers | **not** split into durable steps: at-least-once on retry, unchanged by this work |
| Appointment updated / rescheduled | `/api/webhooks/ghl/appointment-updated`, `/appointment-rescheduled` | ordered upsert into `ghl_appointment_state`; no enrollment, tag or stage change |

All of `/api/webhooks/ghl/` runs `ghlWebhookReceiptMiddleware`: receipt `received → claimed → applied | failed` in
`ghl_provider_event_receipts`, committed before the acknowledgement is released. Storage fault → 503; duplicate while
processing → 409; duplicate of an applied event → 200 without reprocessing. `webhook_event_log` is untouched.

## Custom fields, stages, tags, calendars (review evidence only)

- Installed custom fields (nine): lb_consent_email, lb_consent_sms, lb_do_not_sdr, lb_promo_code, lb_pain_points,
  lb_lead_source, external_contact_id, lead_score, contact_role (ids and observed types are in
  `docs/ghl-native-safety-approval-package.md`; the adapter and review bind id and key only, not type).
- `ghl.ts` can also emit vertical, lb_vertical, monthly_volume, lb_monthly_volume, lb_current_processor and
  lb_partner_code when a contact has values. Optional profile fields that are not installed are recorded as held and
  omitted; they do not block the contact. Only a required suppression field, or a payload naming a field whose id the
  provider inventory does not verify, defers the projection.
- Pipeline stage mappings are empty; opportunity and stage holds never block contact projection.
- Calendars (appointment reader selection): Sales Meeting `YFiIy7oIOUXN2qZZPnOr`, Callbacks `e96swr0hmZSJVdnfGwCd`.
  Appointment recording does not read or change the booking-link configuration.

## Webhook effect idempotency

Receipt identity is a location-scoped occurrence key (legacy keys still resolve); `webhookId` alone is not an event
identity. The same occurrence key with a different payload is adopted only before any durable effect exists, otherwise it
is a held collision (409). Handlers split into steps record each local effect in the same transaction as its step and
each external effect as a leased step with a stable key, so a settlement fault or crash retries only the unfinished step
(an external step that already reached the provider but whose marker was lost can repeat once; its callee must be
idempotent). Handlers that are not split remain at-least-once. Appointment booked/updated/canceled are serialized per
appointment; the booked effect has its own owner and never regresses a later state; effects superseded by a later
accepted terminal transition do not run.

## Certification

`scripts/certification/test-ghl-projection-authority.ts` (disposable database, fake GHL transport, provider denial
fatal). Run: `npx tsx scripts/run-sfp2060-predeploy-disposable.ts --only scripts/certification/test-ghl-projection-authority.ts`.

## Additions after the review of the first build (migration 0375)

- Every provider mutation passes the final fence and appends a `ghl_projection_operations` row before the request; the
  transport recorder hooks (`ghl-dispatch-recorder.ts`) enforce this for retries too.
- Export authority is evidence only (intake source events on or after the cutoff). Producers do not decide it, and the
  claim query, final fence and backlog counts all prove it.
- Lookup before create is `lookupGhlContactStrict`; the reconciler of ambiguous creates uses the identity pinned on the
  original create operation.
- Webhook receipt identity is the stable occurrence key; there is no response-time effect marker (see Webhook effect
  idempotency). Migration 0376 adds effect-step and appointment-booked ownership storage and needs a publish.
- Owner-facing approval material: `docs/ghl-native-safety-approval-package.md`.
