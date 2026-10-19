# Liberty Stage 3 — Task #2075 / C3 audit and required corrections

**Audit date:** October 19, 2026 UTC. **Task:** Prospecting, canonical enrichment and Campaigns. **Verdict:** Keep #2075 as the implementation owner, amend its executable specification with the corrections below, and withhold full-scope completion until its evidence gates pass.

This audit inspected the attached 1,620-line task, current repository source, the signed-in production CRM as an administrator, prior consolidated Stage 3 requirements and the Go Live ledger. It found current functional defects alongside the navigation/design work already assigned to C3. It did not implement or deploy repairs.

**Highest-priority corrections:** Canonical Backlog currently fails to read; Campaign Readiness Intelligence currently fails to read; Sequence create/edit requests violate the server's strict schemas; post-commit audit failures can incorrectly tell users nothing happened; Source Prospects silently reports a loaded 500-record subset as its total; Command metrics have misleading scope labels and insufficiently explicit aggregate access policy. The planned five-area/four-area design has not shipped on these surfaces.

Outbound remains paused. GHL incoming synchronization is a separate capability and must remain enabled. No production mutations, provider runs, uploads, consent changes, enrollment, release, sends, role changes, merge, publication or rollback were performed during this audit.

## 1. Source, serving baseline and verification actually completed

| Evidence | Current result | What it proves / limit |
| --- | --- | --- |
| Repository | `scottpstevenson/Liberty-Bancard-Website-and-CRM` main `ea7955e7dac798f2791814a588c1b3f6eeaf8958` | Fresh clone, main rechecked, working tree clean. File references below are relative to this repository and this SHA. |
| Serving health | `a0e1c10adc1b6ba370da290f30688ec483c135a3`, production, health `ok`; built `2026-10-19T09:38:56.691Z`; publish build `d896b301-b03f-4bab-b3b8-3aa7694279bf` | Main is its metadata-only child; the parent/child source diff is empty. Health alone is not server artifact/schema/worker proof. |
| Production client comparison | Live `index-DhhsfxO_.js`, `index-Dg12G47f.css` and 20 selected C3/shared chunks matched local SHA-256: **22/22** | Strong client parity for those files, not a full server/config/schema certification. |
| Supported clean dependency installation | Node **22.22.0**, npm **10.9.4**; `npm ci --include=dev --ignore-scripts --no-audit --no-fund` passed; 767 packages | Lockfile stayed unchanged. Lifecycle scripts intentionally not run by install. This is not a full stock-CI pass. |
| C1 foundation suite | **338 assertions passed** | Existing source/unit contracts, not complete mounted-browser behavior. |
| C2 contracts | **286 assertions plus boundary checks passed** | Existing C2 contracts, not all business actions. |
| C4 contracts | Passed | Existing source/codec checks, not 39 routes / 70 panels functionally certified. |
| CI suite manifest | Check passed; **186 suites classified** | Classification, not 186 suites executed. |
| Whole-project typecheck | `tsc` exit 0 on supported Node | Earlier missing-toolchain/typecheck limitations are historical, not current blockers. |
| Supported production build | `node --import tsx script/build.ts` passed; recipe records production / Node 22.22.0 / npm 10.9.4; integrity verification passed | Build ID `46c1b4f6-24ac-4488-b367-71aefa5311c8`. Input hash `c90e835b120a037dc6841b3a1758dece19db6d2603d30dafbbc60aa715ac735f`; output hash `e7a34cf8f4d4e144632e010deb31923b453fe4245c42b1ccc587c1e5dce6b063`. This build was not published. |
| Sequence schemas | Actual current create/update schemas rejected UI-shaped payloads in isolated checks | Create: forbidden `status`, `totalSteps`; edit: forbidden `totalSteps`. No production Save was submitted. |
| Production UI | Signed-in administrator; desktop 1363×936, DPR 1; all 24 assigned route patterns entered, all 13 Lead Ops selectors, six canonical views and six outbound selectors visited | Route entrance and selector coverage do not mean every child, action, role or error branch passed. Detailed evidence follows. |
| Backend/DB/browser certification | Not executed against owned disposable infrastructure | No full CI, native GHL/provider canary, controlled command failure injection, alternative-role live matrix, real phone/dark/200% matrix, matched performance or rollback claim. |

The original attachments are historical evidence, not current runtime receipts. The private `.local/tasks/liberty-stage3-c3-post-2090-audit-2026-10-19.md` file referenced by the task is not present in the public clone. Its embedded summary was available; its full external contents were not independently retrieved. A read-only Replit question returned BUSY and was not submitted, so no server-log root cause is claimed for the live read failures.

## 2. Reconciliation with earlier audits and the task

| Earlier allegation / requirement | October 19 disposition | Required treatment |
| --- | --- | --- |
| Provider Results tab broken/missing | **Closed for the observed entrance/read:** actual panel mounts and was visited | Preserve it; do not spend this task rebuilding an already repaired tab. |
| Canonical Enrichment route unserved / 404 | **No longer accurate for current production:** route and all six selectors exist | Keep its compatibility entrance; consolidate its presentation inside Prospecting. Backlog itself still fails. |
| Canonical has five views | **Stale:** current source has six including Backlog | Replace every executable enum, mapping, test and denominator with six. |
| C4 A/B literal route swallowed by campaign ID | **Current repair present:** literal route precedes dynamic route; live report shows “No A/B tests configured” | Retain C4 repair and report owner; no duplicate C3 analytics backend. |
| Build not explicitly production | **Current repair present:** build script sets production and records production recipe; supported build passed | Keep source fix. Do not present the old C4 claim as an open source defect. |
| Human Review always HTTP 500 | **Not reproduced on current first and next pages:** 25 + 25 distinct candidates loaded | Narrow historical claim. Submission, all pages, native outcomes and performance remain unverified. |
| October uploads missing from canonical ledger | **Narrowed:** five October execution identities plus September are visible; selected 633-row run loads rows 1–25 and 26–50 | Ledger UI exists. No claim that every workbook byte/hash, row or later native fulfillment was independently verified. |
| Five vertical campaigns/content absent | **No longer a blanket current claim:** five SFP-V2 draft/unreviewed campaigns with three steps are visible | Validate content and current configuration; do not recreate or activate them merely because an old appendix says absent. |
| Active local sequence state proves sending | **Already corrected in Sequence Report** | Retain distinction: 420 active enrollments can be held in paused sequences; zero sends is consistent. |
| All 95 source entries are unique defects | **Incorrect interpretation:** 95 traceable historical source entries overlap across repair groups | This report supplies grouped amendments, not a new global defect count or closure of all 95. Preserve original IDs/dispositions. |
| C3 owns final eleven-entry sidebar | **Outside C3 boundary:** C5 owns global sidebar consolidation | C3 owns five Prospecting areas and four Campaigns areas, contextual compatibility and interiors. |

Current grouped amendments below are **16 repair/specification bundles**, not 16 newly reproduced runtime bugs. They combine live defects, deterministic source defects, already-planned upgrades and delivery gates. Related original lineage includes C3-V01–V08, CRM3-08 and the retained C3 references in repair groups R03/R05/R06/R07/R08/R12/R13/R14. Preserve the master register; do not manufacture a one-to-one new 95-row recount from these bundles.

## 3. Exact findings, fixes and task amendments

Line numbers are anchors at the audited SHA; re-resolve after rebases. “Source-confirmed” means the call chain exists, not that its production fault condition was induced.

### F01 — Restore unavailable reads and isolate independent panels — P1

**Live-confirmed:** Canonical → Backlog settled to HTTP 503 and “The enrichment backlog is unavailable; nothing was counted.” One explicit Retry returned the same result. Campaigns → Readiness Intelligence settled to “Failed to load readiness statistics.” These are separate readers; no shared root cause is established.

**Code:** `server/routes/canonical-enrichment.ts:28–40`; `server/services/canonical-enrichment-backlog.ts:19–21`; `client/src/pages/dashboard/CanonicalBacklog.tsx:344–385`; `server/routes/campaigns.ts:978` onward; `client/src/components/ReadinessIntelligencePanel.tsx:475–535`.

**Required repairs:**

