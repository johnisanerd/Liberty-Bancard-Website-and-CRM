---
name: Certification fixture reuse after lifecycle mutation
description: Reusing the same seeded business/run/idempotency-key fixture across sequential lifecycle-mutating checks in a certification script causes later checks to observe the mutated state, not the originally-intended one.
---

In disposable-DB certification scripts that walk a state machine (freeze → void →
supersede → mark-as-existing-customer, etc.), a fixture created early (a business
row, a cohort run, an idempotency key) is often reused later in the script to
avoid fixture sprawl. If an earlier check step *mutates* that fixture's state
(voids a run, marks a business as an existing customer via a join table, etc.),
every later check that reads the same fixture id sees the *mutated* state, not
the state the fixture had when it was created — even though the mutating step
and the reading step look unrelated at a glance (different VFC/test IDs, far
apart in the file).

**Why:** exclusion/eligibility pipelines typically check several disjoint
conditions in a fixed priority order (e.g. dbpr → existing_customer →
suppressed → bounced → inactive → geography → vertical). Once a fixture trips
an earlier-priority condition (e.g. an unrelated "make the cohort empty"
fixture step flags it as `existing_customer`), it can never again exercise a
later-priority condition (e.g. `suppressed`) in any run frozen after that
point — the earlier condition wins every time, no code bug required.

**How to apply:** when a later check's actual result doesn't match its
asserted expectation, and the check reuses an id/key created much earlier in
the script, check for any intervening line that mutates *that same fixture*
(state transition, membership in a join/exclusion table, terminal-state flag)
before assuming the application code is wrong. Fix by either (a) pointing the
later check at an *earlier* snapshot/run that predates the mutation, or (b)
minting a fresh, dedicated fixture for the later check. Don't assume a fixture
id is stable in meaning just because its variable name didn't change.

For "unrelated volume does not change returned facts" benchmarks, capture the
baseline after all relevant edge-fixture mutations, immediately before inserting
the unrelated volume.

**Why:** Adding a missing-entity source link to a competing business changed the
original contacts' real evidence. Comparing with the earlier baseline falsely
attributed that fixture change to the volume or query optimization.

**How to apply:** Preserve an independent old-query comparison, but refresh the
volume-invariance baseline after adding conflict/source fixtures. Do not weaken
the full returned-fact assertion to compensate for a stale baseline.

Receipt assertions must bind the current execution/run as well as the selected
source identity. Selecting by candidate ID alone can include an older
review-required eligibility row with no provider receipt, even when the new
validation produced a genuine completed receipt for that same candidate.

**Why:** append-only history preserves multiple decisions for the same source.
Source identity identifies the candidate, not which execution produced evidence.

**How to apply:** prove the current run's output and its direct/reused receipt
lineage explicitly. Keep historical rows and their original evidence unchanged;
do not broaden a passing proof to every row ever associated with the source.

Duplicate-address fixtures must follow the actual committed owner, not assume
the first seeded business wins. Separate intents can also share one candidate.

**Why:** Recipient deduplication can select either alias as owner based on
ordering. Assuming the first business or a distinct candidate made a complete
pipeline certification fail intermittently or fail to exercise real pin drift.

**How to apply:** Derive bridge-contact assertions and source lookups from the
winning intent's business. For address-drift tests, mint a distinct candidate
and prove its identity differs before making the mutation.

Raw-SQL certification fixtures must honor the actual migrated constraints;
do not assume they receive the canonical writer's normalization or defaults.

**Why:** Direct inserts bypass application-derived identity fields and blank
identifier normalization. A setup constraint failure can otherwise be mistaken
for a failure of the feature under test.

**How to apply:** Prefer existing canonical fixture writers when their behavior
is not the subject of the test. For intentional raw native-contract fixtures,
inspect the migrated required fields and identity constraints before insertion,
and distinguish setup failures from assertions on the feature.

Disposable infrastructure does not imply an empty database for every suite.
Bind absolute row-count assertions to the fixture's explicit IDs or actor;
use a measured before/after delta when proving a whole-table invariant.

**Why:** The canonical integration roster can share one migrated disposable
database. Individually passing suites then see retained rows from earlier
suites, so absolute global counts falsely report lifecycle or retention errors.

**How to apply:** Keep prior evidence intact. Scope assertions rather than
deleting earlier fixtures or loosening expected outcomes. Run the canonical
roster as well as bounded fresh-database checks.

Authorization-negative fixtures for fenced commands still need a valid,
current actor/version/command envelope.

**Why:** An obsolete empty-body caller reaches input rejection, not ownership
authorization. A 400 then falsely looks like a role-policy regression, and
changing accepted statuses would conceal the missing authorization proof.

**How to apply:** Pin the suite's own principal and record versions, submit
valid command fields even for nonowners, assert the exact denied response and
retain the existing zero-effect/readback checks. Run mutating registered checks
through their dedicated disposable launcher, never the shared preview database.
