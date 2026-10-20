# Liberty Task #2075 / C3 — post-publication review and final corrections

**Reviewed October 20, 2026 UTC / October 19 evening, New York.** Compared current main, the published CRM, the October 19 C3 audit, the repository's implementation receipt and Section 36.1 follow-up, and the canonical Go Live ledger/specification.

**Verdict: substantial C3 implementation shipped; full C3 acceptance remains open.** The five remaining verification items in the completion note are required work, not optional upgrades. Complete them within the existing C3 scope. Do not rebuild the already delivered upload ledger, wizard, detail rail or release-state screens, and do not create another chain of audit-only tasks.

There are also specific repair gaps beyond those five items: Readiness Intelligence is still broken because of a route collision; Inventory still places extensive matching/review content above the business list; navigation drops allowed record context; Sequence creation has an uncovered post-commit/retry gap; the optional backlog command does not honor its displayed bounds and has an invalid validation-wake job ID; a historical backlog result renders “NaN held”; and shared-looking open-deal metrics still use different predicates. These are grouped into **eight closure bundles below**, including verification/publication. This is not a new recount of the 95 original audit entries.

## 1. What is actually live

| Item | Verified result | Implication |
| --- | --- | --- |
| Current main | `22579a39261bd339e1c54e8fb500ab7a4330cccf` | Contains C3 and the replay-notice follow-up. |
| Main C3 merge | `33f089ee5c725945bf944c140ecc3a2840dda621` | Published source baseline. |
| Publication label | `1d46b40a2cf5aef1fa2fb02b71c82e168288fd20` | Publication metadata commit following the C3 merge; distinguish it from the serving source SHA. |
| Public production health | SHA `33f089ee5c725945bf944c140ecc3a2840dda621`, built `2026-10-20T00:51:22.470Z`, build ID `c4522291-b2e7-471e-b30b-4bc8420064e0`, production, status ok | C3 core is live. **22579a39 is not live.** The read-only Replit inspection independently confirmed this. |
| Client artifact comparison | Built the exact `33f089ee` checkout with Node 22.22.0/npm 10.9.4; **10/10 selected public assets match SHA-256**, including entry JS/CSS and eight C3/shared chunks | Strong selected-client parity. It does not prove bundled-server, DB/schema, worker, GHL or provider parity. |
| Follow-up source diff | `CanonicalBacklog.tsx`, its component test, ledger addendum and regenerated receipts | Persistent in-page replay notice is real source work. It is not yet a production observation, and publishing it alone will not fix Readiness. |
| Signed-in production walkthrough | Administrator, desktop 1363×936; actual grouped navigation, Source Prospects, canonical Pipeline/Backlog, Campaigns/Readiness/Delivery/Sequences, unsaved create form, import wizard, business detail and Back | Read-only production review. No real record edits, imports, release, enrollment, provider work, settings changes or send tests. |
| Outbound | Dashboard and Backlog visibly paused | No pause changed. GHL incoming remains a separate requirement; no current incoming event/receipt proof is inferred from a configuration flag. |

The latest completion message's statement “nothing is published” is accurate for its **follow-up commit**, not for the earlier C3 merge. Conversely, “2075 published” does not mean the later repair or all acceptance evidence is live.

### Local verification performed in this review

