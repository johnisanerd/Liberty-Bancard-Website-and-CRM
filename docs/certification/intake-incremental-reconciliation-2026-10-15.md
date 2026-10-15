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

At completion of local certification these application corrections required one
consolidated publication before ordinary production workers could demonstrate
their effects. That publication and initial recovery proof are recorded below;
the corrections were not force-applied by this audit. The original bounded observer's
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

## Consolidated publication and automatic original-row recovery

The owner's subsequent publication serves revision
`ca10a6d350e439f5b045cd7bd44af276e279e949`, publish build
`0c7f494d-83d3-4913-a866-320e5911832b`, built at
**2026-10-15 13:32:32 UTC**. Production health is `ok`. The selected native
runtime authority advanced to epoch **205**, matches this served revision, has
a live lease and is not revoked. Outbound control remains **paused, epoch 1**.

Authenticated primary reads show the same original run ID and completed-backfill
flag. The incremental window rolled normally at **13:18:13 UTC**, before this
publication: its new `changedSince` is the preceding pass's exact start,
`2026-10-14 23:22:29.253717+00`. This is the existing natural rollover, not an
administrative cursor/window reset. After publication the worker continues
advancing with `lastError=null`.

### The two stale originals are now fulfilled

Ordinary production recovery completed the two original items without a manual
tick, replay, re-upload or manufactured receipt:

| Original source row | Existing contact | Expected business | Completed UTC |
| --- | --- | --- | --- |
| 479 | 161491 | 3538 | 13:40:00.691684 |
| 480 | 161493 | 3538 | 13:40:37.263877 |

Both items are `completed / CANONICAL_LOCAL_IMPORT_FULFILLED` and have fresh
`mailbox_business_identity_v2` receipts written by
`system:canonical-import-recovery`. Independent read-only checks establish:

- Original execution, row number and fingerprint match the retained historical
  coordinates and the new receipts exactly.
- Immutable accounting remains `created`; it was not rewritten to `deferred`.
- Every email in each retained original row matches the fulfilled contact set.
- The existing contacts remain production-class, currently verified and projected
  to canonical business 3538, with their prior verified decision IDs retained.
- Neither receipt is an explicit replay. Both record zero paid-provider calls
  and zero outbound changes.

The subsequent complete original-coordinate aggregate reconciles **713/713**
fingerprints, **2 completed items with current fulfillment receipts**,
**711 blocked**, and zero running at that observation. Recovering a receipt for an
already-verified assignment does not create a new assignment or increment the
contact-link worker's committed count.

### Acceptance still open

The two phone-format-only organization originals had not retried at the latest
coordinate-level observation; their old blocked states are not new-policy
denials. The five previously eligible old contacts also remained unassigned in
the initial post-publication checks. Their IDs were already behind the active
cursor when the new build started, so they require ordinary traversal after
natural rollover; no manual rewind or forced linking was performed.

The separate read-only observer is pinned to the new served revision and retains
its samples across observation-process resume. It checks authenticated primary
worker status, population, import summaries and the seven relevant contact
projections. Its bounded window and notifications do not substitute for durable
receipt verification. Full five-contact recovery, the phone-format originals
and a third distinct ordinary assignment-writing cycle remain pending.

Private primary observations, coordinate/fingerprint aggregates and the
independent original-mailbox/assignment proof are saved under ignored
`generated-artifacts/intake-incremental/consolidated-publication-*`.
Keep this existing continuation open; no additional owner action or publication
is required merely to let the currently running workers continue.

## Upload-wide status reconciliation, approximately 14:17 UTC

The owner's subsequent status question covers all uploaded rows, not only the
713 historically retained exceptions. Read-only production queries and fresh
authenticated primary observations therefore distinguish these scopes:

| Upload scope | Original rows accounted | Rows with at least one currently verified production contact/business link | Current-version original-row completion receipts |
| --- | ---: | ---: | ---: |
| Five XLSX workbooks | 2,914 | 2,401 | 10 |
| Additional CSV | 1,472 | 1,174 | 1,310 |
| All six uploads | 4,386 | 3,575 | 1,320 |

All six import executions are `completed`, but that is execution/accounting
status, not full row fulfillment. Original dispositions remain immutable.
For the workbooks those original outcomes are 2,468 created, 12 matched without
change, 420 deferred and 14 failed. They are not 2,468 unique currently linked
contacts, nor do historical deferred/failed dispositions necessarily describe
the current recovery outcome.

