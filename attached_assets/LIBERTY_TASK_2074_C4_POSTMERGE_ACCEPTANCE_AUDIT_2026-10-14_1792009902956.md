# Liberty Task #2074 / C4 — postmerge acceptance audit

**Date:** October 14, 2026. **Decision: MERGED AND SERVING; ACCEPTANCE REMAINS OPEN.**

This audit verifies the current repository, signed-in cloud CRM, original C4 contract, October 8 corrections and October 9 incomplete closeout. It advances the verification substantially: all 39 assigned routes were checked, 41 named live view/control observations were retained, source gates ran, and a clean production compilation reproduced **83 live client assets byte-for-byte**. It also identifies four grouped repair scopes and the precise execution limits preventing whole-task closure.

The October 9 stop instruction is historical. The current request authorizes renewed verification. No earlier stop was used to avoid current checks. Automatic approval review separately rejected a remote implementation/CI push; that concrete restriction is recorded below. No production application change, merge, publish, outbound operation, native command, role change or integration setting change was made.

## 1. Current source and serving evidence

| Item | Verified value / limit |
| --- | --- |
| Current GitHub main; checked again before closeout | `85296699ec8d11f22750657dfe5ac34a8fd2577d` |
| Live health-reported source | `f28dce470a2462f07d87d8ae08ac70be1c13be53` |
| Source comparison | `git diff f28dce4 8529669` is empty. These source trees agree; the later commit is publication metadata. |
| Live health observation | production / status ok; builtAt `2026-10-14T17:00:45.954Z`; publishBuildId `649f82ee-5650-4573-9ddf-bf93228edc4e`; ghlTransportFailFast false |
| Clean audit baseline | Separate detached checkout at 8529669; tracked worktree clean before and after production build. Other existing worktrees and their modified images preserved. |
| Toolchain and install | Actual Node **22.22.0**, npm **10.9.4**; locked `npm ci --no-audit --no-fund` succeeded, 764 packages. No dependency or lockfile changes. Resolved lockfile hosts use registry.npmjs.org. |
| Production compilation | `NODE_ENV=production node --import tsx script/build.ts` passed. Standard tsx CLI invocation could not create its IPC listener in this workspace; the same entry point ran through tsx's loader. This is not a stock whole-CI pass. |
| Current production build identity | sourceHead 8529669; inputHash `5745c130d637b531add6bcbf00a9737d5a3de924f2eba0220c38de6a8f921005`; outputHash `b579a1947c4a608c4cca2f23482abcb3447bafb3bbb7f9bd601f590a516c1051` |
| Local build identifier | `fc6a8d6d-f242-43b3-97f0-44bcb3ba49a1`; intentionally distinct from the published build identifier. |
| Build integrity | `verifyCandidateIdentity()` passed against this clean baseline: complete source/input and emitted-output hashes, with 3,248 inputs and 471 outputs in the graph. |
| Live asset parity | Entry JS `index-Co7s_vho.js`, CSS `index-F-yPn0Rw.css`, and **81 emitted JS chunks reachable from the C4 source inventory** all match serving bytes by SHA-256. There are 83 distinct verified assets. This is substantial client parity, not a claim that every server/configuration/worker/native artifact was compared. |
| Entry JS SHA-256 | `8a36f0ef80bf463e632c8fd3a6a5c75641a3ba0f9ecfaf94ccab30985ef49e55` |
| CSS SHA-256 | `421793915521b88deef609a5b8462cab532c6f725bc769312bc68bb7a8eb93e7` |
| Task closeout provenance | Commit `4928912`, “Close Liberty Stage 3 C4 at user-requested boundary; retain bounded evidence and explicit gaps”; `docs/certification/stage3-c4/working-status.md:737–747` explicitly withholds whole-task acceptance. |

Build warnings remain: large client chunks and the existing CJS `import.meta` warning in `server/services/email-pre-filter.ts`. No new provider outage or runtime failure is inferred from those warnings.

The old serving-source and private-registry barriers are **not current blockers for this observed release**: source is accessible, a locked supported install succeeded, and the production client was reproduced. Full CI/security/release acceptance remains separate.

## 2. Outstanding-item verdicts

