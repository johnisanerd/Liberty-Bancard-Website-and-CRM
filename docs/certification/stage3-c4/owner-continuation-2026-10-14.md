# C4 owner-authorized implementation continuation — 2026-10-14

## Decision

**Implemented and verified in a separate branch; NOT merged, NOT published, NOT fully accepted.**

The owner authorized scoped implementation, branch push and merge/push only after required checks pass. Normal CI is still red on a failure reproduced on unchanged main. That gate is not waived. No new task ladder was created.

Main was freshly fetched and remained `85296699ec8d11f22750657dfe5ac34a8fd2577d`, the supplied audit baseline. The primary worktree's separate uncommitted intake work was preserved. All C4 implementation occurred in `.local/worktrees/c4-acceptance`, branch `codex/2074-acceptance-reconcile-20261014`.

## Exact compiled implementation identity

- Source: `401d7bdad4c76172736a9a76bb33b3fd7abfd216`.
- Local build ID: `b4ce8687-dad1-4c0f-9451-17572501279f`.
- Serving identity: `publish-build:b4ce8687-dad1-4c0f-9451-17572501279f` is the build artifact's identity, **not evidence of publication**.
- Source-input hash: `378495be79dd774d459635dd705e97d9fa10813a88dbfeedba94447729e1e958`.
- Recipe-bound input hash: `9cac4413f3cb3ac8a8fcccabc19a1313836ce52510351517ff38d42ce5c11854`.
- Complete emitted-output hash: `5d1d6a6d645a44ed282c8dc84d972bd86efde90ab826d295fc4bd035b8198ebe`.
- Node `v22.22.0`, npm `10.9.4`, production NODE_ENV, Vite production mode and production bundled server. Database/session/browser fixture runtimes remain test-mode and provider-denied.
- Merge SHA: **none**. The code identity above is not a merge or deployed-runtime identity.

## Scoped implementation and executed evidence

| Requirement | Implemented / executed | Qualification |
| --- | --- | --- |
| V1 | Literal A/B reader registered before numeric sequence detail; unchanged aggregation/auth/manager ownership. Real campaigns handlers added to fixtures. Populated A/B fixtures, numeric reads, admin/manager ownership, foreign-manager denial, agent/merchant/partner/anonymous denial and empty results exercised. | 309 named real-handler HTTP cases in the expanded C4 actions suite, including the new cases; not 309 individual UI action passes. Independent mounted A/B/campaign/message read faults retained separately. |
| V2 | Persistent Onboarding/Kickoff H1, subordinate board heading, employee-only 44px/focus/rail styling, labelled Portfolio search and Terminal ROI primary/secondary/privileged overflow actions. | Named heading checks and Portfolio geometry in light/dark at 320/390/768/1280/1440 passed. This does not certify every control's loading, contrast and keyboard state. C2 compact header and C5 final sidebar ownership unchanged. |
| V3 | Applications/Boarding status, Outreach child, Leaderboard metric/period use C1 typed URL authority; safe enum handling, duplicate normalization, issue disclosure, paging resets and retained legacy context. | Codec contracts cover allowed/invalid/conflicting values. Mounted reload/Back/Forward passed for Applications approved, Boarding approved, Outreach A/B and Leaderboard calls. This is not every metric/period/status/role combination. Existing Financial/Revenue/Health/Underwriting state retained. |
| V4 | Build-only production mode, actual toolchain/recipe receipt, recipe-bound integrity verification and separate test runtimes. | Whole-project typecheck, fresh production builds, dependency inventory, redacting artifact scan and candidate integrity passed locally. Clean locked installs and whole-project checks also executed in remote isolated jobs. Normal CI is separately required and remains red. |
| Required six suites | C4 actions, C4 mounted browser, C4 focused Health browser, C2 contact header, C2 postmerge browser and toast layout all executed and passed locally **and in remote run 38637895318** at the exact compiled implementation SHA. | Each used owned disposable infrastructure and fatal external transport denial. Browser includes performance/zoom evidence below. Six-suite success is not full-roster CI or full C4 acceptance. |
| Crosswalk/inventory | Original 39 route references × six fixture roles plus 70 admin panel references captured as 304 mounted surfaces. Current inventory has 7,023 repeated conditional control observations. | Inventory observations are **not action passes**: generated inventory retains untested verdicts. Shared/global chrome, repeated controls, inaccessible/unregistered sources and conditional state combinations must not be silently certified. |
| Named financial evidence | Nonempty stored $10.10 observation, exact recorded-period attribution, captured partner relation, unknown net/commission rather than zero, source-fault export suppression and actual Operations CSV/model metadata exercised. | Synthetic stored observations/local confirmation are not native settlement/payment proof. Not every financial child, currency, relationship, pagination/export and failure combination is certified. |