At this observation, 3,066 original items remain blocked across all uploads:
2,353 carry `STAGING_RECIPE_DISABLED`, 626 organization-match holds and 87
affiliation holds. The five workbooks account for 2,904 blocked items, and the
CSV for 162. These are original-item states, not counts of missing contacts.
Existing linked contacts and final complete-original-row receipts are different
checks; business-only rows can also complete without a contact mailbox.
The 713-exception subset must not be presented as the entire upload backlog.

The separately queried active production-class contact population is
**157,446**, with **3,540** current verified canonical-business links and
**153,906** unresolved. The assignment dashboard's broader population is
**157,449 / 3,540 / 153,909** because it also includes **three active `unknown`
intake contacts**; this is a predicate difference, not an unexplained replica
count discrepancy.

The two original stale-affiliation rows remain completed. The two phone-format
originals did subsequently retry at approximately **13:51 UTC**: organization
matching now reaches business 86280, but both originals remain held because
their newly materialized contacts lack independent relationship corroboration.
Their actual native reasons are `independent_corroboration_required`, not a
remaining phone-format organization ambiguity. They are not certified complete.

The complete original 713-coordinate set still matches every retained
fingerprint: two completed, 624 organization holds, and 87 affiliation cases
(86 blocked and one ordinary retry running at this particular read).
The initial five older eligible contacts are still pending ordinary traversal;
the primary cursor reached **114,408** at 14:16:45 UTC with `lastError=null`
and cumulative committed count still 22. No additional assignment-writing cycle
is claimed. The continuation remains open, and outbound controls were unchanged.

Private upload-wide, per-execution, source-contact and current-reason evidence
is retained in ignored `generated-artifacts/intake-incremental/contact-workbook-status*`.

## New ordinary commits and natural rollover, 14:49–14:53 UTC

The new-commit observer notification was independently reconciled against
production-scoped decisions, their native system-evidence rows and deployment
worker logs. It is not merely an increase in inspected or held attempts.

- At **14:50:06.929 UTC**, the ordinary worker logged cumulative committed
  count **24**, up from 22, and `complete=true`. The two new decisions are
  contacts **163039/163040 → business 86280**, created at **14:49:57.359940**
  and **14:50:03.520169 UTC**. Each has matching current `verified` decision,
  contact projection and native `crm_evidence_identity_v3` system-evidence row.
- At **14:50:37.904593 UTC**, the existing worker naturally started its next
  pass. `changedSince` advanced to the preceding exact native pass start,
  `2026-10-15 13:18:13.083464+00`. The original run and completed-backfill flag
  remain unchanged. No administrative reset or tick was invoked.
- A second ordinary worker result at **14:52:09.313 UTC** logged cumulative
  committed count **27**, up from 24. Three of the five previously qualified
  older contacts now have actual current verified assignments:

| Contact | Canonical business | Decision created UTC |
| --- | --- | --- |
| 494 | 76073 | 14:50:48.591492 |
| 1057 | 68387 | 14:51:03.077910 |
| 1074 | 62669 | 14:51:04.668181 |

All three remain production-class. Their stored evidence contact/business IDs,
current decisions and projected business IDs match. Contacts **4741 and 8964**
were still unlinked at **14:53:32 UTC**; five-contact recovery is not yet
complete. These two new assignment-writing worker cycles also establish the
previously missing third distinct cycle when combined with the two earlier
confirmed cycles; they are two new cycles, not five cycles counted from five
decisions.

The two phone-format contacts' assignments do **not** yet establish original-row
fulfillment: both contacts still have record class `unknown`, and both original
items remain blocked with their prior affiliation hold and no current-version
completion receipt at the subsequent original-item read. Do not describe that
old hold as a fresh native rejection of their now-verified assignments.

The **14:53 UTC** population query separates record classes:

| Record class | Active contacts | Current verified links | Unresolved |
| --- | ---: | ---: | ---: |
| Production | 157,446 | 3,543 | 153,903 |
| Unknown intake | 3 | 2 | 1 |
| Broader assignment population | 157,449 | 3,545 | 153,904 |

The latest captured program remains enabled with `lastError=null`; production
outbound control is still **paused, epoch 1**. No application, provider,
outbound, run, cursor or original-accounting change was made by this observation.

### Legacy staging backlog is not ordinary retry progress

Read-only inventory of the **2,353 `STAGING_RECIPE_DISABLED` items** confirms
that every item is blocked, due, originally `created`/`matched_noop`, lacks
versioned native hold evidence, and lacks a current fulfillment receipt.
They comprise **2,268 created-contact rows, 12 matched-contact rows and 73
business-only rows** across the five workbooks.

