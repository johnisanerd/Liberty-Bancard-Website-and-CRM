# Intake and Business Assignment — local verification

Observed through 2026-10-14 UTC. **The original task remains open. This is not
end-to-end production acceptance, publication authorization or release GO.**

## Verified locally

All database cases below ran in newly migrated disposable PostgreSQL databases,
with isolated Redis where applicable. The intake group gives each certificate
its own fresh database rather than reusing another certificate's mutable graph.
No live imports, recovery, provider activation, sending or production DDL were
performed by these checks.

| Check | Result and limits |
| --- | --- |
| Exact retained native recovery and replay | Both EXIT=0. Each reconciled all 1,472 originals: 1,309 qualified fulfillment receipts, 163 revision-evidenced holds and 1,117 fulfilled mailbox occurrences. Full replay adds no materialization. All 917 original assignments, decisions and evidence hashes survive. Actual source-era guards and normal forward migration; no normalized/empty graph substitute. |
| Ordinary native service restart | EXIT=0. An explicitly controlled new three-mailbox upload in the exact populated native graph loses its first committed reply, refuses premature completion, resumes the same execution in a fresh process and returns completed replay without duplicates. This is separate from retained recovery, not an original historical multi-mailbox specimen or production HTTP proof. |
| Recovery fault, restart, qualification and budget regression | EXIT=0: 8 fault, 5 restart, 4 qualification/shared-identity and 13 budget/owner checks. Real lock and cleanup failures, unknown commit response, expired/stale tokens, live-budget-lock independence, unchanged routine owner verification, separate renewal, revoked-owner rejection and newer-token reclamation. Shared-mailbox expectations follow the approved identity model; actual foreign original assignments remain protected by full-native evidence. |
| Five actual October workbooks | Completed serial rerun after the nullable creation change passed all five files through canonical native intake: all 2,914 original rows accounted for, original 93-column payloads retained. No providers, cohorts, validation purchases or messages. This is not production ingestion or a target number of newly created contacts. |
| Native contract and aliases | Actual native identity-bridge verifier passed. Read/native source-family evaluators and reviewed-link enforcement were pinned to exact bodies. No observed production hash was added to an allowlist. |
| Organization resolver | 10 actual native checks passed; zero provider calls/outbound changes. Precise location identity, supported matching/creation and conflicts remain distinct from shared-brand domain identity. |
| Execution isolation | 10 checks passed. Three active imports cannot project a request failure onto the wrong execution. Real native abort isolation and fatal authority-loss behavior remain separate. The shipped serial queue case additionally proves canonical recovery runs before an unsafe expired-upload failure, and that unknown-commit/owner failures still propagate. |
| Source-only reconsideration | 6 checks passed without changing the contact timestamp. Immutable corrections change snapshots; unchanged `last_seen_at` refreshes do not. |
| Source-family materialization | 30 checks passed for GHL, Apollo and manual CRM. Personal mailboxes were accepted with independent organization evidence. Three locations under one brand remained three businesses. Legal-name suffix aliases agreed. Superseded source evidence was rejected; a restoring observation restored eligibility. Actual audited affiliation and repeat preservation were verified. Weak evidence remained held. |
| Ordinary automatic linker | 51 checks passed, including three consecutive eligible ordinary cycles, each committing a new native audited relationship. Explicit pause, stale/live leases, owner-before-graph ordering, publish-owner transfer, retired/revoked owner denial and no-provider/no-send/cohort independence were retained. These are local cycles, not the required production cycles. |
| Authenticated review endpoint | 20 checks passed using actual local login, session guards, route and native hydration. Full returned-fact parity against the frozen prior implementation, domain/DBA/name/owner-phone/filing key coverage, native index-plan use, and microsecond-safe first/next/terminal pages passed. Manager/agent remained 403 and anonymous access 401. At 147,002 businesses and 127,001 linked sources, the latest completed serial run observed 24.934 ms for one contact and 1,192.728 ms for four source-backed contacts. These are disposable serving-volume observations, not corrected production-request timings or a causal speedup claim. |
| Geography | 787 pure checks passed. FL/Florida/case/whitespace aliases agreed; GA, county/ZIP conflicts, disabled Monroe and missing geography remained held. |
| Existing free continuation | Native cursor, pause/resume, replay and zero-spend checks passed. Unchanged Florida-alias holds were reconsidered; a still-held Monroe observation received a policy marker and did not create repeated followup runs. |
| Public preview | Migration 0350 was applied through the existing development migration runner. The application workflow was restarted once and came up on port 5000 with journal migrations current and background jobs off. `/login` rendered. Signed-in UI was not visually verified; authenticated API behavior was separately certified. |
| Build | `npm run build` passed. This is a local build, not a publish or release approval. |
| Type check | Still fails only on the pre-existing missing `LiveChat` name at `server/routes/live-chat.ts:309`; that source is unchanged from HEAD. No task-specific type errors remain. The stock release gate is not declared passed. |
| Audited blank-email correction | 24 checks passed through the native command and actual authenticated API. Mixed-set atomic rejection, exact blank/identity/version checks, retained before/after audits, replay, changed-payload rejection, unchanged physical identity/timestamps and zero provider projections passed. Anonymous 401, manager/agent 403 and missing CSRF 403 were verified. This does not mean the 786 production blanks have been normalized. |

Commands:

```text
npx tsx scripts/run-retained-import-recovery-disposable.ts /tmp --intake-only
npx tsx scripts/run-retained-import-recovery-disposable.ts /tmp --intake-workbooks-only
npx tsx scripts/test-cro03a-geography.ts
npx tsc --noEmit --incremental false
git diff --check
```

## Native delivery boundary

Development delivery is versioned in the existing migration journal:

- `0348_import_identity_bridge_contract.sql` restores the original immutable
  guard contract and its source-observation trigger.
- `0349_source_family_relationship_identity.sql` supplies the source-family
  evaluator and coherent relationship/enforcement rules.

Final disposable body fingerprints:

| Function | MD5 of native body |
| --- | --- |
| `crm_automatic_relationship_reasons` | `3ee7b8798d9dce2f2c6e92ef91c51c7e` |
| `crm_source_family_relationship_reasons` | `4a6980a53fd86d9017679dbca80b2a49` |
| `enforce_reviewed_contact_business_link` | `2d38f8614320afbf936c529662e2c684` |

These are local delivery/verification facts. They do not establish that
production installed the functions. No new production installer, whole-journal
replay, startup hook or approval ceremony was added.

## B1 facts for existing B2/C3 consumers

`getContactLinkAutomationStatus()` adds a typed, current population observation
through `readContactLinkAssignmentPopulation()`. Worker-state reads explicitly
omit that observation inside the execution loop.

The population observation separates active production contacts, current audited
verified assignments, unresolved assignments and legacy projections without a
current verified canonical assignment. These are raw assignment facts, **not**
recipient eligibility, territory qualification, validation or send permission.
The existing cumulative attempt/hold counters retain their original meaning.

Native contract/read failure returns an explicit unavailable state with null
counts and a reason, never healthy zeros. The observation has its own timestamp;
worker freshness/last progress still comes from the persisted program state.
B2 retains DTO/downstream orchestration ownership, and C3 retains consumption.
No C4 interiors or CRM sidebar changes were made.

## Query observations, not acceptance

The captured coverage replica EXPLAIN used parameters
`[101093,159476,500,null]`, returning 500 rows:

- Baseline SQL fingerprint `5ed15d1305212bee`: planning 295.473 ms,
  execution 29,799.169 ms.
- Measured SQL variant fingerprint `974f5b0f91e6c02e`: planning 304.365 ms,
  execution 14,798.294 ms.

The observations were sequential, uncontrolled cold/warm measurements on the
read replica. The variant was measured before the final legal-name
normalization change. They are not current-version primary/concurrent-load
request timings, a causal speedup proof or authenticated review repair proof.
The raw observations are retained in ignored generated output at
`generated-artifacts/intake-coverage-plan-observations.json`.

Earlier read-only checkpoint observations advanced
100000 → 100500 → 101000 → 101093 while production still served older code.
They do not certify progress under the new deployed correction.

The local review test independently reproduced timestamp rounding causing
repeated pages. The fix preserves database microseconds in the keyset cursor.
The exact authenticated human-review 500 was subsequently reproduced and
correlated on 2026-10-11: request duration 32.326 seconds, hydration query
execution 30.042 seconds, SQLSTATE `57014`, fingerprint
`5ed15d1305212bee`, and negligible pool acquisition. This establishes a
hydration statement timeout, not pool exhaustion.

Migration `0350_contact_coverage_indexed_keys.sql` and its matching declared
schema add generated lookup keys and ordinary indexes while retaining the prior
normalization. Parameterized lateral equality probes with `OFFSET 0`, direct
indexed source-key branches and per-candidate domain counts replace the global
key-universe hydration. The frozen pre-indexed query remains a test-only parity
oracle, independent of whichever commit happens to be HEAD. This correction
has not been published or timed through the corrected production endpoint.

## October originals rechecked — 2026-10-10 UTC

The five newly attached files ending in `_1791674434685.xlsx` were read with
the existing tabular reader. Each SHA-256 matches the corresponding original
fixture exactly; the new attachment suffix does not change file identity.