| Requested closure item | This audit completed | What still prevents full acceptance |
| --- | --- | --- |
| Browser / routes / controls | Signed-in admin access; all39 assigned entrances;41 named observations of report selectors, financial children/history, application/boarding filters, Underwriting, Onboarding, Health, keyboard navigation and themes | Remaining conditional controls, Contact interiors, real manager/agent/merchant/partner sessions and durable actions require protected fixtures. Later cloud clicks were credential-protection restricted after documented recovery. |
| Financial provenance | Traced shared A-owned relationship/observation projection; source contracts passed; live revenue/partner/payout labels verified; exact scope/snapshot, recorded-period, unknown currency, stored-versus-native distinctions visible | Fresh nonempty SQL/CSV/permission/partial-source fault matrix was not executable here. Native settlement/payment proof belongs to later business lanes and must not be manufactured to close C4. |
| Responsive / accessibility |1363px actual viewport; one-H1/target/overflow samples; IBM Plex; light/dark toggle and restoration;200px rail; real Tab/Enter rail navigation | Confirmed UI contract gaps below.320/390/768/1280/1440, all overlays/contrast, reduced motion and genuine200% zoom remain incomplete. Attempted zoom shortcut left viewport/DPR unchanged, so it is not certified. |
| Matched performance | Identified build-mode confound; retained useful-record fixture requirements and thresholds | No permitted local listener/PG/Redis; no eligible live Portfolio rows for a useful-merchant benchmark. No matched current/base run. Historical timings cannot substitute. |
| Clean candidate / build | Clean current baseline compiled in production; integrity verified;83 assets match live | Full typecheck not established: default heap exhausted;6GiB attempt timed out after240s. Full required role/action/CI gates and final repaired candidate remain open. |
| Rollback | Retained clean current source/artifact identity; complete review patch applies cleanly to baseline; committed local subset passes reverse-apply check | This is code reversibility of prepared repairs, not a tested production rollback of C4 or database/recovery compatibility. No deployment was flipped or down-migration run. |

These are concrete gate states, not another unexplained list of unverified claims. Implementation and privileged test execution have separate boundaries; no unsafe live record was created to work around them.

## 3. What #2074 actually shipped

| Contract / parent | Current source and observed result | Qualification |
| --- | --- | --- |
| Merchant Operations grouping / V03 | `MerchantOperationsNav.tsx`: Portfolio, Acquisition, Delivery, Service and Partners;16 admin links across five local groups;200px rail observed; role-filtered entries and narrow alternative exist | Global eleven-entry sidebar remains C5. Existing sidebar duplicates are not proof that C4's local grouping failed. |
| Reports V01–V03 | Four areas: Sales & Growth, Operations, Outreach, Financial. Six legacy selectors and three financial children retained. Explicit financial selection, Revenue nested views and compatibility aliases present | Named live selections and Financial Back/Forward work; remaining filter/history gaps listed below. |
| V04 / A02 Portfolio | Default50,25/50/100 paging, authoritative owner totals, typed Contact/deal/editable-deal identities and loaded-page-only filtering language | Live zero eligible merchants is a legitimate empty scope; it is not the Sales Pipeline population. Full >100-row/actor/fault matrix remains fixture work. |
| V05 Support / B | Tickets/RFIs/Review Queue retained, existing command/fence/readback ownership retained | Entrances/selected panes observed; no production create/edit/approval command tested. |
| V06 / M01 Health | Invented100-healthy formula removed. Live explicitly says assessed eligible cohort unavailable and no-alerts does not establish healthy merchants | Presentation truth repaired. Actual eligible merchant assessment/native completeness is not supplied or inferred. |
| V07 Success | Reviews/testimonials/NPS/retention retained; unavailable/sample/model distinctions added | Some entrances observed; later Success clicks blocked by cloud protection. No review request, retention send or configuration write executed. |
| V08 / M02 Onboarding | Complete paged deals/exact contact reads replace first500 joins; status failure separated | Page state observed. Full drift/cohort/SLA/partial-write proof remains protected-test work. |
| A01 Chargebacks | Both consumers use frozen UUID intent/MID identity and202 accepted/queued/readback; Contact caller suppresses changed actor/contact and changed unresolved payload | Source-traced in Chargebacks.tsx and contact-detail-tabs/ChargebacksTab.tsx. No real card-brand queueing or transmission performed. |
| A03 Handoff | Selected Closed Won Sales deal creates/reuses explicitly linked Onboarding local preparation. `crm-operations.ts` binds actor/account version, UUID and selected source; `onboarding-preparation-command.ts` owns durable steps/resume | User-selected policy from retained closeout, not an assumed new policy. Source present; no real kickoff, native workflow resume or production task creation. |
| A04 Financial scope | `ResidualRevenue.tsx` consumes `/api/revenue/residual-group-scope`; A-owned exact relationship/snapshot projection shared across observations, summary, series, agent/partner attribution and export | Live empty scoped observation result is unavailable money, not fake actual revenue. Fresh nonempty/failure/CSV fixture proof pending. |
| A05 / M05 read states | Named Contact/document/service/board/underwriting/outreach/import failures now have independent error/unavailable handling | General repair exists; every independent status/role/fault combination is not accepted from source presence. A/B currently exposes an underlying route defect honestly. |
| M03 / M04 Calendar | Next-month exclusive ISO window and existing positive-duration date helper retained | Pure inherited suite passed; provider coverage and fresh signed-in persistence/DST cases not rerun. |
| M06/M07/M08/M09 | Mobile message metadata/body distinction, fail-closed call/mail affordances, manual rule capability separation and structural transition observations present | Preserve real role/CSRF/stage/pause authority; observation never grants activation or arbitrary stage moves. Full mobile/action matrix remains unexecuted. |
| M10 tasks | `my-day.ts:273` projects effectiveState through authorityStateToLegacyTaskStatus; Contact pending count uses canonical predicate | Prior DTO allegation is source repaired, not a newly reconfirmed defect. |
| M11 active deal | `crm-operations.ts:117–120` excludes known terminal/archived rows and chooses deterministically | Terminal spellings/context completeness still need actual fixtures; retained Contact history must not become production-only. |
| M12 inbox continuation | Local session/audit keysets, pinned snapshot and remainder retained; actor/query-bound signed cursor validation present | Source repair exists; do not claim all providers/filter drift/multipage faults are freshly certified. |
| C2 compact header | Existing C2-R10 ownership retained; C4 consumes Contact shell | Do not recreate RecordHeader or defer this obligation to C5. Fresh compact-header fixture remains required. |