1. Capture the exact server error, SQLSTATE and request timing for each reader through authorized logs. Diagnose the actual aggregate/query/data-shape fault before changing its implementation. The readiness query uses `jsonb_array_elements_text` over `missingReasons`; inspect malformed/non-array values as one possible failure, not a proven diagnosis.
2. Keep aggregate queries bounded and indexed. Backlog currently permits a 60-second statement timeout and uses a five-minute cache. Increasing the timeout or removing safeguards is not a repair. Use the existing backend owner for measured aggregate changes, with exact predicates and explain evidence.
3. Render independent Launch Inventory / Release / Process readers independently. `CanonicalBacklog` returns its top-level error before those siblings render, making a backlog aggregate outage hide otherwise independent controls/status.
4. Remove automatic heavy recount polling. Current backlog `refetchInterval` is five minutes; launch inventory is ten minutes. The task's “no polling” instruction is not implemented by those intervals. Use selected-view lazy reads, explicit refresh and truthful timestamps/cache age. Do not default to expensive forced recounts.
5. Do not convert failed `readLastBacklogPriorityRun()` into “no previous run.” Return a separate unavailable state when the last-run lookup fails.
6. Readiness already has an error state and Retry: retain them while fixing the reader; do not replace failure with zeros. Display backfill capability separately and never start it on entry.

**Acceptance:** Both real read paths return bounded typed results, or explicit partial/unavailable sections with provenance. An injected backlog failure leaves independent launch status visible. A readiness source failure keeps Retry and does not invent grades. Record matched before/after timing and absence of hidden-view polling. Live SQL root causes are pending exact logs, not “confirmed timeout/schema issue.”

### F02 — Repair Sequence create/edit DTOs and prevent destructive content recovery — P1

**Deterministically source-confirmed:** `Sequences.tsx:213–240` sends `status` and `totalSteps` in Create; `campaigns.ts:166–171` uses a strict create schema omitting them. The real schema rejects the UI-shaped payload. Edit `Sequences.tsx:397–404` sends `totalSteps`; the strict update route `campaigns.ts:909–915` rejects it. These are actionable client/server contract failures without needing a production write.

**Additional same-scope defects:**

- Create posts the sequence, then posts steps in a loop. A partial failure needs created-ID recovery and explicit incomplete-content state; blind retry can duplicate a sequence.
- Edit loading `Sequences.tsx:431–446` converts a failed step read to `[]` and omits existing step `config`. Subsequent edits send `config: s.config || null` (`:387–395`), which can clear configuration after the DTO error is repaired.
- Persisted IDs are read by `originalStepIds[index]`; removal reindexes steps without a matching ID model. Existing `sequence-command.ts:35–39` rejects omitted persisted steps. That guard prevents silent deletion and must remain.

**Required repair:** Remove client authority fields; the server owns initial paused status and derived step count. Keep full typed step IDs/configuration, block Save on failed hydration, preserve unchanged fields and stable IDs, and use the existing B command/version/replay contract. Recover a successful create ID after partial step creation. Disable unsupported persisted-step deletion with a reason; allow removal of an unsaved local step. Do not relax strict schemas or remove the omission guard. If durable multi-step creation requires backend work, extend the current command owner narrowly rather than adding a parallel writer.

**Acceptance:** Mounted controls create a paused sequence with the intended exact steps; refresh recovers it. Edit round-trips advanced config unchanged. Failed hydration cannot save an empty sequence. Test partial-create recovery, double submit, stale version, actor change, removal of an unsaved step and attempted persisted-step omission. Use disposable fixtures; no production active enrollment is needed.

### F03 — Distinguish committed effects from audit/readback failure — P1

**Source-confirmed fault path, not production-reproduced:** In `canonical-enrichment.ts:74–98`, release/revoke can commit and then await a storage audit write inside the same catch path. `sfp-canonical-release.ts:189–227` commits before returning. An audit failure can therefore produce a response claiming nothing was released/revoked after the effect occurred. The process enqueue path at `canonical-enrichment.ts:110–119` has the same enqueue-then-audit shape. `CanonicalBacklog.tsx:127,231–241` repeats “Nothing was started”/release failure language.

**Required repair:** Route effect/audit/readback through the existing durable command owner. Return an effect receipt or accepted/unknown reconciliation state if a post-effect operation fails. Reuse the same intent/idempotency identity for readback; never prompt a blind new release. Test audit failures after commit and after enqueue in isolated fixtures. Audit success alone must not prove provider/native completion.

ReleasePanel also reads only `data` without a distinct failed-read state (`CanonicalBacklog.tsx:226–248`), so unknown status can appear as not released and fall back to default limits. Add loading, denied, unavailable, expired, revoked and replay states; disable mutations until authoritative capability/state has loaded. Scope the page's “Read-only status view” wording: Backlog includes privileged commands and is not universally read-only.

**Safety retained:** Preserve current administrator authority, current server-enforced 50/72 limits where applicable, existing command receipts and current pause. The release service can create **active enrollment rows in paused sequences**; do not describe all enrollment rows as paused. Never turn sequence pause or the global gate off for acceptance.

### F04 — Correct classification, affiliation and email-validation semantics — P1/P2

**Live + source confirmed:** Canonical's unresolved business count is described in Exceptions as relationships needing evidence review. `canonical-enrichment-status.ts:52–57` actually derives mapped/unresolved/excluded from effective **business vertical classification**, while `CanonicalEnrichment.tsx:492` supplies the relationship copy. At observation, 5,817 mapped + 74,123 unresolved + 13,825 excluded = 93,765 businesses. This is classification accounting, not verified business/contact-link accounting.

**Required repair:** Label those counters “Vertical classified / Vertical unresolved / Excluded from vertical scope,” or equivalent exact definitions. Use the existing verified-link reader for affiliation. Never infer a relationship from a company graph, matching name or a candidate suggestion.

A business candidate and its linked Contact both displayed raw `active` email status. This is a legacy projection, not proof of a current validation receipt. Keep the correct current “potential contact candidate — not verified link” label. In the Contact canonical context, `ContactDetail.tsx:263–307` also defaults failed validation-history data to an empty history and can say not yet validated. Distinguish failed history lookup, history for an older email, legacy status and the server's current exact-email/age-qualified receipt. Do not infer current validation from a historical success. Do not add a new mandatory paid validation gate to general admission.

**Acceptance:** Shared fixtures with unresolved vertical + verified link and mapped vertical + unverified link show different states. Failed validation-history read says unavailable; changed-email/expired receipt is not current-valid. Current eligibility remains defined by its existing backend authority.

### F05 — Reconcile metric cohorts and enforce aggregate access explicitly — P1

**Live + source confirmed:** Outreach Command displayed 160,306 “CRM Contacts” and 1,575 “Active Deals”; Canonical showed 159,904 production contacts and Dashboard showed two open sales deals. These are differently scoped readers. They do not prove data corruption, but the shared-looking labels do not explain the differences. `OutreachCommand.tsx:123–127`; `server/routes/imports.ts:160–220`; `server/storage/sunbiz.ts:572–584`. Deal aggregate uses all unarchived deals rather than an active/open sales predicate.

**Required repair:** Either use A's existing active/open production sales-deal definition for an Active Deals card, or rename the present measure explicitly as all unarchived deal inventory with its scope. Label all-contact inventory separately from production-unarchived contacts. Do not make different business concepts artificially equal. Show scope, unit, source, as-of and availability on every corresponding card. `imports.ts:185` must not turn a failed communication-events query into an empty/zero result.

**Authorization:** `/api/outreach/status` is guarded by authentication but its aggregate calls do not receive actor scope. Contact/deal object guards do not automatically protect this aggregate route. Source does not establish the intended agent/merchant aggregate policy. The global partner middleware already denies partner access; **no unrestricted partner claim is made**. Use the existing approved aggregate policy: actor-scoped DTO where supported, or an explicit role denial before queries. Do not broaden existing workspace/metadata permissions to make the UI happy. Alternate-role production leakage was not exercised.

**Acceptance:** Admin/manager/agent/merchant/partner/unauthenticated fixtures verify exact allowed scopes or denial, including account/role change. Identically defined cards agree at the same snapshot; intentionally different cohorts show different labels/predicates. Denied/unavailable is never zero.

### F06 — Paginate Source Prospects and stop calling a subset the total — P1

**Live + source confirmed:** Source Prospects showed Total 500; Command showed 12,711 source prospects. `Prospects.tsx:76–85` requests `limit=500` and ignores the server total; `:205–209` uses the loaded filtered array length as Total. Search/filtering likewise acts on the loaded subset.

**Required repair:** Use the existing bounded pagination route (`server/routes/prospects.ts:191–197` supports limit/offset), return/use authoritative filter totals, and apply supported search/sort/filters server-side. Label page-loaded counts separately if that is all a particular API supports. Reset page and selected IDs on filter/actor change. Preserve source-prospect identity and lineage. Do not fetch the entire table or raise the hard cap to hide the problem.

