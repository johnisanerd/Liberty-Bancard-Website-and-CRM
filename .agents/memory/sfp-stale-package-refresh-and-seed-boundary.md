---
name: Stale-package refresh lane and seed-test boundary
description: Why republished packages strand prepared recipients, how preview cost is bounded, and why a real-path seed send cannot use a test contact.
---
- Keyset cursors (population and priority) do not target contacts whose preparation pins a superseded package; running "local_only" after a republish barely changes the stale count. A dedicated stale-package lane (bounded slice, rotating, updates intents in place, touches no cursor) is the fix. Judge it by stale count before/after, not by "processed".
**Why:** a republish made ~600 recipients unreleasable and a cursor pass moved the count 607→606.
**How to apply:** after any package republish, compare stale vs current intents before claiming recovery.
- Per-recipient contact-policy evaluation costs ~0.25s each; release selection applies it lazily only to recipients considered (full inventory count still evaluates all rows), so preview cost follows release size.
- Seed test: transport refuses marketing sends to anything but a production-class, business-linked contact (test class is blocked; no-contact exceptions exclude cold_outreach). A real-path seed send to the operator mailbox therefore needs an explicit design decision (e.g. a dedicated seed category), not a test contact or the global delivery redirect setting. Read-only seed rendering exists and shares the worker's renderer.
- UI cert needs the client built to generated-artifacts/ui-verify-public at repo root (vite outDir defaults under client/).
- Measured in production: each stale re-preparation costs ~5s (commit alone ~2.3s), so a 30s lane share refreshes only ~6 recipients per tick and the scheduled tick runs every 30 minutes. Throughput is time-share bound, not selection bound; size lane budget and operator-pass count against that, and judge by stale→current counts.
- A seed-send capability needs more than a new sender category: the shared SMTP service still enforces the global pause, so the operator must lift pause for a seed send; keep customer sends blocked by having no release active.

## Seed-test design (built, certified on fake SMTP; not yet used live)
- Authority lives in system_settings (no migration): one authorization row, per-idempotency-key receipts, per-occurrence unsubscribe events. The transport re-verifies from durable state; callers pass only a receipt key + occurrence id.
- Seed unsubscribe tokens are a distinct kind (`seed.` prefix); they never verify as contact tokens and vice versa. Seed sends are capped (<=3 per authorization) but NOT counted in outbound_send_counters.
- The global pause authority still gates the seed at the transport. A real seed therefore needs the global pause lifted. Unpause also (a) flips ~918 `_globalPauseBlock*` paused enrollments back to active (VFC-22 sweep) and (b) writes `release_pending` coordinator holds for gated queue keys.
- Other paths on unpause: sequence worker needs sequence.status active (prod: 32 active sequences, 0 active enrollments; 420 active enrollments sit in paused sequences) plus channel flags (emailChannelPaused/coldEmailChannelPaused/smsChannelPaused all true in prod). Prod BACKGROUND_JOB_PROFILE (per .replit shared env) omits outreach/operations groups. Direct sendSmtpEmail callers (auth, partner, merchant, proposal, alert emails) are gated only by the global pause.
**Why:** tell the owner exactly what a global unpause exposes before asking for seed authorization.

## Seed lease (supersedes "seed send requires pause lifted")
The seed send now works while the global pause stays on: the pause authority has a separate per-message seed lease (`authorizeSeedSend`) that is not reachable from `authorize()`, and the exception registry stays empty. The authority re-verifies the durable admin authorization and claimed receipt itself, binds the lease to the exact mailbox and a hash of the rendered subject+html (no extra text), consumes the claim once (claimed→sending), and gives a claim a 10-minute life. It refuses when the pause state is unreadable or activating.
**Why:** the owner wanted a real-mailbox test without a global unpause, which would also reactivate ~900 parked enrollments.
**How to apply:** never add a seed path through `authorize()` or the exception registry; keep the static census (only the seed service, mail service, authority files mention the seed capability) in the seed cert.
