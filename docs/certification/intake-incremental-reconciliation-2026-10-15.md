# Intake / Business Assignment: incremental continuation

## Status

The bounded incremental correction is implemented and locally certified.
The owner subsequently published it; served revision, indexes, preserved
authority/window and ordinary cursor recovery are verified below. Full
production assignment/original-row acceptance is **not yet complete**.
This continues the original intake/business-assignment work; it is not a new
pipeline, task, full backfill or import.

## Focused preflight

At 2026-10-15 10:12:22 UTC, the production-scoped read returned:

- Existing program enabled; rule `independent_guarded_system_links_v2`.
- Completed initial backfill retained; incremental cursor **0**, pass incomplete.
- `changedSince = 2026-10-03 13:06:25.56618+00`.
- `scanStartedAt = 2026-10-14 23:22:29.253717+00`.
- Cumulative attempts: 157,926 scanned, 18 committed, 157,908 held.
- Error checkpoint updated at 10:11:39 UTC, after the previous publication.

Fresh deployment logs independently show the first-stage selection fingerprint
`e7a95c1373a9ff7d` failing at approximately 30 seconds with SQLSTATE 57014 and
available pool capacity. This is a selection failure, not evidence of successful
assignment or a reason to raise timeouts.

The serving revision before this correction was
`ab6304eca6e42831e12fab2cb0a2415e1692e334`; the publication-marker commit had
not changed the selector. Production is a public Reserved VM deployment.

## Correction and invariants

1. The loader inspects at most `limit + 1` ordered raw IDs **before** any source,
   registry, business or evidence query. The lookahead is not hydrated.
2. Change checks run only on the inspected IDs. Equality-first parameterized
   branches retain name, domain, projected business, filing/place keys, source
   events, source-link revisions, registry aliases/revisions and business changes.
   They do not narrow record class, source family or filing presence.
3. Retained-key source-link probes explicitly require a revision at or after
   `changedSince`. An old unchanged key is not selected. New source events have
   their own timestamp-qualified route.
4. The loader and preview expose `inspectedThroughContactId` and `passExhausted`
   independently of changed rows. `nextCursor` follows raw inspection.
5. The worker checkpoints after each completed changed contact. Only after all
   changed rows finish may it checkpoint the inspected unchanged tail. Empty
   unchanged pages advance without incrementing attempts/holds or completing early.
   Interruption, deadline, owner and lease loss leave unfinished changed contacts
   ahead of the saved cursor.
6. The existing pass rollover alone advances the window to the previous native
   scan start. No JS Date conversion, manual rewind, backfill reset or new run
   identity is used. Existing pause, owner/token fences and canonical writer
   protections remain in place.

The audit's timestamp-bypass allegation was not independently reproduced against
the original expanded predicate during preflight. The replacement makes the
required timestamp conjunction explicit for each source-key alternative, and the
real-DB old-key/new-revision regression passes. Do not claim a reproduced
false-positive defect solely from the audit's textual parentheses interpretation.

The full-scope registry indexes include revision as their second key. Bounding
contacts and indexing names alone was insufficient: empty normalized names can
match a large NULL-DBA population. Timestamp predicates must remain inside each
registry branch, not only outside its UNION.

## Verification

All successful certificates are local/disposable or development-only:

- `contact-incremental-pages`: **17 checks**, actual PostgreSQL loader, exact saved
  change-window precision, empty/sparse/final pages, point refresh, name/domain/
  retained-key source-link changes, registry name/DBA/filing changes, source-only
  events and behind-cursor changes. Includes 20,000 decoy businesses and 20,000
  registry rows, half with historical NULL DBA; executed selector/hydration plans.
- `test-contact-incremental-checkpoints.ts`: **12 checks**, actual compiled worker
  with injected boundaries: unchanged progress, writer interruption/restart,
  final exhaustion, next-pass rollover, owner loss, expired lease and deadline.
