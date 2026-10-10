# Intake and Business Assignment — local verification

Observed 2026-10-10 UTC. **The original task remains open. This is not
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
| Authenticated review endpoint | 14 checks passed using the actual local login, session guards, route and native hydration. Admin first/next/third pages advanced without duplicates, then returned an empty terminal page. Manager/agent access remained 403 and anonymous access 401. This is not correlation of the historical production 500. |
| Geography | 787 pure checks passed. FL/Florida/case/whitespace aliases agreed; GA, county/ZIP conflicts, disabled Monroe and missing geography remained held. |
| Existing free continuation | Native cursor, pause/resume, replay and zero-spend checks passed. Unchanged Florida-alias holds were reconsidered; a still-held Monroe observation received a policy marker and did not create repeated followup runs. |
| Public preview | Existing `/login` rendered. Signed-in application UI was not verified. The current ambient server was not restarted to imply that its native schema matches these disposable certificates. |
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
Production log search found no matching `contact-link-coverage` exception
since 2026-10-08. Other worker/pool failures were visible, but are not attributed
to the historical authenticated review 500.

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

## Original acceptance still outstanding

1. A verified authentic September native capture is unavailable. The previous
   private capture was already rejected; no synthetic substitute was accepted.
   Full native ordinary-upload fresh-process restart and retained replay of the
   1,472 originals remain unverified. Preserve all 1,277 mailbox occurrences,
   195 business-only originals and both protected foreign relationships.
2. Exact production execution/source/batch/current-outcome identity for each
   October file remains unverified. The last exact hash lookup found no matching
   production executions; the disposable workbook success cannot fill this gap.
3. Production native delivery and serving-build identity remain unverified.
   No separately authorized publication/live-write action was taken.
4. The exact authenticated human-review 500 remains uncorrelated, and the
   failed coverage operation still needs primary request/transaction/component
   timing under representative ordinary concurrent load.
5. The deployed correction still needs at least three consecutive eligible
   production cycles, full source-scoped dispositions, and the distinct
   ordinary-upload restart/retained replay acceptance.

No additional tasks or replacement pipelines were created. Outbound controls
were not changed. The original acceptance gaps were not moved into follow-ups.
