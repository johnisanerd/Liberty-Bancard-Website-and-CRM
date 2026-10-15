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
The existing read-only observer was bounded to the next new commit,
current-pass completion or its observation deadline; its terminal result is
recorded below. Current hold qualification was unfinished at this observation
and was subsequently performed as documented below. Ordinary-upload restart
acceptance remains separate and unproven; no live fault or controlled replay
was run.

## Current-facts qualification and consolidated recovery correction

The subsequent read-only qualification did **not** wait for another writing
cycle. Production-scoped, bounded native-reader evaluations covered all
153,906 unresolved active production contacts between 11:58 and 12:18 UTC.
This was a sequence of observed snapshots, not a single atomic snapshot.
Replica recovery conflicts were retried at the same cursor; no timeout was
increased and no records were skipped. The empty final page established scope
exhaustion. The unchanged active/verified/unresolved totals corroborate, but
do not replace, the per-batch evidence.

| Current relationship result | Contacts |
| --- | ---: |
| Unique relationship passes the native reader | 5 |
| Candidate exists but current reasons deny qualification | 9,834 |
| Independent business candidate not found | 144,067 |
| Total | 153,906 |

The five eligible contacts are 494, 1057, 1074, 4741 and 8964. Their old
contact/evidence dates explain why a change-only window can continue skipping
them. These are preview qualifications, **not** new committed assignments.
Eleven contacts have supported structured business evidence but still lack
independent corroboration; the reader does not treat that metadata alone as
assignment authority. No-candidate records require additional independently
supported business identity; this report does not manufacture businesses from
company strings or claim those records were fulfilled.

All 626 organization exceptions were evaluated against current candidates
using business fields projected from the original retained rows, the actual
provider column mapper and the actual organization decision policy. Original
raw rows were available for every coordinate, with no conflicting aliases for
the stable place/organization key. The deployed policy still defers all 626.
This does not mean every deferral is a genuine exception: two rows differ
only by the US country-code representation of the same phone number.
Under the corrected policy and fresh candidate retrieval, **624 remain
ambiguous and 2 match business 86280**. Candidate-level conflict facts are
retained in private evidence, rather than inferring justification from
matching historical pins. Name, real phone, address, place and location
conflicts remain substantive; arbitrary international prefixes are not stripped.

The 87 affiliation exceptions were separately compared with current contact
projections, current verified decisions and current native relationship reasons:

| Current original-row affiliation result | Rows |
| --- | ---: |
| Protected verified assignment to a different business | 56 |
| Relationship evidence still unresolved | 29 |
| Expected assignment already verified; fulfillment receipt stale | 2 |

Of the 29 unresolved rows, 17 have a company/trade-name conflict, 1 has
company-name conflict plus missing corroboration across alternative candidates,
and 11 lack independent corroboration. The 56 foreign assignments must not be
transferred merely to satisfy an imported row.

The two stale originals are contacts 161491/161493, expected/current business
3538, on original items dc232b69-ab61-4ae8-9d18-8160a20da2e2 and
2448e7cd-3e25-4ade-b83a-3160c2911fbe. Their immutable `created` accounting
excluded them from both ordinary selection and claim renewal, despite their
versioned original-row hold evidence. Accounting was not rewritten.

### Corrections in the same existing workflow

- Admit `created`/`matched_noop` partial rows only with a supported blocked/running
  original item and same-item versioned hold evidence bound to its original
  execution, coordinate and fingerprint. Selection and every authority renewal
  use the same predicate; raw identity, owner, token/lease and writer fences stay
  in place. Arbitrary created rows remain excluded.
- Evaluate the already-bounded raw contact page before applying the change-window
  optimization. A currently eligible relationship is reconsidered even when old;
  unchanged ineligible rows remain omitted. No cursor/window/backfill reset is
  required. The transient optimization flag is excluded from snapshot authority.
- Compare a US ten-digit phone and its `+1` form consistently in organization
  retrieval and decision policy. Retrieval uses exact digit variants, not a
  function wrapped around every stored phone; real/international differences and
  competing candidates remain protected.

### Verification and remaining production acceptance

Disposable PostgreSQL checks: incremental pages 19; existing contact-link worker
59; organization resolver 23; partial-accounting recovery 13. The partial-row
test uses the ordinary tick, proves actual mailbox reuse with a unique-row count,
completes all retained mailboxes, matches an existing ten-digit-phone business,
preserves immutable accounting, excludes unsupported holds, and retains a
genuine protected foreign affiliation without a fulfillment receipt or transfer.
No provider or outbound I/O was admitted.

The complete repaired original-row selector, including original raw extraction,
executed in approximately 1.85 seconds in a production-scoped replica
`EXPLAIN ANALYZE`. Locking was removed **only for that read-only replica
measurement**; actual locking/renewal was exercised in disposable PostgreSQL.
This is not primary production write acceptance.

Private coordinate-level evidence remains ignored under
`generated-artifacts/intake-incremental/`, including `qualification-complete.json`,
`current-organization-qualification.json`, `current-affiliation-qualification.json`
and `repaired-original-claim-plan.json`.

These application corrections require one consolidated publication before the
ordinary production workers can demonstrate their effects. They have not been
published or force-applied by this audit. The original bounded observer's
terminal result is recorded below: advancing scanned/held counters do not prove
a third assignment-writing cycle. Keep the continuation open for subsequent
production receipt/assignment reconciliation after the consolidated publication.
Outbound remains paused. No new task/pipeline, reset, re-upload, forced link,
live fault or controlled production replay was introduced.

## Bounded observer terminal reconciliation

The observer exited with code 0 after its observation window elapsed, not
because an assignment or full-pass acceptance condition succeeded. Its 128
retained authenticated samples span **11:10:16–13:16:41 UTC on October 15**,
including the earlier samples carried forward by the resumed observation.

- Every sample served `95ba3eaf34d69beaa79e4151fa4b0470329d8099`.
  A fresh public health request after the observer exited still served that
  revision. The consolidated recovery repairs are therefore not yet live.
- The cursor advanced from **7,678 to 162,936** while preserving the original
  run ID and exact pass-start/change-window strings.
- Scanned attempts rose by **17,953**, and held attempts rose by the same
  amount. Committed assignments stayed at **22** throughout these samples.
- Every sample had `lastError=null` and current population evidence. No sample
  reported current-pass completion.
- The terminal population remained **157,446 active contacts, 3,540 currently
  verified assignments, 153,906 unresolved contacts**, and zero legacy-only
  projected assignments.

This establishes continued error-free checkpoint progress during the observed
interval, not a third distinct assignment-writing cycle, a completed incremental
pass or original-row fulfillment. The observer's import summaries do not replace
coordinate-level fulfillment receipts. Its clean process exit must not be
reported as production acceptance.

The existing continuation remains open. After the owner publishes the tested
consolidated corrections, verify the actual served identity and ordinary-worker
assignment/receipt outcomes without changing the retained run, cursor, window or
original import accounting. No additional old-build observation was started,
and no production reset, replay, forced link or outbound-control change was
made to obtain this result.