The current recovery accounting contract excludes these created/matched rows:
its narrow admission requires supported native identity/affiliation hold
evidence and corresponding terminal codes, not `STAGING_RECIPE_DISABLED`.
The outer selector's staging terminal-code allowance does not override that
accounting condition. Thus ordinary waiting alone cannot certify or complete
these 2,353 originals. Their existing contact links must not be substituted for
full original-mailbox/business qualification, and their accounting must not be
rewritten to manufacture eligibility. This is a remaining upload-wide
reconciliation gap, not a currently justified business-identity hold or a new
task/pipeline.

The existing continuation remains open. Private durable-assignment, population,
worker-cycle and original-item evidence is retained under
`generated-artifacts/intake-incremental/natural-rollover-*`, with the staging
inventory in `legacy-staging-inventory.json`. The bounded observer remains
running; its future notifications still require independent reconciliation.

## All five older eligible contacts recovered, 15:00–15:01 UTC

The observer's five-projection notification was independently checked against
current production decisions and their native system evidence at **15:00:58 UTC**.
All five previously eligible contacts now remain production-class, with current
`verified` decisions, matching projected/canonical business IDs and matching
`crm_evidence_identity_v3` evidence contact/business IDs.

| Contact | Canonical business | Decision created UTC |
| --- | --- | --- |
| 494 | 76073 | 14:50:48.591492 |
| 1057 | 68387 | 14:51:03.077910 |
| 1074 | 62669 | 14:51:04.668181 |
| 4741 | 48120 | 14:53:51.383168 |
| 8964 | 38379 | 14:56:56.366285 |

Ordinary worker logs independently show cumulative commits rising **27 → 28**
at **14:54:11.109 UTC**, then **28 → 29** at **14:57:17.056 UTC**. Together
with the preceding two new writing cycles, these establish **four distinct
assignment-writing cycles on the consolidated build**, not a cycle per contact.
The five-contact recovery condition is now satisfied without a manual rewind,
reset, forced link or re-upload.

The new population read returns **157,446 production-class contacts, 3,545
verified links and 153,901 unresolved**. The broader assignment population is
**157,449 / 3,547 / 153,902**, including the three unknown intake contacts, two
of which now have verified links. The observer still serves the pinned
consolidated SHA/build, with the original run/backfill identity and
`lastError=null`. Outbound remains **paused, epoch 1**.

The two phone-format originals still have no current-version fulfillment
receipt at this read, despite their now-verified contact/business assignments.
The two earlier stale-affiliation originals retain their completed states and
current-version receipts. The **2,353 excluded staging-disabled originals**
also remain a separate upload-wide reconciliation gap. Neither contact
recovery nor the cycle condition certifies all uploaded originals as complete.
The existing continuation therefore remains open.

Private independent decision, population/pause, worker-cycle and original-item
evidence is retained under
`generated-artifacts/intake-incremental/five-recovered-*`.

## Upload recovery, older-contact linking and the per-upload ledger (not yet published)

Status: implemented, committed and verified in disposable PostgreSQL plus read-only production plans. Nothing below
is a production claim. Publication is performed by the owner; no production row, setting, cursor or provider
was changed. Outbound remains paused at epoch 1.

### What was wrong, and the reproduction

* Created/matched originals whose item sat in `STAGING_RECIPE_DISABLED` (no hold evidence, because the obsolete
  staging recipe never ran) were not admitted by the shared recovery predicate, so the ordinary worker never
  reached them. The new disposable phase `staging_disabled_created` first FAILED at the selection check before the
  predicate change, and passes after it.
* The replay-retained route (`/api/imports/.../replay-retained`) returned 500 because its scope query did not
  provide the predicate's `item`/`accounting`/`observation` aliases. Fixed together with the predicate.
* A recovery failure echoing predicate SQL containing the literal `..._NATIVE_GUARD_MISSING` was classified fatal by
  the row-failure classifier (which pattern-matched the Drizzle "Failed query" message). A lock timeout on that
  statement aborted the whole tick instead of yielding. The classifier now ignores the echoed statement text and
  classifies on the database error itself; a regression assertion covers both directions.

### Admission contract (one predicate for selection, claim verification and renewal)

Created/matched originals in blocked/running/completed state are admitted only when the retained observation
fingerprint equals the immutable accounting fingerprint, the original raw row is retained (raw-v2/v3 or execution
payload), and the item is in one of: `STAGING_RECIPE_DISABLED`; a fulfilled item (explicit replay); or one of the
worker-authored retry codes accompanied by this worker's own receipt for the same execution/row/fingerprint.
Accounting and existing hold-evidence rows are untouched; no item is reset; the obsolete staging recipe stays
disabled; no hold evidence is fabricated.