| Outscraper file stem | Rows | Columns | Same bytes as tested fixture |
| --- | ---: | ---: | --- |
| `Outscraper-20261002160911s8d6b` | 537 | 93 | Yes |
| `Outscraper-20261002160955s00ed` | 578 | 93 | Yes |
| `Outscraper-20261002161052s68e5` | 513 | 93 | Yes |
| `Outscraper-20261002161147s2b94` | 653 | 93 | Yes |
| `Outscraper-20261002161239s8aab` | 633 | 93 | Yes |
| **Total** | **2,914** | | |

Fresh read-only production-replica queries returned actual result headers:

- No `import_executions` records matching any of the five exact file hashes.
- No executions started on or after 2026-10-01.
- The `csv_imports` ledger contains one entry: the 1,472-row September CSV,
  created 2026-09-09, with its separate execution/hash.
- The Outscraper source population contains 1,472 subjects, all created from
  2026-09-09 through 2026-09-12.

This establishes that the originals are available and exactly identified,
but these five files have no matching recorded production imports in the
queried ledgers. It does not prove their contacts/businesses are absent from
other sources. Chat attachments are not CRM import requests. No live import,
provider call, production mutation or publication was performed.

## September retained graph and native constraint conflict — 2026-10-11 UTC

The ignored private export retains all 1,472 originals, 145 raw columns,
original observation/item identities and 46 original-row parts. Its 305 native
graph files cover 17 tables: 954 contacts, 759 businesses, 739 locations,
749 source links, 10 entities, 2,943 observations, 981 source events, 917
evidence/decision rows each and 2,484 audits, plus the execution/list and 1,472
subject/batch/membership/item/disposition rows each.

Each captured graph file was compared with read-only production rows. All
captured rows matched, and compact source-side hashes for all 17 captured
table scopes agreed before and after verification. The private manifest is
revision-verified; this does not certify successful restoration or recovery.

The real denied disposable native restore refused the graph with SQLSTATE
`23505`, table `contacts`, constraint `contacts_email_unique_idx`. No constraint
was disabled and no retained contacts were merged, archived or normalized.
Recovery and replay were not run after the failed restore.

Read-only production catalog evidence shows that the declared unarchived-email
unique index is absent. The retained scope contains three duplicate active
email groups covering seven production contacts; three of those contacts are
referenced by the original execution. None of these seven has a projected
business relationship.

The full production census separately returned 141 duplicate non-null active
email groups covering 1,186 contacts: one blank-email group of 786 records and
140 syntactic-email groups of 400 records. Record classes were 1,182 production
and four test contacts. One affected contact has a current business relationship
and decision, which must be preserved. These counts do not establish which
records are the same identity and do not authorize blind merging or archival.
Production identity correction and supported schema convergence remain open.

## Authorized production correction — 2026-10-11 UTC

The user authorized blank-to-NULL normalization and archival of only
evidence-confirmed duplicates, preserving original imports, history and valid
relationships.

The existing authenticated, versioned archive command committed **74** confirmed
duplicate archives. Its receipt retained the records and returned zero permanent
deletions. Independent production reads verified 74 archived rows and 74 matching
command-scoped audits, with zero business projections, current relationship
decisions or source events on the archived rows. Comparing the raw receipt with
the stored fields underlying the read DTO verified that physical identity fields
were unchanged. No links were moved, contacts merged, source imports rewritten,
provider calls made or outbound controls changed.

The first request carrying the optional new identity fingerprint was refused
with HTTP 400 and no writes. The committed command used the existing deployed
version/owner/classification contract, following fresh authenticated identity
checks. Private before-state, classification, command and receipt evidence is
retained in ignored restricted storage; authentication cookies are not retained.

The subsequent production census found 86 remaining nonblank duplicate-email
groups covering 272 active contacts, and the same 786 blank-email records.
The retained September graph's seven shared-email contacts were not in the
confirmed archive set: their names, phones or location evidence conflict or
remain insufficient. They were not archived merely to make restoration pass.

A subsequent authenticated reread retained the seven exact contact identities.
The two automotive pairs have different physical addresses and cities, not
merely spelling or phone-format differences. The first-party Vertical Automotive
website explicitly describes two locations in Fort Lauderdale and Wilton
Manors. Shared corporate-domain mail cannot justify collapsing those sites.
The other three held records carry a template-domain mailbox; its appearance
does not authorize treating the unrelated businesses as one identity or
silently extending blank-only correction to nonblank values.

The blank correction is prepared but **not applied to production**. Production
still has a non-null email column. Development migration 0351 permits actual
NULL absence without dropping the real-email unique index or any foreign key.
The existing contact lifecycle command supplies atomic, audited blank
normalization without ordinary profile-write GHL/readiness/validation hooks.
The canonical creation writer also represents a new missing mailbox as NULL,
not an empty-string uniqueness key. Nullable consumers preserve fail-closed
eligibility and existing compatibility DTOs.

The application was restarted after development delivery; `/login` rendered.
Signed-in UI was not visually verified. No production DDL or publication was
performed. The remaining shared-email identity cases and full original
production/native acceptance are still open.

Final local build passed. Initial parallel full-intake and five-workbook reruns
each hit the 300-second command deadline without reporting a failed assertion;
they were not accepted as completed certifications. A subsequent serial
background run completed both commands with exit code zero: the full intake
group, authenticated review, all 24 blank-email checks and free continuation
passed, followed by all five workbooks and all 2,914 original rows. Both
disposable clusters were destroyed. These completed local results do not
establish production import, native retained-graph recovery or release GO.

## Original acceptance still outstanding

1. Authentic September restoration now passes exact hashes for all 17 captured
   tables under real source-era native guards, followed by normal forward
   migration. The unique-mailbox blocker is resolved by the owner's
   identity-based CRM decision and declared migration 0352; login identity is
   unchanged. Current-contract full recovery and full replay passed: all
   1,472 originals reconcile to 1,309 fulfilled and 163 evidenced holds,
   with no replay growth. Ordinary fresh-process restart also passed in the
   restored native graph. These are local proofs, not production acceptance;
   no normalized or empty-CRM substitute was accepted.
    Production ordinary-upload fresh-process restart and retained replay of the
    1,472 originals remain unverified. Preserve all 1,277 mailbox occurrences,
    195 business-only originals and both protected foreign relationships.
2. Exact production execution/source/batch/current-outcome identity for each
   October file remains unverified. The last exact hash lookup found no matching
   production executions; the disposable workbook success cannot fill this gap.
3. Production native delivery and serving-build identity remain unverified.
   No publication or production DDL was performed. The separately authorized
   duplicate archival above does not establish native schema/build convergence.
4. The exact authenticated human-review 500 is correlated and its local
   correction is certified, but it still needs corrected primary request/transaction/component
   timing under representative ordinary concurrent load.
5. The deployed correction still needs at least three consecutive eligible
   production cycles and full source-scoped dispositions. Distinct
   ordinary-upload restart and retained replay now have local native proof,
   but this does not certify the still-unpublished production correction.

No additional tasks or replacement pipelines were created. Outbound controls
were not changed. The original acceptance gaps were not moved into follow-ups.

## Native parity and identity-contract correction — 2026-10-12 UTC

CRM contacts may share a mailbox when they represent independently supported
people/business locations. The canonical writer serializes mailbox/source
transactions, retains exact source-event retries, and reuses only corroborated,
nonconflicting identities. Multiple supported candidates produce a typed
ambiguity hold containing their actual IDs, not an arbitrary first match.
Manual creation returns HTTP 409 for this case. Storage and GHL lookup no longer
silently select an ambiguous mailbox. The dedicated mailbox certificate passed
24 checks after the typed-error amendment.

Historical native decisions are restored under the actual migration journal
through 0348 and independently verified source function hashes. All native
guards remain enabled. The current guard is applied through normal forward
migration before execution; its accepted hashes were not widened to old
contracts and historical evidence was not rewritten. Declared 0353 corrects
fresh-snapshot readiness timestamp type drift while preserving UTC instants
and microseconds and leaving production's existing timestamptz types intact.
Native item INSERT triggers recompute batch projections; the exact captured
projection fields are restored afterward, and every original source field is
verified before commit.

Receipt closure exposed 81 business-only businesses omitted from the
contact-derived export, with 81 locations and 81 source links. All receipt
contact IDs were already present. The original capture remains unchanged.
An extended private capture includes these real source leaves, 840 businesses
and the same 954 original contacts. Production read-only before/after checks
verified all 17 table scopes, and native restoration reproduced their exact
hashes. No missing business was fabricated to satisfy a receipt.

The first expanded run reconciled all 1,472 original rows, but full replay
correctly refused its no-additional-materialization assertion. Older v1
fulfillment receipts predated the identity-based contract and had incorrectly
been treated as current. The current qualification is now
`mailbox_business_identity_v2`: old receipts remain immutable, while their
original items must be requalified. Certification counts current-qualified
receipts, not terminal state labels, and cannot exit while old completed items
remain unqualified.

Concurrent hold snapshot changes must still reject the speculative hold. The
hold transaction now obtains a real PostgreSQL 40001 abort, permitting the
existing bounded, token-fenced recovery cleanup and fresh-authority recheck.
Generic snapshot errors, uncertain connections/commits and owner/lease/native
authority denials remain fatal; no verifier or negative snapshot comparison
was relaxed.