| Check | Result | Limit |
| --- | --- | --- |
| Supported dependency install | Node 22.22.0 / npm 10.9.4 locked install passed, without lifecycle scripts | No dependency or lockfile change. |
| C1 contract suite | 339 assertions passed | Source/unit proof. |
| C2 contract suite | 286 assertions plus boundary checks passed | Source/contracts, not complete browser actions. |
| C3 contract suite | 171 assertions passed | Codec/source assertions. |
| C4 contract suite | Passed | Existing inherited contracts. |
| UploadLedger component | `UPLOAD_LEDGER_UI_PASS` | Real component with injected fetch/jsdom, not DB or production mutation. |
| CanonicalBacklog component | `CANONICAL_BACKLOG_UI_PASS` | Includes new replay notice, unavailable/denied/revoked/expired branches with injected fetch. |
| LeadImports component | `LEAD_IMPORTS_WIZARD_UI_PASS` | Guided review/upload states with injected fetch. |
| Whole-project typecheck | Exit 0 | Supported toolchain. |
| Current-main production build / integrity | Passed, source `22579a39`; input hash `e26906f7ba34a9b2192c24e01919a0187b9cfe95934b68b4b5910c150a22456a` | No publication by this review. Build output hash varies with generated build identity and is not a serving claim. |
| CI manifest classification | Passed | Classification/registration is not all suites executed. |
| BullMQ job-ID counterexample | Installed actual `Job.prototype.validateOptions` rejects `canonical-backlog-validation:123` with `Custom Id cannot contain :` | Pure library validator; no Redis/DB/provider/job execution. The three-part priority-job ID is accepted by this installed version; do not falsely flag both IDs. |

The mounted-suite wrapper's `npx tsx` subprocess initially hit this execution environment's IPC `EPERM`. Running the same three component files with supported Node `--import tsx` completed successfully; no application/test source was changed to get a pass. PostgreSQL 16/private Redis binaries were unavailable here, so the disposable handler/browser suites were **not independently rerun in this review**. Their retained code and receipts were inspected; do not relabel them as new executions by this auditor.

### Retained browser receipts are credible but bounded

The three committed browser receipts record **44**, **30** and **19** checks respectively. Their `sourceHead` names pre-follow-up parent `1d46b40a`, but they also pin effective source inputs. I compared **all 3,365 input files** in the retained receipt with current main: **none missing; none changed**. The retained input hash matches the current-main build input hash above. The parent HEAD label is therefore not grounds to reject otherwise matching dirty-input evidence.

The qualification in the receipts still matters: partial production-route registration, disposable data, Source Prospects-only contrast, emulated CSS viewport zoom, bounded roles/actions, no production/native acceptance. Existing checked-in failed receipts are retained history, not automatically the latest verdict.

## 2. Reconcile the 16 prior audit bundles

“Implemented” here means current source or a named observed slice. It does not close unexecuted role/action/error/serving gates.

| Prior bundle | Current disposition | Remaining closure |
| --- | --- | --- |
| F01 unavailable reads | **Partial.** Backlog and Launch Inventory returned real production data; independent error components exist. Readiness Intelligence still fails. | R1 route collision and full-registration proof. Do not reopen Backlog's old 503 as a currently reproduced failure. |
| F02 Sequence DTO/config/recovery | **Original strict-schema/config defects repaired.** Create no longer sends status/totalSteps; edit keeps IDs/config and blocks failed hydration. Supported receipts exist. | R2 lost initial-create response/audit failure and recovery/draft identity boundaries. |
| F03 committed effect / audit | **Substantial source repair.** Effect receipts separate audit failure; current tests cover policy change/revoke and an unavailable queue. | R3 actual enqueue/throw/after-enqueue audit path, requested bounds and replay identity; R8 verify/deploy later replay notice. |
| F04 classification/link/email meanings | **Source repair and visible classification labels.** Candidate affiliation remains distinct; history errors explicit. | Preserve current-email and affiliation authority; complete the relevant state/role gates, without reintroducing legacy approval policy. |
| F05 metric scope/access | **Partial.** Broader inventory labels and merchant/partner denial are present. Source Prospects and Command agree at 12,711; Dashboard/Command each currently show two open deals. | R6 same-definition/same-snapshot and authorized-agent scope; current coincident totals do not prove predicate identity. |
| F06 capped prospects | **Repaired for observed read.** Production Total matching = 12,711, server page size 50; >500 coverage exists in retained fixtures. | Keep late-response/selection/actor cases in R2/R8. |
| F07 error-to-empty | **Named branches repaired, including signatures.** | Full fault/state coverage remains bounded; Readiness is still a real error, not a false empty success. |
| F08 actor/cancellation/lazy reads | **Partial adoption.** Lead Ops parent, ledger/import/prospects/campaign readers use protected hooks. | Sequence and other C3 read/draft paths still need the actor/late-response closure in R2/R8; existing global cache clearing is retained and no live leak was proved. |
| F09 navigation | **Five/four area grouping and six canonical URL views implemented.** | R5 record/query/hash/history preservation across actual selectors, aliases and guards. |
| F10 Liberty shell/design | **One H1 and 24px title observed on adopted hubs; existing Plex/token foundation retained.** | R4 useful inventory first; R8 complete responsive, keyboard, true zoom, contrast and performance evidence. |
| F11 business context/actions | **Record link, main/320px rail and Back observed; provider plan made read-only and generic action relabeled.** | R4 matching/census placement; actual safe mutation/state acceptance stays in existing C3 scope. |
| F12 campaign taxonomy/capacity | **Five-v2-label UI source adopted and capacity labels separated.** | Preserve current program authority and legacy read-only values; browser edit/archive/cancel and multi-scope tests remain R8. No extra campaign recreation/activation. |
| F13 history/health | **Pilot labeled read-only history and grouped under Program Health.** | Keep worker/source freshness and GHL capability meaning accurate; final global sidebar remains C5. |
| F14 imports/ledger | **Guided wizard and actor-aware URL-addressable ledger delivered.** Visible import accounting separates intake from later fulfillment. | Original-bytes/hash/all-five-upload/native fulfillment receipts are separate owner evidence; R7 historical result decoding. |
| F15 task/spec contradictions | **Repository override exists, but its final paragraph still names canceled #2092/#2093 and older evidence counts.** | Update one authoritative closure receipt, with current ownership/status and no fictional task ladder. |
| F16 acceptance | **C3 suites exist and are registered. Bounded handler/browser evidence is real.** | R8 outstanding required gates; neither registration, merge nor publication closes them. |