### Disposable evidence (`run-retained-import-recovery-disposable.ts`)

* `--partial-accounting-only`: partial_accounting 13 checks; staging_disabled_created 43 checks (existing-record
  reuse with address/phone corroboration, multiple mailboxes, business-only, matched_noop, protected conflicting
  assignment held, retryable failure then ordinary-worker recovery, capability hold and restoration, owner/lease
  loss and resume, changed payload rejection on a retained coordinate, retained raw evidence governing replay over a
  mutated execution payload, replay without duplicate logical effects, ledger checks below).
* `--recovery-faults-only` (faults 8, restart 5, legacy 4), `--scoped-replay-only` (including HTTP replay) and
  `--linker-performance-only` pass.
* `--audited-only` / `--identity-only` fail at the "58 hold receipts" assertion (`0 !== 58`). The same failure
  occurs with these changes stashed, so it is pre-existing and not related; it is not being widened here.

### Older unchanged contacts reach the materializer

The change window no longer hides an older contact with supported materialization evidence, no assignment and no
decision. It is re-evaluated at most once per 24 hours per unchanged (contact revision, evidence revision) pair using
the materializer's own recorded outcome (`contact_link_materialization_outcome`, observation only, never
relationship authority). The recorded status and reason code are counted per contact as
`materialization:<reasonCode>`. A pre-existing contact without independent corroboration is correctly held
(`INDEPENDENT_ORGANIZATION_CORROBORATION_REQUIRED`); nothing is forced. Contacts 494, 1057, 1074, 4741 and 8964 were
already committed and are regression checks only.

### CRM changes

* New read-only, admin/manager endpoints: `/api/canonical-enrichment/uploads`, `.../uploads/:id/summary`,
  `.../uploads/:id/rows?after=&limit=&filter=`. The existing `/status` contract is unchanged (the capped 25-row
  lists remain for compatibility; the UI no longer uses them, and the original-availability probe now recognizes
  raw-v3 as well as raw-v2).
* The ledger pages every original coordinate of one upload in `source_row_number` order (stable keyset, limit 1..100),
  shows all mailboxes and business-only rows, recognizes raw-v2 and raw-v3, and validates receipts against
  coordinate, fingerprint and qualification version, reporting stale and inconsistent receipts separately.
  The summary reports rows, distinct contacts, verified links and receipts as separate measures that are never added.
* Production-scale plan check (read-only `EXPLAIN ANALYZE` on the 1,472-row September upload, 100-row page):
  accounting page 116 ms, retained originals 165 ms, mailbox provenance/links 49 ms, summary links 230 ms,
  summary receipts 187 ms after removing a redundant `entity_type` predicate that had caused a 2.9 s plan. The
  execution-payload fallback is read only for coordinates without a retained observation (extracting 100 elements
  from the large payload cost 1.5 s).
* `contact-link-population.ts` now reports `totalActiveNonTest` (production plus any other non-test class such as
  `unknown`), `totalActiveProduction` (production class only) and `otherNonTestClass` separately; the former
  name no longer covers a wider population than it claims.
* The Contact Link Coverage panel labels the full-pool census as frozen history (it classifies contacts at its
  watermark and does not change afterward), replaces the "rerun the separate preview/apply policy" instructions with
  the automatic workflow, and shows one card per source-recovery identity.
* Duplicate source-recovery cards, reproduced and fixed. A first diagnosis (several name keys per contact) was wrong:
  a contact has exactly one name key. The real cause is `raw_sunbiz_by_contact_business`, which joined each raw
  Sunbiz entity to its legal name AND its DBA and then to `business_name_keys`, where 142,602 of 167,687 production
  businesses emit the same key twice (canonical and normalized name). One unlinked entity was therefore aggregated
  up to four times per contact and business, and each copy became a separate card and a separate
  `rawSunbizMatches` entry (which also fed the "more than one raw match" ambiguity check). Reproduced first in
  disposable PostgreSQL (`test-intake-review-pages.ts`: four copies of one filing before the fix, one after), then
  measured with the real batch query on production (read-only, four 500-contact pages): 43/43, 76/76, 66/66 and
  84/84 contacts with raw matches carried a duplicated entity before; 0 after. Execution time did not regress
  (5.5 s old, 2.5 s new on the first production page). The client also de-duplicates by identity key, and the
  rendered-panel test feeds duplicated raw candidates and fails without that de-duplication.
  Consequence: contacts that were flagged ambiguous only because one entity appeared several times are now
  evaluated as the single match they are.