The strict native recovery and replay both passed. Each converged after 27
concurrent worker cycles to exactly 1,309 fulfilled originals and 163
revision-evidenced holds: 75 preserved foreign-affiliation conflicts and 88
ambiguous organization matches. All 1,117 fulfilled mailbox occurrences have
the intended business and fingerprint-bound provenance. Immutable dispositions
are unchanged. All 917 original projections plus exact hashes of all 917
decisions and all 917 evidence records survive both runs. Full replay adds
zero contacts, businesses, provenance, provider operations, communications or
validation intents. No lease-expiry/owner-loss exemption was needed.

The separate ordinary-upload mode passed interrupt and fresh-process restart.
The actual September corpus has a maximum of one mailbox per row (1,277
mailbox occurrences across 1,472 originals); it cannot supply a genuine
historical multi-mailbox input. The test explicitly uses a controlled NEW
three-mailbox upload in the exact populated native graph. It does not alter a
historical row or claim those three mailboxes came from an original workbook.
A real PostgreSQL mailbox commit occurred before the injected lost reply.
Original row accounting could not complete the unfinished upload. A fresh
process resumed the same ordinary execution, reconciled all three contacts,
their business and exact provenance, completed it and returned replay without
additional materialization. All 917 original relationships/decisions/evidence
remain unchanged. This uses the ordinary import service, not the deferred
worker; only the controlled fixture's lease was expired for takeover.

Both focused modes returned EXIT=0 and destroyed their disposable clusters.
Provider calls, outbound effects and nonselective validation admission remain
zero. These completed local checks do not establish production acceptance or
release GO. The current build succeeds; the project type check still reports
the existing out-of-scope `server/routes/live-chat.ts:309` undefined `LiveChat`.
Development startup uses background profile off with canonical outbound pause
intact. The login screen was visually verified; signed-in UI was not visually
verified in this run.

## Publish timeout repair — 2026-10-12 UTC

The failed promotion reported a database migration timeout. Its logged plan
contained twelve separate STORED generated-column additions, five on the
approximately 1.9-million-row Sunbiz registry and seven on Businesses, plus
their indexes and the other pending schema changes. Logs listed the statements
before execution; they did not identify which statement stalled. Empty activity
results on the production replica are not proof of an unlocked primary.

Declared migration `0354_contact_coverage_single_rewrite.sql` packs the same
computed lookup keys into one generated text array per table. Fixed array slots
preserve every prior normalization and NULL result. The migration compares all
existing old/new key tuples before dropping the superseded calculated helpers;
no base/source fields, identity guards, original assignments or evidence are
removed. Matching reads and all twelve existing lookup indexes use the exact
corresponding slots. Historical migrations and their hashes are unchanged.

The existing development runner completed with EXIT=0 in approximately 161
seconds on the registry with approximately 1.9 million rows. The actual managed
diff afterward contained 20 statements, only two stored-column additions and
all twelve intact array-subscript indexes. It reported no tables or columns
removed, no truncation and no structural data loss. It still flagged possible
non-backwards-compatible rollout; table rewrites/index builds can block reads
or writes while publishing.

The focused disposable authenticated-review certificate passed all 20 checks,
including frozen returned-fact parity, actual indexed plans and role denials.
With 147,002 businesses and 127,001 linked sources, observations were 24.549 ms
for one contact and 2,190.119 ms for four source-backed contacts. These are local,
uncontrolled observations, not production timings or a speedup claim.

Build passed. Type checking still reports only the unchanged missing `LiveChat`.
Development restarted with current migrations, background jobs off and canonical
outbound pause intact. `/login` rendered; signed-in UI was not visually verified.
Existing production startup policy continues to skip development journal replay.
No deployment configuration, startup-DDL workaround, production DDL or outbound
control changes were made. Production promotion and original acceptance remain
unverified until the user republishes; this is not task completion or release GO.

## Published continuation and selective hydration — 2026-10-13 UTC

The owner published successfully. The served production health response identifies
`2ff0add39a70fe812786433766ef98a07ff4bf00`; production now has nullable contact
email and both generated coverage-key arrays. Publication did not establish native
guard delivery: the identity-bridge guard function has its correct
`f0c933f2b332d19ec7d51866e2ad5a7b` body, but its required observation immutability
trigger is absent. The source-family relationship function is absent, and automatic
and reviewed relationship routines remain on the pre-0349 bodies. The actual
automatic hash and reviewed-body inverse transformation match 0349's upstream
preconditions. Existing owner-console repairs 0348 then 0349 are needed; no Agent
production DDL, installer or startup replay was used.

The published authenticated review request still returned HTTP 500 after 31.675
seconds. Its correlated SQLSTATE 57014 represented approximately 30 seconds of
execution and approximately 0.05 ms of acquisition, not evidence of pool exhaustion.
The actual replica plan exposed five full registry scans inside outer-join
array-subscript branches. Explicit entity existence now makes entity-owned keys
selective, while filing-only links retain their original missing-entity behavior.
Both raw-source-to-business name probes are also parameterized. Competing-address
evidence uses separate exact native-name/DBA index probes, including the old empty
name/NULL DBA case; coverage's different ASCII name normalization is not substituted.

The expanded plan enables JIT at its very high estimated cost; the same read
completed within budget with JIT disabled. Coverage and review hydration now
disable JIT only on their own transaction
checkout, with rollback/release cleanup and the original statement timeout intact.
The independent prior-read oracle retains its original competing-registry scan.
All 24 authenticated disposable checks passed, including full returned-fact parity,
an actually exercised competing-address conflict, missing-entity filing-only
retention, first/next/end pages, and role denials. Serving-volume fixtures contain
147,003 businesses and 127,003 linked sources; those are local checks.

Read-only production-replica execution measurements for the corrected SQL:

| Scope | Planning | Execution |
| --- | ---: | ---: |
| Exact review-page contact selection, 49 distinct contacts | 345.667 ms | 4,880.342 ms |
| Original failed 500-contact scope, cursor 101093 / watermark 159476 | 96.475 ms | 11,301.271 ms |
| Current same-run checkpoint, cursor 126593 / watermark 159476 | 83.942 ms | 9,508.274 ms |

These are replica SQL measurements, not corrected primary HTTP/component timing,
nor a committed checkpoint advance. A combined full production returned-fact
comparison did not return the required result and remains unverified; it is not
reported as passing. The correction still needs publication and primary evidence.

The previously authorized blank-email cleanup is now committed. Fifteen of the
original 786 selections had acquired nonblank email and were preserved. The
remaining 771 were normalized to NULL through eight existing audited admin commands
with exact actor, lifecycle, ownership and identity pins. The original oversized
request returned 413 before mutation; the operator helper now saves and dispatches
bounded 100-contact commands without raising the body's size limit. Production
postconditions show zero active blank emails, 771 NULL emails, 771 normalization
audits, and no selected contact archived. Commands and receipts remain private
generated evidence; no provider or outbound activation was performed.

Build passes. Type checking still reports only the unchanged missing `LiveChat`.
Development restarted with background jobs off and canonical pause intact.
The public login screen rendered; the signed-in UI was not visually verified.
Production ingestion of all five October files, native September current-qualified
recovery/replay, three eligible ordinary cycles, complete population dispositions,
and ordinary-upload production fresh-process restart remain in the original task.
Native guard repair and publication are continuation requirements, not completion,
replacement tasks or permission to weaken the authorities.

## Owner-console native repair verified — 2026-10-13 UTC

After the owner reported running 0348 and 0349 in the production Database SQL
console, read-only production catalog checks confirmed the installed postconditions:

| Installed object | Verified fingerprint / condition |
| --- | --- |
| `cro03_immutable_row_guard` | `f0c933f2b332d19ec7d51866e2ad5a7b` |
| `cro03_source_observation_immutable` | Enabled `O`, trigger type `27`, no condition, correct public guard function |
| `crm_source_family_relationship_reasons` | `4a6980a53fd86d9017679dbca80b2a49` |
| `crm_automatic_relationship_reasons` | `3ee7b8798d9dce2f2c6e92ef91c51c7e` |
| `enforce_reviewed_contact_business_link` | `2d38f8614320afbf936c529662e2c684` |

The authenticated primary `/api/canonical-enrichment/status` request returned
HTTP 200 and `nativeContracts.state="verified"`. Its current import total remains
one completed execution; exact October file-hash reads still found no matching
executions. The September ledger still contains all 1,472 original dispositions
(1,471 deferred and one failed); immutable accounting is not fulfillment.

Recovery actually resumed: the ordinary production worker reported
`committed_progress` at `2026-10-13T17:22:04.715Z`, with two fulfilled originals,
two attempted, no row/cleanup failures, and no authority failure. The production
audit read also returned two `mailbox_business_identity_v2` receipts for the
September execution, separate from 1,092 older-version receipts and 246
unversioned receipts. This establishes initial current-qualified progress, not
three consecutive cycles or full retained-population acceptance.

The authenticated automatic-affiliation reader returned current population
evidence with native verification true: 154,865 active production contacts,
963 current verified assignments and 153,902 current unresolved contacts.
Its program remains enabled and incomplete. These current population facts
remain distinct from cumulative scan/hold counters.