**Acceptance:** A fixture with >500 rows finds a matching row beyond the first 500 through server search, reports the correct total, does not duplicate/skip between pages and does not retain stale selection across filters/roles.

### F07 — Remove error-to-empty and indefinite-loading states — P2

**Source-confirmed branches:**

| Destination | Code anchor | Current failure behavior / required repair |
| --- | --- | --- |
| Outreach Command | `OutreachCommand.tsx:48–82` | No separate query error; failed no-data status can leave a skeleton. Render unavailable with scoped Retry. |
| Sequence tier breakdown | `Sequences.tsx:1544–1574` | Non-OK becomes `[]` then no-active/zero. Throw and render unavailable. |
| Sequence steps | `Sequences.tsx:1595–1631` | Non-OK becomes `[]` then “No steps configured.” Preserve failed-read state. |
| Sequence grouping metadata | `Sequences.tsx:192,657–661`; `campaigns.ts:848` | No explicit metadata error; denied manager request can look like missing classification/GHL ID. Respect current admin-only endpoint; display denied/unknown separately. Do not broaden it casually. |
| Import stats/list | `LeadImports.tsx:690–716,932–1010` | Stats default to zero; some failed lists fall back empty. Use loading/partial/denied/unavailable and only show accounting equations for a loaded same-scope result. |
| Contact validation history | `ContactDetail.tsx:263–307` | Failure can appear as no validation history; apply F04. |

These fault branches are proven in code; they were not all deliberately induced in production. Sequence metadata later loaded and cards grouped in this session; do not label all 122 sequences permanently uncategorized based on initial loading. Promotion Review loaded an empty-state view, but that is not an independent SQL proof of zero inventory.

**Acceptance:** Actual rendered consumers receive 401/403/404/409/429/503/network-failure and malformed/partial data fixtures as applicable. Only a successful empty response may render a legitimate empty state. Retry affects the owning read, not unrelated mutations.

### F08 — Adopt actor-aware queries, cancellation and selected-view loading — P2

**Code:** `LeadOpsCenter.tsx:2229–2318` mounts parent queries independently of the selected tab; stats/free-health/staging poll at 30 seconds, health at 120 seconds. `CanonicalEnrichment.tsx:219–222` reads global status on every canonical view; the header refresh near `:593` refreshes status even when a different reader owns the visible content. `UploadLedger.tsx:12–15,88–105` uses raw fetch without AbortSignal and generic query/infinite-query keys, with execution/filter state local.

Use existing `client/src/hooks/use-crm-query.ts`, `use-crm-infinite-query.ts` and the protected actor identity contract. Pass query cancellation signals; key by authorized actor plus typed selected execution/filter/cursor; avoid prior-filter placeholder records and late responses. Bind command drafts to the current actor/account version. Enable expensive queries only for the active selected child. Refresh the visible reader and show its own timestamp. Protect independent child queries from parent failures.

**Narrowing:** `queryClient.ts:129–140` already cancels/removes protected queries on actor transition. No actual cross-actor live disclosure was reproduced. This is adoption of the existing stronger contract and cancellation/freshness repair, not permission to replace the query authority.

**Acceptance:** Mounted tests prove inactive heavy children do not fetch/poll, late responses cannot overwrite new selections, actor switch clears data/drafts, explicit refresh targets the selected reader and background work does not resume provider operations.

### F09 — Deliver five Prospecting areas, four Campaigns areas and persistent view state — P2

**Live + source confirmed:** Lead Ops still has 13 flat primary tabs (`LeadOpsCenter.tsx:2168,2504`). Outbound still has six (`OutboundCenter.tsx:39–56`). Canonical has six local `useState` views (`CanonicalEnrichment.tsx:38–48,219,601–623`); reloading Settings & Health returned to Pipeline. Outbound selection replaces the entire query and history entry, losing unrelated valid context.

Implement the exact mappings in Sections 4–5 below through the existing C1 destination codec. `crm-destination-state.ts:53–65` currently allowlists retained selections for reporting/leaderboard/status; extend the real owner additively for C3 routes rather than invoking it unsupported or creating another parser. Preserve valid query/hash context, typed entity namespace, role-aware standalone entrances and back/forward history. Define duplicate/invalid parameter behavior and encode/decode round-trip tests.

The canonical enum must be `pipeline | backlog | records | imports | exceptions | health` everywhere. Existing standalone `?view=` must adapt explicitly to grouped `canonicalView=`. Keep old leaf selectors as compatibility inputs while rendering area/secondary selection. C4's outreach results already navigate to `/dashboard/reporting?tab=outreach-analytics&outreachView=ab-testing`; retain that owner and valid context.

**Acceptance:** All 24 patterns, 28 historical panel rows, new six-view register and newly discovered controls have explicit receipts. No unauthorized user is redirected into an admin/manager-only shell. No content/data action disappears merely because its old primary tab was removed.

### F10 — Apply actual merged Liberty components and remove duplicate shells — P2

**Live + source confirmed:** Lead Ops rendered two H1s (“Lead Ops Center”, “Lead Operations Center”). Command rendered “Outreach” plus “Outreach Command.” Business detail rendered a generic Dashboard H1 plus the record name. `DashboardLayout.tsx:416–422` does not include C3 in its adopted-page recognition; legacy heading at `:797–804` stays visible. Canonical nests another `<main>` around `:569` and uses its own page gutters/hero treatment. These surfaces have not adopted the delivered C1/C2 hierarchy.

Use one `CrmPage`, one H1, `CrmPageHeader`, `CrmAreaNav`, shared worklist/data-state/table/drawer components, and a presentation-only embedded mode where a child needs the shell's heading. The actual `CrmPageHeader` supports `headingLevel`, `context`, `primaryAction`, `secondaryActions` — it has **no `overflow` prop**. The actual `CrmActionMenu` is an inline button group, **not a dropdown menu**. Use the existing Radix DropdownMenu in `secondaryActions` for More; do not invent missing component APIs. WorklistToolbar's shared hard-coded search ID needs an owner-level additive unique-ID correction if two mounted instances require it.

Use Section 6's exact source tokens, spacing, typography, hierarchy and responsive layout. Keep C1 scope employee-only; do not alter public-site colors/fonts globally. Current tab targets measured 44px on Lead Ops and Campaigns, so no blanket undersized-tab allegation is made. Improve clutter and hierarchy rather than claiming those measured controls failed target height.

**Acceptance:** One landmark `<main>` from the shell; one H1 per full page; embedded headings descend appropriately; no double main padding; real drawer/dialog/menu portal styling and focus behavior; token values used rather than another theme system.

### F11 — Put inventory first and make business actions describe their real effect — P1/P2

**Live confirmed:** On the settled Businesses view, the business table began around y=1,048 in a 936px-high viewport, behind full matching/census/review/bootstrap/repair sections. The primary inventory is below the fold. A real business row's View control opened business `173508`; Inspect Candidate opened contact `62340`. Those navigations worked. Business names themselves are not internal record links; domain links go externally.

Move advanced reconciliation/run/repair tools into Program Health or an explicit privileged context drawer. Keep the inventory toolbar and first useful rows visible without scrolling past administrative operations. Make the business name an accessible canonical-business link and retain View if useful; preserve current list/filter/back context. `BusinessDetailPage.tsx:227` currently returns to a fixed base route. Reuse C2 contact presentation when opening the actual contact; do not treat business ID, company ID and contact ID as interchangeable.

**Source-confirmed misleading action:** `BusinessDetailPage.tsx:562–589` displays provider-plan operations (live plan included ZeroBounce) but every Run invokes `enrichMutation` at `:179`, which posts `/businesses/:id/enrich-free`. `server/routes/lead-ops.ts:1740–1775` enqueues generic `free-contact-enrichment {businessId}`, not the selected displayed provider operation. A Run button beside one operation implies a more specific action than its payload.

Keep such rows read-only plan diagnostics, or label the supported generic action accurately. Only expose a specific operation when the existing canonical command/capability actually supports it. Do not wire paid provider execution as a UI fix. Narrow `run_email_discovery`/“Outreach approved” copy similarly; approval/enrichment is not dispatch authority.

**Acceptance:** Actual selected business ID reaches the intended generic command; provider-plan controls cannot silently run something else. Candidate label stays unverified until authoritative evidence says otherwise. Both direct detail and from-list Back restore appropriate context. No provider runs are needed for a read-only production check.

### F12 — Use current configured campaign taxonomy and show effective capacity separately — P2

