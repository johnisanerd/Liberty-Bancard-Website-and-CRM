# Liberty Bancard — CRM and enrichment continuation review
Date: October 21, 2026. Repository pinned to **6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3**.

## Verdict

Useful fixes have shipped, but the attached handoff is incomplete and several publication statements are stale. Three concrete repairs deserve priority: the partner route collision, retained Sunbiz completion rollback, and preservation of retained website/phone/ZIP facts. The dead-letter archive also has transaction and concurrent-status gaps.

Finish those repairs within the existing owners. Continue the existing enrichment work toward qualified South Florida businesses; do not replace it with another disconnected pipeline, a blanket domain-link approval, or a repeat of every historical task.

## Evidence and limits

Reviewed the complete Pasted text(20261021-111633).txt; relevant current source, tests and certification documents; recent commit history and changes since b2680467; and targeted original UI/source audit requirements.

Independent public production observation at approximately **07:26 EDT / 11:26 UTC**:
- GET https://libertybancard.com/api/health returned status ok, environment production, SHA **c983b7a13cdf2f24c857f135134b3734e6c3b718**.
- Reported build time: 2026-10-21T02:20:53.162Z; publish build ID dc09b0bd-fb04-429b-a242-2faf58b0d8a5.
- Current main is a later publication-marker commit, 6c1935d9, containing that code. An additional publish is not the missing step for the changes in the attachment.

Executed three isolated Node tests using the actual retained-completion and archive-route function bodies with injected database/transport dependencies. These demonstrate control flow and failure handling. They are **not PostgreSQL certifications**, and I did not rerun Replit's reported 41/87/167-check suites or full pre-deploy roster.

No active Kernel browser session was available. I did not independently authenticate to the CRM, repeat the reported page freezes, finish the remaining page walk, read private production counts or modify production. No sends, provider requests, archive operation, policy change or deployment were executed.

## 1. What the attachment gets right, and what has changed

| Area | Current repository result | Acceptance still needed |
|---|---|---|
| GHL activity freeze | Unfiltered GET /api/ghl/activity defaults to 100 rows, with explicit requests capped at 500. The old full-log Settings read is bounded. | Confirm actual Settings responsiveness on the live build and label the list as recent activity. Contact-filtered reads can still be unbounded without an explicit limit. |
| Review Queue freeze | Normal list and normal aggregate counts exclude dead-letter rows. A separate keyset-paged component loads operational failure alerts. | Live large-population recheck; see archive defects below. Normal review items themselves remain an unpaginated list. |
| Preparation suppression | The no-live-preparation path screens suppressed/invalid contacts before qualification. Priority page cap is 40; the time deadline still bounds actual work. | Normal-cycle throughput and exact upload outcomes on the live candidate. Do not interpret a 40-page maximum as guaranteed throughput. |
| Phase timing | Qualification and transaction sub-phase timing is present. | Use measured production phases to justify the next optimization. |
| Backlog status | Geography-deferred businesses no longer appear ready for first classification merely because a domain exists. | Ensure actual territory and unresolved reasons remain visible, rather than counting changed labels as new enrichment. |
| Geography recovery | Four-worker pool, limit 60, business-level retry checkpoint and source references are implemented. | Production outcomes, supported locations, and subsequent classification/preparation. |
| Expired validation claims | Recovery now selects processing intents with expired leases. | Prove normal recovery without duplicate dispatch; this does not release uncertain billed operations. |
| Sunbiz business-only completion | Wired into the existing continuous-discovery worker at limit 100 unless its environment switch is false. Preserves original claims/prospects. | Fix the write/handoff gaps below and measure completed business-to-crawl-to-contact progression. |
| Serper contact-page search | Not implemented in this change set. | Build the previously requested evidence-preserving continuation, then certify its complete handoff. |
| Broad legacy assignment | Narrow domain-based acceptance is a proposal, not a shipped repair. | Source-quality breakdown, explicit acceptance semantics and supported audited writes. |

