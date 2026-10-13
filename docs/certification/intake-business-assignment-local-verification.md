# Intake and Business Assignment — local verification

Observed through 2026-10-12 UTC. **The original task remains open. This is not
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