Do not add these rows as 16 new defects to the 95-entry historical master register. Attach R1–R8 to the existing parent repair scopes and preserve original IDs/dispositions.

## 3. Eight final closure bundles — exact fixes and evidence

### R1 — Readiness route collision — P1, confirmed live + code

**Evidence:** Campaigns → Readiness Intelligence still says “Failed to load readiness statistics.” Direct authenticated navigation to `/api/contacts/readiness-stats` returns `{"message":"Not found","code":"NOT_FOUND"}`. Replit's read-only inspection reports the retained production line:

```text
2026-10-20T02:07:46.844Z INFO GET /api/contacts/readiness-stats 404 in 111ms
```

That inspection found no readiness reader/SQLSTATE failure in its retained 01:46Z–02:09:54Z log window. This is attributed production-log evidence, not a claim this auditor retrieved the raw complete log archive.

**Exact chain:** `server/routes.ts:140–159` registers contacts before campaigns. `server/routes/contacts.ts:1037–1041` registers `GET /api/contacts/:id` and returns the observed NOT_FOUND for a nonpositive/noninteger ID. The literal reader is registered later in `server/routes/campaigns.ts:983`. The literal word `readiness-stats` is therefore consumed as `:id` before its actual handler. The deployed error is consistent with the exact source path; it is not an established database/query failure.

**Repair:** Register the literal reader before the dynamic contact detail route, preferably through a small explicit reader registration before contact detail rather than moving an entire route module and creating new collisions. Keep admin/manager permission. Alternatively narrowly pass nonnumeric detail segments to the next route only after reviewing the object fence and existing 404 contract. Do not weaken invalid numeric-ID handling or access controls.

**Acceptance:** Test with the **real production registration order**, not only `registerCampaignsRoutes` in isolation. Authenticated admin/manager reach the stats handler; unauthorized roles are denied; ordinary numeric contact detail/invalid IDs retain their guards. Inject each readiness reader failure separately and verify valid sibling sections remain. Publish and revisit the actual Readiness tab. No backfill/provider run needed.

### R2 — Sequence creation/recovery and delayed actor-bound editor state — P1, source-confirmed; fault cases not induced in production

The DTO/config fixes are good. The remaining initial-create path is not durable under all the failure conditions its message promises.

