# Restore GHL projection and automation

## What & Why
GHL projection is not running. Production has 16,559 pending GHL contact projections with zero attempts, the oldest from 2026-08-26, and the repository production worker profile does not include the dedicated GHL sync group. Separately, a confirmed code path makes policy-deferred projections permanently unclaimable. This task owns audit findings 2 and 3 plus the GHL field, tag, message-template, workflow and calendar bindings and provider event feedback. It restores ordinary automatic projection safely; it must not pour the whole backlog into GHL.

Companion task: "Public journeys and branded comms" owns findings 1 and 4 to 8 and all copy, rendering and lifecycle decisions. Reuse its copy, renderer and journey decisions; create no competing provider-side campaigns and no second owner of any message. This task can progress independently; the companion's provider-dependent effects need this task's working handoff, and this task must expose projection state per contact so the companion can read it.

Three stages are reported separately: (1) implemented and certified on a disposable database with fake provider transport, (2) published (served SHA, selected deployment, worker profile verified), (3) accepted in production (observed ordinary processing). The task is not complete before stage 3.

## Standing constraints (from the owner's earlier decisions)
- Writing to GHL is approved by the owner (confirmed in chat on 2026-10-23); this replaces the earlier one-way-only scope. The code still blocks every GHL write (contact create or update, tags, fields, stages) until a stored native workflow review is current, because those changes can start GHL's own workflows that send messages while the app's outbound pause is on. Production has no control record today, so the control is disabled and the review is unverified; every write is denied.
- This task prepares the review but does not approve it. The agent reads the live GHL workflow, tag and custom field inventory (read-only), builds a review sheet, and the owner approves it. The agent never records its own approval.
- Outbound, email and SMS pauses, promotional sending and enrollment stay off. Incoming GHL sync stays on. Provider spending controls are untouched. GHL ownership does not transfer SFP ownership.

## Verified from code and read-only production (as of 2026-10-23 15:58Z, re-measure in preflight)
| Item | Evidence |
|---|---|
| Worker selection | The production profile list (selective with enrichment, free-enrichment-lane, provider-live, email-validation, sunbiz-backfill, sfp groups) omits `ghl-sync-only`. The selection function returns `needs_isolated_group` unless the profile or selective groups include it; it also requires control enabled, owner profile match, selected runtime equal to the current deployment. The group contains only the `ghl-sync` queue. |
| Tick early exits | The tick returns silently when GHL is unconfigured, the job lock is not acquired, or the runtime lease is not acquired (not selected, held, unavailable). No reason is recorded or shown. |
| Attempt accounting | The claim increments `attempt_count` on every claim and only selects rows with count below 8. A control or policy deferral sets state retry for one minute but keeps the increment, so after 8 deferrals the row is never selected again and is not terminal. Provider failures use the same counter. |
| Tick phases beyond projections | After projections the tick also syncs up to 10 contacts without a GHL id that are not projection-owned and up to 5 deals per tick, plus later phases; enabling the worker activates these too. |
| Backlog composition | Of 16,559 pending: 16,019 are production-class `historical_backfill` with legacy_unknown category (509 already have a GHL id); 526 are test-class (356 other, 141 ghl_sync inbound, 14 statement upload, 13 estimate, 12 get-started); only 4 are real current intake (2 manual CRM, 1 support form, 1 statement upload). 4 more are terminal. Creation weeks: 6,142 in week of 2026-09-14, 4,518 in week of 2026-10-12, 2,903 in week of 2026-10-19. Backlog is still growing (16,454 earlier in this review, 16,559 now). |
| Production control record | The control and runtime owner records were not found under the key patterns tried; read the exact keys in preflight rather than assuming. |
| Calendar | Appointment booked, canceled and showed events are handled; update and reschedule events and a calendar events store are not. Calendar id is configured as one fixed value in shared settings. |
| Workflows in GHL | Production CRM has 17 enabled internal workflows; native GHL workflow inventory is not yet captured by this repository's review record. |

## Preflight (before code; evidence goes in the final report)
1. Read production with timestamps: control record, runtime owner record, selected groups actually deployed, selection reason from the existing runtime truth read, queue age and counts by state, source class and attempt count.
2. Enumerate every phase of the tick and every GHL write path it reaches; for each, record the authority gate it passes and what GHL native workflow could trigger.
3. Capture the native GHL workflow, tag, custom field and calendar inventory read-only and compare with the repository bindings (field ids, tag names, message templates, workflow ids, calendar id). Report gaps; do not edit GHL.
3a. Build the review sheet for the owner: every native workflow with its trigger (contact created, tag added, field changed, stage changed, form, appointment) and whether it sends messages or starts sequences; the exact write operations the projection needs (method, path, fields, tags, stage ids, custom field ids, purpose); and which workflows each operation could trigger. Flag any workflow that would fire on a projected contact. Where a trigger is unsafe, propose avoiding it (omit the tag or field, or have the owner disable that GHL workflow) instead of widening the allowlist.
4. Decide, with the owner's data, the backlog policy: classify the 16,559 rows into (a) real current intake, (b) historical backfill, (c) test-class, (d) already linked. Recommended default: ordinary processing for (a) only; (b) stays held and is surfaced as a counted, owner-reviewed cohort; (c) is terminal with a test-fixture reason; (d) is reconciled by id match, not rewritten.