## 4. Four grouped repair scopes confirmed by this audit

These are **amendments within existing owners**, not four new tasks or four additions to the original95 claims. UI subclaims deliberately share one repair scope.

### V1 — A/B results route is shadowed by sequence-detail route — P1

At baseline `server/routes/campaigns.ts:833`, `GET /api/sequences/:id` is registered before the literal results reader at1532. Express matches `ab-test-results` as `:id`; the handler passes `Number('ab-test-results')` to the ID reader instead of reaching the actual report. Live A/B Testing displays an unavailable state.

**Counterexample executed:** Express's actual ordered path matcher, populated from current source route declarations, selects `/api/sequences/:id` for the A/B URL. The new regression fails on baseline and passes on the prepared route reorder. A numeric sequence-detail URL still resolves to its existing detail route. This is path-selection proof, not a claim that a fresh SQL/auth handler test ran.

**Narrow repair prepared:** Move the unchanged, guarded literal GET reader before the parameterized reader. Preserve authentication, admin/manager guard, manager-owned sequence filtering and the existing DTO. Do not rewrite A/B aggregation, winner selection, send gates or refresh authority.

**Important fixture correction prepared:** C4's existing fixture did not register campaigns routes; it could show A/B unavailable from its unsupported-source501 without exercising this collision. Register the real owner and test admin200/manager200/agent403/anonymous401, actual empty collection, and explicit independent campaign/A-B/message503s. Honest fallback is not proof that the successful route works.

Relevant files: `server/routes/campaigns.ts`; `scripts/test-stage3-c4-contracts.ts`; `scripts/test-stage3-c4-actions.ts`; `scripts/test-stage3-c4-browser.ts`; `client/src/pages/dashboard/OutreachAnalytics.tsx`.

### V2 — C4's Liberty design/accessibility adoption remains incomplete — P2

Confirmed cases share the existing A07/shared presentation repair:

- **Missing page identity:** settled Onboarding Overview has **zero main H1**; it renders Onboarding Pipeline as H2 while the adopted shell title is non-heading. Kickoff's title is CardTitle/div, also lacking a page H1. Board currently owns an H1, so adding a hub H1 requires changing the board child to H2. Prepared changes preserve exactly one title across views and the kickoff loading state.
- **Undersized targets:** Terminal ROI “All” measured **36.2×44px**; Applications “All” measured **41.1×44px**. Boarding/Onboarding samples also expose narrow targets. Existing CSS enforces height while minimum width applies only to selected icon/ARIA-labelled buttons. Review patch uses the existing44px token for adopted employee targets rather than changing public controls.
- **Focus ownership:** real rail Tab moved focus to Applications and Enter navigated correctly, but computed focus was the browser's **1px automatic outline**, not the promised2px ring/2px offset. The rail sits outside `.crm-page`; the existing focus selector misses it. Extend the employee-scoped selector, preserving portal ownership and native input behavior.
- **Navigation tokens:** C4 rail links use13px text,9px gap and9px horizontal padding rather than the retained14px body/8px gap/12px spacing scale. Use existing `--crm-body-size`, `--crm-space-2/3`, not new global tokens. Ensure H1 token styles also apply to Merchant Operations content outside `.crm-page`.
- **Field labelling:** Portfolio search relies on placeholder text without a persistent explicit label. Add a meaningful accessible label identifying its loaded-page scope. This is a concrete contract improvement; no broad WCAG certification is inferred.
- **Action density:** Terminal ROI currently exposes four header actions (Refresh, Export, Manage models, Configure thresholds). Apply the existing primary/at-most-two-secondary/overflow contract without dropping controls or changing privileged configuration authority.

Relevant files: `OnboardingHub.tsx`, `Onboarding.tsx`, `OnboardingBoard.tsx`, `OnboardingKickoff.tsx`, `TerminalROI.tsx`, `MerchantApplicationsList.tsx`, `BoardingTracker.tsx`, `MerchantPortfolio.tsx`, `client/src/styles/crm-theme.css`, `CrmPresentation.tsx`.

Do not claim these are deployed repairs. The review patch contains the heading/target/focus/token/search corrections; header action consolidation still needs implementation under this same scope after authorization.

### V3 — Some retained view/filter state still disappears on reload/history — P2

The live Applications and Boarding status tabs change selection while leaving the URL unchanged. Source confirms local `useState('all')` in `MerchantApplicationsList.tsx:982` and `BoardingTracker.tsx:115`; no URL codec adopts those selections. The original C4 contract explicitly required URL-bound Boarding status. Outreach's three children still use `Tabs defaultValue='campaigns'`; Leaderboard metric/period remain local state.