**Live + source confirmed:** Create Campaign's CRM audience selection uses 12 hard-coded old labels in `Campaigns.tsx:61–64`, while five SFP-V2 draft campaigns use the current vertical family. The form cannot faithfully express all current configured versioned IDs/labels. It also displays stale approximate contact-population copy. The current five draft campaign records already exist; blanket missing-content claims are stale.

Read the approved current program taxonomy/version from its existing owner, use stable IDs in audience configuration and display actual current labels. Source defaults are Automotive, Healthcare, Beauty/Spa, Construction/Trades/Home Services, Fitness/Recreation; source defaults alone do not prove live program configuration. Retain legacy campaigns' historical labels; do not bulk rewrite them, reintroduce excluded DBPR restaurants/food trucks or change backend eligibility through a UI taxonomy patch.

`Campaigns.tsx:1079–1092` defaults the configured daily campaign limit to 200, while the current sequence report displayed one sender identity with 30/day capacity. These are different concepts. Show configured campaign limit, effective available sender capacity and global pause independently. Do not hard-code 30 from this snapshot or auto-replace a configured value. Draft creation/edit/archive/cancel must use supported commands and remain independent from activation/enrollment/send.

**Acceptance:** Current versioned IDs round-trip through draft audience edit/preview; legacy IDs remain interpretable/read-only where needed. Missing source/capacity state is unavailable, not zero or permission to send. Existing five drafts are not duplicated. No real sends.

### F13 — Move legacy ceremony to history; label worker/provider health precisely — P2

**Live confirmed:** Paid Pilot (Legacy) and South Florida Prospecting remain first-level destinations, with old freeze/cohort/approval/profile ceremonies mixed into ordinary work. Program Health displayed raw Sunbiz “Enriched Today” and “Total Enriched” totals and a stale GHL heartbeat from September 5.

Move retired pilot/cohort ceremony into role-aware read-only historical context under Program Health. Preserve evidence and old links, and retain current reviewed admin processing/release operations where the backend still authorizes them. Do not restore the old frozen-100 requirement or removed paid-approval policy; do not remove current release limits/guards by analogy.

Label provider counts as raw source entities/attempts/results, with source and timestamp; they are not unique CRM contacts or current-valid emails. Show configured/enabled, last-started, last-completed, running/failed/stale/unknown separately. A stale legacy GHL heartbeat does **not** prove incoming sync is disabled. Current incoming receipts remain a separate required verification; no switch was changed here.

### F14 — Finish import/ledger workflows without conflating intake and fulfillment — P2

**Current live ledger evidence:**

| October workbook identity shown in UI | Rows | Execution ID |
| --- | ---: | --- |
| `Outscraper-20261002161239s8aab_1791037870874.xlsx` | 633 | `6b28085c-8ee3-475c-973d-dd6a500e5109` |
| `Outscraper-20261002161147s2b94_1791037870876.xlsx` | 653 | `6623a227-8986-4d95-a46c-14b09ed67d12` |
| `Outscraper-20261002161052s68e5_1791037870877.xlsx` | 513 | `9cd520f7-0d80-4265-985f-0fe6af0b7307` |
| `Outscraper-20261002160955s00ed_1791037870876.xlsx` | 578 | `b070a72b-faa5-4056-b300-c24686ccc76e` |
| `Outscraper-20261002160911s8d6b_1791037870877.xlsx` | 537 | `83e594ce-3b4c-484a-96a8-2f9f71f789d7` |

September CSV execution `79356e0b-c0b0-4a2f-abe1-f5844b7c9335` appeared separately with 1,472 rows. For the selected 633-row October execution, the UI reported 529 created + 103 deferred + one matched/no-op, 524 distinct contacts / verified links and 529 current receipts, with zero stale/inconsistent. Rows 1–25 and then 26–50 loaded through the actual next-page control. These are **UI reports at observation**, not independent SQL/file-hash/native-delivery certification. Contact counts and row receipt counts use different units.

Required: keep immutable intake disposition accounting separate from later promotion/link/selection/preparation/native fulfillment. Preserve original bytes/hash/execution/row lineage and current-email qualification. Reuse `UploadLedger` with actor-bound cancellation, typed execution/filter/cursor URL state, loading/retry/empty/denied states and bounded continuation. No all-uploads-complete claim from one paged run. The import-to-native bridge needs its own evidence beyond the seven general native guards.

`LeadImports.tsx:912,920` also nests page padding and places a large historical Priority Master Lead section ahead of ordinary upload; a July sheet/count appears in fixed copy near `:375`. Move historical privileged operations to context/history; derive current source identity/count from readback. Retain actual CSV/XLSX mapping, validation, row errors, cancellation and durable result recovery. A file accepted is not an import completed; an import completed is not a deal created or email delivered.

### F15 — Publish one executable specification instead of contradictory appendices — P2

The attached task has useful recent amendments, but older sections still describe five canonical views, a 21-route register, old taxonomy names, an unserved canonical page, missing supported-toolchain verification and older task dependencies. Its “binding portable” language can cause an implementer to follow contradictory directions.

Amend #2075 with a concise controlling override containing this report's baseline, 24 routes, 28 historical rows, six canonical views, current taxonomy authority, exact component APIs, current safety boundaries and acceptance table. Label older material **historical / superseded where this override differs**. Preserve it for lineage without competing executable instructions.

Reconcile the no-startup-DDL language with the **already reviewed** manifest/version-0362 first-party installation path. Preserve that existing reviewed installer; do not disable it or authorize arbitrary new DDL. A single first-party installer does not prove all other migrations/triggers are installed. Source work present on main does not require an extra manual task ladder merely because old task status remains draft. Conversely, source presence does not prove serving DB/native acceptance.

This user request authorizes an audit/report. The attached implementation imperative does not authorize this audit session to build/deploy/mutate production. The updated Replit task may execute implementation when assigned in Build Mode, within its existing boundaries.

### F16 — Add C3-specific behavioral evidence and preserve remaining gates — P2

There is no current named C3 UI acceptance suite registered in the audited manifest. This is an expected missing delivery artifact for unbuilt C3, not a claim that all existing suites are absent. Existing C1/C2/C4 checks passed and must stay green.

Implement C3 codec/unit/source checks plus mounted-browser action/state tests using the existing runner/manifest. Reuse current guarded backend suites **under `scripts/certification/`**: `test-intake-review-pages.ts`, `test-canonical-release-authority.ts`, `test-vertical-acceptance-policy.ts`, `test-staged-email-materialization.ts`, `test-serper-lookup-memory.ts`, `test-first-party-native-install.ts` and existing supporting guards. Do not cite nonexistent `scripts/<name>` paths or treat these scripts' presence as execution.

Tests requiring DB/Redis/native receipts must run only after owned disposable infrastructure and provider-deny/paused gates are proven. Browser fixtures must click the actual controls and inspect intended request + durable readback after refresh. A modal opening is not Create/Save/Delete/Promote passing. Section 8 defines the outstanding evidence; do not mark it complete from source grep.

### Relevant implementation files — current real destinations

| Concern | Files |
| --- | --- |
| Shell, route compatibility and destination codec | `client/src/App.tsx`; `client/src/pages/DashboardLayout.tsx`; `client/src/lib/crm-destination-state.ts` |
| Liberty primitives/theme | `client/src/components/crm/CrmPresentation.tsx`; `client/src/styles/crm-theme.css`; existing `client/src/components/ui/` |
| Protected queries | `client/src/hooks/use-crm-query.ts`; `client/src/hooks/use-crm-infinite-query.ts`; `client/src/lib/queryClient.ts` |
| Prospecting/records | `client/src/pages/dashboard/LeadOpsCenter.tsx`; `Prospects.tsx`; `LeadImports.tsx`; `LeadOps/BusinessDetailPage.tsx`; `LeadOps/ProgramHealthPanel.tsx` (last five relative to `client/src/pages/dashboard/`) |
| Canonical views/ledger | `client/src/pages/dashboard/CanonicalEnrichment.tsx`; `client/src/pages/dashboard/CanonicalBacklog.tsx`; `client/src/pages/dashboard/UploadLedger.tsx` |
| Campaigns/sequence/reports | `client/src/pages/dashboard/OutboundCenter.tsx`; `Campaigns.tsx`; `Sequences.tsx`; `SequenceReport.tsx`; `OutreachCommand.tsx`; `ContactDetail.tsx` (last five relative to `client/src/pages/dashboard/`); `client/src/components/ReadinessIntelligencePanel.tsx` |
| Existing API owners | `server/routes/campaigns.ts`; `canonical-enrichment.ts`; `imports.ts`; `prospects.ts`; `lead-ops.ts` (last four relative to `server/routes/`) |
| Existing authority/readers | `server/services/sequence-command.ts`; `sfp-canonical-release.ts`; `canonical-enrichment-status.ts`; `canonical-enrichment-backlog.ts` (last three relative to `server/services/`); `server/storage/sunbiz.ts` |
| Existing contracts and CI | `shared/canonical-enrichment-status.ts`; `shared/canonical-enrichment-backlog.ts`; `shared/canonical-upload-ledger.ts`; `scripts/ci-suite-manifest.ts`; existing `scripts/certification/`; `script/build.ts` |