**Code:** `client/src/pages/dashboard/Sequences.tsx:222–280,452–499`; `server/routes/campaigns.ts:896–907`; retained fixture `scripts/test-stage3-c3-sequences.ts:29–42`.

- `POST /api/sequences` inserts a paused row, then awaits its audit log and response. It has no retained client create-intent/replay identity. If the row commits but the audit fails or the create response is lost, the client does not know the created ID. `partialCreate` is populated only after response JSON succeeds. Clicking retry can create a second row while the toast promises no duplicate.
- The existing partial-create test starts from an already known ID and manually adds the missing second step. It does not prove lost **initial create response** recovery or actual editor retry after that failure.
- `partialCreate` is component memory and `closeDialog` clears it. Reload/close needs honest recovery through a known durable draft/receipt, not a blanket no-duplicates promise.
- Recovery skips every persisted `stepOrder` without checking edited content. If an operator changes an already-persisted local step during partial-create recovery, the saved content can silently remain the old value. Either lock persisted content in this recovery mode or reconcile edits through the existing versioned command.
- `hydrateEditSteps` has no AbortSignal or selected-record/actor generation guard before writing its result. A late response can populate an editor after another record/actor was selected. Many Sequences readers still use generic `useQuery`; no current live actor disclosure is claimed, because existing global protected-cache clearing remains in place.

**Repair:** Add create intent/replay/reconciliation through the existing sequence/work command owner, bind normalized payload and actor/account version, return/recover the committed ID, and record audit outcome honestly. Do not relax strict content schemas. Retain stable step IDs/config and the existing persisted-step omission safeguard. Add request cancellation/current-editor generation checks and clear or quarantine drafts/partial IDs on actual actor/account changes. Do not reset a known ambiguous intent simply because a response failed.

**Acceptance:** Actual rendered Create commit→lost response; audit-after-create failure; retry/double click; close/reload recovery; partial persisted-step editing; late A→B hydration; actor/account switch with a pending request. Prove exactly one created row/expected steps and no stale draft leakage, using owned disposable fixtures.

### R3 — Make the actual backlog enqueue/worker contract match its UI — P1

The completion note correctly admits that successful enqueue and thrown-enqueue paths were not tested. The code exposes substantive defects those cases must cover.

**Code:** `server/services/canonical-enrichment-backlog-run.ts:42–55`; `server/services/queue-manager.ts:2756–2850`; `server/routes/canonical-enrichment.ts:219–235`; `CanonicalBacklog.tsx:132–142`.

1. **Requested bounds are ignored.** The route validates/passes `maxRows` and `timeBudgetSeconds`, but the continuous-discovery worker uses fixed staged materialization `drain:{timeBudgetMs:5*60_000,maxRows:2000}` and a separate preparation loop up to ten minutes. It never reads `priorityRequest.maxRows` or `.timeBudgetSeconds`. An operator selecting 100 rows / 60 seconds has not authorized those larger displayed limits. Honor the normalized request in the bounded phases and document whether a time budget covers just staging or the whole pass; do not mislabel it.
2. **Validation wake job ID is rejected.** The worker uses `canonical-backlog-validation:${bucket}`, a two-part colon ID. The installed BullMQ validator throws `Custom Id cannot contain :`. This was executed in isolation against the actual installed library. The priority job's three-part ID passes this version's compatibility rule; the finding is specifically the validation wake ID. Use the repository's supported deterministic job-ID convention, then test the actual add/readback path without provider transport.
3. **Window deduplication is not durable intent replay.** The priority job ID depends on `Math.floor(Date.now()/600_000)` and scope only. A retry across a bucket boundary can create a second job; changed bounds in the same bucket can be echoed as if they were the queued payload although the earlier job had different bounds. The route's blanket “repeating it cannot queue it twice” claim is too broad. Bind the same retained intent to normalized payload and return the actual prior job/request. Same intent + changed payload must conflict; a deliberate new request uses a new intent.
4. The current post-commit fixture proves `accepted:false` with **no queue manager**. It cannot prove queue-add failure, accepted job surviving an audit failure or response loss, validation wake-up, or worker bounds.