Use C1's existing selection/context authority in `crm-destination-state.ts` and registry policy. Define typed route-owned status/child/metric/period selectors, validate their actual enums, retain permitted context, push deliberate selections and replace compatibility adapters. Reset paging when filters change. Equal duplicates collapse; conflicts/invalid/forbidden values need an explicit reason and safe permitted fallback. No second parser and no change in endpoint eligibility or role access.

Prove all actual status/child values, reload/Back/Forward, valid legacy links, malformed/conflicting state, filter reset, and unauthorized child no-mount/no-fetch. Preserve already working Revenue, Underwriting and Health URL state. Do not reopen the repaired Financial precedence allegation.

This scope is **not implemented in the prepared patch**. It remains a concrete C4 consumer obligation rather than being reassigned to final sidebar C5.

### V4 — Certification build mode is not bound tightly enough — P1 verification gap

This audit compiled identical source with identical receipt inputHash under two environments:

| Build | Main client | Result |
| --- | --- | --- |
| NODE_ENV=test | `index-BGea4EFE.js` | Different client from Publish; not the production-parity proof |
| NODE_ENV=production | `index-Co7s_vho.js` | Entry/CSS/81 C4 chunks match live bytes |

`script/build.ts` calls Vite without forcing its production NODE_ENV. The normal CI static job explicitly sets NODE_ENV=test, so an otherwise identical build can include a different client. `candidate-build-identity.ts` hashes source/output and records a recipe string, but the inputHash alone does not encode the effective build mode. Output hashes also include randomized server build identities, so the **different client artifacts**, not merely different aggregate outputHash, establish this confound.

**Repair direction:** Compile production artifacts in an isolated **build process** with production mode explicit, record actual build mode/toolchain/recipe, and verify the intended mode before reusing an artifact for acceptance/performance. Keep every DB/session/test process NODE_ENV=test with all existing isolation assertions. Never switch the application test runtime to production to bypass those guards.

A build-only production-mode correction is included as a review-only patch; full recipe/receipt and regression integration still require the existing build-authority owner and current gates. Do not retroactively assert that every historical C4 benchmark used test mode: those environment details are not established. Match baseline/current in the same declared production recipe and fixture conditions.

## 5. Actual checks and execution boundaries

| Check | Actual result |
| --- | --- |
| Locked supported install | PASS; no private-URL workaround or dependency change |
| C4 source/codec contracts at baseline | PASS; this did not contain the newly added A/B priority regression |
| C1 foundation | PASS338 source/unit assertions |
| C2 contracts | PASS281 counted source/unit assertions plus boundaries |
| Postmerge Calendar/task helper | PASS46 injected/pure assertions; no SQL/browser claim |
| Manifest | PASS consistency for **186 classified suites**; not186 executed suites |
| New A/B ordered-route regression | Expected FAIL on current serving-source baseline; PASS on prepared local reorder; numeric detail routing retained |
| Clean main production build / integrity | PASS through supported tsx loader invocation;83 live client assets match |
| Standard CLI source/build invocation | Environment failure: tsx IPC `listen EPERM`; resolved for source/build by loader, not for server-required tests |
| Default typecheck | Heap exhaustion, exit134; not a source pass |
| Typecheck with6GiB heap |240s timeout; no whole-project type acceptance claimed |
| PostgreSQL/Redis/browser mutation fixture | Not run: no configured disposable DB/Redis or installed PG/Redis/Chromium here; OS denies listener creation. Package setup also failed under the workspace's process/UID restrictions. No guard was weakened or production URL substituted. |
| Replit access | App resolved correctly. Read-only questions twice returned busy and were not submitted; no remote task was queued or changed. |
| GitHub status retrieval | No commit statuses and no PR-triggered workflow runs returned. The workflow wrapper filters PR events, so this is not proof that push CI does not exist. No existing job ID was available to rerun safely. |
| Live admin |39 route patterns and41 named observations, bounded to the recorded states |
| Cloud interaction limitation | Later clicks on an enabled Testimonials tab were credential-protection rejected after explicit document recovery. Further clicks stopped. This is not a confirmed dead CRM button. |
|200% zoom | Attempted shortcut produced no measured viewport/DPR change; unverified |
| Code rollback check | Committed local subset reverse-apply check PASS; review patch applies cleanly to clean baseline; no actual rollback performed |

The retained `working-status.md` and JSON receipts remain historical: root handler receipt has298 bounded named rows; root browser receipt27 observations; control inventory304 surfaces; source inventory1,132 expressions across160 reachable files. Their hashes differ from current clean8529669 and from each other. Preserve their proven scope without promoting them into current whole-task acceptance.

## 6. Prepared changes, safety and approval boundary

**Local-only branch:** `codex/2074-acceptance-20261014`, commit `0bb99ff`. No remote branch was found by read-only `git ls-remote`; no merge/publish occurred.

The committed subset contains narrow headings, Terminal target width, unchanged A/B reader reorder, real route/role/fault regressions, an inherited LiveChat type-only import and a six-suite isolated CI workflow. The broader review patch additionally contains employee-only target/focus/token/search styles and explicit production compilation. Those supplemental changes were generated as a review artifact and **were not applied to application source** after the rejection. V3 URL state, complete action overflow and remaining matrix expansion still need implementation.