The coverage reader still reports the same run, cursor 126,593 / watermark
159,476, with 126,500 processed and no last error; its last committed timestamp
remains `2026-10-13T14:16:04.598Z`. Healthy status and processing enabled are not
new committed progress. The primary health response still serves
`2ff0add39a70fe812786433766ef98a07ff4bf00`, not the workspace's selective-hydration
and transaction-local JIT correction. Publish remains required before corrected
primary review/coverage timing and same-run checkpoint advance can be certified.

Catalog, source-disposition and first-cycle evidence is retained in
`generated-artifacts/intake-native-repair-observation.json`; authenticated raw
status responses remain in the ignored private acceptance directory. No Agent
production DDL, live import, schedule/control change, outbound activation or
replacement task was performed. The original task remains open.

## Corrected published requests and surviving domain constraint — 2026-10-13 UTC

The owner republished. The authenticated primary health response now serves
`2dab7f8ef5a4901b2e5909bfe1cccc8fd05f125b`, built
`2026-10-13T19:16:03.679Z`, including the selective hydration and transaction-local
JIT correction. Native contract status remains verified.

Actual authenticated primary request observations:

| Request | HTTP | Elapsed | Returned / current matching evidence |
| --- | --- | --- | --- |
| Review first page, `limit=100` | 200 | 8,894 ms | 100 / 95 |
| Next page using the exact returned microsecond cursor | 200 | 6,999 ms | 100 / 89 |
| Canonical enrichment status | 200 | 3,161 ms | native contracts verified |
| Automatic linking status | 200 | 610 ms | current population observed |

There was zero candidate-ID overlap between review pages. Anonymous access to
the same review endpoint returned HTTP 401. Manager/agent denial remains
supported by the prior disposable certificate, not a new signed-in production
role check. Signed-in UI rendering was not visually verified.

Correction to the earlier observation wording: 100 returned DTOs do not mean
100 candidates have matching current evidence. Five first-page and eleven
next-page candidates return the explicit `candidate_facts_no_longer_match`
hold. All 200 rows also return no independently bound retained review evidence
for this observed admin actor and are non-reviewable. Successful reads are not authorization to bypass those holds
or proof of completed human-review acceptance.

The original coverage run and watermark are unchanged. Durable production
checkpoint receipts show successive committed cursors 137,593 → 138,093 →
138,593 → 139,093, with processed counts 137,500 → 138,000 → 138,500 →
139,000. The last recorded page began at `21:55:26.216764Z` and its checkpoint
was updated at `21:55:49.408Z`, approximately 23.2 seconds later. This is a
primary committed-page observation, not a replica EXPLAIN or a new run/reset.
It does not establish that all remaining contacts are disposed.

Ordinary retained recovery logs report three consecutive committed-progress
cycles at `21:48:44.407Z`, `21:50:42.907Z` and `21:51:17.119Z`,
fulfilling one, one and two originals respectively. September-scoped current
`mailbox_business_identity_v2` receipts corroborate original rows 1221, 1084,
1223 and 1225 at those boundaries. The last cycle also had two row failures;
these are not three error-free cycles. A separate current census found 115
distinct current-qualified originals, separate from older-version and
unversioned receipts; background recovery continued afterward.

Recovery failures exposed an installed native constraint omitted from the
fresh migrated certification template: both development and production retain
`businesses_website_domain_unique_idx` from historical migration 0043. The
current declared schema permits distinct businesses sharing a brand domain.
Production SQLSTATE 23505 failures use query fingerprint `93542bc5fb34f2ee`;
the real canonical business insert independently generates exactly that
fingerprint.

Additional read-only production corroboration found an existing exact-domain
business for each sampled failed original (126, 1319, 349 and 1349). Originals
126 and 1349 have a different retained city and address from that business;
349 has a different retained address. Production logs omit the constraint name,
so the reproduced named constraint and these installed/data facts establish
the shared-domain obstruction, not attribution of every other failure to it.

Migration `0355_business_shared_domain_identity.sql` pins the exact historical
index definition before removing only that domain-wide uniqueness constraint,
retaining the declared lookup index. No records, source identities, relationship
guards or resolver locks are removed. It is applied in development, not
production. The extended denied disposable certificate explicitly reinstalls
the historical index, reproduces the real resolver's 23505 and exact constraint
name, then applies the correction twice. All 15 checks passed, including
unchanged original business facts, two distinct same-domain locations,
concurrent equivalent-input idempotency, exact-source precedence, alias parity
and conflict holds. Provider calls and outbound changes were zero.

The supported Publish schema diff is exactly:

```sql
DROP INDEX "businesses_website_domain_unique_idx";
```

It reports no structural data loss and no table/column removal or truncation.
The compatibility flag is true because uniqueness semantics change. This
supports the already-required separate-branch identity behavior, not weakening
source/place identity. No production console repair, Agent DDL, custom installer
or startup-production migration replay is required or attempted.

The development workflow restarted successfully and the login UI rendered.
Type checking still reports only the existing `LiveChat` error. The original
task remains open for production delivery of this correction, complete current
population disposition, October production intake, ordinary-upload production
fresh-process restart and retained replay. Existing configured gate failures
are not represented as full-roster passes.

Evidence is retained in `generated-artifacts/intake-published-primary-progress.json`,
`generated-artifacts/intake-published-scoped-receipts.json` and
`generated-artifacts/intake-shared-domain-publish-diff.json`; raw authenticated
page/status responses remain in the ignored private acceptance directory.

## Shared-domain delivery and source-scoped production proof — 2026-10-13 UTC

The next owner publish now serves `a7b51b19a9c97b31a812e1260260008bbed06af9`,
built `2026-10-13T22:18:45.134Z`. The production catalog confirms the obsolete
domain unique index is absent and the ordinary lookup index remains. The
authenticated primary native verifier reports `verified`. The selected runtime
release and live owner both match this exact served SHA, owner epoch 139;
no owner credential/token was exported.

The same primary review requests returned HTTP 200 in 19,938 and 11,405 ms,
100 DTOs each, zero candidate-ID overlap, and 95/89 matching evidence payloads.
Their retained-evidence and stale-facts holds remain as qualified above.
Primary coverage status reports the original run/watermark unchanged, cursor
141,593, processed 141,500 of 154,418, no last error, incomplete.

Three consecutive published ordinary recovery cycle reports are now corroborated
by current September-scoped fulfillment receipts:

| Cycle end UTC | Fulfilled | Held | Attempted | Row / cleanup failures |
| --- | --- | --- | --- | --- |
| 22:39:17.259 | 1 | 0 | 1 | 0 / 0 |
| 22:47:44.997 | 1 | 0 | 1 | 0 / 0 |
| 22:49:13.700 | 3 | 1 | 4 | 0 / 0 |

Current-qualified receipt timestamps for original rows 1249, 409, 170, 1251
and 411 fall within those cycles. This establishes the original three-cycle
committed-progress requirement, not complete original-row disposition.

A read-only source-scoped census preserves all 1,472 originals, with immutable
1,471 deferred/one failed accounting. It finds 1,116 mutable completed items,
but only 142 have current `mailbox_business_identity_v2` receipts; 974 completed
items still have older qualification. There are 339 blocked and 17 running
items. Current hold-revision validity is not inferred from blocked state.
Concurrent scheduling continues after this observation.

Fresh production comparisons against the exact native capture found:

| Captured native objects | Count | Missing | Changed |
| --- | --- | --- | --- |
| Contact-to-business assignments | 917 | 0 | 0 |
| Current decision identities, revisions and evidence references | 917 | 0 | 0 |
| System-link evidence hashes, identities and rule/source references | 917 | 0 | 0 |

Automatic affiliation remains incomplete: its cursor is 12,875 with 12,782
cumulative scans and 13 committed links. The independent current population
read finds 154,883 active production contacts, 980 verified and 153,903
unresolved; cumulative held counts are not that population's disposition.
Live logs expose owner acquisition contention (including 55P03 and 25P03)
outside the claimed program's persisted last-error boundary. The current
program's `lastError=null` does not establish error-free ordinary execution.

The actual deployed active-page builders were compiled and measured read-only
on the production replica: cursor selection at 12,875 took 8.738 ms, and a
representative adjacent 25-ID evidence page took 2,917.541 ms. These indexed
read-plan observations do not replace primary transaction/acquisition/write
timings or certify the full automatic-affiliation population.

Both attachment copies of each of the five October workbooks have identical
bytes. A fresh parameter-bound exact-hash production ledger query returned the
expected result header and zero executions for all five. Their 2,914 source
rows remain unimported through the recorded native path. The original scope
requires separate authorization for those real production imports; publication
alone is not that authorization. No live import, provider/outbound control
change, replacement pipeline or additional task was performed.

The corrected-schema denied native certificates now both completed with exit
code zero and both disposable clusters were destroyed:

| Fresh corrected-schema certificate | Actual result |
| --- | --- |
| Native retained recovery | All 1,472 originals accounted: 1,309 fulfilled, 163 held; 1,117 proven mailboxes; 17 cycles |
| Native full materialization replay in another process | 1,310 fulfilled, 162 held; 1,118 proven mailboxes; 15 cycles; baseline contact/business/provenance counts unchanged |
| Separate ordinary-upload interruption | A real native mailbox commit loses its reply; unfinished upload is not completed by original-row accounting |
| Ordinary upload resumed by a fresh process | All three actual native mailboxes and business links proven; no duplicate people or businesses |

