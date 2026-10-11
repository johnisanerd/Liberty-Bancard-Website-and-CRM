# Intake and Business Assignment — local verification

Observed through 2026-10-11 UTC. **The original task remains open. This is not
end-to-end production acceptance, publication authorization or release GO.**

## Verified locally

All database cases below ran in newly migrated disposable PostgreSQL databases,
with isolated Redis where applicable. The intake group gives each certificate
its own fresh database rather than reusing another certificate's mutable graph.
No live imports, recovery, provider activation, sending or production DDL were
performed by these checks.

| Check | Result and limits |
| --- | --- |
| Five actual October workbooks | Passed on the final native contract: all 2,914 original rows accounted for, original 93-column payloads retained. All five files passed separately. No providers, cohorts, validation purchases or messages. This is not production ingestion or a target number of newly created contacts. |
| Native contract and aliases | Actual native identity-bridge verifier passed. Read/native source-family evaluators and reviewed-link enforcement were pinned to exact bodies. No observed production hash was added to an allowlist. |
| Organization resolver | 10 actual native checks passed; zero provider calls/outbound changes. Precise location identity, supported matching/creation and conflicts remain distinct from shared-brand domain identity. |
| Execution isolation | 10 checks passed. Three active imports cannot project a request failure onto the wrong execution. Real native abort isolation and fatal authority-loss behavior remain separate. The shipped serial queue case additionally proves canonical recovery runs before an unsafe expired-upload failure, and that unknown-commit/owner failures still propagate. |
| Source-only reconsideration | 6 checks passed without changing the contact timestamp. Immutable corrections change snapshots; unchanged `last_seen_at` refreshes do not. |
| Source-family materialization | 30 checks passed for GHL, Apollo and manual CRM. Personal mailboxes were accepted with independent organization evidence. Three locations under one brand remained three businesses. Legal-name suffix aliases agreed. Superseded source evidence was rejected; a restoring observation restored eligibility. Actual audited affiliation and repeat preservation were verified. Weak evidence remained held. |
| Ordinary automatic linker | 51 checks passed, including three consecutive eligible ordinary cycles, each committing a new native audited relationship. Explicit pause, stale/live leases, owner-before-graph ordering, publish-owner transfer, retired/revoked owner denial and no-provider/no-send/cohort independence were retained. These are local cycles, not the required production cycles. |
| Authenticated review endpoint | 20 checks passed using actual local login, session guards, route and native hydration. Full returned-fact parity against the frozen prior implementation, domain/DBA/name/owner-phone/filing key coverage, native index-plan use, and microsecond-safe first/next/terminal pages passed. Manager/agent remained 403 and anonymous access 401. At 147,002 businesses and 127,001 linked sources, one-contact hydration took 41.369 ms; four source-backed contacts took 1,205.827 ms. These are disposable serving-volume observations, not corrected production-request timings. |
| Geography | 787 pure checks passed. FL/Florida/case/whitespace aliases agreed; GA, county/ZIP conflicts, disabled Monroe and missing geography remained held. |
| Existing free continuation | Native cursor, pause/resume, replay and zero-spend checks passed. Unchanged Florida-alias holds were reconsidered; a still-held Monroe observation received a policy marker and did not create repeated followup runs. |
| Public preview | Migration 0350 was applied through the existing development migration runner. The application workflow was restarted once and came up on port 5000 with journal migrations current and background jobs off. `/login` rendered. Signed-in UI was not visually verified; authenticated API behavior was separately certified. |
| Build | `npm run build` passed. This is a local build, not a publish or release approval. |
| Type check | Still fails only on the pre-existing missing `LiveChat` name at `server/routes/live-chat.ts:309`; that source is unchanged from HEAD. No task-specific type errors remain. The stock release gate is not declared passed. |

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

## Original acceptance still outstanding

1. The September capture is revision-verified, but authentic native restoration
   is blocked by the demonstrated production/schema uniqueness mismatch.
   The original 1,472-row recovery and replay remain uncertified; no normalized
   or empty-CRM substitute was accepted.
   Full native ordinary-upload fresh-process restart and retained replay of the
   1,472 originals remain unverified. Preserve all 1,277 mailbox occurrences,
   195 business-only originals and both protected foreign relationships.
2. Exact production execution/source/batch/current-outcome identity for each
   October file remains unverified. The last exact hash lookup found no matching
   production executions; the disposable workbook success cannot fill this gap.
3. Production native delivery and serving-build identity remain unverified.
   No separately authorized publication/live-write action was taken.
4. The exact authenticated human-review 500 is correlated and its local
   correction is certified, but it still needs corrected primary request/transaction/component
   timing under representative ordinary concurrent load.
5. The deployed correction still needs at least three consecutive eligible
   production cycles, full source-scoped dispositions, and the distinct
   ordinary-upload restart/retained replay acceptance.

No additional tasks or replacement pipelines were created. Outbound controls
were not changed. The original acceptance gaps were not moved into follow-ups.