The existing missing LiveChat import is retained baseline gate repair, not another invented C4 feature defect. Its one-line type-only correction has no runtime effect; a fresh whole-project type pass is still required.

**Automatic approval review rejected the remote push** because it interpreted the retained #2074 instructions as audit-only and the command as implementation plus a new remote CI workflow. The rejected operation was not retried through another tool or indirect path. Safe source/build/live checks continued. Approval is needed to finish these implementation changes and push/run the protected verification branch; no approval for a production deployment is being requested here.

The prepared CI path uses the existing disposable launcher and exact registered suites:

```text
scripts/test-stage3-c4-actions.ts
scripts/test-stage3-c4-browser.ts
scripts/test-stage3-c4-health-browser.ts
scripts/test-c2-contact-header.ts
scripts/test-c2-postmerge-browser.ts
scripts/test-toast-viewport-layout.mjs
```

It preserves the normal CI workflow and required gates. It neither waives the186-suite policy nor certifies a release from six scoped suites. Test resources are owned private PostgreSQL16/Redis with per-suite isolation, actual session/CSRF/object authority and denied native/external transport. No production secrets, migration target, shared Redis or public auto-login fixture.

**Kill lines:** outbound email/SMS/sequences remain paused; proposals held for review; incoming GHL independently enabled/no-echo. No live send/dial/enrollment/activation/provider generation/native submission/approval/payment/purge/merge/settings/worker/schedule/deployment action. Do not restore removed spend-approval or ZeroBounce-valid eligibility gates. Runtime incoming-sync success is not certified by health or by the timed-out GHL banner.

## 7. Exact completion sequence — same #2074

1. Finish the four bounded repair scopes through existing owners. Apply the reviewable narrow corrections; wire V3 through C1; complete action overflow and build-mode receipts. Preserve all current A/B authority and the C2 compact header. No new task ladder or final global sidebar cutover.
2. Produce one clean committed repaired candidate and production build. Recheck source/input/output/toolchain/mode and current/live differences. Run full typecheck and required gates without suppressing baseline failures. Keep exact failures and owners.
3. Execute registered handler/browser suites on protected infrastructure, then extend the **actual C4 action denominator** where current suites explicitly leave gaps: Contact Lifecycle/Service callers, task/ticket/RFI edits/reassignment, document preview/metadata/version, chargeback accepted/unknown/replay states and linked-handoff actor/context/concurrency/partial recovery. Use real rows/handlers/sessions and durable readback, never live native work. Expand dynamic controls without pretending1,132 source expressions are independent actions.
4. Complete width/theme/zoom/focus/contrast/overlay matrix and matched baseline/current performance using the same production build recipe, hardware, network/cache and declared record volume. Keep <=2.5s useful hydrated lists and <=200ms local response; do not import historical timings or empty-live first paint. The inherited C1372ms issue needs its own matched comparison rather than an unrelated C4 timing.
5. Rehearse forward-compatible source/artifact rollback on the disposable DB, retaining exact target/build/receipts and data invariants; no destructive down-migration. D later binds repaired deployment verification to the exact served release. Stages5/6 retain actual processor/MID/residual/commission execution; C5 retains eleven-entry sidebar.
6. Update this report, master spec and Go Live ledger with case-by-case evidence. Close C4 only after its actual scoped acceptance passes. Preserve original95 entries/14 repair groups/eight-task lineage and prior Stage1/2 completion; no Stage9 freeze or final GO here.


## 8. Exact route disposition — all39 current assignments

Entrances/alias selection are bounded admin observations, not durable/all-role/action passes. Initial loading is not a failure. Source guard strings describe the current entry; server/object/child authority remains independent.

