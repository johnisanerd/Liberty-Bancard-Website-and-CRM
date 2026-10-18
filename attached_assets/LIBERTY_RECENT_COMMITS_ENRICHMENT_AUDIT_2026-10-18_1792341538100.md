# Liberty Bancard — recent commits and enrichment progression audit

**Audit date:** October 18, 2026  
**Repository:** scottpstevenson/Liberty-Bancard-Website-and-CRM  
**Audited main:** `615cfb50fc06977f303c5f3c6ece164c48757d96`  
**Comparison baseline:** `f358d745934154bf14e9ae0b1e483177195bb917`  
**Scope:** ten subsequent commits; 35 changed files, 2,538 additions and 164 deletions. The latest substantive changes are the bounded reconsideration/recovery-test commit and the production constraint repair.

**Verdict:** The accepted-vertical repair and bounded traversal landed. The repeated escalation loop remains a source-confirmed defect. First-party evidence capture has independently reproduced faults that can leave otherwise useful businesses provisional. Whether canonical paused preparation is actually stalled has not yet been established by the legacy-name check in the supplied production note.

## Evidence boundary

This audit inspected the current committed source and diffs through the revision above. It independently executed **10 local assertions**: eight extractor/policy checks using fake HTTP/DNS and two fingerprint checks. No production query, app control change, provider request, enrollment or send was performed.

Production figures below are **reported observations from the user's Replit note**, not newly measured results:

- 543 accepted businesses: 436 website-service acceptances and 107 AI-cited acceptances, between 08:00 and 10:00 UTC.
- Approximately 835 subsequent reconsiderations recorded provisional results.
- 3,401 untiered targets remain, including 2,051 already behind the cursor.
- Approximately eight businesses repeatedly receive provisional rows from paid-escalation runs; examples include 38474 and 48130.
- The observed reconsideration cursor is 81,624 with no recorded error.

No PostgreSQL binaries were available in this audit environment. The repository's disposable database suites and production query timings were not independently rerun. No independently observed served revision is asserted; the latest Git commit is publication bookkeeping.

## What landed

| Area | Landed implementation | Acceptance limit |
| --- | --- | --- |
| Accepted verticals | Policy-owned `policy_accepted` tier, supporting facts, source references, input/content fingerprints and revised effective-vertical/ROI readers | Source confirms integration; supplied production note reports 543 accepted businesses |
| Single-source policy | Own website activity or retained, identity-matched Serper category can suffice; AI quotes checked for presence, generic text, negation, audience/vendor context and contradictions | Earlier reported counterexamples are covered; source acquisition still has the defects below |
| Retained listing handoff | Reads encrypted `listing_category` paid evidence, ignores discredited/quarantined evidence, includes its hashes in inputs | No need to require an additional source or Sunbiz for ordinary vertical acceptance |
| Automatic reconsideration | Old untiered targets, stale inputs/policy, unread provisional websites and scheduled website refresh are discoverable | A provisional result is not an accepted vertical; changed website availability can remain behind a hold |
| Bounded discovery | Persisted keyset cursor; windows of 1,000 canonical businesses, at most ten windows and 25 work items per tick; cursor advances after work handling | Replaces the prior whole-population reconsideration query; paid escalation retains its separate whole-set selector |
| Scale harness | Disposable production-shape fixture of 93,140 businesses, 103,187 evidence rows and 128,754 items; query-plan and full-pass measurements | Harness presence is verified; runtime results are not independently recertified here |
| Recovery test repair | Restores `email_status='unvalidated'` instead of NULL; bounds the concurrency-claim fixtures to one row | Prior TC-7c fixture defect is fixed in source |
| Test execution registration | Disposable runner now includes `post-enrichment-intent-recovery`, `reconsideration-scale`, `vertical-acceptance-policy` and legacy containment | Do not continue citing absence from a runner as a blocker |
| Production schema delivery | Migration 0367 and shared schema rename the admission-tier check to `sfp_classification_evidence_admission_tier_v2_chk`, allowing `policy_accepted` | Supplied note reports the corrected constraint is live; verify remaining columns/checks with the actual served build |
| Legacy producers | Post-enrichment enrollment/GHL effect is contained; unattended broad ZeroBounce auto-run is contained | Operator-launched ZeroBounce campaigns remain filter-based; their canonical validation gate remains relevant |
| #2090 follow-up | Full Serper replay return shape, canonical JSON hashing, revised credit reservations and under-bound closure, updated certifications | Unlabeled measurement remains separate; no numeric cap is needed to repair the local classification/preparation problems |