Sources: [GHL activity route](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/routes/integrations.ts#L228), [Review Queue storage](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/storage/workflows.ts#L225), [preparation worker](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/canonical-recipient-preparation-worker.ts), [geography recovery](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/cro03/sfp-geography-recovery.ts#L323), [queue wiring](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/queue-manager.ts#L2805).

## 2. Confirmed repairs required

### R1 — Partner referral endpoint is shadowed by the generic partner-ID route
Priority: high. Confirmed by source registration order.

The main route registrar registers Partners before Onboarding Stages. Partners registers GET /api/partners/:id; the specific GET /api/partners/referral-pipeline handler is registered later in Onboarding Stages. An authenticated request for referral-pipeline therefore reaches the ID handler first. That handler calls Number(req.params.id), producing NaN, then passes it to an integer database lookup.

This explains the reported failure on both partner pages without assuming a permissions or schema defect.

Repair: register the specific route before the generic route, or make the generic route pass through non-ID segments to the intended route, and validate numeric IDs before querying. Merely turning the existing 500 into a 404 still leaves the real endpoint unreachable. Check other fixed partner paths against the same generic route.

Regression: register the real route modules in production order. Both partner pages must reach the pipeline handler, numeric partner IDs must still work, and invalid IDs must cause no integer database query.

Sources: [registration order](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/routes.ts#L164), [generic route](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/routes/partners.ts#L123), [intended pipeline route](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/routes/onboarding-stages.ts#L326), [integer lookup](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/storage/partners.ts#L110).

### R2 — Sunbiz completion can commit a business after discovering that the retained source is no longer eligible
Priority: high. Independently reproduced with injected transaction dependencies.

The completion opens a transaction and calls resolveOrganization before locking/rechecking the retained Sunbiz/prospect/claim relationship. The resolver can insert a business. If the later retained-source check finds nothing, the callback returns status skipped with RETAINED_EVIDENCE_CHANGED. Returning normally commits the earlier insert.

Independent result:
- Outcome: skipped / RETAINED_EVIDENCE_CHANGED.
- Simulated committed business inserts: 1.

Also, the later check verifies IDs and old claim status but does not compare the identity/location inputs used by the resolver against the now-locked source row. An in-flight source edit can therefore leave stale fields treated as the completed source.

Repair: a failed late recheck must roll back any preceding creation. Pin and revalidate the actual source inputs using the existing lock order; use controlled rollback/hold handling or an equivalent transaction/savepoint arrangement. Keep original evidence unchanged.

Regression: change the prospect/contact relationship, claim or source identity fields between candidate selection and locked recheck. Assert no new business, source link or successful-completion audit survives an invalidated source.

Sources: [completion order and normal-return skip](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/retained-sunbiz-business-completion.ts#L78), [resolver insert](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/organization-resolver.ts#L85).

### R3 — Sunbiz completion can drop the fields that make enrichment possible
Priority: high for the requested enrichment outcome. Confirmed by source and an isolated matched-shell test.

Two omissions matter:
1. Matching an existing canonical business returns its existing row. Neither the resolver's matched branch nor the new completion fills a blank website or phone from the retained source. The filing then gains a canonical source link and drops out of selection, even though the business remains without the retained website needed for crawling.
2. The candidate contains principal_zip and selection uses it for South Florida eligibility, but the resolver call does not pass it into business creation. A business that qualifies by ZIP can consequently be created without that ZIP and fall back into unresolved geography.

The matched fixture in the 41-check certification creates a business without a website but only verifies its link/ID, not projection or downstream usefulness.

Independent injected-dependency result:
- Completion result: matched.
- Matched business domain and phone: still null.
- Postal code supplied through the resolver create options: absent.
- Business field-update statement issued by this completion: none.

Repair: through the existing supported writers, preserve valid retained source fields on creation and fill only absent, non-conflicting fields on matched businesses, with provenance. Make newly usable website evidence eligible for the existing free crawl and changed-input classification. Do not blindly call the older bootstrap projection helper: it currently restricts its writes to record_class production, whereas this worker requires canonical.

Regression: matched canonical shell with retained domain; already-present conflicting domain; newly created business whose ZIP is the resolving geography fact; and ordinary automatic crawl/classification continuation. Do not certify success solely from a source-link insert or audit count.

Sources: [new completion resolver inputs](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/retained-sunbiz-business-completion.ts#L80), [matched resolver returns without projection](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/organization-resolver.ts#L83), [older projection helper and class restriction](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/sunbiz-bootstrap.ts#L749).

### R4 — Dead-letter archive and its audit do not commit together; approval has an archive race
Priority: medium. Audit-failure behavior independently reproduced with injected dependencies.

The storage operation commits the archive transaction before the route calls createAuditLog. If audit storage then fails, the response is 500 after rows have already been archived. A retry encounters a different count, with no successful archive audit.

Independent result: 7 rows archived, 0 audits, HTTP 500 after the injected audit failure.

Separately, approve reads pending status and later updates the row by ID without a pending-status condition. If archive runs between those statements, approval can overwrite archived with approved. The serial test that an already-archived item cannot be approved does not cover that race.

Repair: commit archive state and its audit together; select/lock the exact archive set so expected-count checking and mutation describe the same rows. Make approval a conditional pending-to-approved transition, and issue its audit/side effects only after that transition succeeds.

Regression: audit failure rolls back archive; simultaneous archive/approve cannot revive an archived item; concurrent archive requests do not produce misleading receipts or duplicate effect claims.

Sources: [archive transaction](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/storage/workflows.ts#L270), [audit after storage returns](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/routes/review-queue.ts#L104), [approval path](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/routes/review-queue.ts#L178), [unconditional update helper](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/storage/workflows.ts#L302).

## 3. Additional correctness and reporting requirements

### Registered geography must remain attributable
The new worker selects by Sunbiz principal city/state/ZIP, then puts principal city/state into ordinary business fields. Those fields are eligible inputs to the existing geography reader. That is a route by which registry geography can become outreach geography without an explicit distinction between a registered/principal address and a confirmed operating branch.

Keep the underlying address provenance and purpose clear. A supported Sunbiz organization may be materialized without requiring classification or email validation; do not describe a registry address alone as newly confirmed first-party operating-location evidence. Apply the previously agreed operating-geography policy consistently, while allowing the registry fact to prioritize discovery.

This is a provenance/policy consistency concern; I did not establish that any specific production business was incorrectly located.

### The injected authority-fence test is narrower than the production wiring
The certification passes a false authority callback and verifies no write. The production queue calls the tick with limit 100 and no authorityCheck; the completion defaults that callback to true.

That proves the injected rejection behavior, not a live deployment-owner fence. Wire any required existing worker authority through the actual caller and test that path, or accurately document the internal execution authority this local business-only writer relies on. Do not invent a new approval ceremony.

### Held outcomes are not individually reconciled yet
The new Sunbiz tick counts held/skipped/failed outcomes but persists only successful completion audits and a global cursor. It does not durably retain each returned hold reason. Preserve original claims and add an appropriate append-only per-entity disposition through an existing ledger/audit mechanism, so a genuine identity hold is distinguishable from an unfinished scan and unchanged cases do not generate unexplained rework.

### Archive is acknowledgement, not recovery
The archive filter is queue name, optional job name, pending status and cutoff. It does not establish that each original import row has recovered. The 27,662-row cleanup should be described as acknowledgement/archival of obsolete failure alerts, supported by the relevant job-level evidence. It must not close remaining import-row exceptions.

The current code intentionally excludes archived rows from history, counts and individual GETs (404), despite the earlier attachment describing archived/total counts and retained visible history. Data remains in the database, but the application no longer exposes it through those reads. Correct the documentation and provide an existing administrative history/filter/export if user-accessible archive history is required; do not reload tens of thousands of rows into the active queue.

## 4. Assessment of the two requested policy decisions

### ZeroBounce: support a bounded extra attempt, not a blanket reset
The explanation of the uncertain-result hold is consistent with canonical-address-validation.ts. An expired lease does not prove the prior request was uncharged or unprocessed.

A single additional authorized attempt is a reasonable recovery option. The actual scope must be based on distinct current addresses/validation episodes, not 109 operation rows. The reported 109 operations, 64 intents and 51 businesses are different measures, and a retry does not guarantee that all 51 businesses become launch-qualified.

Implementation requirements:
- Reuse a matching fresh retained receipt first; do not demand an unavailable vendor-history API.
- Preserve the old ambiguous attempt and billing facts.
- Tie one extra attempt to an explicit bounded recovery authorization, exact address/current selection and a new operation identity.
- Atomically prevent two workers, multiple contacts or multiple old operations from consuming more than the allowed retry for the same address episode.
- Respect the approved cooldown and existing provider/recipient checks.
- If the extra attempt is uncertain again, hold it; do not automatically issue another recovery allowance.
- Separate additional physical requests, known charges, retained uncertain reservations and actual recipient outcomes.

This is a change to retry/spend policy, not permission to send emails and not an automatic valid result. No retry was authorized or executed by this review.

Importantly, address-wide deduplication already exists: canonical_address_validation_claims, transaction-scoped address locks, legacy in-flight detection and physical dispatch fencing are implemented. Close remaining dedup defects against that owner rather than build a second validation system.

Source: [existing address owner](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/server/services/canonical-address-validation.ts#L72).

### Legacy linking: the 23,666 are candidates, not established assignments
The proposal is more selective than domain-only matching, but it is a new acceptance route relative to the existing independent-source rule. Do not confuse company-name compatibility and absence of a location conflict with an affirmative independent observation.

Before changing the writer, produce one non-overlapping breakdown:
- Domain, company and affirmative location agreement.
- Domain/company agreement with missing location.
- Shared-brand/location domains and multiple plausible identities.
- Business records independently established versus records derived from these same contacts.
- Retained CRM/import/provider relationships that already support assignment.

Count supported South Florida businesses separately from the nationwide population. Reuse retained source relationships and supported missing-business creation already scoped under #2091. Do not make all assignment wait for a domain-policy change or force nationwide contacts onto Florida filings.

Use the existing native writer and its audited evidence contract. If acceptance semantics change, encode the new evidence basis explicitly and verify the actual migration/guard path. A database migration being involved is implementation work, not proof that the original task is impossible.

## 5. Serper and the unfinished highest-return handoff

The proposed contact-page discovery approach is the right shape: use the existing gateway to find relevant pages on an already established business domain, fetch those pages through the bounded website reader, retain attributable evidence, and feed the existing materializer/linker/preparation path.

It remains unbuilt in this change set. Calling it a large design task does not make it a blocker. Reuse existing engines and add only the missing stage, evidence and memory behavior.

Scope paid work to accepted in-territory businesses after free crawling and retained-email reuse. Retain result URL, source/domain, query/input pin, retrieval time, returned-field evidence and operation/usage association. Separate request counts from provider-reported credits. Preserve no-result memory and concurrent-claim protection. Measure distinct additional qualified businesses per credit.

The existing #2090 allowance remains **500 total credits, 500 daily, maxCreditsPerRequest 3 as the reservation allowance**, exclusively for its one-time registry measurement. It is not a new global 500-per-day cap and not automatic funding for another paid scope. Ordinary Serper remains enabled and its existing ceiling unchanged.

Likewise, a name-only business row is not proof that all retained evidence is absent. Exhaust relevant CRM/import/Sunbiz/provider facts before claiming that paid discovery is the only route.

## 6. UI and acceptance findings

The saved live-admin walk was on **dev.libertybancard.com**, not independently on the production host. Production SQL population counts and a live dev-host browser walk are separate evidence.

The walk document currently lists **34** route names under Not walked, despite prose referring to 33. It explicitly excludes remaining Reports tabs, record details and live agent/manager walks. The C5 fixture suites do provide useful role, shell, access-control and selected real-handler evidence; other API sources answered 501 and were checked for honest unavailable states. Neither fact should be erased or exaggerated.

The partner 500 and slow Outreach Queue, Inbound Operations, SFP and Lead Gen pages remain open in the recorded live walk. An eight-second loading observation establishes a performance concern, not its cause. Recheck after the route repair and current publication, with actual response errors, timings, payload sizes and final loading/error states.

The GHL Settings stored-run test did not reproduce the real activity-list overload because it tested the incoming-sync card and a different dataset. The bounded activity fix addresses the separately discovered list. Verify the full Settings page with a large activity population, not only the incoming-sync component.

The missing C4 performance-baseline folder is test infrastructure debt, not a passing performance check. Restore the pinned comparable baseline and rerun the affected suite. Do not require the enrichment task to repair every unrelated inherited failure, but keep the full-roster result and its owners truthful.

Sources: [partial live walk](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/docs/certification/stage3-c5/live-admin-walk.md), [C5 evidence and limits](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/docs/certification/stage3-c5/README.md), [archive test's actual expectations](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/6c1935d9cf0fa0c35033403a8a4ef0adb081d8c3/scripts/test-dead-letter-archive.ts).

## 7. Minimum implementation and acceptance order

1. **Repair R2/R3 in the enrichment continuation.** Preserve sources and actually hand retained domain/phone/ZIP facts to the canonical business. Add transaction-invalidation and matched-shell/ZIP regression cases.
2. **Repair R1/R4 under the existing CRM/C5 owners.** These do not need to block independent enrichment work. Keep archive display cleanup separate from import recovery.
3. **Complete the existing Serper contact-page stage and bounded validation recovery implementation.** Live retry spending requires the explicit bounded policy decision; building and fake-transport certification can proceed first.
4. **Continue #2091 source-based assignment.** Measure the domain proposal, then implement the agreed evidence basis without manual review of ordinary supported cases.
5. **Verify normal production progression on the served candidate.** Trace newly completed Sunbiz businesses through usable website, classification or specific hold, crawl, staged email, contact/link, preparation, validation and qualified primary. A business created or source link inserted is not the final outcome.
6. **Finish the partial CRM walk and existing launch/seed readiness in parallel.** Do not wait for the entire national contact inventory to finish before preparing the already-qualified SFP recipients for the established launch process.

The five actual uploads must retain their exact import identities and distinct-contact population. The broader uploaded/historical family of approximately 154k contacts is not a substitute for the five-upload reconciliation. Record before/after examined, held/rejected, pending validation, ready-held and **current launch-qualified primary** counts for that exact set.

All current production inventory counts in the attachment—including 844 qualified businesses, 1,026 qualified recipients and 221 pending—remain the agent's snapshots until refreshed. Do not mix them with frozen historical eligibility or assert that they authorize sending.

## 8. Certification additions that close the identified gaps

- Real partner route modules registered in actual order; named route wins over :id, invalid IDs do not reach integer SQL, relevant roles remain enforced.
- Retained Sunbiz source invalidates after selection: zero committed business/link/completion mutation.
- Source edits during resolution are revalidated against the pinned facts.
- Matched canonical shell receives supported missing website/phone; conflicts remain unchanged.
- ZIP-based source eligibility retains the ZIP and correct source provenance.
- New and matched businesses progress through the ordinary classification/crawl continuation, or record a specific attributable hold, without manual kicks.
- Archive/audit failure rolls back together; archive/approve race has one legal state transition.
- Additional validation attempt authorization is single-use across concurrent callers and multiple intents, preserves original ambiguity, reuses any fresh receipt and holds a second uncertainty.
- Final live UI checks on the served build and affected C4/C5 checks with the restored comparable performance baseline.

No new sends, broad provider activation, source resets, blanket domain merges or global pause changes are part of these repairs.