| ID | Entrance | Observed destination / boundary | Entry guard |
| --- | --- | --- | --- |
| R-001 | `/dashboard/partner` | /dashboard/partner — separate Partner Portal Login content; no partner session supplied | PartnerProtectedRoute: partner/admin; outside employee theme |
| R-013 | `/dashboard/onboarding` | /dashboard/onboarding — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-014 | `/dashboard/tickets` | /dashboard/support-hub?tab=tickets — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-019 | `/dashboard/review-requests` | /dashboard/merchant-success?tab=reviews — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-020 | `/dashboard/testimonial-submissions` | /dashboard/merchant-success?tab=testimonials — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-021 | `/dashboard/onboarding-kickoff` | /dashboard/onboarding-kickoff — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-023 | `/dashboard/rfis` | /dashboard/support-hub?tab=rfis — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-024 | `/dashboard/review-queue` | /dashboard/support-hub?tab=review-queue — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-037 | `/dashboard/outreach-analytics` | /dashboard/reporting?tab=outreach-analytics — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-038 | `/dashboard/reporting` | /dashboard/reporting — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-040 | `/dashboard/win-loss` | /dashboard/reporting?tab=win-loss — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-045 | `/dashboard/statement-review` | /dashboard/statement-review — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-051 | `/dashboard/merchant-applications` | /dashboard/merchant-applications — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-052 | `/dashboard/boarding` | /dashboard/boarding — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-053 | `/dashboard/onboarding-board` | /dashboard/onboarding?tab=board — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-054 | `/dashboard/merchant-portal` | /dashboard/merchant-portal — admin inspection of Merchant Portal; actual merchant-session/object isolation pending | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-055 | `/dashboard/merchant-health` | /dashboard/merchant-risk?tab=health — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-056 | `/dashboard/chargebacks` | /dashboard/merchant-risk?tab=chargebacks — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-057 | `/dashboard/nps` | /dashboard/merchant-success?tab=nps — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-058 | `/dashboard/retention-campaigns` | /dashboard/merchant-success?tab=retention — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-060 | `/dashboard/my-earnings` | /dashboard — expected admin fallback from agent-only Earnings; agent page not accepted | ProtectedRoute: agent |
| R-061 | `/dashboard/residual-revenue` | /dashboard/reporting?tab=financial&financialTab=revenue — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-062 | `/dashboard/referral-program` | /dashboard/referral-program — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-063 | `/dashboard/partner-referral-pipeline` | /dashboard/partner-referral-pipeline — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-064 | `/dashboard/partner-portal` | /dashboard/partner-portal — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-065 | `/dashboard/partner-orgs` | /dashboard/partner-orgs — employee entrance / selected alias observed | ProtectedRoute: admin |
| R-066 | `/dashboard/co-branded-proposals` | /dashboard/co-branded-proposals — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-076 | `/dashboard/forecasting` | /dashboard/reporting?tab=financial&financialTab=forecasting — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-095 | `/dashboard/leaderboard` | /dashboard/leaderboard — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-096 | `/dashboard/terminal-roi` | /dashboard/reporting?tab=financial&financialTab=terminal-roi — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-099 | `/dashboard/document-vault` | /dashboard/document-vault — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-104 | `/dashboard/growth-kpi` | /dashboard/reporting?tab=growth — employee entrance / selected alias observed | legacy alias; destination guard applies |
| R-107 | `/dashboard/underwriting` | /dashboard/underwriting — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-113 | `/dashboard/merchant-success` | /dashboard/merchant-success — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-114 | `/dashboard/portfolio` | /dashboard/portfolio — employee entrance / selected alias observed | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries |
| R-115 | `/dashboard/support-hub` | /dashboard/support-hub — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-119 | `/dashboard/financial-hub` | /dashboard/reporting?tab=financial&financialTab=revenue — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-124 | `/dashboard/merchant-risk` | /dashboard/merchant-risk — employee entrance / selected alias observed | ProtectedRoute: admin/manager |
| R-141 | `/dashboard/executive` | /dashboard/executive — employee entrance / selected alias observed | ProtectedRoute: admin/manager |

## 9. Retained70-panel references and fresh evidence families

The original reference IDs remain intact. Some entries repeat hub/nested representations of the same view. “Live family” identifies related evidence; it does not turn a parent entrance, fallback or repeated observation into individual action acceptance. Every row retains C4 ownership. Underwriting current destination is Delivery; its historical Administration wording is superseded for current handoff, with privileged rule authority retained.

