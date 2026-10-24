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
| current_intake, linked_update | yes | new desired state on a contact without / with a GHL id |
| historical_hold | no | open work created before 2026-10-23T04:00Z; waits for an explicit owner-scope release (activation prerequisite) |
| local_only | no | pipeline local-only fence; never reopened |
| test_local_only | no | record class test/demo/synthetic; also rechecked at claim time and in `syncContactToGhl` |
| closed | no | archived or missing contact |

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

Ambiguous creates (response lost on POST): never retried blindly. The next claim reconciles with a read-only lookup by
email: found → link and continue as an update; absent → one new create; lookup failure → deferred. Unresolved
ambiguity ends in terminal `DISPATCH_AMBIGUOUS_UNRESOLVED` after the budget.

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
| Contact created/updated, notes, tasks, opportunities | existing handlers in `server/routes/sdr.ts` | #2096 explicit occurrence claims |
| Appointment booked / showed / canceled | existing handlers (enrollment, tags, stage chains) | same |
| Appointment updated / rescheduled | `/api/webhooks/ghl/appointment-updated`, `/appointment-rescheduled` | ordered upsert into `ghl_appointment_state`; no enrollment, tag or stage change |

All of `/api/webhooks/ghl/` runs `ghlWebhookReceiptMiddleware`: receipt `received → claimed → applied | failed` in
`ghl_provider_event_receipts`, committed before the acknowledgement is released. Storage fault → 503; duplicate while
processing → 409; duplicate of an applied event → 200 without reprocessing. `webhook_event_log` is untouched.

## Custom fields, stages, tags, calendars (review evidence only)

- Installed custom fields (nine): lb_consent_email, lb_consent_sms, lb_do_not_sdr, lb_promo_code, lb_pain_points,
  lb_lead_source, external_contact_id, lead_score, contact_role.
- `ghl.ts` can also emit vertical, lb_vertical, monthly_volume, lb_monthly_volume, lb_current_processor and
  lb_partner_code when a contact has values. These are not installed, so such contacts wait under
  `GHL_CUSTOM_FIELD_CONTRACT_BLOCKED` until the fields are installed or the payload contract changes.
- Pipeline stage mappings are empty; opportunity and stage holds never block contact projection.
- Calendars (appointment reader selection): Sales Meeting `YFiIy7oIOUXN2qZZPnOr`, Callbacks `e96swr0hmZSJVdnfGwCd`.
  Appointment recording does not read or change the booking-link configuration.

## Certification

`scripts/certification/test-ghl-projection-authority.ts` (disposable database, fake GHL transport, provider denial
fatal). Run: `npx tsx scripts/run-sfp2060-predeploy-disposable.ts --only scripts/certification/test-ghl-projection-authority.ts`.

## Additions after the review of the first build (migration 0375)

- Every provider mutation passes the final fence and appends a `ghl_projection_operations` row before the request; the
  transport recorder hooks (`ghl-dispatch-recorder.ts`) enforce this for retries too.
- Export authority is evidence only (intake source events on or after the cutoff). Producers do not decide it.
- Lookup before create is `lookupGhlContactStrict`; the reconciler of ambiguous creates uses the identity pinned on the
  original create operation.
- Webhook receipt identity is the stable occurrence key; effect-applied is recorded before the acknowledgement.
- Owner-facing approval material: `docs/ghl-native-safety-approval-package.md`.