**Repair:** Add a narrow producer dependency seam to the existing owner/test harness or a private producer-only queue adapter. The current `getQueueManagerProducers` getter does not itself initialize a producer-only fixture. Do not initialize the entire worker fleet or call live providers just to test enqueue. Preserve existing schedules and paid/outbound controls. Show accepted/already queued/unknown/rejected as distinct, with the original request receipt and safe reconciliation.

**Acceptance:** Private queue add/readback, duplicate, clock boundary, conflicting payload, pre-add throw, add committed→audit throw, response loss, actual worker honoring small/large bounds, and valid validation wake ID. External transport remains denied. Readiness of general scheduled enrichment is a separate assertion; do not claim this optional command is already proven by ordinary progress.

### R4 — Finish Inventory hierarchy and worklist design — P2, live + source confirmed

**Code:** `LeadOpsCenter.tsx:2604–2612` renders `SystemContactBusinessLinksPanel`, advanced reconciliation and `ContactLinkCoveragePanel` **before** `BusinessesTab`. Moving bootstrap/repair cards below the table inside BusinessesTab did not move those three earlier siblings.

At 1363×936 with the main scroll at zero, the matching/review table (50 rows) began at **y=1,068**; the actual business inventory table, identified by its Company / Location / Legacy vertical / Email Status columns, began at **y=16,243**. These are different tables. The inventory has working links but is still buried under census, automatic-link progress and 25 detailed review cards.

**Repair:** Render the ordinary business inventory first. Move matching/census/recovery/review into a clearly labeled privileged context under Program Health, or a collapsed accessible drawer/disclosure opened deliberately from the worklist. Preserve all current handlers/evidence/permissions; do not remove the review capability or change its policy. Lazy-load advanced readers only when that context is opened. Default Inventory entry must show its actual toolbar and first useful row without a long administrative scroll.

Keep the shipped Liberty foundation: IBM Plex Sans; H1 24/32/600; section 18/24/600; body 14/20; labels 12/16; metric 28/32 with tabular numerals; 4/8/12/16/24/32px spacing; 44px controls; 6px control/8px surface radii; max width 1280; 12px mobile/24px >=640px main gutters; 16px cards and 24px section gaps. Use the existing CrmPage/header/toolbar/table/card/drawer APIs, one H1 and one main owner. Do not touch public-site CSS.

**Acceptance:** Geometry assertion targets the **business inventory row/toolbar**, not the first matching/review row or a generic H1. Run with admin data large enough to populate the review queues. Verify at desktop/tablet/phone widths, keyboard access to advanced context and no heavy advanced reads before opening it.

### R5 — Preserve URL context and Back through every selector/alias — P2, live + source confirmed

**Live reproduction:** Loaded `/dashboard/outbound-center?tab=campaigns&businessId=173508#context`; clicked the real Sequences tab. Result was `/dashboard/outbound-center?tab=sequences`: the allowed business context and hash were discarded.

**Code:** `OutboundCenter.tsx:45–55` uses a literal new URL in its tab handler and area links. `LeadOpsCenter.tsx:2226–2241` still uses replace-history for leaf/staging choices and drops hash; its area links are literal URLs. Existing App aliases and C3 standalone exceptions need the same compatibility review. Canonical six-view round trips are already implemented; preserve them.

**Repair:** Extend/use the existing destination owner for C3 area/leaf/staging changes. Preserve **allowed typed** record/from/report context and hash, reset only the owning paging/selection where intentional, push user navigation to history, and keep invalid/duplicate selection behavior explicit. Do not preserve arbitrary untrusted parameters or introduce a second parser. Keep current agent-authorized standalone routes; do not route them through an unauthorized admin shell.

**Acceptance:** All 24 assigned entrances and 28 historical panel references, six canonical views, actual area/leaf/staging selectors, aliases, direct URL, reload, Back/Forward, valid typed context/hash, invalid/conflicting/forbidden values and real route roles. The present 171 source/codec assertions are not a substitute for those production-order and mounted-navigation cases.