| Reference | Retained selection / label | Fresh evidence family / remaining obligation |
| --- | --- | --- |
| T-051 | `/dashboard/reporting` — Overview / hub-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-052 | `/dashboard/reporting?tab=growth` — Growth Metrics / hub-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-053 | `/dashboard/reporting?tab=win-loss` — Win/Loss / hub-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-054 | `/dashboard/reporting?tab=outreach-analytics` — Outreach Analytics / hub-tab | Outreach children selected; A/B unavailable and V1 route collision confirmed; no evaluation command executed |
| T-055 | `/dashboard/reporting?tab=operations` — Operations Report / hub-tab | Area selected; subsequent interaction timed out; settled Operations/CSV/fault proof incomplete |
| T-056 | `/dashboard/reporting?tab=financial` — Financial / hub-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-065 | `/dashboard/onboarding` — Onboarding / hub-tab | Overview/Board selected; missing Overview H1 confirmed; protected lifecycle/action proof pending |
| T-066 | `/dashboard/onboarding?tab=board` — Board / hub-tab | Overview/Board selected; missing Overview H1 confirmed; protected lifecycle/action proof pending |
| T-067 | `/dashboard/merchant-risk` — Chargebacks / hub-tab | Risk entrance and four Health children observed; no computation/configuration/acknowledgement command |
| T-068 | `/dashboard/merchant-risk?tab=health` — Merchant Health / hub-tab | Risk entrance and four Health children observed; no computation/configuration/acknowledgement command |
| T-069 | `/dashboard/support-hub` — Tickets / hub-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-070 | `/dashboard/support-hub?tab=rfis` — RFIs / hub-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-071 | `/dashboard/support-hub?tab=review-queue` — Review Queue / hub-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-072 | `/dashboard/merchant-success` — Review Requests / hub-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-073 | `/dashboard/merchant-success?tab=testimonials` — Testimonials / hub-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-074 | `/dashboard/merchant-success?tab=nps` — NPS / CSAT / hub-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-075 | `/dashboard/merchant-success?tab=retention` — Retention Campaigns / hub-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-079 | `/dashboard/financial-hub` — Revenue Dashboard / hub-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-080 | `/dashboard/reporting?tab=financial&financialTab=forecasting` — Forecasting / hub-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-081 | `/dashboard/reporting?tab=financial&financialTab=terminal-roi` — Terminal ROI / tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-122 | `/dashboard/reporting?tab=financial` — Revenue Dashboard / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-123 | `/dashboard/reporting?tab=financial&financialTab=forecasting` — Forecasting / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-124 | `/dashboard/reporting?tab=financial&financialTab=terminal-roi` — Terminal ROI / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-125 | `/dashboard/reporting?tab=financial&financialTab=revenue` — Dashboard / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-126 | `/dashboard/reporting?tab=financial&financialTab=revenue` — By Partner / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-127 | `/dashboard/reporting?tab=financial&financialTab=revenue` — Import & Reconcile / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-128 | `/dashboard/reporting?tab=financial&financialTab=revenue` — History / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-129 | `/dashboard/reporting?tab=financial&financialTab=revenue` — Payouts / nested-tab | Named Report/Financial selections, provenance, Back/Forward observed where recorded; individual role/action/export faults remain pending |
| T-130 | `/dashboard/reporting?tab=outreach-analytics` — Campaigns / nested-tab | Outreach children selected; A/B unavailable and V1 route collision confirmed; no evaluation command executed |
| T-131 | `/dashboard/reporting?tab=outreach-analytics` — A/B Testing / nested-tab | Outreach children selected; A/B unavailable and V1 route collision confirmed; no evaluation command executed |
| T-132 | `/dashboard/reporting?tab=outreach-analytics` — Recent Messages / nested-tab | Outreach children selected; A/B unavailable and V1 route collision confirmed; no evaluation command executed |
| T-133 | `/dashboard/merchant-risk?tab=health` — Health Alerts / nested-tab | Risk entrance and four Health children observed; no computation/configuration/acknowledgement command |
| T-134 | `/dashboard/merchant-risk?tab=health` — Churn Risk / nested-tab | Risk entrance and four Health children observed; no computation/configuration/acknowledgement command |
| T-135 | `/dashboard/merchant-risk?tab=health` — NPS / nested-tab | Risk entrance and four Health children observed; no computation/configuration/acknowledgement command |
| T-136 | `/dashboard/merchant-risk?tab=health` — Signal Settings / nested-tab | Risk entrance and four Health children observed; no computation/configuration/acknowledgement command |
| T-195 | `/dashboard/leaderboard` — Deals / nested-tab | Leaderboard entrance observed; all metric/period/role/history cases remain required |
| T-196 | `/dashboard/leaderboard` — Revenue / nested-tab | Leaderboard entrance observed; all metric/period/role/history cases remain required |
| T-197 | `/dashboard/leaderboard` — Proposals / nested-tab | Leaderboard entrance observed; all metric/period/role/history cases remain required |
| T-198 | `/dashboard/leaderboard` — Calls / nested-tab | Leaderboard entrance observed; all metric/period/role/history cases remain required |
| T-199 | `/dashboard/leaderboard` — Close Rate / nested-tab | Leaderboard entrance observed; all metric/period/role/history cases remain required |
| T-200 | `/dashboard/leaderboard` — Contacts Added / nested-tab | Leaderboard entrance observed; all metric/period/role/history cases remain required |
| T-218 | `/dashboard/underwriting` — Needs Review / nested-tab | All three selectors clicked with URL state; no decision or rule save; current group Delivery |
| T-219 | `/dashboard/underwriting` — Auto-Approved Today / nested-tab | All three selectors clicked with URL state; no decision or rule save; current group Delivery |
| T-220 | `/dashboard/underwriting` — Rules Config / nested-tab | All three selectors clicked with URL state; no decision or rule save; current group Delivery |
| T-221 | `/dashboard/merchant-applications` — All / nested-tab | All six status selectors clicked; URL persistence missing; no application mutation |
| T-222 | `/dashboard/merchant-applications` — Submitted / nested-tab | All six status selectors clicked; URL persistence missing; no application mutation |
| T-223 | `/dashboard/merchant-applications` — Under Review / nested-tab | All six status selectors clicked; URL persistence missing; no application mutation |
| T-224 | `/dashboard/merchant-applications` — Approved / nested-tab | All six status selectors clicked; URL persistence missing; no application mutation |
| T-225 | `/dashboard/merchant-applications` — Declined / nested-tab | All six status selectors clicked; URL persistence missing; no application mutation |
| T-226 | `/dashboard/merchant-applications` — Draft / nested-tab | All six status selectors clicked; URL persistence missing; no application mutation |
| T-227 | `/dashboard/boarding` — All / nested-tab | All six status selectors clicked; URL persistence missing; native refresh/transition not executed |
| T-228 | `/dashboard/boarding` — Submitted / nested-tab | All six status selectors clicked; URL persistence missing; native refresh/transition not executed |
| T-229 | `/dashboard/boarding` — Under Review / nested-tab | All six status selectors clicked; URL persistence missing; native refresh/transition not executed |
| T-230 | `/dashboard/boarding` — More Info Needed / nested-tab | All six status selectors clicked; URL persistence missing; native refresh/transition not executed |
| T-231 | `/dashboard/boarding` — Approved / nested-tab | All six status selectors clicked; URL persistence missing; native refresh/transition not executed |
| T-232 | `/dashboard/boarding` — Declined / nested-tab | All six status selectors clicked; URL persistence missing; native refresh/transition not executed |
| T-242 | `/dashboard/merchant-success?tab=reviews` — Review Requests / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-243 | `/dashboard/merchant-success?tab=testimonials` — Testimonials / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-244 | `/dashboard/merchant-success?tab=nps` — NPS / CSAT / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-245 | `/dashboard/merchant-success?tab=retention` — Retention Campaigns / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-246 | `/dashboard/support-hub?tab=tickets` — Tickets / nested-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-247 | `/dashboard/support-hub?tab=rfis` — RFIs / nested-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-248 | `/dashboard/support-hub?tab=review-queue` — Review Queue / nested-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-252 | `/dashboard/merchant-success?tab=testimonials` — Pending / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-253 | `/dashboard/merchant-success?tab=testimonials` — Approved / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-254 | `/dashboard/merchant-success?tab=testimonials` — Rejected / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-255 | `/dashboard/merchant-success?tab=testimonials` — All / nested-tab | Success aliases selected; later Testimonials tab clicks cloud-protection blocked; no send/publish/retention action |
| T-256 | `/dashboard/support-hub?tab=review-queue` — Pending / nested-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-257 | `/dashboard/support-hub?tab=review-queue` — Approved / nested-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |
| T-258 | `/dashboard/support-hub?tab=review-queue` — All / nested-tab | Support/RFI/Review Queue aliases selected; create/edit/approval/replay fixture still required |