- `canonical-contact-link-automation`: **59 checks**, real migrated disposable
  PostgreSQL/Redis and real native writers. Adds unchanged-page resume, unchanged
  attempt counts and a later committed assignment to the existing tests for
  protected writers, owner/lease fencing, explicit off, graph contention,
  three eligible ordinary committed cycles and the existing serial processor.
  Provider, enrollment and communication counts are unchanged; no external
  provider attempts occurred.
- `contact-source-only-reconsideration`: **6 checks**, retained source additions
  without touching contact timestamps; last-seen refresh does not alter snapshots.
- Full `npx tsc --noEmit`: passed.

The development measurement used **164,610 contacts, 3,768 businesses,
1,919,456 registry rows and 295 source links**. Four actual 25-ID changed-window
pages after IDs 0, 153674, 159881 and 160660 had total loader times approximately
922 ms, 1,852 ms, 290 ms and 17 ms. Their repeated executed selector plans took
approximately 1–2 ms. A separate cold saved-scope measurement recorded 71 ms
execution and 5 seconds planning; planning is not omitted from the evidence.
These four development pages were unchanged, so they do not measure production
writer progress or changed-page hydration. The disposable changed-page test
separately captures hydration execution.

Private detailed SQL/parameters/plans and current-row evidence are in ignored
`generated-artifacts/intake-incremental/`. Development counts and replica
measurements do not substitute for production primary-request acceptance.

## Current populations, kept separate

Production-scoped snapshot at **2026-10-15 10:26:34 UTC**:

| Unique active production contacts | Count |
|---|---:|
| Total | 157,446 |
| Current verified canonical assignment matching projection | 3,536 |
| Unresolved | 153,910 |
| Legacy projected without current verified assignment | 0 |

The 153,910 unresolved contacts do not have current projected business IDs.
The completed initial pass does **not** establish that every one is correctly
held under current evidence. Current per-contact qualification into recoverable
source-backed, insufficient-evidence and genuine conflict outcomes remains
unfinished. Assignment is not outreach eligibility.

At **2026-10-15 10:30:23 UTC**, one statement reconciled all **713 exact historical
item/execution/row/fingerprint coordinates**. Every original coordinate and
fingerprint matched the retained historical set.

- October: 553 exceptions across five original executions; September: 160.
- Reasons: 626 organization-match blocks, 87 affiliation holds.
- Mutable item states at this instant: 712 blocked, one running affiliation retry.
  Running is not fulfilled; ordinary retries can change this snapshot.
- All 713 have versioned hold receipts, dated from October 14 13:03:44 UTC through
  October 15 10:30:17 UTC. **Zero** current `mailbox_business_identity_v2`
  fulfillment receipts.
- Original accounting, source-event fingerprints and saved native snapshot IDs
  attribute these exceptions to **203 distinct active production contacts**:
  **163 currently verified**, **40 unresolved**. **169 rows** overlap verified
  contacts. These are subsets of the contact population, not an additional
  missing-contact denominator.
- 498 exception coordinates have no attributable contact in those receipt
  paths. This is not proof of 498 missing contacts or mailbox-bearing rows.
- The initial audit reported 74 matching affiliation snapshots and 13 changed
  pins. That was overstated: the post-publication audit below corrects 11
  timestamp-rendering false positives, leaving 85 matching and two changed.
  Matching recorded pins does not test newly competing candidates, every identity dimension or
  the complete original-mailbox fulfillment contract. It is not full hold
  recertification.
- Of the 87 affiliation rows, 56 reference verified contacts belonging to a
  **different** business from the row's expected business, 29 reference unresolved
  contacts, and two reference a verified expected-business assignment. Even those
  two are not certified original-row fulfillment. Protected relationships must
  not be transferred to improve counts.
- The 626 organization hold candidate sets likewise still require full current
  resolver requalification; a stored hold receipt is not proof that no new
  candidate/evidence has appeared.

No row state, source data, checkpoint, lease, control or assignment was manually
changed to produce these production observations.

## Publication and remaining acceptance

