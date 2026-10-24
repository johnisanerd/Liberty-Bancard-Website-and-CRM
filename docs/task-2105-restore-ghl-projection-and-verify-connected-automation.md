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