## 10. Read-only source discovery / verification anchors

Run against a refreshed pinned checkout and retain actual outcomes. Grep matches are discovery, never action acceptance.

```bash
git rev-parse HEAD
git status --short
git diff --check
rg -n 'app.get.*api/sequences/(ab-test-results|:id)' server/routes/campaigns.ts
rg -n '<h1|<h2|CardTitle|CrmPageHeader' client/src/pages/dashboard/OnboardingHub.tsx client/src/pages/dashboard/Onboarding.tsx client/src/pages/dashboard/OnboardingBoard.tsx client/src/pages/dashboard/OnboardingKickoff.tsx
rg -n 'filter-tier|button-refresh-report|button-export-report|button-manage-models|button-configure-thresholds' client/src/pages/dashboard/TerminalROI.tsx
rg -n 'focus-visible|crm-merchant-ops-link|min-width|crm-target-height' client/src/styles/crm-theme.css
rg -n 'useState|useSearch|useLocation|statusFilter|Tabs defaultValue' client/src/pages/dashboard/BoardingTracker.tsx client/src/pages/dashboard/MerchantApplicationsList.tsx client/src/pages/dashboard/OutreachAnalytics.tsx client/src/pages/dashboard/Leaderboard.tsx
rg -n 'NODE_ENV|viteBuild|writeCandidateIdentity' script/build.ts scripts/fixtures/candidate-build-identity.ts .github/workflows/ci.yml
rg -n 'residual-group-scope|snapshotIdentity|complete_exact_relationship|nativeExecution' client/src/pages/dashboard/ResidualRevenue.tsx server/routes/routes-revenue.ts
rg -n 'stage3-c4|postmerge-browser|contact-header|toast-viewport' scripts/ci-suite-manifest.ts scripts/pre-deploy.ts
```

Relevant durable owners remain `server/services/onboarding-preparation-command.ts`, work-item/task/ticket/RFI/chargeback command services, A-owned revenue/task/object readers, and C1's existing query/state/portal authority. No replacement pipeline, duplicate SQL authority, deployment label shortcut or silent gate waiver.

## 11. Deliverables and retained accounting

- This report: current shipping evidence, four grouped repair scopes, exact execution boundaries, all39 route rows and all70 reference rows.
- `LIBERTY_2074_PREPARED_REPAIRS.patch`:13-file review artifact. Applies cleanly to baseline8529669; not a deployed change, full completed C4 implementation or passing final candidate. It includes review-only supplements beyond the10-file local commit.
- `LIBERTY_2074_ACCEPTANCE_EVIDENCE_2026-10-14.zip`: sanitized named observations, exact per-asset comparisons, gate outcomes/logs, build-mode counterexample and patch. No credentials, raw CRM record bodies, production screenshots or copied repository tree.
- Master spec and Go Live ledger updated in place, preserving their prior versions and original claim lineage.

The original95 entries,14 repair groups and A/B/C1–C5/D accounting remain. No global deduplicated defect recount or blanket status closure is inferred from this scoped audit. The four bundles are concrete work within existing repair scopes; native execution and final release gates stay with their established lanes.

**Result:** source/client publication and substantial bounded UI/provenance proof are now established. Whole C4 acceptance still requires the bounded repairs and protected execution above. The next approval concerns implementation on the isolated branch and its test runs only; it does not authorize merge, publish, production data writes or native execution.