Both retained phases individually prove the original 917 assignments, 917
decisions and 917 evidence rows unchanged, immutable original accounting
unchanged, and fingerprint-bound provenance for each fulfilled original.
The replay legitimately qualifies one additional mailbox that already exists;
its exact baseline equality assertion passes, so this is not new materialization.
Each remaining held original has a fingerprint-matched receipt with a recognized
reason and retained competing identity/affiliation diagnostics. The ordinary fresh-process proof preserves
the same original graph. Both runs report zero provider/outbound/validation
admission effects. These are isolated local certificates, not a production
upload restart or production full-population completion.

Evidence: ignored private `shared-domain-published-verification.json`,
`intake-domain-published-recovery-cycle-evidence.json`,
`intake-published-original-disposition.json`,
`intake-published-original-relationship-preservation.json`,
`intake-published-original-evidence-preservation.json`,
`intake-published-exact-source-ledger.json` and
`intake-active-affiliation-production-plans.json`.
The new isolated full-row certificates are retained in ignored
`intake-post-domain-native-recovery-report.json`,
`intake-post-domain-native-replay-report.json` and
`intake-post-domain-native-upload-restart-report.json`.

## Authorized October production upload: admission failure and correction

The owner explicitly authorized importing all five original October workbooks
through the existing production pipeline, with provider/outbound settings
unchanged. The first real multipart request at `2026-10-13T23:48:41.048Z`
used the original `5079ea…cf833` bytes, original `.xlsx` filename, official
workbook MIME, an authenticated admin session and CSRF token. It returned HTTP
500 after 446 ms. A subsequent exact-hash production execution census returned
its actual header and zero executions: no import claim was created.

Root cause: the intake handler already parses XLSX, but its shared CSV/ZIP
multipart filter intentionally excluded workbooks before the handler ran.
The correction supplies a dedicated CSV/XLSX disk-upload policy to this
intake route only. The other CSV/ZIP and CSV-only policies remain unchanged;
the authenticated role/CSRF boundary, original-byte hashing, source coordinates,
claiming, native writer and permanent replay key remain unchanged. Unsupported
intake types now return a typed HTTP 400 rather than an opaque 500.

The actual loopback HTTP multipart/parser regression passed 18 checks:
all five original-byte workbook hashes, all 2,914 rows and source coordinates,
recognized Outscraper format, binary/legacy-browser workbook MIME compatibility,
four supported CSV MIME variants, rejected ZIP/image/legacy XLS/type-mismatch
inputs before parser entry, corrupt workbook HTTP 400, and route-policy
isolation. This test makes no DB/provider/outbound writes. Full native workbook
persistence and retained replay remain independently certified, not inferred
from this transport test.

The failed request and its original control/status baseline are retained
privately. No CSV conversion, renamed-file bypass, new import pipeline, provider
control change or blanket validation was attempted. The five authorized
production imports remain pending delivery of this scoped route correction.

Verification: the production build succeeds; the only full-project type-check
error is the unchanged `LiveChat` type reference in the unrelated live-chat
route (confirmed in HEAD). After one application restart, the real running
intake route with admin session and CSRF returns the expected HTTP 400 for an
unsupported extension before any import claim. The public app also renders;
signed-in import UI rendering was not verified.

The already-authorized one-off HTTP operator is waiting up to 30 minutes for a
new production serving SHA, then confirms the scoped admission policy on the
real authenticated route before uploading the five original attachments.
Until those checks pass it only performs public health reads. It uses a local
single-process lock, preserves the first failed request/control baseline, and
stops for reconciliation on any ambiguous or partial upload response rather
than blindly retrying. This is not a new application pipeline or activation
gate. Successful row accounting alone will not close remaining native
fulfillment/held-revision or full-population acceptance.

## Real October timeout reconciliation and upload continuation — 2026-10-14 UTC

The scoped admission correction is served as
`a5a82f14d8813bc56fd233e48187ea77b7ec3078`. The production authenticated
unsupported-type probe returned the exact scoped HTTP 400 before processing.
The first two original workbook requests subsequently received HTTP 504 after
approximately 300 seconds each. These were not pre-claim failures.

Read-only exact-hash production reconciliation establishes two distinct
executions and UI projections, retaining all 537 and 578 original rows
(1,115 total). Current primary GET independently confirmed the first execution
and its partial immutable ledger. At 00:39:50 UTC both executions had 61
accounted-for rows, remained running and had been reclaimed by the existing
resumer. Neither original file was resent. These observations are **not**
completed fulfillment, current complete hold disposition, production restart
acceptance or five-file acceptance.

The first live request's error was correlated to
`IMPORT_EXECUTION_LEASE_LOST`: the interactive provider branch renewed every
100 rows despite executing native transactions per row, exceeding the
five-minute execution lease before the first batch finished. Existing
request-free provider recovery already renewed per row.

The correction renews that same token-fenced lease per provider row. Ordinary
provider uploads now return HTTP 202 with committed original-byte file hash,
execution/projection identity and explicit processing state, while the same
existing processor continues. No alternate intake or recovery worker was
introduced. Errors retain exact-claim cleanup and original/cleanup diagnostics.
Generic import responses remain awaited. The existing import UI distinguishes
processing from complete and refreshes active history; live native leases
prevent stale projection timestamps from incorrectly reporting interruption.

Targeted checks pass: 18 real multipart/parser checks, three actual-route
lease-block guard units and five actual-route handoff/reader/UI-wiring units.
The latter are dependency-isolated units, not authenticated native HTTP
persistence certificates. Build succeeds; type checking reports only the
unchanged missing `LiveChat` type. One development restart came up successfully;
login rendered, but signed-in UI rendering was not verified.

The remaining three original attachments (1,799 rows) are queued for the same
already-authorized ordinary HTTP uploader after a serving build newer than
the admission-only correction is detected. The wait is limited to 30 minutes.
No first/second-file resend, provider/outbound setting change, production SQL
write, native-function alteration, new task or approval gate was performed.
The original A–G task remains open; full disposition, primary timings,
full-population convergence and actual production restart/replay remain required.

## Five real October admissions and subsequent native failures — 2026-10-14 UTC

Owner publication is independently served as
`5b382fe759548449ef347d9166ac0ebbbd6d3139`; the authenticated unsupported-file
probe still returned the scoped 400 before claim. Exact-hash production
reconciliation and primary import-detail reads establish:

| Original attachment suffix | Original rows | Projection | Durable execution |
| --- | ---: | ---: | --- |
| 160911s8d6b | 537 | 3 | 83e594ce-3b4c-484a-96a8-2f9f71f789d7 |
| 160955s00ed | 578 | 4 | b070a72b-faa5-4056-b300-c24686ccc76e |
| 161052s68e5 | 513 | 5 | 9cd520f7-0d80-4265-985f-0fe6af0b7307 |
| 161147s2b94 | 653 | 6 | 6623a227-8986-4d95-a46c-14b09ed67d12 |
| 161239s8aab | 633 | 7 | 6b28085c-8ee3-475c-973d-dd6a500e5109 |

All **2,914 original rows** are retained under these five distinct executions.
No accepted file was resent. The last three ordinary authenticated upload
responses were HTTP 202 in 1,750, 3,208 and 2,185 ms respectively, with original
hash, row count and durable execution identity. The third request's response
was saved before an operator assertion stopped: the raw partial-index upsert
returned snake_case projection keys despite its CsvImport type assertion.
Primary/replica reconciliation confirmed acceptance; the operator then accepted
either projection wire spelling while still requiring agreement with the
top-level execution and exact primary detail. Only files four and five followed.

Admission is **not completed native fulfillment**. At 02:04:27 UTC, immutable
row accounting was 98/537, 113/578, 6/513, 2/653 and 2/633. Three projections had
failed, while execution originals remained running/recoverable; the ordinary
resumer had reclaimed the fifth execution. Live request transactions exposed
SQLSTATE 25P03 at 01:43–01:44 UTC, and an ensuing rollback failure obscured the
original callback error. These observations do not prove the CPU/network/lock
cause of idle termination or that a retry finished.

Scoped local follow-through, not a replacement pipeline:

- Normalize the raw partial-index upsert to the existing Drizzle CsvImport
  shape, preserving all fields, zero/null values, dates and JSON.
- Skip the generic mapper's three full-contact-table caches for native provider
  rows, which never consume them. Native identity/consent reads remain intact.
  Reduced scan/memory work is verified; resolution of live idle termination is
  **not** established.
- Preserve callback and rollback errors together; ambiguous cleanup is neither
  a safe retry nor a definitive immutable failed-row outcome. Both fallback
  branches now retain their fatal boundary for unknown/authority failures and
  expose failure-write errors instead of swallowing them.
- Order eligible expired uploads by oldest lease/start/identity. Reclaimed
  projection reopening requires the exact execution/token and a live lease,
  preserves accounting and occurs before processing. A failed projection is
  not presented as healthy merely because its old lease has not expired.