The local materializer, canonical preparation owner and queue integration already exist; a new pipeline is not required.

## Findings and corrections

### F1 — unchanged paid-escalation work is selected repeatedly

**Priority: high. Source-confirmed; consistent with the supplied repeated-row observations.**

Sources:

- [Free classification continuation](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-free-classification-continuation.ts), especially `processPendingVerticalEscalations()`, lines 149–214.
- [Classification bridge](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-classification-bridge.ts), default OpenAI adapter and cache/provisional writes.

The selector finds historical provisional/retry-coded evidence, orders by business ID and limits the result. It does not require the candidate evidence to be the latest attempt for the current inputs, and it has no next-attempt timestamp or backoff predicate. The reconsideration sweep's seven-day/day hold is not used by this separate escalation selector.

Each invocation creates a new run key from the classification-run count. The bridge's completed-result cache deliberately excludes provisional and unavailable/non-attempt results. Its evidence idempotency key includes the new run key, so an unchanged provisional result can be appended again every tick.

The default OpenAI adapter also collapses several distinct outcomes into null: invalid output, a replay with unusable result data and caught failures. The caller turns null into `OPENAI_UNAVAILABLE` and treats that as a non-attempt. This prevents a precise explanation of why these businesses are repeatedly provisional.

**Repair within #2087:**

- Select the latest relevant work state for the current business/evidence/policy/prompt inputs.
- Record explicit attempt/retry disposition and next eligibility. Reopen on materially changed inputs or a corrected rule; back off actual transient failures.
- Reuse retained successful provider results. Distinguish configuration denial, transport failure, unusable output, stale/replayed results and missing usable source evidence.
- Do not append another identical classification observation merely because a new queue invocation happened. Preserve immutable historical evidence; use an existing operational work ledger or a narrowly scoped retry record for scheduling.
- Prevent low-ID unchanged failures from repeatedly occupying the front of the batch.

**Acceptance:** ordinary repeated ticks with unchanged evidence do not produce another provider purchase or another identical provisional row. A transient failure retries when due; new usable evidence reopens once. Verify both zero-cost no-attempt behavior and actual provider-operation/receipt state.

A reported cost of zero alone is not proof of zero requests or zero provider billing: this code can project absent cost information as zero. Count requests, reservations, receipts and settled usage separately.

### F2 — website evidence can lose usable sources or accept an error response

**Priority: high. Independently reproduced against current extractor and acceptance logic with fake HTTP/DNS.**

Sources:

- [Website extractor](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-website-evidence.ts), lines 93–175.
- [Acceptance policy](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-vertical-acceptance.ts), retained website statements and deterministic acceptance.
- [Bridge website fetch](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-classification-bridge.ts), lines 808–835.

| Fixture | Current observed behavior |
| --- | --- |
| HTTP 301 with a Location header to the business's www host | Only the first URL is requested; an empty evidence object is returned without an error |
| HTTP 503 containing a dentistry heading | Returned as ordinary evidence and accepted as Healthcare |
| HTTP 200, generic title, dentistry services described in a paragraph | Paragraph is discarded; deterministic acceptance returns none |
| Same service description placed in a heading | Accepted |

The extractor requests `redirect: "manual"` but never handles the returned redirect. It also does not check the HTTP status before parsing. Consequently, a redirect is not necessarily recorded as `WEBSITE_EVIDENCE_UNAVAILABLE`; it can look like a successfully read but insufficient page and receive the longer reconsideration hold.

The retained quotable description consists of title, meta description and h1–h3 headings. Ordinary service paragraphs are reduced to a small token vocabulary. The AI sees some tokens, but cannot cite the omitted paragraph through the acceptance policy.

These defects are plausible contributors to the 835 provisional outcomes. **The exact affected production count is unknown** and must be established from retained source/fetch outcomes or a bounded diagnostic sample.

**Repair within the #2087/#2089 handoff:**