## 4. Exact navigation and view plan

These are required C3 destinations, not a claim the grouped navigation already exists. Keep the current route namespaces. The global eleven-entry sidebar remains C5.

### Prospecting: 13 primary tabs → five primary areas

| Primary area | Retained secondary keys / views | Canonical destination and behavior |
| --- | --- | --- |
| Inventory | `businesses` | `/dashboard/lead-ops?tab=businesses`. Inventory first; canonical business record links; privileged reconciliation in context, not full-screen blocks above rows. |
| Sources & Imports | `prospects`, `sources`, `imports`, `census` | Preserve corresponding `tab` values. Source Prospects remains a distinct source inventory; use paginated counts. CSV/XLSX wizards and execution ledger retain typed lineage. Census remains separately privileged. |
| Enrichment | `intelligence`, `provider-results`, new grouped `canonical` | `/dashboard/lead-ops?tab=canonical&canonicalView=pipeline`; same existing canonical reader/components. Provider Results remains intact. |
| Qualification & Staging | `staging`, `quality`, `pipeline`, `sfp`; authorized ready-audience context | Preserve `stagingTab=master-leads|promotion-review`. Distinguish vertical/region, completeness, consent/contactability, validation and dispatch pause. No legacy automatic approval or synthetic equality. |
| Program Health | `health`, `pilot` history | Existing worker/provider/canonical diagnostics with precise freshness; old pilot is read-only historical context. Current privileged capabilities remain explicitly guarded. |

**Canonical six views:** Pipeline → `pipeline`; Backlog → `backlog`; Records → `records`; Imports & Sources → `imports`; Exceptions → `exceptions`; Settings & Health → `health`. Each must round-trip in `canonicalView` on the grouped route and `view` on the standalone compatibility adapter. A direct URL and reload must select the same visible child and current reader. Backend source/config/health permissions do not broaden because they share a shell.

### Campaigns: six primary tabs → four primary areas

| Primary area | Retained secondary keys / views | Destination / owner |
| --- | --- | --- |
| Manage | `campaigns`, `sequences`; Campaigns / Readiness Intelligence subviews | Existing `/dashboard/outbound-center?tab=campaigns|sequences`; draft/content maintenance uses existing commands. Readiness is diagnostic and never starts backfill on entry. |
| Audience | `prospects` (Re-engagement); contextual qualified-ready link | `/dashboard/outbound-center?tab=prospects`. Dormant-contact scope is explicit; do not confuse it with Source Prospects. Ready queue remains the same authorized authority. |
| Delivery | `command`, `governance`; Pipeline / Outreach Sources / Signatures | Preserve these leaf selectors. Global outbound paused; signature editing is a real future-delivery change and must have supported permission/save/recovery tests. C5 deliverability/GHL configuration remain contextual links, not copied controls. |
| Results | `analytics`; Sequence Report context | Route to C4's `/dashboard/reporting?tab=outreach-analytics` with retained allowed report context. Keep `/dashboard/sequence-report` compatibility and existing honest runtime copy. |

Business detail stays `/dashboard/lead-ops/business/:id`. Contact is a separate typed destination. Identity Crosswalk and Contact Census remain admin-only. Agent-authorized standalone intelligence/queue routes must continue to work without being forced into a broader denied manager/admin shell. No new public/merchant route inheritance.

### Assigned route register — all 24 entrances inspected

The following is the current source guard/target inventory. Admin entrance observations do not certify alternate roles or mutations.

| ID | Current route pattern | Current target | Current guard | Required reconciliation |
| --- | --- | --- | --- | --- |
| R-031 | `/dashboard/outbound-center` | OutboundCenter | ProtectedRoute: admin/manager | Retain namespace and current guard; group by tables above. |
| R-147 | `/dashboard/canonical-enrichment` | CanonicalEnrichment | ProtectedRoute: admin/manager | Six-view standalone adapter into Enrichment; same reader. |
| R-032 | `/dashboard/prospects` | LegacyProspectsRedirect | ProtectedRoute: admin/manager | Retain namespace and current guard; group by tables above. |
| R-033 | `/dashboard/prospects/import` | ProspectImport | ProtectedRoute: admin/manager | Retain namespace and current guard; group by tables above. |
| R-034 | `/dashboard/lead-imports` | LegacyLeadImportsRedirect | ProtectedRoute: admin/manager | Retain namespace and current guard; group by tables above. |
| R-035 | `/dashboard/master-lead-database` | LegacyMasterLeadDatabaseRedirect | ProtectedRoute: admin | Retain namespace and current guard; group by tables above. |
| R-036 | `/dashboard/campaigns` | /dashboard/outbound-center?tab=campaigns | legacy alias; destination guard applies | Retain namespace and current guard; group by tables above. |
| R-039 | `/dashboard/acquisition-hub` | /dashboard/outbound-center?tab=analytics | legacy alias; destination guard applies | Compatibility to C4 shared outreach Results; preserve allowed context. |
| R-042 | `/dashboard/sequences` | /dashboard/outbound-center?tab=sequences | legacy alias; destination guard applies | Retain namespace and current guard; group by tables above. |
| R-043 | `/dashboard/lead-gen` | LeadGenCleaner | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries | Retain namespace and current guard; group by tables above. |
| R-044 | `/dashboard/lead-intelligence` | LegacyLeadIntelligenceRedirect | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries | Retain namespace and current guard; group by tables above. |
| R-046 | `/dashboard/outreach` | /dashboard/outbound-center?tab=command | legacy alias; destination guard applies | Retain namespace and current guard; group by tables above. |
| R-047 | `/dashboard/outreach-command` | /dashboard/outbound-center?tab=command | legacy alias; destination guard applies | Retain namespace and current guard; group by tables above. |
| R-048 | `/dashboard/lead-engine` | LegacyLeadIntelligenceRedirect | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries | Retain namespace and current guard; group by tables above. |
| R-049 | `/dashboard/lead-command-center` | LegacyLeadCommandCenterRedirect | ProtectedRoute: authenticated dashboard roles; merchant/partner boundaries | Retain namespace and current guard; group by tables above. |
| R-106 | `/dashboard/cold-leads` | /dashboard/outbound-center?tab=prospects | legacy alias; destination guard applies | Retain namespace and current guard; group by tables above. |
| R-109 | `/dashboard/outreach-hub` | /dashboard/outbound-center | legacy alias; destination guard applies | Retain namespace and current guard; group by tables above. |
| R-129 | `/dashboard/data-quality` | LegacyDataQualityRedirect | ProtectedRoute: admin/manager | Retain namespace and current guard; group by tables above. |
| R-134 | `/dashboard/contact-census` | ContactCensus | ProtectedRoute: admin | Privileged context; never inherit broader shell access. |
| R-137 | `/dashboard/lead-ops/business/:id` | BusinessDetailPage | ProtectedRoute: admin/manager | Canonical business namespace; restore typed list context. |
| R-138 | `/dashboard/lead-ops` | LeadOpsCenter | ProtectedRoute: admin/manager | Retain namespace and current guard; group by tables above. |
| R-139 | `/dashboard/identity-crosswalk` | IdentityCrosswalk | ProtectedRoute: admin | Privileged context; never inherit broader shell access. |
| R-140 | `/dashboard/outreach-queue` | OutreachQueue | ProtectedRoute: admin/manager/agent | Same ready-audience authority; preserve agent standalone access. |
| R-142 | `/dashboard/sequence-report` | SequenceReport | ProtectedRoute: admin/manager | Results context; retain corrected runtime-state wording. |

### Original 28 panel rows: preserve lineage and add current dynamic coverage

All 13 Lead Ops selectors and all six outer outbound selectors were clicked. The remaining historical rows are mapped below. A visited selector is not automatically a settled child/API/action pass. Explicit defects and settled reads are recorded in Sections 2–3. Current canonical six views, upload continuations, Human Review pagination, business/contact navigation and new overlays are additions to this historical register, not substitutions for it.