* Checks run: `npx tsc --noEmit -p .` clean; `npm run build` succeeds; the ledger component renders in jsdom with
  paging, multi-mailbox, business-only and stale-receipt states (`UploadLedger.test.tsx`).
* `ContactLinkCoveragePanel.test.tsx` was stale and is repaired against the current panel: it now authenticates
  through `transitionProtectedActor`, drives the server-owned census (resume, pause, completion observed by
  refresh, and no browser-driven step), expects automatic evidence attachment instead of a manual evidence picker,
  and covers the frozen-history note, the automatic-workflow text and the duplicated-candidate case. It passes.
* `contact-link-coverage.source.test.ts` and `contact-link-coverage.execution.test.ts` had drifted from the current
  query (CTE shapes, `SET LOCAL jit`) and fail at baseline; both are updated and pass.
* Not repaired: `test-intake-review-pages.ts` fails at baseline at the plan assertion "Full-page source namespace
  probe must execute its index" (same failure at the original baseline commit). Every assertion before it,
  including frozen-query parity with the prior implementation and the new duplicate check, passes.
* Signed-in rendered pages, verified in a cloud browser. A private, disposable app (its own PostgreSQL and Redis,
  synthetic accounts, real login form, provider calls denied, no session injection) served the production build of
  commit 8d4c4066 over the public preview host, and an isolated cloud browser signed in through the real form as a
  synthetic admin. On the Canonical Enrichment page, Imports & Sources tab, the upload ledger rendered for a six-row
  upload: original rows 6, distinct contacts 0, verified links 0, current receipts 0, stale 0, "Deferred 6", and the
  expanded row showed the original business name, the original reason, `STAGING RECIPE DISABLED`, "No receipt" and
  each mailbox with "no provenance for this row". On Lead Ops, the Contact Link Coverage panel rendered the "Frozen
  history" note, the automatic-workflow text (no manual preview/apply loop), and, for one unlinked Sunbiz entity
  whose legal name and DBA both match a business, exactly one source-recovery card (one checkbox, one filing) with
  no ambiguity conflict; the same page's candidate API returned one raw candidate. The fixture cannot show recovery
  outcomes, receipts for fulfilled rows, or production numbers; those need the published build and its workers.
  Not exercised there: the unrelated "Find company matches" preview (its route is not registered in the isolated app).

### Remaining action and acceptance

The owner must publish the committed revision. After publication: verify the served revision; observe ordinary
workers committing assignments and receipts for created originals and older contacts; report before/after rows,
distinct contacts, verified links and receipts per upload (five workbooks, 2,914 rows; September import
`79356e0b`, 1,472 rows) and for the contact population. Counters, passing tests and completed jobs are not recovery
evidence; per-contact materializer outcomes and committed rows are.

## Publication of the upload-recovery build, 18:14–18:26 UTC

Production health served `a0ea8598f5eb41e105dfc89c905eace7c5338f79`, build `e128252a-c85a-4f71-872e-33632190685c`
(built 17:55:23 UTC), at 18:18 UTC. Production queries below are read-only (replica) and used the ledger's own
definitions: a current receipt is a completed `CANONICAL_LOCAL_IMPORT_FULFILLED` item with a matching
`canonical_import_row_fulfilled` audit row at `mailbox_business_identity_v2`. No row, setting or cursor was changed,
no administrative run/replay was invoked, no paid call or re-upload was made, and outbound stays paused.

| Upload (execution) | Rows | Current receipts, 14:17 → 18:19 → 18:25 | `STAGING_RECIPE_DISABLED` open, 18:19 → 18:25 |
| --- | ---: | ---: | ---: |
| 6623a227 | 653 | 0 → 40 → 55 | 516 → 501 |
| 6b28085c | 633 | 0 → 2 → 2 | 527 → 527 |
| 79356e0b (September CSV) | 1,472 | 1,310 → 1,310 → 1,310 | 0 → 0 |
| 83e594ce | 537 | 7 → 36 → 49 | 369 → 356 |
| 9cd520f7 | 513 | 0 → 3 → 3 | 419 → 419 |
| b070a72b | 578 | 3 → 46 → 46 | 407 → 407 |
| All six | 4,386 | 1,320 → 1,437 → 1,465 | 2,238 → 2,210 |

