# Stage 3 C5 — Administration, Resources and final CRM shell: evidence and handoff

Candidate: working tree on `f1fb96a3` plus the C5 changes (uncommitted at the time of writing; the task merge commit is the identity). Verdict: **NOT READY** for final acceptance (see "Remaining owners"). Implementation is complete in source. Real-browser role-session shell smoke, a data-bearing panel suite on a disposable migrated database (including readiness, compiled style, responsive overflow, labels and GHL Settings states) and a matched client performance comparison passed (below). A remaining-panel walk, a live role negative-request suite and a production-sized GHL Settings recheck (below) also passed. Still not run: a real screen reader or other assistive technology, live-app (production or dev-provider) checks, full roster, deployment.

## What was executed on this candidate

| Check | Result |
| --- | --- |
| Whole-project `tsc --noEmit`, Node heap 8 GiB | clean |
| `scripts/test-stage3-c1-foundation.ts` | 339 assertions passed (source/unit only) |
| `scripts/test-stage3-c3-contracts.ts` | 211 assertions passed |
| `scripts/test-stage3-c4-contracts.ts` | passed |
| `scripts/test-ssr-style-isolation.ts` | passed, 120 rules below application layers |
| `scripts/test-stage3-c5-route-inventory.ts` | passed (real Express 5 registration, nested mounts, inherited guards, unknown stays unknown, synthetic false method) |
| `scripts/test-stage3-c5-diagnostics.ts` | passed (queue-holds DTO decoder, readiness registry, bounded audit reader, operator card wording) |
| `scripts/test-stage3-c5-resources.ts` | passed (codec selectors, area/role fallback, lazy children, ResourcesNav, reader states, JSON decoding) |
| `scripts/test-stage3-c5-sidebar.ts` | passed (exact order, role filtering, every target a registered route whose guard admits the role) |
| `scripts/test-stage3-c5-mounted.ts` | passed (`GhlSettings.test.tsx`, jsdom, injected fetch) |
| `scripts/test-stage3-c5-browser.ts` (disposable runner, compiled client, real admin/manager/agent sessions, private Chromium) | passed, 76 checks; receipt `docs/certification/stage3-c5/browser/receipt.json`. Scope: every role-visible sidebar target loads on its route without redirect, exact order and hrefs per role, correct highlighted destination, Administration area children, manager forbidden-area fallback and admin-only child not mounted, no uncaught exceptions, no provider egress. Every non-session `/api` route answered 501 in this fixture, so this is shell/route/role proof, not data-bearing panel proof |
| `scripts/test-stage3-c5-panels.ts` (disposable runner, migrated schema, real admin session, real handlers for permissions/queue-holds/readiness/knowledge, GHL incoming-sync stub) | passed, 137 checks; receipt `browser/panels-receipt.json`. Readiness ran all 26 registered probes with no missing-column/table failure (empty disposable DB: 10 pass / 13 warn / 3 fail is the fixture's data, not a production reading). Permissions listed 290 of 290 registered routes. Queue Holds rendered the real DTO with pause facts and issued no write. Knowledge Admin honoured `?tab` and wrote it back; its dialog fields all carry programmatic labels and the editor measured 190px (was 58px). Compiled style at 1280/768/390: IBM Plex Sans, no horizontal overflow, 44px tab targets, no unnamed visible buttons or alt-less images. GHL Settings mounted in a real browser for ready/previewing/running/error/timeout: card reached in under 1.1s each, worst animation-frame gap 23ms, no uncaught exceptions; the stall was **not reproduced**, cause unclaimed. In previewing/running the card issues about 33 status reads and 16 step calls in 8s because the stub never advances the run; that is the existing, unchanged continuation workflow |
| `scripts/test-stage3-c5-walk.ts` (disposable runner, migrated schema, real persisted sessions for admin, manager, agent, affiliate, merchant and partner; real handlers for admin/knowledge/documents/permissions/integrations/content/information-flow/sdr; every other source answers 501) | passed, 709 checks; receipt `browser/walk-receipt.json`. Walked: all 46 Operator views (route, view key in URL, one h1, no error boundary, no uncaught exception, no unnamed control, no overflow); the five Settings Integrations selectors standalone and inside Administration (URL write, reload restore, no non-GET request); Content children including Blaze, Playbooks and Training children; manager Content and manager-visible controls (no admin-only endpoint answers 401/403); agent, affiliate, merchant and partner access to every C5 destination (no admin/manager workspace, no admin data request; merchant lands on the merchant portal, partner on the partner portal, neither shows the employee sidebar); light and dark theme with WCAG 2.x contrast computed on 3,322 rendered text elements per theme across nine pages (0 failures after fixes; image/gradient backgrounds and disabled controls excluded, none occurred); keyboard ArrowRight on the Administration tab list, visible focus indicator, focus retention; Chromium accessibility tree on seven pages (no unnamed interactive node, one level-1 heading, no skipped level, main/navigation/banner landmarks, selected tab); real 200% Chromium zoom (device pixel ratio 2, 720px CSS width) on six pages with no horizontal overflow. Data was real only for the registered handlers; Operator views whose sources answered 501 were proven to show an unavailable state rather than crash, not to show production data |
| `scripts/test-stage3-c5-browser.ts` (re-run with the per-area walk) | passed, 85 checks (was 76). Adds all five Administration areas per role: admin mounts each area's children (users-access: agents/permissions/users; integrations: ghl/info-flow/integrations; operational-controls: automations; data-audit: audit-log/consent; release-readiness: gate-result/pci); manager mounts only permitted children per area (users-access: agents; integrations: ghl/integrations; data-audit: consent; release-readiness: pci) and `operational-controls` shows the selection issue and falls back to `consent`; agent landing on `/dashboard/admin-hub` does not mount Administration (lands on `/dashboard/my-day`) |
| `scripts/test-stage3-c5-role-negative-requests.ts` (disposable runner, real route modules/guards for admin, knowledge-admin, documents, permissions-audit, integrations, content, information-flow, sdr and incoming GHL sync; persisted admin/manager/agent sessions over HTTP) | passed, 27 checks; receipt `browser/role-negative-receipt.json`. The registered-route inventory lists 135 admin-only method/path pairs: manager 135/135 and agent 135/135 answered **403 from the role guard** (`Requires role` or `Admin access required`), unauthenticated 135/135 answered 401. 89 admin+manager GET routes admit the manager and 403 the agent. Admin is admitted (200) to route-permissions, queue-holds, queue-holds backlog-preview, incoming-sync status, processor-activation-snapshots and SDR sending identities, which manager and agent get 403 on. Manager and agent also get 403 on incoming-sync preview, step, execute and control. Only routes in the registered modules are covered |
| `scripts/test-stage3-c5-ghl-stored-run.ts` (disposable runner, real incoming-sync handlers and service, persisted runs sized like the stored run, in-process fake of the GHL contact list, private Chromium with CPU profile) | passed, 23 checks; receipt `browser/ghl-stored-run-receipt.json`. **Stall not reproduced.** See "GHL Settings recheck" below |
| `scripts/test-stage3-c5-performance.ts` (explicit opt-in; matched pre-C5 client built from `1422503b` vs candidate, same API/DB/machine, cache disabled, 7 cold runs per page) | passed. Median ms baseline→candidate: dashboard 575→514, admin hub 500→359, knowledge base 311→311, permissions 335→218. Receipt `browser/performance-receipt.json`. Local loopback timings to first ready element, not production or network measurements |
| Production build (`script/build.ts` via `node --import tsx`) | passed locally, artifact `72343abc-59aa-4037-8cb3-36a4dd3e3f69`; not a stock CI or deployment pass |
| Suite manifest (`scripts/ci-suite-manifest.ts --check`) | valid; 212 mandatory entries = 201 at the starting HEAD + 11 new C5 suites (route inventory, diagnostics, resources, sidebar, mounted, browser smoke, panels, remaining-panel walk, role negative requests, GHL stored-run profile, and the explicit opt-in matched performance suite) (the report's 200 was measured at `ef643420`) |
| "Start application" workflow restart | starts cleanly; `/api/health` 200; `/dashboard/admin-hub` serves the SPA; `/api/admin/route-permissions`, `/api/admin/queue-holds`, `/api/admin/queue-holds/backlog-preview` return 401 unauthenticated |

## Role / negative-request matrix

Sidebar, route and Administration-area rows are browser-observed for admin, manager and agent sessions on a disposable fixture (shell only; APIs answered 501). Endpoint-level negative requests were exercised live against the real guards (role negative-request row above). The walk suite additionally exercised agent, affiliate, merchant and partner sessions against every C5 destination (see the walk row above).

| Subject | admin | manager | agent | unauthenticated |
| --- | --- | --- | --- | --- |
| Sidebar entries | 11 | 11 | 9 (no Campaigns, Administration) | not rendered |
| Administration selectors | all 11 | consent, pci, agents, integrations, ghl | no AdminHub route | route guard |
| Resources: Content, Knowledge Admin | yes | yes | disabled with reason (route guard unchanged) | route guard |
| Sending identities (SDR), workflow-ID PUT, seed, zerobounce auto-run PUT | write | 403 | 403 | 401 |
| Sending identities (`/api/admin/sending-identities` reads), zerobounce auto-run GET | yes | allowed (route guard is admin+manager) | 403 | 401 |
| Queue Holds, route-permissions, incoming GHL sync (status, preview, step, execute, control) | yes | 403 | 403 | 401 |

No backend handler was broadened. Manager and agent requests to all 135 registered admin-only endpoints were exercised live over HTTP and answered 403; unauthenticated answered 401. The sidebar/area/route cells are browser-observed; endpoint cells are HTTP-observed on the disposable fixture, not on production.

## GHL Settings recheck (stored run, real handlers)

Production read (read-only SQL) showed the active stored incoming-sync run is `ready`, phase `plan`, 3,994 sources and 3,994 plans, about 650 KB stored. The recheck persisted runs of that size (1.68 MB of JSON, 183 KB stored) in a disposable `system_settings` table and drove the real handlers and service from the compiled Integration Hub → GHL Settings page, with GHL contact pages from an in-process fake (no egress).

| Scenario | Page worst frame gap | Long tasks | Server event-loop max | Unrelated endpoint probe max | Calls |
| --- | --- | --- | --- | --- | --- |
| Persisted ready run, 8s (card mounted in 1.0s) | 20ms | 0 | 17ms | 5ms | 2 status reads |
| Real Preview from the card, 25s window (3,994 contacts scanned, planned, ready in 45.7s) | 119ms | 0 | 105ms | 30ms | 52 step, 53 status |
| Real Apply from the card, 45s window (440 of 3,994 contacts created on the disposable DB) | 35ms | 0 | 34ms | 18ms | 23 step, 23 status |

Browser CPU profile: 0.25 to 0.30 s busy in the 25s and 45s windows, 8162 ms sampled with 34 ms busy while idle on ready; top self time is animation-frame and fetch bookkeeping. A status read of the 3,994-contact run took 32 ms median (50 ms max) and returned 845 bytes; at 20,000 contacts (8.5 MB JSON) it took 156 ms median (380 ms max, 120 ms event-loop max).

Result: **not reproduced**. No cause is claimed and no code was changed. Observations that are not stalls: apply runs about 9.8 contacts per second (about 23 steps in 45 seconds, so roughly 7 minutes for 3,994 contacts) because each 20-contact step rewrites the whole stored run more than once; the card keeps polling every 3 seconds and chaining steps while a run is previewing or running. Not covered: the real GHL provider's latency and timeouts (20s per page), production data, a different browser, and production CPU contention. A live stall that depends on those is neither confirmed nor excluded.

## Cutover record (R10)

All eleven targets are `activated` in `client/src/lib/employee-sidebar.ts`: each target is a registered route whose guard admits the role (asserted by `test-stage3-c5-sidebar`) and whose C3/C4/C2 owner was left unchanged. Per-target smoke: each target was navigated in a real browser for each role that sees it (route stays, correct entry highlighted, no exceptions). Targets were not exercised with live data because the disposable fixture answers non-session APIs with 501; data-bearing acceptance remains with the owners below. A target is reverted to its legacy entrance by setting `status: "legacy"` with `legacyHref` and `blocker` on its entry (the test requires both).

Retained legacy entrances: Dev Mode (admin/manager) renders the previous groups as `LEGACY:` groups plus Lead Engine, Automation, Growth and System groups. Merchants keep the previous My Portal / Security shell. Footer keeps AI Advisor, Account security, My Leads (agents), Replay Tour and Sign Out. Nothing was deleted. Partners are reached through the C4 Merchant Operations navigation.

Rollback: the shell change is isolated to `client/src/lib/employee-sidebar.ts` and the render branch in `client/src/pages/DashboardLayout.tsx` (`renderEmployeeNav`); reverting those two files restores the previous sidebar without touching routes. Administration composition rolls back by reverting `AdminHub.tsx` and the `adminArea*` additions in `crm-destination-state.ts`. This is a source rollback plan, not an exercised rollback.

## Not run and not claimed

- Data-bearing acceptance of all 59 routes and 181 historical panels with production-like data. The walk used real handlers only where registered; other Operator sources answered 501 and were checked for an honest unavailable state, not for correct figures. Agent-facing destinations beyond the C5 routes were not walked.
- A real screen reader or other assistive technology. The accessibility checks are Chromium accessibility-tree and keyboard assertions; they do not replace NVDA, JAWS or VoiceOver. Mobile-device zoom, OS high-contrast mode and print were not run. Contrast is computed from rendered colors, not a certified audit tool.
- Defects the walk found and this task fixed: a Operator AI Health reader that treated a failed response as data and crashed; about twenty icon buttons, date/number inputs, file input and switches without accessible names across Operator views, Blaze and AI Learning Center; second `h1` on Operator views, Playbooks and Content (hubs now own the h1; `PageHeadingLevel` context for embedded `PageHeader`s, raw headings moved to `h2`); the dashboard Overview requested admin-only rep-activity endpoints for every role (now gated to admin/manager); low-contrast amber, yellow, muted and tile-value text on Queue Holds, Training, Settings Integrations and Operator tiles (light and dark). Earlier heading fix for the six measured C5 pages is retained.
- Live-app GHL Settings recheck against the real provider. The stored-run recheck used a fake provider on a disposable database; only a read-only production query of the stored run's size and state was made.
- Full pre-deploy roster: not rerun. The historical 161 of 197 (36 failed; 34 reproduce on baseline) stands and is not relabeled. Full CI stays FAILED through its owners.
- Native-object reconciler/migration 0348–0367 applied state on production, Reserved VM hosting, and publication remain unobserved. Incoming GHL stays enabled and outbound stays paused; nothing here changed either.

## Remaining owners

| Item | Owner |
| --- | --- |
| Per-role walk of every remaining agent-facing destination with production-like data | C5 acceptance run (follow-up task) |
| Real screen reader / assistive-technology pass | C5 acceptance (follow-up task) |
| 34 inherited roster failures + 3 fixture suites | their existing owners (C1/B browser suites, C4 baseline, provider-import-recovery, Serper memory, intake review pages) |
| Stage 4 provider proof, Stage 8 certification, Stage 9 native/release proof | their stages |
| GHL Settings behavior against the real provider's latency and timeouts (the production-sized stored-run recheck did not reproduce a stall) | C5 acceptance, only if a stall is observed again |

`actions.csv` marks every row's evidence level; only the sidebar/area shell rows are marked browser-tested (shell only); none is merged, deployed or live-observed.

## Workflow-ID guidance (review correction)

Sequence workflow IDs are reference-only; IDs for supported handoff workflows are read by `enrollInGhlWorkflow` at enrollment and that enrollment is skipped when the ID is missing. All GHL guidance, the activation diagnostic detail and `shared/ghl-ownership-guidance.ts` now state both classes. The activation row stays informational (no new outbound eligibility policy).