| Historical ID | Retained panel | Required location | October 19 evidence limit |
| --- | --- | --- | --- |
| T-001 | Campaigns / tab | Campaigns → Manage | Selector visited; action/role closure requires protected fixture receipts. |
| T-002 | Sequences / tab | Campaigns → Manage | Selector visited; action/role closure requires protected fixture receipts. |
| T-003 | Governance / tab | Campaigns → Delivery | Selector visited; action/role closure requires protected fixture receipts. |
| T-004 | Re-engagement / tab | Campaigns → Audience | Selector visited; action/role closure requires protected fixture receipts. |
| T-005 | Analytics / tab | Campaigns → Results | Selector visited; action/role closure requires protected fixture receipts. |
| T-027 | Businesses / hub-tab | Prospecting → Inventory | Selector visited; action/role closure requires protected fixture receipts. |
| T-028 | Source Prospects / hub-tab | Prospecting → Sources & Imports | Selector visited; action/role closure requires protected fixture receipts. |
| T-029 | Imports / hub-tab | Prospecting → Sources & Imports | Selector visited; action/role closure requires protected fixture receipts. |
| T-030 | Staging & Promotion / hub-tab | Prospecting → Qualification & Staging | Selector visited; action/role closure requires protected fixture receipts. |
| T-031 | Sources / hub-tab | Prospecting → Sources & Imports | Selector visited; action/role closure requires protected fixture receipts. |
| T-032 | Census / hub-tab | Prospecting → Sources & Imports | Selector visited; action/role closure requires protected fixture receipts. |
| T-033 | Intelligence / hub-tab | Prospecting → Enrichment | Selector visited; action/role closure requires protected fixture receipts. |
| T-034 | Data Quality / hub-tab | Prospecting → Qualification & Staging | Selector visited; action/role closure requires protected fixture receipts. |
| T-035 | Inbound Operations / hub-tab | Prospecting → Qualification & Staging | Selector visited; action/role closure requires protected fixture receipts. |
| T-036 | South Florida Prospecting / hub-tab | Prospecting → Qualification & Staging | Selector visited; action/role closure requires protected fixture receipts. |
| T-037 | Provider Results / hub-tab | Prospecting → Enrichment | Actual Provider Results panel mounts; prior broken-tab claim not current. |
| T-038 | 🧪 Paid Pilot (Legacy) / hub-tab | Prospecting → Program Health / Legacy | Selector visited; action/role closure requires protected fixture receipts. |
| T-039 | Enrichment Program Health / hub-tab | Prospecting → Program Health | Selector visited; action/role closure requires protected fixture receipts. |
| T-238 | Campaigns / nested-tab | Campaigns → Manage | Selector visited; action/role closure requires protected fixture receipts. |
| T-239 | Readiness Intelligence / nested-tab | Campaigns → retained nested section | Selected and settled: Failed to load readiness statistics; F01 open. |
| T-240 | Census / nested-tab | Prospecting → retained nested section | Selector visited; action/role closure requires protected fixture receipts. |
| T-241 | Reconciliation / nested-tab | Prospecting → retained nested section | Selected; reconciliation controls visible; no run started, no proposal mutation. |
| T-249 | Provider Results / tab | Prospecting → Enrichment | Actual Provider Results panel mounts; prior broken-tab claim not current. |
| T-250 | Master Leads / nested-tab | Prospecting → retained nested section | Selector visited; action/role closure requires protected fixture receipts. |
| T-251 | Promotion Review / nested-tab | Prospecting → retained nested section | Selected; empty-state view rendered; no promotion submitted. |
| T-259 | Pipeline / nested-tab | Campaigns → retained nested section | Selected and settled; read-only diagnostics observed; cohort/error corrections remain. |
| T-260 | Outreach Sources / nested-tab | Campaigns → retained nested section | Selected and settled; read-only diagnostics observed; cohort/error corrections remain. |
| T-261 | Signatures / nested-tab | Campaigns → retained nested section | Selected; three signature presentations visible; Edit/Save not submitted. |

## 5. Shared data contract: exact meanings must travel with the UI

| UI concept | Existing read/authority destination | Required meaning / correction |
| --- | --- | --- |
| Canonical production contacts/businesses | `canonical-enrichment-status` service and existing status DTO | Production record scope; preserve historical-work qualifier. No all-contact inventory substitution. |
| Business mapped/unresolved/excluded | Effective business vertical SQL in that service | Vertical classification, not affiliation; F04 labels. |
| Business/contact affiliation | Existing verified business-link facts/coverage reader | Candidate ≠ Company graph ≠ verified canonical link. Keep namespace/evidence/time. |
| Source prospect total | Existing prospects list/count route | Server-filtered total; page loaded count separate; F06. |
| Active/open sales deals | Existing A-approved deal summary definition | Same statuses, pipeline, test/archive exclusion, actor scope and as-of as matching Dashboard measure; otherwise label broader inventory. |
| Sunbiz enrichment/provider counters | Existing raw source/program readers | Entities/attempts/results, never unique validated people or successful sends. |
| Email validity/current eligibility | Existing exact-email receipt/qualification authority | Email value, age/version, source, current validity and policy qualification distinct from legacy `active`. |
| Intake rows | Upload execution ledger | Immutable source row disposition accounting; executions and file hashes explicit. |
| Current upload fulfillment | Existing later link/receipt/preparation/native readers | Distinct contacts, links, receipts and downstream effects keep separate units. No row total used as delivery total. |
| Local sequence/enrollment state | Sequence command and report owners | Local status/held/paused counts; neither native running nor email delivered implied. |
| Capacity | Existing configured campaign limit + sender/runtime facts | Configured limit, effective capacity and pause separate; unknown capacity disables unsupported claims. |
| GHL incoming | Actual incoming event/receipt authority | Enabled/configured and recent successful incoming receipt separately observed; stale legacy heartbeat is insufficient. |
| Native/provider completion | Existing durable result/receipt owner | Requested/accepted/queued/dispatched/unknown/completed/failed are separate. No HTTP success, billing change or audit-only row treated as completion. |

Each shared metric needs a documented DTO/source predicate, unit, cohort ID, exclusions, actor scope, as-of and availability. Reuse the authority rather than rebuilding SQL in React. Add fixture checks at reader/consumer boundaries; do not assert unrelated cohorts must match. Read errors may preserve clearly marked prior data only within the same authorized scope.

## 6. Exact Liberty design and UI implementation plan

This is a code-grounded implementation prescription, not a promise of “100% premium” without rendered acceptance. Actual source authority: `client/src/styles/crm-theme.css`, `client/src/components/crm/CrmPresentation.tsx`, `client/src/components/ui/*`, employee CRM context and the existing DashboardLayout. Use their actual exports/props; no replacement design system or public CSS rewrite.

### Colors, typography and tokens