- Follow a bounded number of supported redirects, validating each destination and actual connection through the existing public-target protections; preserve time/body limits and the final source URL.
- Classify non-success responses, redirect failures and unreadable/challenge content explicitly instead of presenting them as usable business evidence.
- Retain bounded, relevant main-content service descriptions, with provenance and content hashes, so both deterministic policy and AI citations can use the business's actual description.
- Reopen affected provisional work after the corrected extraction rule; do not make it wait seven days solely because the defective extractor previously produced an empty success.

**Acceptance:** redirect-to-www, redirect-to-private-target rejection, loops, HTTP failure, paragraph-only services and ordinary positive pages are covered through the real bridge/continuation using fake transport. Failed fetches must not create a target or non-target classification.

### F3 — adding a website does not reopen the provisional hold through the input fingerprint

**Priority: high for automatic recovery. Independently reproduced fingerprint behavior plus source-confirmed selector effect.**

Sources:

- [Shared fingerprint](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/shared/sfp-input-fingerprint.ts).
- [Server fingerprint](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-input-fingerprint.ts).
- [Reconsideration discovery](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-reconsideration-discovery.ts), current-provisional hold branch.

The fingerprint includes legacy vertical/industry values and retained listing-category hashes, but excludes website domain and website availability. The separate domain check applies only where an accepted decision carries `acceptance_facts.websiteSourceUrl`.

A source-poor provisional result has no such acceptance facts. Adding its first website leaves the fingerprint unchanged; a current provisional row can therefore continue suppressing reconsideration for seven days even though new evidence is available. A materially improved page fetch also is not represented in that provisional hold's scheduling inputs.

The independent check confirmed equal fingerprints before and after adding a website to otherwise identical inputs.

**Repair:** distinguish decision validity from retry/discovery inputs. A valid listing-based decision need not be invalidated by filling a domain, but a pending job waiting for website evidence must reopen when its website becomes available, changes, or newly retained content arrives. Include the appropriate source/availability/extractor version in that pending-work key or its wake-up mechanism.

Keep the bounded cursor and existing completed progress. Do not reset the whole scan or remove all retry delays.

**Acceptance:** an old provisional business receives a supported website or corrected retained content, then advances through ordinary work without waiting for the old no-evidence hold. Unchanged missing evidence stays quiet.

### F4 — the preparation conclusion is based on the wrong evidence

**Priority: high for completion/production acceptance; current root cause not yet established.**

Sources:

- [Canonical preparation worker](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/canonical-recipient-preparation-worker.ts).
- [Canonical preparation writer](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/canonical-recipient-preparation.ts).
- [Queue orchestration](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/queue-manager.ts), lines 2736–2794.
- [Legacy SFP staging worker](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/615cfb50fc06977f303c5f3c6ece164c48757d96/server/services/cro03/sfp-campaign-staging-worker.ts).

The supplied note checks `sfp_ready_held_*`, an older SFP path. Current canonical preparation writes:

- `cr04_enrollment_intents` with `preparation_state='pending_validation'` or `'ready_held'`;
- paused `sequence_enrollments` whose metadata contains `canonicalPreparationId`, `programId` and `outboundAuthorized:false`;
- selected-recipient validation intents where required.

The queue manager invokes the canonical preparation worker inside **SFP_CONTINUOUS_DISCOVERY**, scheduled every 30 minutes. The classification queue runs every ten minutes. Seeing classification ticks does not verify preparation execution. The local preparation call precedes paid discovery and is not itself gated on provider readiness.

The worker requires a verified contact/business association, available contact email and exactly one supported program/sequence binding. It uses the effective-vertical reader, which now recognizes policy acceptance. A business becoming classified does not by itself create a contact or a sequence binding.

**Required read-only production reconciliation:**

Freeze the reported 543 businesses as a dated cohort, then report distinct businesses/contacts through:

1. current accepted decision and effective vertical;
2. retained staged mailboxes, materialization outcomes and usable linked contacts;
3. current verified relationship;
4. active program and explicit/current-package sequence bindings, including missing or ambiguous bindings;
5. canonical preparation records and their states;
6. owned paused sequence memberships;
7. pending validation, fresh reused receipts and explicit hold reasons.

Inspect `canonical_recipient_preparation_cursor`, its population/priority progress, runtime/native guard failures, actual discovery-queue executions and `[CanonicalRecipientPreparation]` logs. A queue invocation may succeed after this local stage logged an error because its exception is caught.