The 14:17 reads recorded only the 2,353 total of staging-disabled originals (not per upload), so that column starts at
the first post-publication read at 18:19. Receipts rose by 145 from 14:17 and by 28 in the six minutes between the
two post-publication reads, so the ordinary recovery worker is committing created originals that were previously
unreachable. Verified-contact counts per upload moved only at 6623a227 (556 → 558); the others are unchanged
(6b28085c 524, 79356e0b 1,101, 83e594ce 443, 9cd520f7 391, b070a72b 487). Organization holds (626 → 626) and
affiliation holds (87 → 85 at 18:19) are separate from the staging-disabled population and were not forced.

Population: active production-class contacts 157,449 with 3,547 current verified links (3,547 at 18:19 and 18:25;
14:17 was 157,446 / 3,540). The contact-link automation program is enabled, cursor 14,543, `lastError` null,
`updatedAt` 18:25:09 UTC, 29 committed (unchanged), 0 replayed.

Per contact, the older-contact materializer wrote `contact_link_materialization_outcome` observations for 11
contacts between 18:14:26 and 18:15:44 UTC, all `matched` with a canonical business ID and zero provider calls or
outbound changes: 160787, 160788 (business 47089), 160876, 160877, 160879 (40238), 161230, 161232 (10205),
161535 (17851), and 162964, 162965, 162966 (71053). At 18:24:44 UTC none of the 11 has a contact business
assignment or current decision. They were scanned and held by the ordinary system policy; the aggregate hold reasons
are not attributed per contact, so this does not show why. They were not forced. Contacts 494, 1057, 1074, 4741 and
8964 remain verified (regression checks).

Not yet shown: that all unfulfilled originals are fulfilled, and any link for the 11 older contacts above. This
continues as ordinary worker progress; the item stays open.

## Unlinked-contact reconciliation and the matched-but-unlinked cause (read-only production, 2026-10-15 ~21:00 UTC)

One mutually exclusive partition of the 153,902 active production contacts without a business, using the evaluator's
own name/domain normalization and canonical businesses only (priority order, each contact in exactly one bucket;
sums to 153,902):

| Bucket | Contacts |
| --- | ---: |
| Retained structured business evidence (reached the materializer) | 11 |
| Domain and name agree on one unique canonical business | 15,246 |
| Domain and name agree, several businesses share a key | 2,160 |
| Domain and name point to different businesses | 89 |
| Domain only, one business | 8,538 |
| Domain only, several businesses | 1,393 |
| Name only, one business | 784 |
| Name only, several businesses | 1,020 |
| No canonical match; Sunbiz name and phone/address/website agree | 1,464 |
| No canonical match; Sunbiz name only, one entity | 13,301 |
| No canonical match; Sunbiz name only, several entities | 1,238 |
| No canonical or Sunbiz match | 108,631 |
| No company name | 27 |

The earlier figures (26,032 unique + ~3,800 ambiguous + 126,156 unmatched; 15,187 versus 15,240; 76 conflicts) were
overlapping sets built with different normalizations, which is why they exceeded the population. The 15,246 /
89 above replace them. The worker's cumulative `reasons` counters count contact-passes across the backfill and
incremental cycles; they are not a contact population and must not be compared with these buckets.

Why the 15,246 "domain+name agree" contacts are not links: for 14,794 of them the matching business has no
canonical source link at all (a candidate row from SDR dedupe exists for 14,817), i.e. the business was derived from
the same contact data, and copying that agreement would be self-corroboration. Only 452 of the 15,246 have a business
with any independent source link; all 452 fail `independent_corroboration_required`, and 294 also fail
`location_state_conflict` (253 contacts recorded in Alabama against a Florida business), 2 fail registry/trade name
conflicts. They stay held for those specific reasons.

Cause for the 11 matched-but-unlinked contacts (160787, 160788, 160876, 160877, 160879, 161230, 161232, 161535,
162964-162966; businesses 47089, 40238, 10205, 17851, 71053): the materializer matched existing Sunbiz-bootstrap
businesses by name+city+state but did not pass the original Outscraper `place_id` to the resolver. Those businesses
already own an `outscraper/place` source link with that exact key, but `businesses.google_place_id` was NULL, so the
evaluator's maps branch saw no stable identifier and every alternative failed `independent_corroboration_required`.
Substituting the established place key makes all 11 evaluate with no rejection reasons. System-wide 23 businesses
(27 unlinked contacts with exact event place ids) are in that state; 19 contacts clear corroboration, 8 of those also
carry a real `company_or_trade_name_conflict` and stay held; 18 other contacts whose business already has the column
set fail `company_or_trade_name_conflict` and stay held.