### R6 — Reconcile open-deal predicates and actor scope — P1/P2, source mismatch confirmed; no current admin numerical mismatch

The improved labels are useful and both current admin cards showed **2**. The separate all-unarchived inventory showed **1,575**, properly labeled as a different cohort. Source Prospects' matching **12,711** and Command's prospect total also agree for their observed unfiltered reads.

The underlying open-sales definitions still differ:

| Consumer | Actual predicate |
| --- | --- |
| Outreach Command `server/storage/sunbiz.ts:572–587` | Unarchived + production + sales + `stage IN OPEN_SALES_LEAD_STAGES`, all owners; called by admin/manager/**agent** aggregate endpoint. |
| Dashboard `server/routes/analytics.ts:104–111,210–219` | `dealReadPredicate(actor,...)` production/nonarchived with owner-or-unassigned scope for unprivileged users, then sales stage is anything except Closed Won / Closed Lost. |

For example a production sales row in a legacy stage such as Contacted can satisfy the Dashboard's nonterminal test while not being in the positive open-stage list. An agent can also receive globally aggregated Command counts while Dashboard is owner-scoped. The latter may be an intentional global-operations permission, but it must be an explicit approved policy/label, not accidental inheritance from contact object authorization. No live alternative-role exposure test was performed here.

**Repair:** Use the existing A/revenue-read authority to define each measure and authorized cohort. Reuse the current shared stage constants/read predicates where appropriate; a new standalone metrics service is not inherently required. If different measures are intentional, name and scope them distinctly. Do not make unrelated all-contact/all-deal counts equal or broaden permissions. Keep archived/test/production/owner/as-of filters explicit.

**Acceptance:** One pinned fixture/snapshot across Dashboard, Command and relevant worklist/export, with supported and legacy stages, owner/unassigned/other owner, classes, archived rows and roles. Assert identical definitions agree and deliberately different scopes remain explicit. Two coincident live admin values are useful smoke evidence, not G06 closure.

### R7 — Decode historical backlog run counters safely — P2, live + source confirmed

The live Backlog last-run summary displays **“NaN held.”** `CanonicalBacklog.tsx:199–200` formats `last.staged.held` as a required number; the stored history is cast to `BacklogPriorityRunRecord` without runtime decoding in `canonical-enrichment-backlog-run.ts:76–80`. Current types are not proof that every older persisted run has that field.

**Repair:** Validate/version the reader DTO; map known historical shapes explicitly, otherwise show “Unavailable for this older run.” Use finite numeric guards and keep each counter independently available. Do not turn an absent historical field into zero or rewrite immutable accounting just to make a display pass.

**Acceptance:** Render current, older/missing-field, null, malformed and actual finite-zero run fixtures. No NaN/undefined and no fabricated zeros; original historical facts stay unchanged.

### R8 — Complete existing acceptance, then publish one verified candidate — required closure

The agent asked whether to build these. **Yes — all five remain required:**

1. Successful/thrown process enqueue and post-enqueue audit/response fault cases — extended by R3's concrete defects.
2. Late-response and actor/account-switch **mounted-browser** cases — include Sequence editor/drafts and protected source/import/ledger/command queries, not only page reload after a role demotion.
3. Actual Campaign edit/archive/cancel controls, cancel/no-op, failed save, version conflict/replay, refresh and DB readback — preserve a draft/paused state and do not activate/send.
4. Non-Sequence role checks across the assigned C3 destinations and representative actionable children, plus the API matrix and preserved standalone access.
5. Same-snapshot metric agreement and intentional scope differences — R6, not screenshot arithmetic across unrelated measures.

The existing C3-G01–G12 contract also retains useful worklist geometry, responsive/keyboard/true-zoom/contrast/performance, required full CI/predeploy dispositions, and final serving acceptance. A 640-CSS-pixel viewport at DPR2 is an emulation, not actual browser 200% zoom; six Tab presses are not a complete keyboard/focus audit; Source Prospects main-only contrast is not every C3 overlay/page. Keep those claims narrow and complete the required slices. No screen-reader result is implied.

**Registration/fixture correction:** Suites importing only campaigns routes can prove their own actions but miss R1's contacts-before-campaigns collision and broader route middleware interactions. Add the relevant full-registration fixture/test; no blanket replacement of all good existing tests is needed. Retain the safe private DB/Redis/provider-deny boundary.

**Existing broader failures:** The implementation receipt retains failing `intake-review-pages` and `serper-lookup-memory`, plus a C4 browser baseline prerequisite and an incomplete full roster run. Reproduce/disposition them on the exact candidate under existing owners; do not call their presence fixed or every C3 test failed. Do not silently drop them or add another task ladder. Partial initialization of the full fleet is not an acceptable test shortcut.

**Publication:** After actual repairs/tests, commit/merge as appropriate, run supported clean required checks and build, publish the intended candidate, then verify production health/build identity, selected client parity, affected routes and paused/no-echo behavior. `22579a39` is currently unpublished; do not claim its replay notice is live. Current core `33f089ee` is already live and does not need to be rebuilt from scratch as a new design task.

**Documentation:** Reconcile repo ledger Section 36/36.1 and specification Section 28 with the final result. Section 28 still references old 166 assertions/two mounted suites and canceled #2092/#2093; label dated receipt content and add one controlling final disposition. Preserve the 95 original source-entry lineage and ownership; global sidebar is C5, integrated CRM closure D, broad native/provider outbound proof Stage4 and final frozen-SHA release Stage9.

## 4. Minimal implementation order and exact verification destinations

Keep one coherent completion scope under existing #2075/C3 (or its existing repair continuation if the task is administratively closed). The canceled follow-ups should not become a prerequisite chain of new audits.

1. **Repair actual contracts:** R1 routing, R2 sequence intent/editor, R3 queue bounds/replay/ID and R7 history decoder. Add targeted regression tests using actual current handlers and library behavior.
2. **Finish promised navigation/UI/data reconciliation:** R4 inventory, R5 context/history and R6 scoped metric predicates; reuse existing C1/C2/A/B/C4 owners. No global sidebar redesign or native activation.
3. **Close R8 and publish once:** exercise the five missing proof areas plus retained visual/performance/final-check gates, retain truthful baseline dispositions, and verify the exact serving candidate. Update all records after the implementation/audit.

| Scope | Relevant current files |
| --- | --- |
| Route collision | `server/routes.ts`; `server/routes/contacts.ts`; `server/routes/campaigns.ts`; `client/src/components/ReadinessIntelligencePanel.tsx` |
| Sequence | `client/src/pages/dashboard/Sequences.tsx`; `server/routes/campaigns.ts`; `server/services/sequence-command.ts`; `client/src/hooks/use-retained-local-intent.ts` |
| Queue contract | `server/services/canonical-enrichment-backlog-run.ts`; `server/services/queue-manager.ts`; `server/routes/canonical-enrichment.ts`; `shared/canonical-enrichment-backlog.ts` |
| Inventory/detail | `client/src/pages/dashboard/LeadOpsCenter.tsx`; `LeadOps/ContactLinkCoveragePanel.tsx`; `LeadOps/SystemContactBusinessLinksPanel.tsx`; `LeadOps/BusinessDetailPage.tsx` (last three relative to dashboard) |
| Navigation | `client/src/lib/crm-destination-state.ts`; `client/src/pages/dashboard/OutboundCenter.tsx`; `LeadOpsCenter.tsx`; `CanonicalEnrichment.tsx` (last two relative to dashboard); `client/src/App.tsx` |
| Metric authority | `server/storage/sunbiz.ts`; `server/routes/imports.ts`; `server/routes/analytics.ts`; `server/services/revenue-read-authority.ts`; `shared/schema.ts` |
| Tests/receipts | `scripts/test-stage3-c3-*.ts`; the three dashboard component `.test.tsx` files; `scripts/pre-deploy.ts`; `scripts/ci-suite-manifest.ts`; `docs/certification/stage3-c3/` |
| Canonical documentation | `docs/LIBERTY_BANCARD_GO_LIVE_AUDIT_LEDGER_CURRENT.md`; `docs/LIBERTY_BANCARD_STAGE_3_CONSOLIDATED_IMPLEMENTATION_SPEC.md`; current shared audit records updated separately by this review |

Source discovery checks, not proof of acceptance:

```bash
rg -n 'registerContactsRoutes|registerCampaignsRoutes' server/routes.ts
rg -n '/api/contacts/:id|/api/contacts/readiness-stats' server/routes/contacts.ts server/routes/campaigns.ts
rg -n 'partialCreate|createdSequenceRef|hydrateEditSteps|closeDialog|useQuery' client/src/pages/dashboard/Sequences.tsx
rg -n 'jobId|600_000|priorityRequest|timeBudgetMs|maxRows' server/services/canonical-enrichment-backlog-run.ts server/services/queue-manager.ts
rg -n 'SystemContactBusinessLinksPanel|ContactLinkCoveragePanel|BusinessesTab' client/src/pages/dashboard/LeadOpsCenter.tsx
rg -n 'handleTabChange|setActiveTab|replace: true|AREA_HREF' client/src/pages/dashboard/OutboundCenter.tsx client/src/pages/dashboard/LeadOpsCenter.tsx
rg -n 'OPEN_SALES_LEAD_STAGES|totalActiveSales|dealReadPredicate|openSalesProduction' shared/schema.ts server/storage/sunbiz.ts server/routes/analytics.ts server/services/revenue-read-authority.ts
rg -n 'last.staged|readLastBacklogPriorityRun|BacklogPriorityRunRecord' client/src/pages/dashboard/CanonicalBacklog.tsx server/services/canonical-enrichment-backlog-run.ts shared/canonical-enrichment-backlog.ts
```

## 5. Message to send Replit with this report

> Yes — finish all five remaining verification areas as required C3 acceptance. Keep this as completion of the existing #2075 scope; do not create another audit-only task ladder or rebuild the screens already delivered.
>
> The post-publication review confirmed core C3 is live at 33f089ee, while 22579a39 is not published. It also found repairs that must precede final closure: Readiness is a production 404 because contacts/:id is registered before contacts/readiness-stats; Sequence initial-create response/audit failure lacks durable ID recovery; backlog command bounds are ignored by the worker, validation wake job IDs fail the installed BullMQ validator, and ten-minute scope buckets do not provide durable replay; business inventory still starts below matching/census/review content; actual tab navigation drops valid business/hash context; Dashboard/Command use different open-deal/actor predicates; historical backlog counters display NaN.
>
> Implement R1–R7 from the attached report using the existing route/command/query/metric/UI owners. Then complete R8: real enqueue/fault readback, late-response and actor/account switching, Campaign edit/archive/cancel browser actions, role coverage beyond Sequences and same-snapshot metric fixtures. Retain required visual/accessibility/performance and full CI/predeploy dispositions. Test the production route registration order so isolated campaign fixtures cannot hide the Readiness collision.
>
> Keep outbound paused and incoming GHL independent; no real prospects, provider calls, enrollment or sending for proof. After the repairs and required checks, finish the merge/push/publication process and verify the exact serving SHA/build, affected live views and pause state. Update the ledger and specification with implemented, verified and still-unexecuted evidence separately. Do not mark C3 fully accepted until its gates have receipts.

## 6. Review boundary and record updates

This is a read-only source/production review with local installation/build/tests, plus a read-only question to Replit for retained logs/publication identity. No application source, production data, provider setting, worker schedule, permission, GHL switch or outbound gate was changed. No merge/push/publish occurred in this review. No sending was attempted.

The canonical Go Live ledger gains **Section 37** and the consolidated specification **Section 29**, preserving the prior audit and original finding IDs. Repository Section36/36.1 is retained as implementation evidence; it does not overwrite the independent October19 audit. Stage3 remains OPEN / NOT CERTIFIED, with specific remaining work rather than another unqualified “done” or blanket rejection of the useful work shipped.