The targeted actual-block units pass, including 26 projection columns, native
cache exclusion, 14 failure-boundary cases, five rollback-preservation cases,
five projection-start/fairness checks, and the existing multipart/lease/handoff
cases. Existing bounded transaction retry checks also pass. Full build
succeeds; type checking still reports only the unchanged LiveChat reference.

The authentic source-era disposable native upload/restart certificate was
rerun against these changes: an actual mailbox commit followed by confirmation
loss cannot complete the unfinished row; a separate fresh process resumes all
three actual native mailboxes and business links without duplicate people or
businesses. All five scoped assertions pass, denied provider/outbound/blanket
validation assertions pass, and the isolated cluster was destroyed. This is
**local restart proof**, not production restart acceptance.

Primary import details returned 200 in 244–298 ms. The original coverage run
remains unchanged and advanced to cursor 148,593, processed 148,500/154,418;
its status read took 629 ms. Automatic affiliation remains incomplete:
cursor 13,024, 12,931 cumulative scans and 13 committed automatic links, with
155,105 active production contacts, 1,188 currently verified and 153,917
unresolved; that primary read took 7,821 ms. Coverage scans and cumulative holds
are not full identity disposition.

One development restart and public login render succeeded. Signed-in UI
rendering remains unverified. These follow-through corrections require owner
publication before live confirmation; all files are already retained and need
no re-upload. Provider/outbound settings, native SQL definitions, historical
relationships and task scope were not changed. No release GO or A–G completion
is claimed.

## Failed rolling publication: policy verification lock — 2026-10-14 UTC

The owner's 02:55 UTC publication built but failed promotion: port 5000 did not
open before the startup deadline. The prior serving build still returned
HTTP 200 from its health endpoint. Database reachability was independently
confirmed; the failure was not proof that the previously published site was down.

The failed process's 30-second statement fingerprint `b0c43b80f2c662bd` exactly
matches the startup convergence query selecting the outreach policy control
`FOR UPDATE`. The persisted production seed-convergence audit confirms
`sfp_outreach_policy_v1` was the **only unexpected target**; its recorded failed
query is that same control read. Live native/eligibility consumers pin that
control with `FOR SHARE`, so exclusive verification unnecessarily competes with
ongoing reads during rolling publication. Production selected policy v2.

The local correction uses shared policy-before-document pins for existing
immutable v1 seed verification. Content validation, insert-only initialization
and failure-on-mismatch remain unchanged. Recipient-policy convergence now
checks a shared pin first: an already-selected non-v1 policy is preserved.
An actual v1 upgrade releases that read transaction, obtains the original
exclusive lock in a fresh transaction and re-checks all original content and
custom-selection conditions. No lock upgrade is attempted while holding the
shared pin. No early HTTP readiness, timeout increase, worker/provider control
change, production DDL or manual production repair was introduced.

`scripts/test-startup-policy-reader-contention.ts` runs against fully migrated
private PostgreSQL with a genuine concurrent policy/document shared lock:

- The old exclusive control read genuinely fails with lock timeout.
- Both corrected real startup convergence calls finish in **13 ms** while the
  reader still holds its pin; immutable hash and selected policy remain equal.
- A real original-seed policy upgrade still executes successfully.
- Dependency-isolated drift and custom-policy cases retain write-time re-check
  and no-write preservation.
- Six checks pass; the private cluster is destroyed. No production writes,
  provider calls or outbound effects occur.

The full build passes; type checking still reports only the pre-existing
LiveChat reference. One development restart reports all 18 startup seed
targets converged, opens 0.0.0.0:5000, and serves the proxied root with HTTP 200
in 59 ms. The public login render is intact; signed-in UI was not visually
verified. These are local corrections requiring owner publication; they are
not production promotion proof or certification of the remaining native
idle-transaction, five-workbook fulfillment, or full-population work.

## Published startup repair and runtime continuation — 2026-10-14 UTC

The owner's corrected publication is served as
`badd5c2673650f88ebc21d96adee782104f28f64`, build
`4ace6354-a41d-4af8-9b44-46176b4fe040`. Health returned HTTP 200 in
301.690 ms. Production startup reports all 18 seed targets converged at
03:30:30 UTC, including the previously blocked policy target. The public login
renders; signed-in UI was not visually verified. Authenticated API observations
are separate from this public screenshot.

The four required native function bodies exactly match the local certified
hashes, and the precise enabled identity-bridge observation trigger/function
predicate returns true. No production DDL was performed.

All five executions retain their original 537, 578, 513, 653 and 633 rows,
respectively: **2,914 rows**, with no re-upload. Primary detail reads return
HTTP 200 in 227–286 ms, and all five projections have reopened to processing.
At 04:12 UTC, their accounting counts remain **98, 113, 6, 2 and 2**.
Repeated claims/heartbeats and processing labels are not new row fulfillment.
No October execution has a current-qualified recovery audit receipt; the
scheduled retained-recovery selection requires a completed execution and its
observed progress belongs to the September execution, not these still-running
October uploads.

Native retained recovery committed fulfillment in three consecutive ordinary
ticks at 04:04:30, 04:05:18 and 04:06:03 UTC. Those ticks respectively report
one fulfilled row with zero, two and one evidenced holds. A read-only audit
query returned 230 distinct September item identities with the current
`mailbox_business_identity_v2` receipt qualification. This is source-scoped
progress, not complete accounting of 1,472 originals, proof of every receipt's
current graph, ordinary-upload fresh-process restart, or fulfilled full replay.

The same coverage run advanced to 152,000/154,418, cursor 152,093, without
resetting its committed scope. Its primary status read returned in 250 ms.
The automatic-linker population read took 12,005 ms: 155,111 active production
contacts, 1,193 currently verified and 153,918 unresolved. These population
counts are not outreach qualification or a full unresolved disposition.
Authenticated human-review first/next pages each return 50 candidates with
HTTP 200 in 12,639 and 7,165 ms, retaining native-microsecond cursors.
These are uncontrolled primary HTTP observations under live worker activity,
not isolated transaction/component timings or a speedup claim.

### Runtime evidence and its limits

Idle-transaction SQLSTATE 25P03 still occurs after publication, including native
materialization/finalization and owner heartbeat phases. Existing statement,
lock and idle limits remain unchanged. Available pool slots during failures
do not support a pool-exhaustion diagnosis.

An existing authenticated, read-only primary capture at 04:02 UTC bound SQL
tags and process metrics to the same process. It captured three real blocker
snapshots, with a native materializer in ClientRead and no blockers while
another worker awaited its transaction. The observation itself subsequently
failed after 16 samples; it is not a successful full 60-second capture.
Over 23.378 seconds, process CPU was only 287.282 ms, while event-loop maximum
delay reached 4,601.151 ms and p99 reached 1,400.898 ms. An observer round trip
took 2,200.517 ms.

A separate controlled comparison used 60 shallow public health GETs over
approximately 65 seconds; all returned 200, maximum HTTP latency 120 ms.
The same process's capture completed, with 106 samples and nine blocked
samples. Its event-loop maximum was 880.280 ms and p99 552.075 ms over
60.209 seconds; total process CPU was 2,897.440 ms. The maximum observer round
trip was 621.870 ms. This comparison shows substantially different scheduling
conditions, not a controlled proof of CPU throttling or the exact cause of
each idle termination. No keepalive traffic loop remains running, and none
was added to the application.

Deployment metadata confirms Autoscale. Official platform documentation
describes Autoscale as traffic-driven/scaling to zero and Reserved VM as
dedicated always-on compute suitable for continuous background work. It does
not document the precise idle CPU allocation. Changing hosting would have a
fixed monthly cost and requires the owner's decision; no deployment target,
machine resources, provider settings or outbound controls were changed.

### Diagnostic follow-through, local only

Combined callback/rollback errors retained both exceptions, but their safe
formatter followed only linear cause edges, concealing nested SQLSTATEs again.
The formatter now follows only cause/originalError/cleanupError edges, bounded
by depth, node count and a visited set. Exact provider-import capability codes
remain actionable. No raw messages/SQL/parameters are emitted, and no retry,
failure classification, native guard or transaction limit is changed.

The focused branched-diagnostic regression passes. The actual disposable native
blocker/privacy/observer certificate passes all 33 checks on a serial rerun.
Its first run, concurrent with the production build, timed out without a
completed certificate and is not counted as a pass. Full build passes. One
development restart reports all 18 seeds converged, background workers off
and port 5000 serving; this diagnostic amendment is not yet published.

The original task remains open: October fulfillment, full current dispositions,
production-wide affiliation, complete native restart/replay and representative
component timings are not established. No new task, replacement pipeline,
activation gate or publication was performed.

## Cadence publication verification and exact schedule repair — 2026-10-14 UTC

The owner's next publication serves SHA
`e77b298a4ac1e82cd086af6d76d119921d5bd231`, published build
`49101ff5-6e39-47c7-b985-aa7abfe07870`, built at 09:03:31 UTC.
Deployment metadata confirms a successful public Autoscale build. Startup logs
report all 18 seed targets converged at 09:03:17 UTC.