## Steps
1. Make the intended worker selection explicit in the production profile, and make the reason selection fails visible: expose the exact no-owner, no-selection, not-enabled, held or unavailable reason through the existing runtime truth read and the admin status screen (no generic healthy heartbeat). Each early exit of the tick records its reason.
2. Separate local deferrals from provider attempts: deferrals (control disabled, review not current, pause drain, capability missing) keep the row claimable after recovery and never count toward the attempt limit; provider failures count; exhausted provider attempts end in an explicit terminal outcome.
3. Reconcile existing nonterminal rows already at the claim limit: a bounded, audited, idempotent repair that returns only deferral-stranded rows to claimable, and never touches succeeded, terminal, ambiguous or already-processing evidence and never blind-retries everything.
4. Gate the non-projection tick phases (unlinked contacts, deals, later phases) behind the same CRM authority and the same cohort policy, so enabling the worker cannot start unreviewed bulk writes. Local-only and test-class contacts are never exported.
5. Backlog handling per the preflight policy: ordinary processing for current intake with a small rate bound and a canary of a few rows first; historical and test cohorts handled only as the owner approves; every move is audited and reversible by state.
6. GHL bindings: verify and fix field, tag, message-template, workflow and calendar bindings against the captured inventory; add update and reschedule appointment handling and a provider event feedback record so appointment and delivery events return to the CRM truthfully; calendar id comes from one verified configuration source.
7. Stale-work reconciliation: detect and report stale owner leases, deployment mismatch after publish, and stuck processing leases, with recovery that is fenced to the current owner.
8. Per-contact projection state read for the companion task (pending, processing, succeeded with provider id, deferred, terminal with reason). A missing GHL id never blocks a receipt sent through another supported transport.
9. Review approval and enablement: the owner approves the review sheet and the approval is recorded through the existing admin control with an evidence reference; the control is then enabled, the sync worker group and current build are selected, and the canary runs. The review expires after 24 hours and is invalidated by any change to GHL workflows or custom fields, so add a visible "review current / expired / changed" status and an alert before it lapses, so projection does not silently stop again.

## Grep and gate checks (must pass before publication)
- Every GHL write call site passes through the CRM authority check; no direct provider write helper is reachable from the tick without it.
- No code path in this task enrolls contacts in sequences or workflows, or sends messages.
- Attempt counter increments occur only on provider calls (search the claim and outcome code).
- The shared worker groups still list the sync group only under the isolated group name.
- Static scanners for pause authority and sender policy still pass.

## Kill lines
- Enabling the worker would start any write the owner's native-workflow review has not approved, or would export historical or test-class contacts without approval.
- The control or runtime record cannot be read in production, so the cause cannot be established; report instead of guessing.
- Any step needs the agent to approve its own review, unpause outbound, or change provider budgets.
- The canary shows duplicate GHL contacts, unexpected native workflow triggers, or rising errors: stop, leave the control disabled, report.

## Test requirements
Disposable database with fake GHL transport and the real worker: more than 8 deferral cycles then capability recovery and ordinary success; provider failure to bounded terminal; ambiguous response keeps evidence and is not retried blindly; concurrent workers claim each row once; stale deployment and stale owner are refused with the right reason; reconciliation repair is idempotent and skips completed, terminal and ambiguous rows; test-class and historical rows are not exported; tick phases are gated; appointment update and reschedule events; per-contact state read. Register in the existing disposable roster.

## Acceptance by stage
- Implemented: all tests pass; owner receives the classified backlog counts and the native inventory comparison.
- Published: served SHA matches, selected groups include the sync group, runtime truth reports the selection reason, control still disabled until the owner approves the review.
- Production (needs the owner's review approval to switch on): timestamped snapshots across multiple ordinary cycles showing claims, provider receipts, saved GHL ids, shrinking age of current-intake rows, and no change to the paused outbound and promotional state. Without approval, report "built and published, blocked awaiting owner review approval".

## Done looks like
The GHL sync worker is selected and owned in production with an explicit reason on screen, deferred projections can no longer strand, current intake reaches GHL automatically with receipts, the backlog is dispositioned by an owner-approved policy, and bindings and calendar events are verified.

## Out of scope
Message copy, rendering and journeys (companion task); activating GHL workflows or campaigns; promotional sending and enrollment; bulk replay of the historical cohort without owner approval; provider spending controls.

## Relevant files
- `.replit`
- `server/services/ghl-sync.ts`
- `server/services/ghl-sync-runtime.ts`
- `server/services/ghl-sync-control.ts`
- `server/services/background-profile.ts`
- `server/services/ghl-form-sync.ts`
- `server/services/ghl-workflows.ts`
- `server/services/ghl-workflow-enrollment.ts`
- `server/services/sdr/ghl-client.ts`
- `attached_assets/LIBERTY_PUBLIC_FORMS_AND_GHL_AUDIT_2026-10-23_1792770808627.md`