## Matched Portfolio performance, native zoom and bounded rollback

`performance-rollback.json` records fresh matched measurements, not historical timings. Both production clients use the same locked Node/npm dependencies, machine, owned API and 110 eligible synthetic businesses. Fresh private Chromium profiles disable HTTP cache; network is loopback; reduced motion is declared. The identical mobile prerequisite warms the database before measurement. Trial order alternates baseline/candidate/candidate/baseline.

| Trial | Useful visible-list time | Physical-input local feedback |
| --- | ---: | ---: |
| Baseline 1 | 424.712 ms | 57.152 ms |
| Candidate 1 | 371.139 ms | 41.032 ms |
| Candidate 2 | 391.851 ms | 40.335 ms |
| Baseline 2 | 383.283 ms | 39.510 ms |

Both candidate trials pass ≤2,500 ms useful-list and ≤200 ms local-response limits. Local response measures visible physical-input feedback; the subsequent actual server-filtered record list is checked separately. These are local fixture targets, not production latency assurances.

Native Chromium page zoom was 200%: DPR `2`, CSS viewport width `720`, body CSS zoom `1`, no document-wide horizontal overflow. This is not CSS zoom, device-scale simulation or pinch zoom.

Rollback switched baseline→candidate→candidate→baseline→candidate production clients against the latest disposable schema and the actual unchanged Portfolio reader/storage/schema, with source-byte equivalence checked. The 223 scoped contact/MID rows retained identical before/after hash `7849d1ead0d47d3ffaab4978251c2b81ae2363304ce8330aac07c0f10fd7c5fb`. No down-migration or production rollback occurred. **This is bounded Portfolio reader/client rollback, not whole bundled-server rollback certification.**

## Required gate blocker and remaining acceptance

- Latest normal CI: [run 38637895423](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/actions/runs/38637895423), failed Static Checks; Integration Tests skipped by normal dependency ordering.
- Exact blocker: deterministic-static suite 12/66, `scripts/test-sfp-pipeline-correction.mjs`, assertion “ZeroBounce execution uses plaintext only inside governed boundary”, expects obsolete source text `verifyEmail(realEmail)`.
- The same assertion failed when executed against unchanged main. C4 did not change SFP runtime or restore removed eligibility, spending or approval gates. This unrelated SFP assertion is not weakened, skipped or repaired here.
- Protected six-suite remote evidence: [run 38637895318](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/actions/runs/38637895318), **completed success, six of six jobs green** at source `401d7bdad4c76172736a9a76bb33b3fd7abfd216`. Individual jobs retain uploaded receipts, build recipes, screenshots and failure history; historical failures are not current successes.
- Local browser receipt records two generic `Uncaught` observations in the deliberate-fault workload; those are retained, not represented as an exception-free certification.
- Open C4 acceptance remains the full conditional control/action, role/object/loading/error/empty/denied matrix; all retained metric/period/status combinations; complete financial reader/SQL/UI/CSV scope combinations; full keyboard/focus/overlay/contrast/reduced-motion coverage; whole-source/bundled-artifact rollback; and all required CI/predeploy gates.

These obligations remain in the **same bounded C4 continuation under existing ownership**, not a new task ladder or silent deferral. No full acceptance, release GO or task-complete claim is made.

## Safety and lineage

No production durable test writes, native payments/submissions, real sends/enrollments/activation/provider generation, purges, integration/worker/schedule changes or publication were performed. Product migrations, dependency lockfiles, worker/service controls and `.replit` were unchanged by C4. Outbound PAUSED, proposals HELD and incoming GHL independently ENABLED/no-echo remain the owner’s standing operating contract; isolated fixture settings are not proof of current production controls.

The supplied evidence archive's 28 manifest hashes were verified without extracting over source. The original 95-finding lineage, 14 repair groups and C2/C3/C4/C5/A/B/D ownership are preserved. This amendment supersedes old provisional C4 source/build identities only for its explicitly executed cases, not historical evidence or unresolved acceptance.