Authenticated queue telemetry returned HTTP 200 in 2,854 ms, with 13 selected
and ready workers. Its effective configuration reports Sunbiz 300,000 ms,
free enrichment 2,700,000 ms, classification 600,000 ms and discovery
1,800,000 ms. Import recovery remains 60,000 ms. Telemetry remains degraded;
it does not establish a complete worker fleet or Redis capacity.

Crucially, a separate read-only inspection of the actual shared Redis repeat
registries found both 60,000 and 300,000 ms Sunbiz schedules, and both
900,000 and 2,700,000 ms free-enrichment schedules. Returned schedule metadata
omits the original stable job ID. The existing `job.id` filter therefore did
not remove the earlier schedules. New interval telemetry alone overstated the
effect of the scheduling cleanup.

The local repair recognizes only the exact owned BullMQ descriptor/hash using
the known job name and stable ID plus persisted repeat metadata. It fixes the
existing base/named startup replacement and interval-update paths. No cadences,
queue selections, concurrency, dispatcher, heartbeat, import limits, native
guards, provider or outbound controls change. No production schedule removal
was executed manually; application replacement requires owner publication.

The installed BullMQ/private disposable Redis regression reproduces the missing
ID and duplicate intervals, then verifies one replacement, preserved unrelated
and named schedules, and retained one-off job data. The structural cadence gate
and all 17 background-profile checks pass. The full build passes with existing
chunk-size and CJS import.meta warnings.

The production replica still reports all 2,914 October originals retained,
five running executions and accounting 98, 113, 6, 2 and 2. Renewed claims are
not fulfillment. The current-qualified audit population is 316 distinct
September items, latest receipt 09:14:05.756078 UTC; no October execution
appears in that qualified receipt aggregation.

One existing authorized read-only primary capture started at 09:13:53 UTC and
failed at 09:14:49 UTC, after 13 samples and five lock snapshots. Its runtime
window reports 51,105.962 ms elapsed, 530.117 ms consumed CPU and
33,403.437 ms maximum/p99 event-loop delay; maximum observer round trip is
33,400.053 ms. The capture is incomplete, not a passed 60-second measurement.
Snapshots include an import linker idle in transaction/ClientRead holding locks
while discovery and runtime renewals on another tagged process wait. The
observer's own process identity is recorded; this is not proof that every
observed backend belongs to that process or to the new release.

Published recovery still reports SQLSTATE 25P03 and lock-timeout failures,
interspersed with isolated September fulfillment. The amended safe formatter
now exposes the nested original SQLSTATE. These observations do not establish
CPU saturation, hosting causality or a successful cadence effect, especially
while obsolete installed schedules remain. Original A–G production acceptance,
October fulfillment, full disposition and restart/replay stay open.

After the local repair, one development restart again converges all 18 seed
targets, keeps background workers off and serves port 5000. The public login
renders intact; signed-in UI was not visually verified. This confirms local
startup/rendering, not removal of production's obsolete schedules.

## Consolidated intake correction and final local evidence — 2026-10-14 UTC

The subsequent owner publication serves SHA
`a7ad926932deeea8721ea637fb4b0b81b5cd6f41`, build
`b4067caa-fe75-411b-bd5f-623097641877`. Actual repeat-registry inspection
confirms only the owned Sunbiz 300,000 ms and free-enrichment 2,700,000 ms
schedules; the obsolete owned intervals are gone. This is schedule proof,
not proof that all imports or the full contact population have converged.

The consolidated corrections below are still unpublished:

- A retained-recovery failure no longer skips independent ordinary upload
  recovery. Either fatal boundary remains fatal; simultaneous failures retain
  both causes, including falsy thrown values.
- Confirmed ordinary native aborts do not manufacture immutable failed row
  dispositions. Every ordinarily fulfilled mailbox must have its actual native
  business link. A current hold preserves earlier original accounting, pins
  native evidence and clears pending work atomically. Claim-releasing hold
  transitions validate their token before clearing it, rather than rejecting
  their own completed transition afterward.
- Existing CSV list/detail readers expose additive version-1 recovery facts:
  observation time, execution status, pending mailbox fulfillment, bounded
  claim-fenced last failure, persisted-array/file-hash availability and the next
  eligible claim action/time. These are execution facts, not proof of provider
  readiness, guaranteed scheduling or B2's assembled status.

Final denied, private native evidence:

| Verification | Result |
| --- | --- |
| All five exact original October workbooks | PASS: 2,914 rows; 2,548 native fulfilled outcomes and 366 native evidenced holds; all 93-column originals retained |
| September native recovery | PASS: 1,472 originals; 1,311 fulfilled; 75 affiliation holds and 86 organization-ambiguity holds; 1,117 proven mailbox occurrences |
| September native replay | PASS: 1,312 fulfilled; 74 affiliation holds and 86 organization-ambiguity holds; 1,118 proven mailbox occurrences; no new contact, business or provenance duplicates |
| Historical protection | All 917 captured business projections, decisions and evidence rows, including both protected foreign relationships, preserved |
| Final ordinary fresh-process interruption/restart | PASS: all three expected mailboxes and their actual business links resumed; no duplicate people/businesses |
| Final nine-suite intake batch | PASS: native hold/55P03 retry, organization 15, execution isolation 24, source-only 6, source-family 30, authenticated review 24, blank correction 24, mailbox identity 24, affected Florida followup |
| External effects | Zero provider/outbound/nonselective-validation attempts in native recovery, replay, restart and workbook certificates |
| Final application build | PASS; existing chunk-size/CJS import.meta warnings remain |

Replay legitimately resolves one earlier affiliation hold as current graph
evidence changes. Neither pass rewrites immutable original dispositions.
The private reports distinguish mailbox occurrences from new people.
These certificates do not establish production October fulfillment.

The configured stock release run is **FAILED**, not release GO: 124 passes,
60 failures and two explicit opt-in skips across its 186-entry roster, with
zero gate-control failures. In individual fresh-database comparisons,
contact-link automation and the compiled C4 browser pass on both candidate
and unchanged HEAD. The older provider-import fixture's distinct-place
expectation fails identically on both. Its assertions now match approved
separate-location creation, replay and contradictory exact-place holds;
those assertions pass, but its later full 1,472-row bulk loop exceeds the
existing 180-second stock-suite ceiling. The separately completed full native
certificate above is not substituted for a passing stock gate.

The CSV reconciliation fixture failed on both versions because it treated
asynchronous provider admission as immediate HTTP 201 completion. Its existing
scenarios now verify HTTP 202 admission identity/hash/denominator, bounded
authenticated polling of the actual existing reader and reconciled terminal
counts; the isolated stock CSV suite passes. Business-only rows still create
no fabricated contacts. This does not waive any other stock failure.

The stock artifact gate reports one type error in the unchanged
server/routes/live-chat.ts at line 309. The three pre-existing native-console
SQL documents also fail the tracked-file exposure scan on unchanged HEAD.
The earlier standalone typecheck timeout was not a pass. The remaining stock
failures have not all been individually certified; no blanket baseline waiver
or production release GO is claimed.

After the final backend batch, development restart converges all 18 seed
targets, leaves background workers off and serves port 5000. The public landing
page renders intact. Signed-in Intake UI was not visually verified; authenticated
review/read API coverage and separate C4 fixture-browser evidence retain their
stated scopes.

Fresh deployment metadata confirms public Autoscale hosting. Official Replit
documentation says Autoscale is request-driven and can scale to zero; Reserved
VM is the continuously running option for background workers. This is an
architectural constraint, not proof that hosting caused the observed 25P03,
lock waits or event-loop delays. Hosting remains unchanged pending an actual
owner decision. Native limits, provider/outbound controls and production schema
have not been relaxed or changed.

Production remains on the earlier build. The last verified October execution
accounting is 98/113/6/2/2 with pending fulfillment 60/55/1/1/1; earlier September
isolated committed cycles do not establish full disposition. The latest primary
capture failed after 5.09 seconds with zero database observations, so it provides
no performance-improvement proof. Recent published logs still show runtime
renewal/acquisition and native import delays.

Original A–G production acceptance remains open: deploy the consolidated
verified corrections through the existing supported publication path, establish
ordinary sustained execution, prove three consecutive eligible source-scoped
committed cycles, then reconcile the full production-contact population and
each actual October execution, with production fresh-process restart and
retained replay. No new task, recovery service or approval gate is created.

### Owner-approved always-on hosting configuration

The owner selected Reserved VM after disclosure of ongoing compute charges.
The supported publishing configuration now sets deploymentTarget to `vm`.
The verified configuration diff changes only that target; the existing
build command and release-SHA-aware run command remain byte-for-byte unchanged.
No provider/outbound control, workflow, native limit or production schema was
changed.

This configuration takes effect on the next owner publication, not immediately.
No publication was performed by the agent. The failed stock release checks and
original A–G production acceptance remain open. After publication, obtain fresh
deployment metadata and serving/build identities before measuring worker
continuity, original source-scoped progress and the remaining disposition,
restart and replay obligations.

## Post-publication production observations — 2026-10-14 11:17–11:27 UTC

The owner published the consolidated corrections. The production health response
serves SHA `584d6acb633f68ee100a553989bd13fbf09f782f`, built at
11:17:15.311 UTC, with publish build identity
`5fa23497-da68-402c-bffc-c4f807240bca`. Actual worker readiness logs identify
that same release. This establishes delivery, not full acceptance.

