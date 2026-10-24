# Restore GHL projection and verify connected automation (#2105)

## Purpose
Contact projection to GHL was stalled: policy-deferred rows became unclaimable, the tick could leak its lease, an
idle backlog could look unhealthy, edits made during processing could be lost, and webhooks were de-duplicated before
they were handled. This change replaces those paths with one projection authority and certifies it on a disposable
database with a fake provider transport.

## What changed
- Migration `0374_ghl_projection_generation_authority.sql`: generation, disposition, deferral and dispatch columns on
  `contact_provider_projections`; `ghl_provider_event_receipts`; `ghl_appointment_state`. Runtime convergence applies
  the same statements to legacy rows.
- `ghl-projection-authority.ts`, `ghl-projection-convergence.ts`, `ghl-dispatch-recorder.ts`: enqueue, claim, settle,
  convergence and dispatch evidence.
- `ghl-sync.ts`: tick lifecycle with single cleanup, healthy idle, export-filtered probe, retired bulk export,
  contained legacy phases.
- `ghl-webhook-receipts.ts`, `ghl-appointment-events.ts`, `server/routes/sdr.ts`: receipt before acknowledgement,
  ordered appointment state.
- Admin UI: outgoing export backlog and last pass, per-contact receipt levels, token guidance only when the read-only
  health check fails, outgoing controls shown separately from incoming sync.
- `.replit`: `ghl-sync-only` added to the shared worker group list (consumer only).

## Not done by this change (activation prerequisites)
- Historical rows created before 2026-10-23T04:00Z stay held until the owner releases a scope.
- Native review approval, enabling permissions and selecting the runtime remain owner actions.
- Production acceptance (sustained ordinary processing) requires publish and observation.

See `docs/ghl-projection-write-path-matrix.md` for the write-path matrix.

## Follow-up hardening (review of the first build)
- Migration `0375_ghl_projection_operations_and_intake_evidence.sql`: durable `ghl_projection_operations` (one row per
  provider request, written before it is sent), webhook receipt `payload_fingerprint`/`effect_applied_at`, and a
  correction demoting creation-time `current_intake` rows that lack intake evidence. 0374 is unchanged.
- Export authority comes only from source evidence (website form, partner referral, merchant application, manual CRM
  on or after the cutoff). Queue creation time and caller source strings grant nothing; an existing hold survives
  every background producer.
- Final fence (token, unexpired lease, generation, ownership, eligibility) and an operation record before every
  mutation, including transport retries. Ambiguous creates are reconciled by a read-only lookup of the identity that
  was originally sent; phone-only or empty identities are held with a specific reason.
- Strict lookup before create (exact/absent/ambiguous/unavailable/conflicting owner); no mailbox- or phone-only merge.
  Required suppression fields not installed defer before any write; optional fields not installed are held, never created;
  a failed permission write is a failed component (identity stays linked, no tags).
- Webhook receipts key on the stable occurrence (provider event id, else semantic subject/time, else payload fingerprint);
  effects are made durable before the acknowledgement and recovered on retry; enrollment/tagging handoffs are awaited.
- Appointment events: missing location/calendar/event time are rejected; ordering is decided before booked/showed/canceled
  handlers; reschedule audit is replay-safe; terminal states are preserved.
- Exhausted expired-processing rows and stranded linked-update rows are reconciled; convergence is bounded and resumable.
- Fixed: the deferred-operation metric write failed on an untyped SQL parameter.
- UI: component outcomes (held/failed fields) shown separately from request receipts; token guidance only for
  authentication-class read-check failures.
- Certification: `scripts/certification/test-ghl-projection-authority.ts` includes an approved fake-provider journey
  (real worker, executor, transport and CRM control) with exact request counts, plus explicit mutants.
- Owner package: `docs/ghl-native-safety-approval-package.md` (prepared, not approved).