Values below are HSL triples consumed through the existing semantic variables; do not paste them as unrelated page-local colors.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` | `40 33% 98%` | `222 47% 11%` | Employee canvas |
| `--foreground` | `222 47% 11%` | `210 40% 98%` | Primary text |
| `--card` / `--popover` | `0 0% 100%` | `222 47% 10%` | Surface/portal |
| `--primary` | `222 47% 11%` | `210 40% 98%` | Primary action; existing inverse foreground |
| `--accent` | `221 78% 48%` | `217.2 32.6% 17.5%` | Selection/surface accent; charts use own token |
| `--brand-red` | `0 72% 47%` | `0 70% 55%` | Liberty identity accent, restrained rule/indicator |
| `--muted-foreground` | `215 16% 47%` | `215 20.2% 65.1%` | Supporting text, with measured contrast |
| `--border` | `214.3 31.8% 91.4%` | `217.2 32.6% 17.5%` | Surface separation |
| `--crm-control-border` | `215 16% 47%` | `215 20.2% 65.1%` | Input boundary |
| `--ring` | `222 47% 11%` | `212.7 26.8% 83.9%` | 2px focus outline, 2px offset |
| `--stat-positive` / `--stat-negative` | `152 52% 36%` / `0 66% 48%` | `152 45% 50%` / `0 72% 62%` | Semantic indicators with text/icon; not color alone |
| `--crm-danger-surface` / foreground | existing brand-red / white | existing destructive / white | Use existing scoped danger mapping; do not globally revert the measured destructive-text correction |
| Chart series 1–5 | existing blue / green / red / navy / slate tokens | existing dark variants | Labels/markers/dashes and accessible data table |

- **Fonts:** IBM Plex Sans existing local 400/500/600/700 faces for all operational typography. IBM Plex Mono 400 for record/execution identifiers and small technical metadata, **not monetary or ordinary metric values**. Use tabular numerals with Plex Sans for counts/amounts.
- **Title:** 24px / 32px / 600; **section:** 18px / 24px / 600; **body:** 14px / 20px / 400; **label:** 12px / 16px / 500; **metric:** 28px / 32px / 600. Inputs on narrow screens use existing 16px rule.
- **Spacing:** `--crm-space-1…6` = 4, 8, 12, 16, 24, 32px. **Controls:** 44px minimum target height, 6px radius. **Surfaces:** 8px radius. Use current card/elevated shadows; elevated shadow only for overlays. Do not add gradients, pill-shaped card stacks or multiple oversized heroes.

### Layout and information hierarchy

| Surface | Exact prescription |
| --- | --- |
| Shared shell | Preserve existing 256px expanded / 48px collapsed sidebar geometry and 56px header; final global destinations stay C5. Content max-width 1,280px. Mobile drawer `min(288px, viewport − 32px)` only where supported by the existing shell. |
| Page gutters | One CrmPage owns 12px padding below 640px, 24px at/above 640px. Nested child panels have no second main gutter. Card padding 16px, section gap 24px, compact internal gap 8–12px. |
| Page order | Header → five/four area navigation → secondary selector → optional scoped summary rail → worklist toolbar → useful worklist → pagination. Advanced diagnostics/history belong below or in context, not above all rows. |
| Header actions | One primary, up to two secondary, then actual accessible More dropdown. Disabled controls show a specific capability/pause reason. No clickable-looking inert badges. Read-only view has no misleading mutation promise. |
| Prospecting Inventory | Search/filter toolbar and first useful rows visible without scrolling past matching/backfill/census operations. Up to five relevant scoped metrics. Name opens canonical business record; external domain clearly external. |
| Worklist toolbar | Wide search minimum 240px, 44px fields, 8px control gap; supported server search debounce 250ms; mobile full-width search and accessible filter drawer. Unique label/input IDs. Filter change resets cursor and selection. |
| Worklists | Existing sticky header and bounded table viewport `min(640px,70dvh)`; 44px header/interactive row targets, body cells 10px vertical/12px horizontal. Default page 50 only where API supports it; 25/50/100 choices only when actually supported. No fake client slicing of a capped response as global pagination. |
| Narrow content | At available content width <768px, existing container-based worklist cards replace wide tables; primary identity, status, owner/next step and actual actions remain. Do not hide a broken layout with body overflow clipping. |
| Business detail | One record header with canonical identity/current classification, owner, next safe action and Back. At >=1280px: `minmax(0,1fr) + 320px` context rail, 24px gap; 768–1279 stacked; narrower cards. Remove arbitrarily numbered two-column field ordering. |
| Forms | One-column by default; meaningful pairs only on wide panels. Labels above fields, help/error adjacent, required markers explained. Preserve drafts on recoverable errors; do not save without loaded authority/version. |
| Drawers/dialogs | Existing C1 wrappers/Radix primitives; target 480px desktop drawer/full mobile, 560px standard form dialog where supported. Scroll body, visible action footer, close/cancel/focus return/escape tested; destructive confirmation only for real destructive commands. |
| Metrics | At most five primary metrics per rail. Scope/source/as-of/availability visible through ScopedMetricStrip. No metric-wide Mono font. Avoid decorative charts that duplicate one count. |
| Long identifiers | Plex Mono, wrapping/copy affordance with success/error feedback; do not force horizontal body overflow. Do not expose secrets/provider credentials. |
| Motion | Existing 140ms transitions; honor existing reduced-motion rules. No animation delaying controls or receipt visibility. |

### Per-area UI changes to ship

- **Inventory:** compact useful business list, actual record links, explicit candidate vs verified linkage, current classification, visible filter scope; advanced matching/census tools removed from the default top block.
- **Sources & Imports:** source registry + source prospect list + imports/census secondary navigation; guided upload/mapping/validation/result recovery; execution detail with immutable row accounting and later fulfillment in separately labeled sections.
- **Enrichment:** Canonical flow is the main shared context, with six URL-selected views; Provider Results/Intelligence remain reachable. Read failures are local to a panel. Current-email receipts and raw source outcomes are distinct.
- **Qualification & Staging:** criteria dimensions appear separately, supported preview/command actions have exact intended effect and durable readback, ready state does not imply send permission. Master Leads/Promotion Review remain separate leaf views.
- **Program Health:** precise source/worker freshness, current supported capabilities, legacy pilot/history collapsed/read-only. No startup/provider activation on mount.
- **Campaign Manage:** useful campaign/sequence table or bounded cards, draft/version/status/source, working schema-correct maintenance, preserved advanced step configuration, real create recovery, current taxonomy labels.
- **Audience:** re-engagement is labeled dormant-contact scope, filters count server-authorized audience, preview explains exclusions without making a new eligibility authority.
- **Delivery:** one clear paused status, reason/capability hierarchy, configured vs effective capacity, supported signatures, current command/governance facts, contextual privileged integrations.
- **Results:** share C4 report implementation and controls, preserve context/deep links and honest local/native/delivery distinctions. Do not copy charts/queries into C3.

### State and interaction contract for every area

Loading; successful empty; no filter match; denied; unavailable; stale same-scope data; partial/degraded; pending command; version conflict; durable success; accepted/unknown reconciliation must be visibly distinct. Error states offer the correct Retry; pending buttons prevent duplicate submission; controls have keyboard focus and accessible names. A click must reach its intended handler/entity, and success must survive refresh. View entry never runs backfill, enrichment, promotion, release or dispatch.

## 7. Minimal safe implementation sequence inside #2075

Do not split this into a new audit ladder or rebuild already-owned backend systems. Use four coherent implementation groups with explicit checkpoints; narrow backend amendments stay with their current owners.

1. **Correct contracts and data truth first:** F01–F07, F11's misleading action and F12 taxonomy/capacity. Keep full strict schemas and existing commands. Capture exact read-failure root causes, make independent sections resilient, then test sequence persistence and post-effect reconciliation. Do not put a polished shell over broken Save/read contracts.
2. **Add C3 destination codec and query adoption:** F08–F09, typed six-view state, compatibility routes and actor/cancellation/lazy loading. Maintain single shared readers and existing role wrappers. Existing C1/C2/C4 suites remain green.
3. **Apply the Liberty shell and useful interiors:** F10–F14 across the exact five/four areas. Preserve every retained leaf/action, simplify above-fold hierarchy, actual More menus, useful worklists, record context and guided imports. C5 owns global sidebar cutover; C4 owns reports; C2 owns shared contact shell.
4. **Prove and package:** F15–F16; reconcile every original assigned row plus new controls, run isolated mounted/browser/role/fault tests and supported final build/checks, then record exact candidate/serving receipts and outstanding external evidence. Update the specification and Go Live ledger after the implementation and its audit.

If a backend reader/command owner must make a repair, identify exact code/acceptance and keep the safe independent UI work moving. An unavailable third-party provider can leave that receipt unverified; it does not justify fabricating success or marking the entire workspace done.

## 8. Gate checks and stop conditions

### Required acceptance register

For every route/view/control record: original ID (or new C3 ID), route/state, role, fixture identity/ownership, visible label, intended entity/action, request/handler, expected permission/pause, cancel result, success receipt/readback after refresh, retry/replay behavior, conflict/error branch, responsive/keyboard outcome, evidence path/time and verdict. Use **pass / confirmed defect / denied as designed / unavailable / not exercised**, never a blanket pass for a mounted page.

| Gate | Evidence required before C3 full completion |
| --- | --- |
| C3-G01 source/serving identity | Fresh main and serving identity, source-tree relationship, final candidate hashes/build recipe and changed-file scope; public-site smoke retained. |
| C3-G02 destination compatibility | All 24 assigned patterns; 28 historical rows; all six canonical views; new dynamic controls and alias/query/hash/back/forward/reload/invalid/duplicate-param cases. |
| C3-G03 permissions/actor boundaries | Admin, manager, agent, merchant, partner, unauthenticated; role/account changes; aggregate endpoints and retained standalone exceptions; no widening to satisfy UI. |
| C3-G04 real actions | Actual sequence/campaign create/edit/save/archive/cancel, supported signatures, import wizard, business/context action and authorized existing lifecycle controls in owned fixtures; requests plus durable readback, not only clicks/toasts. |
| C3-G05 failure/consistency | F01 read failures resolved or truthfully scoped; F03 post-commit audit/unknown receipt fixtures; schema DTO, config preservation, pagination >500, error-to-empty, late response and actor-switch cases. |
| C3-G06 data provenance | Same-metric matching at common scope/as-of; intentional cohort differences labeled; current-email facts and intake/native lineage distinguished; October ledger bytes/hash/native bridge evidence supplied by its authority. |
| C3-G07 responsive/a11y | Widths 320/390/768/1280/1440, light/dark, real 200% zoom, keyboard traversal/activation, focus return/traps, screen-reader names/status, measured text/control contrast, reduced motion and no body overflow. Current audit only exercised desktop light. |
| C3-G08 performance | Matched seeded data/network/device/cache conditions; useful worklist target <=2.5s and local interaction <=200ms where the task defines them; measure rather than infer from source/no errors. Heavy query budgets and inactive polling verified. |
| C3-G09 backend safety | Current guarded certification suites on owned disposable DB/Redis; test provider-deny/pause before any mutation suite. General native guard pass is not import-to-native bridge completion. |
| C3-G10 final CI/build/recovery | Supported Node/npm, unchanged intended lockfile, required manifest/CI/predeploy checks, final production candidate, recovery/rollback evidence from an authorized safe environment; no inference from the local build alone. |
| C3-G11 serving walkthrough | Published candidate verified by exact identity, then real role/control/read/error/mobile matrix evidence against that serving build; incoming GHL receipt current and outbound paused. |
| C3-G12 ledger closure | Original finding/repair lineage reconciled, no stale claim promoted to current defect, outstanding entries named with owner/evidence limit; C5/D/Stage4 boundaries preserved. |

### Kill lines — stop the affected operation, not independent safe work

- Any outgoing email/SMS/sequence unpause, provider purchase/run, enrollment/release/send test in production, or clearing a real queue: stop; these are not authorized by this audit or a visual refactor.
- Incoming GHL disabled as a shortcut to outbound safety: stop and separate capabilities; do not alter its switch here.
- A browser view triggers writes/providers/backfill on mount: stop that path and repair it.
- A strict schema, authorization guard, current receipt requirement, version/replay protection or existing reviewed native installation guard must be weakened to make a UI action pass: stop and repair the caller/contract instead.
- A failed/unknown read is about to be shown as zero, no records, not validated or not released: stop that presentation; use explicit availability.
- An effect may have committed but a response/audit failed: read/reconcile the same intent before retry; no new random intent.
- A test's DB/Redis/fixture ownership or provider-deny boundary is unproven: do not execute the mutating suite.
- A public-site/global CSS rewrite, schema push, arbitrary startup DDL, full dependency upgrade, global sidebar cutover or duplicate C4 report is introduced into C3 without scope need: stop/reduce to the existing owner and safe narrow change.

### Practical source checks for Replit preflight

These are discovery checks, not tests that prove runtime behavior. Use `rg -n` against the current checkout, then inspect each match. Do not require zero matches for intentional guarded backend authority.

```bash
rg -n 'type ViewKey|activeView|canonicalView|refetchInterval' client/src/pages/dashboard/CanonicalEnrichment.tsx client/src/pages/dashboard/CanonicalBacklog.tsx
rg -n 'status: form.status|totalSteps|originalStepIds|config:|res.ok' client/src/pages/dashboard/Sequences.tsx
rg -n 'createSequenceSchema|totalSteps|grouping-meta|readiness-stats|ab-tests' server/routes/campaigns.ts
rg -n 'limit=500|filteredProspects|total' client/src/pages/dashboard/Prospects.tsx
rg -n 'getContactAggregateStats|getDealAggregateStats|catch' server/routes/imports.ts
rg -n 'enrich-free|enrichMutation|nextProviderPlan' client/src/pages/dashboard/LeadOps/BusinessDetailPage.tsx server/routes/lead-ops.ts
rg -n 'useCrmQuery|useCrmInfiniteQuery|transitionProtectedActor' client/src/hooks client/src/lib/queryClient.ts
rg -n 'retainedSelectionUrl|reporting|outbound-center|lead-ops' client/src/lib/crm-destination-state.ts
rg -n 'isAdoptedPage|dashboard-main' client/src/pages/DashboardLayout.tsx
rg -n 'CrmPageHeader|CrmActionMenu|WorklistToolbar' client/src/components/crm/CrmPresentation.tsx
rg -n 'stage3-c[124]|intake-review-pages|canonical-release-authority|first-party-native-install' scripts/ci-suite-manifest.ts scripts/certification
```

Resolve moved paths rather than assuming these anchors are immutable. Run the supported installed toolchain's current package/manifest commands. Required existing checks include `scripts/test-stage3-c1-foundation.ts`, `scripts/test-stage3-c2-contracts.ts`, `scripts/test-stage3-c4-contracts.ts`, `scripts/ci-suite-manifest.ts --check`, project typecheck and production build. Add meaningful C3 behavior/codec suites to the existing runner; do not manufacture green source-only assertions that mirror implementation.

## 9. Portable message / controlling amendment for Replit

> Update existing Task #2075 in place as the C3 implementation task. Apply this October 19 report as its controlling current-source correction; keep old appendices for history, clearly superseded where inconsistent. Do not create another audit-only task or duplicate C1/C2/C4/backend authorities.
>
> Current source is ea7955e7 (same source tree as serving a0e1c10a). Source/client parity, supported local typecheck/build and inherited C1/C2/C4 checks are established to the limits in Section 1. They are not C3 functional acceptance. Provider Results, the canonical route, the C4 A/B route and explicit production build mode are current repairs; preserve them. Human Review first/next reads and a selected upload-ledger continuation worked; do not reopen historical blanket failures without new evidence.
>
> Repair F01–F08 and F11/F12 functional/data contracts before or alongside the design: current Backlog 503 and readiness read failure; Sequence create/edit strict-schema mismatch, config/ID preservation and partial-create recovery; post-commit audit uncertainty; classification/link/current-email semantics; cohort/access truth; >500 server pagination; error-to-empty branches; actor-aware cancellation/lazy reads. Obtain exact logs for read root causes; do not invent them, increase timeouts blindly or weaken guards.
>
> Deliver F09–F14 through the existing Liberty C1/C2 components: five Prospecting areas and four Campaigns areas, all 24 route patterns / 28 historical rows retained, six URL-addressable canonical views including Backlog, exact token/typography/spacing/layout in Section 6, one shell/H1, useful inventory first, contextual admin tools, accurate provider-plan actions, current versioned taxonomy, guided import lineage, read-only legacy history and shared C4 results. Use actual component APIs; CrmActionMenu is not an overflow dropdown and PageHeader has no overflow prop.
>
> Preserve outbound pause, incoming GHL independence, existing current release authority/limits/version/replay/native-install guards, record namespace and original permissions. No provider activation, legacy approval restoration, arbitrary schema/startup changes, public CSS refactor, new global sidebar or duplicate reporting/query authority.
>
> Execute the four implementation groups and C3-G01–G12 gates with owned disposable mutations and actual control/request/durable-readback evidence. Register C3 behavior suites in the current manifest and retain passing inherited checks. Report each unexecuted role/mobile/native/performance/recovery check honestly. Update the canonical specification and Go Live ledger. Full C3 completion requires those receipts; a merge or polished screenshot alone is insufficient.

## 10. Audit limits and ledger disposition

This audit completed current-source analysis, a real signed-in administrator desktop walkthrough, isolated actual sequence-schema checks, supported dependency installation, inherited C1/C2/C4/manifest checks, whole-project typecheck, production build/integrity and selected serving-client parity. It did not silently substitute audit-only observation for functional command completion.

No application source, DB, startup config, external provider, outbound gate or production record was changed. No full-scope C3/C4/C5/D acceptance is issued. Admin visibility is not a substitute for alternative-role testing. Current incoming GHL transport/event processing, all native/provider receipts, five-file original-byte/hash reconciliation, mutating action readback, matched performance, phone/dark/zoom matrix and recovery remain explicit evidence gates with owners, not newly confirmed bugs by default.

The Go Live sequence remains **10 stages**. Stage 3 remains OPEN / NOT CERTIFIED; C3 implements this scope, C5 owns final workspace/sidebar consolidation and D performs integrated CRM closure. Stage 4 owns broad prospecting/provider/native outbound end-to-end proof; Stage 9 owns final frozen-SHA platform/security/release certification. This audit adds ledger Section 36 and consolidated-specification Section 28, preserving the 95 original source entries and their overlap/repair lineage.
