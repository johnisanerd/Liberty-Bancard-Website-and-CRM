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

## Launch email presentation is versioned content
The signature + logo live in one leaf module used by the shared launch renderer (worker, seed, previews); step text carries no signature. Its fingerprint is derived from the rendered markup and folded into both the package content hash and the recipient binding hash, so a presentation edit stales preparations and release approvals without a manual bump. Changed content/presentation versions publish into NEW draft campaign + paused sequence (old rows untouched, superseded); same versions with different live text stays a drift refusal. Signature markup must use line-per-div with no newlines between divs, or the transport's HTML→text conversion produces blank lines. The SMTP transport originally sent From without a display name; cold outreach now adds the sender-policy name.
**Why:** presentation changes must be detected by approval/release, and in-place edits of pinned sequences are refused by design.
**How to apply:** after any presentation/content change: publish, run the launch-content apply route (republish), then the stale-package lane; expect staging/live-hash mismatches until republished.

## Correction: republish is IN PLACE on the package's home sequence
Cloning a package into a new campaign/sequence on republish was wrong: prepared intents (idempotency key includes sequence id), paused enrollments (~1,200) and the stale-package lane (matches `current.sequence_id = intent.sequence_id`) are all keyed by the sequence, so a copy strands every recipient and the lane never selects them. The home sequence is the one the package's oldest version pinned; republish rewrites its steps in place by step order (ids preserved), supersedes the old version, pins the new one to the same ids. A package found pinned to a copy is returned home and the copy sequence is retired (retired_at). Refuse when the sequence has active enrollments.
**Why:** discovered only after the first production republish showed 0 intents on any current package's sequence.
**How to apply:** after any republish, check intents join a *current* package by sequence_id before expecting the stale lane to work.