Do not infer a new preparation merely from the worker's `prepared` counter: it increments when the writer returns an enrollment ID, including convergence onto an existing membership. Compare distinct durable rows/identities and meaningful state transitions.

If the canonical records show real stagnation, repair the first failing transition identified by this reconciliation. Do not invent a missing worker, re-enable the legacy producer, reset all contacts or force links.

**Acceptance:** several ordinary worker cycles produce source-backed canonical preparations for eligible members of the accepted cohort. Every remainder has an evidence-backed source/contact/link/binding/eligibility outcome. A lack of usable evidence is an honest hold, not a reason to force acceptance.

## Additional boundary to handle in the same continuation

**Operator-launched ZeroBounce campaigns:** unattended auto-run containment does not retire these filter-based campaigns. They call `createValidationIntent()`, which still requires `currentCanonicalValidationSelection()`; the presence of a filter-based selector therefore is not proof of a provider-spend bypass.

However, the worker ignores the boolean returned by `createValidationIntent()` and then dereferences `intent.rows[0].id`. If a contact is unselected and has no validation intent, this can become an exception/retry instead of a clear selection-required disposition. Handle that return explicitly and verify the guarded manual path. This is a secondary, source-confirmed failure-handling gap; it is not established as the cause of the current classification/preparation stall.

## Interpretation of the production note

- The constraint repair and 543 acceptances are meaningful reported progress.
- No acceptances after 10:00 UTC is **not alone proof of a stopped worker**. Later businesses may lack usable evidence; the extractor defects and source supply must be checked before deciding.
- Advancing the reconsideration cursor proves traversal, not accepted classification or preparation.
- The repeated paid-escalation observations have a concrete scheduling/idempotency explanation in source.
- A seven-day delay after an accurate no-evidence outcome may be intentional; applying it after a redirect misread or after new website evidence arrives is the problem.
- The claim that nothing reaches paused preparation remains unverified until the canonical records above are examined.
- The 30-day website refresh remains an eligibility interval, not a guaranteed completion deadline under backlog.
- #2090's numeric cap is relevant to its unlabeled Serper measurement. It does not block these local repairs, free first-party reads or auditing the accepted cohort.

## Recommended continuation and ownership

Keep these repairs in **#2087 and its coordinated #2089 continuation**, with one concrete owner for shared files. Do not create a task for each finding.

1. Repair F1 so unchanged no-attempt/failed work stops generating identical evidence and monopolizing selection.
2. Repair F2 and F3 together: acquire usable first-party evidence, preserve its meaning/provenance, and wake pending work when that source becomes available or the extraction rule changes.
3. Reconcile the reported 543 businesses through F4 before changing preparation logic. Fix the actual missing transition and capture reasons for all remaining holds.
4. Handle the secondary ZeroBounce selection-required return without weakening the canonical gate.
5. Run the existing disposable suites plus the focused regressions above. Include consecutive ordinary-tick tests with unchanged inputs, changed evidence, transient failures and later-ID eligible work. Test the worker path, not only direct calls to the preparation writer.
6. Publish the reviewed candidate once the checks pass, verify the served build and required native objects, then certify durable ordinary progression with distinct business/contact/preparation/member counts.

Preserve original evidence, provider receipts, source fingerprints, current links and cursor progress. Keep Serper enabled under existing controls and outbound paused. No new provider ceiling or email acceptance policy is required.

Broad nationwide business assignment remains #2091. Do not make completion of all roughly 152,000 unresolved contacts a prerequisite for processing the currently eligible accepted cohort.

## Commit inventory

Times below are UTC.

| Commit | Time | Change |
| --- | --- | --- |
| `eba41237` | 2026-10-17 22:55:21 UTC | Published your App |
| `91b16ecd` | 2026-10-17 23:48:32 UTC | Refactor SFP classification logic and update certification scripts |
| `eb85ed29` | 2026-10-18 00:35:16 UTC | Update vertical policy documentation and expand acceptance tests |
| `e3ed213b` | 2026-10-18 00:58:05 UTC | Bound SFP reconsideration discovery with a persisted cursor; add scale measurement; fix post-enrichment recovery test fixtures |
| `ab816720` | 2026-10-18 01:13:20 UTC | Published your App |
| `bbd34189` | 2026-10-18 01:33:19 UTC | Record publish schema-drift lesson |
| `81383062` | 2026-10-18 02:08:01 UTC | Published your App |
| `0eeb39d6` | 2026-10-18 08:08:33 UTC | Publish corrected admission_tier constraint under a new name so the schema diff applies it |
| `233d390e` | 2026-10-18 08:16:23 UTC | Add asset image |
| `615cfb50` | 2026-10-18 08:24:12 UTC | Published your App |