Publishing **did not apply Reserved VM**. Two fresh deployment metadata reads
report public Autoscale with a successful build. The publication's sole
configuration edit changed `deploymentTarget` from `vm` back to `cloudrun`.
The supported configuration has been restored to `vm`, with the same build/run
commands. Official documentation identifies Publishing → Adjust settings as
the place to select the existing deployment's new type before republishing.
An unchanged Publish click is not verified to perform that switch here.

The owner's subsequent mobile screenshots show only Autoscale CPU/RAM and
maximum-machine controls, with no deployment-type selector. The earlier
instruction to select Reserved VM directly in that live settings screen did
not match the available UI. Further official documentation lookups say that
switching an already-published app requires unpublishing before selecting
the new type. The owner subsequently approved planned downtime for this
hosting switch. No shutdown/unpublishing was performed.

The later full-pane screenshot `IMG_1908_1791980040919.png` identifies the
actual **Change deployment type** button in **Manage your app**, below
**Database settings** in expanded **Adjust settings**. Its displayed explanation
states that changing type requires unpublishing and publishing again. This
guided flow is distinct from Autoscale sizing, Pause and the standalone
Unpublish button. The adjacent development-to-production copy checkbox is
unchecked and explicitly warns of overwriting production data; it must remain
unchecked. The owner is directed to the guided switch, not project/database
deletion. Live hosting and all connected domains still need verification after
the owner completes the publication.

Existing authenticated production readers returned:

| Actual primary request | HTTP | End-to-end request time |
| --- | ---: | ---: |
| Canonical enrichment status | 200 | 2,908 ms |
| Automatic assignment status | 200 | 612 ms |
| Existing coverage status | 200 | 221 ms |
| First human-review page, 50 candidates | 200 | 4,896 ms |
| Next human-review page using the exact returned cursor | 200 | 3,984 ms |
| Existing CSV import list with version-1 recovery facts | 200 | 366 ms |

The two review pages contain 50 distinct candidate IDs each with zero overlap.
Their cursors retain native timestamp microseconds. This is successful deployed
first/next-page behavior during active ordinary workers, not signed-in rendered
UI verification, complete returned-fact parity or component/transaction timing
under a controlled representative load.

The three native relationship function fingerprints match the previously
certified bodies. At 11:27:30.99428 UTC the separate full identity-bridge
predicate returned true: exact relation, trigger name/type/enablement,
no predicate/internal substitution, exact function namespace/name and
`f0c933f2b332d19ec7d51866e2ad5a7b` body hash. The general status guard was
not substituted for this separate native check.

At 11:22 UTC the five October executions still have original accounting
98/113/6/4/2, with pending mailbox fulfillment 54/55/1/1/1. All five executions
remain running. The fourth execution advanced two original rows beyond the prior
2-row checkpoint. None appears in the retained current-qualified receipt
aggregation: retained recovery applies to completed executions, so that
aggregation is not an assertion that ordinary October materialization is zero.
September has 352 current-qualified retained item receipts, latest at
11:18:03.672 UTC; original accounting remains 1,472. These are observed partial
effects, not full original-row fulfillment or replay/restart acceptance.

The assignment reader reports 155,172 active production contacts, 1,255 current
verified assignments and 153,917 unresolved, with native contract verified and
zero legacy projected contacts lacking a current verified assignment. Its
independent program remains incomplete at cursor 13,159 and last checkpoint
11:18:26.369 UTC. The separate coverage run remains incomplete at cursor
153,601, with last recorded progress 04:20:26.683 UTC.

The existing admin read-only primary capture was accepted (HTTP 202), but
**failed** after 21,397 ms, 43 samples and four blocker snapshots. Observed
process CPU is 1,076.785 ms; event-loop p99 is 500.433 ms and maximum is
1,801.454 ms. Snapshots identify the capture's process, an import-materialize
transaction and ordinary discovery waiting on that transaction. These short
observed waits do not prove deadlock or the cause of prior delays. The incomplete
window is not a passing 60-second measurement or proof of VM performance.
Published ordinary failures still expose SQLSTATE 25P03.

Private HTTP responses/capture evidence are retained under the ignored
`generated-artifacts/intake-consolidated-stock-evidence/post-publish` directory.
Session cookies and credentials were not written. Initial collector cookie
handling was corrected before authenticated measurements; the review overlap
assertion was corrected to use actual `candidateId` fields, and both saved
successful responses were independently verified. These collector mistakes
were not attributed to application defects.

No workbook was re-uploaded, provider/outbound control changed, production SQL
written or application timeout relaxed. Original production acceptance and
the failed stock release checks remain open; there is no release GO.

## Reserved VM and exact coverage correction — 2026-10-14 13:13–13:40 UTC

Fresh deployment metadata confirms public Reserved VM, a successful build,
primary `https://libertybancard.com`, additional `https://dev.libertybancard.com`
and the existing Replit production domain. Both Liberty health endpoints returned
200 with the same SHA `ddb92c501a32892485ed9e4345eb3c86942fe750`,
build `f8bdeb30-0762-49b7-838a-2a147562723f`, built 13:03:30.696 UTC.
The owner reconnected the Liberty domains after the hosting switch.

The primary read-only diagnostic completed its full 60-second window:
216 samples, zero observed blockers and no failure; event-loop p99 21.873 ms,
maximum 66.781 ms, primary database round-trip maximum 167.718 ms. This is
a successful observation window, not sustained production acceptance.
Canonical, assignment and coverage readers returned 200. Actual first/next
review requests returned 200 in 6,836/5,776 ms, with 50 unique candidates each,
zero overlap and a lossless microsecond cursor. An earlier collector used the
wrong query parameter names and repeated the first page; only corrected
`afterCreatedAt`/`afterId` requests establish that result. Signed-in rendered UI
remains unverified.

At 13:18 UTC the separate complete bridge verifier returned true and all three
relationship function fingerprints retained the certified bodies. October
accounting was 270/119/13/113/166, pending fulfillment 1/1/0/2/1; all five
executions remained running, with observed advancement in two executions.
September retained 1,472 originals and 363 distinct current-qualified receipts.
Assignment reported 155,474 active contacts, 1,556 verified and 153,918
unresolved, with independent cursor 13,359 still incomplete. These are partial
observations, not full source/contact disposition.

The **same original coverage run**, cursor 153,601, watermark 159,476 and
153,000/154,418 processed, was tested through its existing authenticated,
CSRF-protected resume action. The collector timed out at 25 seconds; actual
production logs subsequently established SQLSTATE `57014` at 30,070 ms,
HTTP 500 at 30,597 ms and rollback. Pool state was six total, three idle,
zero waiting. This is a query statement timeout, not pool exhaustion.
No scope reset, workbook resend or blind transport-timeout retry occurred.

The actual pure hydration query's plan exposed repeated full-business/source
hash builds beneath parameterized source-key branches. An entity-first draft
still rebuilt the full business hash: its executed candidate-only profile
read 705,565 shared blocks and took 8,920.432 ms. That scalar profile was
diagnosis, not full hydration acceptance. A baseline replica profile was
canceled by recovery conflict and is not a completed runtime measurement.

The correction preserves business existence explicitly with a parameterized
PK probe, pairs it with an exact indexed source-namespace probe, and prevents
unlinked-source existence checks from flattening into universe hash joins.
Filing-only missing-entity behavior, payload fields, matching, relationship
proofs, scope and timeouts remain unchanged. No DDL or native-function changes
are part of this correction.

The **full corrected query**, including payload/proof extraction, executed on
the production read replica with exact parameters `[153601,159476,500,null]`:
500 contact rows, 956 candidate pairs, planning 417.805 ms, execution
4,021.735 ms, and zero repeatedly executed business/source universe scans
in the candidate-pair subtree. The compiled workspace SQL equals the measured
variant after comments/whitespace normalization; its SHA-256 is
`2c674e9b94d1357abb620f76062b1a21dea90a4359ca1b0e454c79ae52ca7328`.
This is an uncontrolled replica observation, not a primary request timing,
causal speedup proof or committed coverage-checkpoint advancement.

The disposable intake batch passed all nine intake suites and the affected
Florida continuation regression. The review suite now passes 31 checks,
including full 500-contact result parity against the frozen prior-query oracle
at 147,003 businesses and 127,003 linked sources, executed source-namespace
and business-PK indexes, no repeated universe scan in the candidate-pair stage,
admin hydration/keyset continuation, manager/agent 403 and unsigned 401.
The local full 500-contact query took 18,938.768 ms; this fixture timing is
separate from the replica observation and not a production latency claim.
The automatic-linking certificate passed 51 checks with unchanged native
fingerprints and zero external network attempts. Application build passed;
the existing build warnings remain. The restarted development app serves its
public landing page; development release identity is unverified as expected.
Startup confirmed no unknown contacts to reclassify.

Evidence is retained under ignored
`generated-artifacts/intake-consolidated-stock-evidence/post-publish`.
The corrected query is **not published**. Original run advancement, three
eligible ordinary production cycles, full source/contact disposition and
production fresh-process restart/replay remain pending. The previous stock
release result (124 passes, 60 failures, two skips) is not superseded by this
focused regression batch. The task remains unfinished and there is no release GO.