Repair (code, certified on a disposable database, not yet in production): (1) the materializer passes the original
retained place id to the resolver; (2) a blank-only, exact-source-link, unique-owner mirror of the established place
identity (`mirrorEstablishedPlaceIdentity` / `mirrorEstablishedPlaceIdentities`, audited as
`business_place_identity_mirrored`) runs in the ordinary worker before each scan; (3) materializer outcomes carry a
rule version so contacts held by an older rule are revisited without waiting 24 hours. No contact field is copied as
corroboration; the ordinary canonical writer still applies the link. Certification: source-family materialization
42 checks, source-only reconsideration 13 checks, CRM link automation suite passed, `tsc` clean.

Correction to the original path assessment: the structural Sunbiz cohort is still in scope. The Sunbiz bootstrap
IS wired to the ordinary full-backfill worker, not only an admin route. The investigation below replaces the
incorrect admin-only conclusion; it does not defer these cases to manual review or discovery.

## Place-ownership correction and retained Sunbiz worker trace (2026-10-15 ~22:40–22:47 UTC)

The first batch mirror was unsafe: a per-business distinct-key count did not establish global ownership across
`outscraper`, `google_maps`, and `google` namespaces. Both single and batch now use the resolver's place advisory
lock (seed 1642), reject any other business's place source link even if both columns are blank, reject multiple
distinct place keys on the same business, and recheck source/column ownership in a fresh statement after row-lock
waits. Batch candidates are hints only; all their place locks are acquired in sorted order before any business-row
locks. The resolver also treats retained place links across all three namespaces as exact ownership evidence,
including contradictory links (which defer instead of creating another root).

Successful mirrors return `{businessId, placeId, sourceLinkIds}`. The worker writes one audit event per identity
inside the same transaction; the single materializer includes that identity in its existing per-contact audit.
The provider import re-resolves in its separate source-insertion transaction to retain the same place-lock fence
across that handoff. No changed-row audit is inferred from a batch count.

Disposable PostgreSQL certification: 26 ownership/concurrency assertions, including conflicting pairs of all
three namespaces, same owner across namespaces, multiple place keys on one root, resolver-first and mirror-first
operations with observed PostgreSQL advisory-lock waits, commit-time ownership revalidation, idempotency, and
competing single/batch mirrors with exactly one identity receipt. Source-family materialization: 42 checks;
source-only reconsideration: 13 checks; CRM relationship certification passed with zero external network attempts
and unchanged native fingerprints. These are local certification results, not production relationship receipts.

Read-only production preflight: 23 blank businesses have one place key, with **zero cross-namespace ownership
conflicts** in this current set. All 11 diagnosed contacts remain unassigned. **19 contacts clear corroboration;
eight also fail the company-name check, leaving 11 fully clear**, not 19 expected links. The ordinary contact-link
cursor was 98,649 at 22:46:04 UTC; no elapsed-time or “tick or two” forecast is established.

### Why the ordinary Sunbiz path misses the retained-source cohort

Definition: distinct active production contacts with NULL business_id, reached by
`contacts.id = prospects.contact_id -> sunbiz_entities.prospect_id = prospects.id`.
This is **1,397 distinct contacts**, not the sum of potentially overlapping entity-level statuses. The earlier
description “prospect or identical email” conflated separate diagnostic joins; this cohort is the structural
prospect chain specifically. These are existing source relationships, not name-only discovery matches.

The registered `SUNBIZ_FULL_BACKFILL` queue executes `runSunbizBackfillMicrobatch`, which selects a bounded window
and invokes `runSunbizBootstrapBatch`. Production is `running`, phase `remaining`, remaining cursor 729,726 and
processed count 187,676 at 22:40:15 UTC. It is not disabled and does not require another admin confirmation.

One priority-ordered partition of the structural cohort:

| Current contact-level situation | Distinct contacts |
| --- | ---: |
| Terminal `legacy_sunbiz_promotion_exists` claim, no canonical source lineage | 1,375 |
| Unclaimed hot/warm, ahead of remaining-lane cursor | 17 |
| Claimed, no existing source link | 2 |
| Existing canonical source link, relationship still unverified | 2 |
| Unclaimed cold (excluded by hot/warm eligibility) | 1 |
| **Total** | **1,397** |