## Changed-file ledger

This ledger covers the entire comparison range, including earlier policy and containment work in the same release batch. Asset-only and documentation-only changes are identified by their paths; they are not functional enrichment repairs.

| Path | Diff |
| --- | --- |
| `.agents/memory/MEMORY.md` | +2 / −0 |
| `.agents/memory/accepted-vertical-policy.md` | +20 / −0 |
| `.agents/memory/legacy-enrollment-containment.md` | +8 / −0 |
| `.agents/memory/publish-vs-dev-environment-drift.md` | +4 / −0 |
| `.agents/memory/serper-credit-ledger.md` | +5 / −4 |
| `attached_assets/IMG_2096_1792311368256.png` | +0 / −0 |
| `migrations/0366_sfp_vertical_policy_acceptance.sql` | +29 / −0 |
| `migrations/0367_sfp_admission_tier_policy_accepted_constraint.sql` | +9 / −0 |
| `migrations/meta/_journal.json` | +14 / −0 |
| `scripts/certification/measure-sfp-reconsideration-scale.ts` | +225 / −0 |
| `scripts/certification/test-legacy-enrollment-containment.ts` | +103 / −0 |
| `scripts/certification/test-serper-lookup-memory.ts` | +57 / −8 |
| `scripts/certification/test-vertical-acceptance-policy.ts` | +518 / −0 |
| `scripts/run-sfp2060-certification-disposable.ts` | +5 / −0 |
| `scripts/test-post-enrichment-intent-recovery.ts` | +4 / −1 |
| `scripts/test-serper-zero-yield-cooldown.ts` | +38 / −13 |
| `scripts/test-sfp-serper-pilot-control-certification.ts` | +27 / −34 |
| `server/routes/lead-ops.ts` | +2 / −2 |
| `server/services/cro03/roi-cohort-selector.ts` | +22 / −12 |
| `server/services/cro03/sfp-ai-vertical-result.ts` | +21 / −2 |
| `server/services/cro03/sfp-classification-bridge.ts` | +201 / −23 |
| `server/services/cro03/sfp-free-classification-continuation.ts` | +86 / −10 |
| `server/services/cro03/sfp-input-fingerprint.ts` | +25 / −0 |
| `server/services/cro03/sfp-paid-waterfall.ts` | +25 / −5 |
| `server/services/cro03/sfp-reconsideration-discovery.ts` | +179 / −0 |
| `server/services/cro03/sfp-reconsideration.ts` | +54 / −0 |
| `server/services/cro03/sfp-retained-listing-category.ts` | +43 / −0 |
| `server/services/cro03/sfp-serper-allowance.ts` | +96 / −40 |
| `server/services/cro03/sfp-vertical-acceptance.ts` | +503 / −0 |
| `server/services/cro03/sfp-website-evidence.ts` | +59 / −2 |
| `server/services/post-enrichment-worker.ts` | +40 / −4 |
| `server/services/zerobounce-campaign-worker.ts` | +21 / −0 |
| `shared/effective-vertical.ts` | +9 / −2 |
| `shared/schema.ts` | +20 / −2 |
| `shared/sfp-input-fingerprint.ts` | +64 / −0 |

## Reproduction and validation record

Independently executed with Node.js v24.19.0, fake HTTP/DNS and no external requests:

- Eight assertions cover redirect handling, HTTP failure, paragraph-only service evidence and the positive heading case.
- Two assertions cover unchanged retry fingerprints when a website is added and the conditional nature of the accepted-website domain binding.
- For the extractor probe, only the unavailable third-party HTTP import was replaced with throwing stubs; the injected fake transport exercises the current extractor and policy logic. This is not a production transport or DNS-rebinding certification.
- No disposable PostgreSQL, full typecheck/build, authenticated CRM, live database or provider execution was performed in this audit environment.

The failure mechanisms above are source-confirmed or locally reproduced as labeled. Their exact production prevalence and the preparation stop reason remain to be measured.