The managed Publish diff was independently inspected: **exactly five additive
nonunique indexes**, no structural data loss, no non-backwards-compatible changes
or warnings. No startup/build production-DDL runner was added. Development
delivery is the existing migration/schema path; production delivery is Publish.

After the owner publishes the consolidated correction:

1. Pin `/api/health` to the correction's actual served SHA/build; inspect the five
   production indexes and current selected native/runtime authority.
2. Verify continuation of the saved run/backfill/window, not manual reset.
3. Observe at least three eligible ordinary cycles through the existing reader
   and queue path. Require durable checkpoint movement, fresh error-free
   diagnostics, and independently verified committed decisions when linkable work
   is eligible. Raw inspected IDs, replayed receipts, queue completions and import
   summaries are not committed assignments.
4. Reconcile population deltas and original-row outcomes again, especially
   changed hold pins, foreign protected relationships and missing current
   qualification. Replica data alone does not prove primary request performance.
5. Keep original retained replay and controlled physical ordinary-upload restart
   acceptance separate. Neither has been performed in this continuation.

Production outbound pause was read as **paused, epoch 1**. No outbound, provider,
schedule, timeout or pool-size control was changed. No workbook was reuploaded,
ambiguous relationship forced or production fault/replay test executed.

## Post-publication observations

At 2026-10-15 11:08–11:16 UTC, the public production health endpoint served
`95ba3eaf34d69beaa79e4151fa4b0470329d8099`, build
`d0e863b8-52e1-49b8-870a-6c12215d2c84`, built at 11:03:58 UTC.
This is the tested correction plus the attached audit report. The deployed
application files and migration are unchanged from the tested correction.

- All five indexes are valid and ready on production.
- Selected native runtime owner epoch 204 matches the served SHA and build,
  is not revoked, and has a live lease.
- The original run ID, completed backfill and exact saved change-window/pass-start
  strings are preserved; no administrative run/reset/tick/replay was invoked.
- Production cursor moved from 0 to 18,821 by 11:16:11 UTC. Repeated authenticated
  primary API observations show durable movement with `lastError=null`.
- Four independently queried new verified decision receipts, at 11:04:25,
  11:04:37, 11:05:22 and 11:05:30 UTC, match their contacts' current projected
  businesses and production record class. Cumulative committed count rose
  from 18 to 22; unique current verified assignments rose from 3,536 to 3,540.
- At 11:16:11 UTC the active population remains 157,446, with 153,906 unresolved
  and zero legacy-only projected assignments. Later inspected/scanned/held
  increments are **not** additional successful assignments.
- The existing serial queue completed multiple ordinary jobs. Original-row
  recovery logs report bounded held attempts, zero fulfilled, zero failed and
  zero cleanup failures. Queue completion is not fulfillment.

The 11:12:56 UTC production-scoped reconciliation preserved all 713 exact
coordinates/fingerprints and the same contact overlap: 203 distinct contacts,
163 verified, 40 unresolved, 169 rows overlapping verified contacts. All 713
were blocked at that instant: 626 organization and 87 affiliation holds.
There are still zero current-version original-row fulfillment receipts.

The audit-only SQL comparator previously compared a registry `timestamp::text`
against a snapshot produced by `to_jsonb(row)->>'updated_at'`. These render the
same instant differently. Comparing with the snapshot producer's actual
extractor removes 11 false positives: **85 recorded affiliation pin sets match;
two genuinely changed**. Both changed snapshots predate verified assignments
to the expected business, but their original items remain blocked with no
current fulfillment receipt. No hold, item, assignment or pause was changed
to manufacture this result. This SQL/report correction does not change the
deployed application or require another publication.

Sustained successful inspection is established. Three distinct ordinary
assignment-writing cycles are not yet established: the four confirmed new
assignments occurred in two early cycles, followed by unchanged/held work.
The existing read-only observer continues, bounded to the next new commit,
current-pass completion or its observation deadline. Full current hold
qualification and ordinary-upload restart acceptance remain separate and
unproven; no live fault or controlled replay was run.