The 1,375 terminal-held contacts span 1,421 entity rows. None of these contacts has an original filing-number
source event and none of those filings has ANY canonical source link. `wasPromotedByLegacySunbiz` treats
`p.id IS NOT NULL` as completed legacy promotion; the retained prospect alone therefore makes the bootstrap
finalize `deferred_collision/legacy_sunbiz_promotion_exists` without creating a business. The selector excludes
that terminal claim on every later pass. This is a legacy partial-promotion handoff gap, not missing discovery
and not a stopped worker. The 17 unclaimed eligible contacts' entity IDs are 2,008,641–2,014,799, all ahead of the
remaining-lane cursor, so they are pending ordinary traversal, not demonstrated cursor skips.

The contact materializer separately admits only retained `businessEvidence` events, not the prospect-to-entity
chain, so it cannot complete the legacy partial promotion either. Merely removing the bootstrap's prospect
guard would NOT recover old terminal claims. Resetting those claims would destroy the held-state evidence;
merely changing its status would also bypass the existing bootstrap claim fence. The completion below instead
uses the canonical contact-materializer's source policy, leaving the bootstrap's commercial classification
and terminal claims unchanged.

The two existing-link contacts are 38 (business 5972) and 72 (business 5719). The complete read-only evaluator
returns exactly `company_or_trade_name_conflict` for each. They are not forced.

An append-only completion path is now implemented for supported legacy partial promotions. The bounded ordinary
contact page admits the original prospect-to-entity chain; a contact with exactly one retained terminal legacy
claim may reach the materializer. It independently requires a permitted registry source, hot/warm source status,
company/trade-name agreement and no contrary city/state evidence. Ambiguous retained filings, contradictory
names, locations and unsupported sources stay held with specific reason codes.

The materializer resolves using original registry facts and the filing's source identity, locks/rechecks the
original source/prospect/claim/contact snapshot, writes canonical lineage, and appends a source event documenting
that ORIGINAL relationship. It does not copy contact fields as business corroboration. New roots use the same
resolver-owned `canonical` organization class as the existing contact/provider materializers, only after the
retained source policy passes. The separate commercial `production` classification is not substituted for
organization canonicality: the native relationship evaluator explicitly requires `canonical`. No commercial
classification override was added. The original terminal claim and all hold/accounting evidence remain unchanged.
The existing native relationship preview/writer still decide and commit the contact link; source materialization
is not reported as a link.

Two sparse relationship-probe indexes are defined in migration 0358 and the schema for ordinary bounded pages.
There is no runtime/startup DDL. Production needs the owner-published schema/code before this path can run.
No discovery handoff or new Human Review prerequisite is justified for this structural cohort.

The unintended external port-6000 mapping is removed. The C1 command is unchanged; its eager `waitForPort=6000`
declaration was also removed because platform configuration otherwise automatically restored the mapping.
Production access in this investigation was read-only. No claim resets, cursor/window resets, accounting rewrites,
forced assignments, provider calls, outbound changes or production writes were performed. Assignment remains open
through production committed relationship outcomes.

### Completion-path local acceptance (2026-10-15 ~23:01 UTC)

The selected disposable suite run now passes:

- Candidate retrieval: 32 checks, including 50,001 unrelated businesses.
- Source-family materialization: 42 checks.
- Place ownership/concurrent resolver-mirror operations: 26 checks.
- Retained Sunbiz completion: 39 checks. Supported missing-business creation AND existing-business linkage commit
  via the native writer; original terminal claims and contact identity fields remain byte-for-byte equivalent
  as JSON. Ambiguous filings, cold sources, name/state conflicts, noncanonical matched roots and lost authority
  do not create relationship evidence or forced assignments.
- CRM ordinary-worker certification: 69 checks, including a real older-contact retained-registry relationship
  committed by the ordinary incremental worker without a cursor reset, original terminal hold preserved,
  replay without another relationship decision, zero external network attempts and unchanged native fingerprints.
- Source-only reconsideration: 13 checks.

TypeScript checking passed. The development application starts with background jobs off and the pause authority
reports paused; the public homepage renders. No signed-in UI was changed or visually verified.

A separate whole-import regression consumed all 2,914 retained fixture rows with zero row failures, but failed
its final duplicate-email assertion. This is NOT reported as a green whole-import certification; baseline
comparison with unchanged main completed in a separate disposable PostgreSQL/Redis environment using the same
five retained workbooks. Unchanged main also consumed all 2,914 rows with zero row failures and failed the SAME
normalized duplicate-email assertion at `test-provider-import-recovery.ts:147`. This establishes a pre-existing
whole-import certification failure, not a green gate and not a newly introduced relationship-repair regression.
No contacts were deleted/merged and no assertion was removed or weakened to conceal it.
