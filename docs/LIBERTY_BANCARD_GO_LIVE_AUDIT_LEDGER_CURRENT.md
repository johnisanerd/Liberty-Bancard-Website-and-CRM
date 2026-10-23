> Reconciled repository working copy, 2026-10-08. Baseline preserved verbatim from attached_assets/LIBERTY_BANCARD_GO_LIVE_AUDIT_LEDGER_CURRENT(2)_1791032739413.md. The later uploaded spec _4 contains only a file-stream-access-denied error, so it is not used as a specification. All historical source entries, repair groups and evidence remain below; the scoped amendment controls the new postmerge status.

## Owner-directed C4 patch integration

The prepared C4 patch and completed scoped repairs from candidate `2877b3a4e51b832dd0b2802b36e489787dc4242a` are integrated with current main, preserving existing C2/intake changes. The user explicitly clarified that unrelated existing test/CI failures are not prerequisites for applying this patch to origin/main. Publication is not authorized.

Exact-source isolated C4 run `38675003130` passed all six jobs; Static Checks passed; the local protected C2 browser passed 335 bounded receipts. Main-side C4 contracts and 46 C2 helper assertions passed. Normal CI's separate C1 browser row-set assertion (`50 !== 11`) remains reported, not silently relabeled green or used to block this scoped patch. Full conditional acceptance and Stage 3 release certification are not claimed. See `docs/certification/stage3-c4/owner-continuation-2026-10-14.md` for the controlling integration amendment.

## C2 postmerge correction — C2-R10: unfinished Contact header and action hierarchy

This was an unmet existing C2 implementation-step-4 requirement at the earlier closeout. It remains assigned to existing Task #2073/C2 alongside the Calendar-duration and pending-task corrections; it is not deferred to C3–C5 or a new task.

Implementation: ContactDetail adopts the existing RecordHeader/Liberty components, with identity, owner, lifecycle, consent/contactability, next action and essential outbound-pause reasons in a compact header. Log Call is primary; Add Note and New Task are the only secondary record actions. Other permitted operations are in the labelled More actions menu. Substantial SFP/readiness explanations and record diagnostics are expandable after the nearby five-area URL-backed navigation. Existing handlers, record context and permissions must remain intact.

Evidence status: scoped local PASS on 2026-10-08. Before/after desktop, phone and actual native 200% captures are retained. Thirteen bounded check groups verify real contact-bound Edit/Deal/Ticket/Note/Task/Call/scheduler persistence, clipboard values, keyboard/menu/dialog focus return, last-command reachability at 200%, and unchanged owner/merchant denials. See docs/certification/stage3-c2/contact-header/README.md and after-receipt.json for exact source/build hashes, geometry and qualifications. Three existing post-commit blueprint attempts were denied; external egress was zero. Email/AI execution, published signed-in UI, full C2/global acceptance and other-role/interior states are not certified. This amendment supersedes earlier blanket claims that the Contact outer composition was complete; it grants no global release GO.

The final eleven-entry sidebar remains C5. Outbound stays paused; incoming GHL synchronization remains independently enabled. No production writes, sends, provider activation, access bypass or publication are authorized by this correction.

---

# LIBERTY BANCARD — GO-LIVE AUDIT LEDGER (CURRENT)

## C4 owner-authorized implementation record — 2026-10-14

**Current controlling amendment:** Exact compiled source `b4810727c371c9e4b49e394c5dfc7af045b19767`, production build `e87f5f9c-7337-4aba-a120-5314da480330`. All six required suites passed locally and in [remote acceptance 38665072643](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/actions/runs/38665072643), alongside all 66 static suites, whole-project typecheck and build/integrity. Executed evidence includes 318 handler cases, 102 named browser rows, 40 responsive/theme probes, genuine 200% zoom, selected-tier Terminal actual CSV/failure suppression/single Escape/caller focus, fresh matched performance targets and actual production bundled rollback/schema-business invariants. Candidate useful-list `914.618 / 722.980 ms`; browser feedback `20.5 / 21.6 ms`. Exact hashes, recipe and qualifications are in the continuation.

[Normal CI 38665072299](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/actions/runs/38665072299) passes Static Checks; full Integration remains running at this amendment. Required C2 workspace-browser is unresolved: owned agent rejection-text case failed; a separate, unaccepted test-only reconciliation stopped at Quick Edit Sheet connected-focus return. Pipeline/preflight/deal-authority code is unchanged from main; further C2 edits are separate and unaccepted, with no authority/header-design change or new task ladder. Full applicable conditional-control/state-space qualification remains open; inventory observations are not action passes. **Merge SHA: none; C4 OPEN / NOT FULLY ACCEPTED; release remains NO-GO.** Original 95 findings/14 repair groups and existing ownership remain intact. No production durable tests, native transmission or publication; outbound PAUSED, proposals HELD and incoming GHL independently ENABLED/no-echo remain the operating contract.

### Superseded implementation record

**Current amendment superseding the historical paragraphs below:** Latest pushed source is `c5ee15ba2393a67aea51a330e6c1912916e1a831`. [Normal CI 38660366151](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/actions/runs/38660366151) passes Static Checks/all 66 static suites, dependency audit and production artifact scan; Integration is pending. [Latest isolated C4 38660365949](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/actions/runs/38660365949) has five passing jobs and a pending expanded browser. Preceding source `77662cadf8be9519325eb349b16aa71e1ea95420`, local build `d2d50121-3f08-4ee6-882c-2efdc20dfd9b`, passed all six suites locally and in [remote acceptance 38658649909](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/actions/runs/38658649909): 318 handler cases, 101 named browser rows, all 40 responsive/theme probes, genuine 200% zoom, matched 2,500/200 ms performance limits and actual candidate→baseline→candidate production bundled-server rollback with data/schema invariants. Its normal integration run passed the C4/C2 cases but failed a stateless Toast runner resource mismatch. That runner-only correction passed its real denied child at four widths with no database/Redis variables and is pushed in the latest candidate. Control appearances remain inventory, not action passes. **Merge SHA remains none; C4 remains OPEN / NOT FULLY ACCEPTED.** Latest CI and full applicable control/state-space qualification are still required. No publication occurred. Original 95-finding/14-group ownership and operating safety contracts remain unchanged. See the linked continuation for exact hashes and qualified historical evidence.

See [exact C4 continuation evidence and limits](certification/stage3-c4/owner-continuation-2026-10-14.md). V1–V4 are implemented on the isolated verification branch; all six required suites passed locally and in remote run 38637895318, including named nonempty financial and real handler/session/CSRF cases. Matched Portfolio candidate visible-list times were 371.139/391.851 ms; physical-input feedback was 41.032/40.335 ms. Native browser zoom was 200%; 223 scoped contact/MID rows retained their exact hash across bounded reader/client rollback.

Compiled source is `401d7bdad4c76172736a9a76bb33b3fd7abfd216`; local build is `b4ce8687-dad1-4c0f-9451-17572501279f`. Neither is a deployed or merge identity. **Merge SHA: none. C4 OPEN / NOT FULLY ACCEPTED; global release remains NO-GO.** Required normal CI fails a reproduced unchanged-main SFP assertion expecting obsolete `verifyEmail(realEmail)` source text; no gate was waived. Full C4 conditional control/action, state, accessibility, financial-scope and whole-source/bundled rollback acceptance remains unresolved under its existing owner, not moved to new tasks. Original 95 findings/14 repair groups and C2/C3/C4/C5/A/B/D ownership remain intact. Outbound PAUSED, proposals HELD and incoming GHL independently ENABLED/no-echo stay the operating contract. No production test writes or publication occurred.

**Canonical working record for the fresh Liberty Bancard go-live audit**

**Latest audit:** Section 18 records the October 2 Stage 3 three-audit consolidation, fresh authenticated checks, current source/runtime identities, proposed navigation/design/metric contracts and grouped implementation roadmap. Section 17 and earlier sections remain historical evidence.  
**Created:** 2026-09-28  
**Purpose:** Preserve every material audit finding, closure state, evidence gap, and coverage decision so findings are never lost in chat history or overwritten by later reports.

---

## 1. Operating Rules

This ledger is **append-only in substance**.

- Never delete a finding because it was fixed.
- Never overwrite discovery evidence with later closure evidence.
- Move findings through explicit states instead:
  - `OPEN`
  - `FIX IN PROGRESS`
  - `MERGED`
  - `DEPLOYED`
  - `RUNTIME VERIFIED`
  - `CLOSED`
- If code is fixed but production/runtime has not been independently verified, do **not** mark the finding `CLOSED`.
- If an area has not been exercised, mark it `UNTESTED` or `NOT STARTED`; never call it `PASS` merely because no defect is known.
- Every audit session must record the Git SHA reviewed.
- Final certification must bind to one exact deployed SHA only after remediation/build work is finished.
- Security review is continuous, but final **Platform / Security / Release Certification** occurs near the end of the go-live program.

### Severity

| Severity | Meaning |
|---|---|
| `P0` | Immediate launch stop / active data, auth, send, spend, destructive, or severe security risk |
| `P1` | Must be corrected before go-live; material security, reliability, business-flow, data, release, or compliance defect |
| `P2` | Important operational/UX/control defect; can be scheduled behind P0/P1 if safely bounded |
| `P3` | Improvement / polish / low-risk cleanup |
| `EVIDENCE` | Not necessarily a product defect, but proof is missing and certification cannot close without it |

---

## 2. Last Independently Audited Baseline

| Item | Current Evidence |
|---|---|
| Repository | `scottpstevenson/Liberty-Bancard-Website-and-CRM` |
| Default branch | `main` |
| Current audited `main` SHA | `74a5307b2c4dcfd9e5e09fefa3ce1a14603e0827` |
| Current `main` commit title | `Published your App` |
| Migration journal | 317 entries |
| Current migration journal head | `0312_contact_business_system_links` |
| Latest GitHub commit explicitly titled `Published your App` observed during audit | `74a5307b2c4dcfd9e5e09fefa3ce1a14603e0827` |
| Current `main` vs that publish-marked commit | Same GitHub commit |
| Exact currently deployed runtime SHA | **UNVERIFIED FROM GITHUB ALONE** |
| Final release SHA frozen? | **NO — intentionally deferred** |
| Replit contacted during this audit? | **NO** |
| Production mutated during this audit? | **NO** |

### Important baseline rule

The commit titled `Published your App` is useful historical evidence, but it is **not by itself proof of the exact SHA currently serving production**. Final runtime identity remains an evidence requirement.

---

## 3. Open Findings — Current Fresh Audit

### SEC-01 — Internal deal proposal read route is reachable by authenticated merchant sessions

| Field | Value |
|---|---|
| Lane | Platform / Security / CRM authorization |
| Severity | `P1` |
| Status | `MERGED — present in current publish-marked head; authenticated runtime role verification pending` |
| Discovered at SHA | `8c88fd13126e8a87efbbb728a59a6a68e348a186` |
| Primary path | `GET /api/deals/:id/proposal` |
| Primary file | `server/routes/ai.ts` |
| Related authority | `server/services/crm-object-access.ts`; `server/replit_integrations/auth/replitAuth.ts`; `server/routes.ts` |

**Finding**  
`GET /api/deals/:id/proposal` currently uses `isAuthenticated`, not `isDashboardUser` or another merchant-safe object authorization contract.

The global `crmObjectAccessGuard` scopes direct deal/contact paths only when `req.user.role === "agent"`. The partner middleware separately blocks partner sessions from general CRM routes. An authenticated `merchant` is therefore not rejected by either of those global guards before the proposal handler reads the deal/proposal.

**Why it matters**  
An authenticated merchant account should not be able to enumerate/read arbitrary internal CRM deal proposal data merely by possessing or guessing a deal ID.

**Required correction**

- Classify the intended audience for the internal deal-proposal endpoint.
- Apply the appropriate dashboard/object-level authorization boundary.
- Do not break the separate public bearer-token proposal journey.
- Add negative tests for merchant, partner, unrelated agent, and anonymous access.
- Preserve admin/manager and correctly owned agent behavior where intended.

**Closure evidence required**

- Merged SHA.
- Route guard/object-policy test.
- Deployed SHA.
- Authenticated runtime verification across relevant roles.

---

### SEC-02 — Session revocation / expiry authority fails open when validation lookup errors

| Field | Value |
|---|---|
| Lane | Platform / Security / Authentication |
| Severity | `P1` |
| Status | `MERGED — present in current publish-marked head; runtime failure-injection verification pending` |
| Discovered at SHA | `8c88fd13126e8a87efbbb728a59a6a68e348a186` |
| Primary file | `server/replit_integrations/auth/replitAuth.ts` |
| Primary function | `checkSessionValidity()` |

**Finding**  
When the backing `user_sessions` validity lookup throws, the catch path logs `session_validation_failed` and returns `null`. `null` is then interpreted by `isAuthenticated`, `isDashboardUser`, `isAdmin`, and other role guards as “no invalid reason,” allowing the already-authenticated request to continue.

The code explicitly states: `On error, allow through (fail open to avoid breaking the app)`.

**What this does NOT mean**  
This is not an anonymous login bypass. Passport must still consider the request authenticated.

**Actual risk**  
If a session should have been rejected because it was revoked, idle-expired, absolutely expired, or administratively terminated, a failure of the session-validity backing lookup can prevent that revocation/expiry decision from being enforced for that request.

**Required correction**

- Fail closed for protected CRM/dashboard/admin routes when session validity cannot be authoritatively checked.
- Use an explicit error result such as `session_validation_unavailable` rather than returning the same value as “valid.”
- Choose an appropriate response (`401`, `503`, or controlled equivalent) without silently permitting the request.
- Add tests for backing-store failure across `isAuthenticated`, `isDashboardUser`, `isAdmin`, and other security-sensitive guards.

**Closure evidence required**

- Unit/integration failure-injection tests.
- No anonymous regression.
- No merchant/partner/dashboard role regression.
- Runtime verification after deployment.

---

### REL-01 — GitHub CI cannot execute cleanly because lockfile contains Replit-internal package URLs

| Field | Value |
|---|---|
| Lane | Platform / Release / CI |
| Severity | `P1` |
| Status | `CLOSED — clean GitHub-hosted runner install now succeeds; current CI is red for a different SFP regression` |
| Discovered / reconfirmed at SHA | `8c88fd13126e8a87efbbb728a59a6a68e348a186` |
| Current GitHub Actions run inspected | CI run `#314` / run id `36460401002` |
| Primary file | `package-lock.json` |
| Historical related program | Repository exposure / dependency-lockfile portability work (`RVR-02`) |

**Finding**  
The current GitHub Actions run fails at `npm ci` before any security/build/integration suites execute. The lockfile contains package tarball URLs pointing at `http://package-firewall.replit.internal/...`, which a GitHub-hosted runner cannot resolve.

At the audited SHA, six occurrences of the Replit-internal package host were present in `package-lock.json`, including PostgreSQL dependency packages.

**Observed CI consequence**

- Dependency installation: `FAIL`
- Deterministic static suites: `SKIPPED`
- External dependency/security audit: `SKIPPED`
- Release artifact build/scan: `SKIPPED`
- Integration job: `SKIPPED`

The failure is therefore **not evidence that application tests failed**; it is evidence that the independent CI gate cannot run.

**Why it matters**  
A release cannot be independently certified on GitHub if a clean runner cannot install the locked dependency graph.

**Required correction**

- Regenerate/normalize the lockfile so resolved package URLs are portable from standard clean CI runners.
- Preserve dependency versions/integrity rather than silently changing the dependency graph.
- Add a portability check preventing reintroduction of `*.replit.internal` package resolution URLs.
- Re-run static, external-security, build-scan, migration, and integration jobs successfully.

**Closure evidence required**

- Clean-runner `npm ci` success.
- Full current-head GitHub CI completion.
- Artifact/security/integration stages actually executed, not skipped.

---

### REL-02 — Pre-deploy wrapper claims provider denial without establishing a global provider-deny boundary for the server process

| Field | Value |
|---|---|
| Lane | Platform / Release / Certification Safety |
| Severity | `P1` |
| Status | `MERGED — outer pre-deploy zero-egress boundary is present; full certification-run proof pending` |
| Discovered at SHA | `8c88fd13126e8a87efbbb728a59a6a68e348a186` |
| Primary files | `scripts/run-pre-deploy.sh`; `scripts/pre-deploy.ts`; provider-deny helpers |

**Finding**  
`scripts/run-pre-deploy.sh` says it starts the dev server “with provider denial,” but the wrapper launches the server with `GHL_TRANSPORT_FAILFAST=true` and does not itself establish `VG_PROVIDER_DENY_MODE=1` for the server process.

Many individual certification suites correctly install disposable/provider-deny boundaries. The background server, however, inherits the surrounding process environment and selected worker topology unless otherwise fenced.

**Why it matters**  
A ceremony that states “This gate makes NO real provider calls” should establish that property at the outermost process boundary, not rely on every individual worker/service/test path to remain independently safe.

**Required correction**

- Make zero-egress/provider-deny behavior explicit at the wrapper/server boundary for certification runs.
- Ensure background workers/schedulers cannot make live provider calls during certification.
- Preserve GHL fail-fast isolation.
- Add an executable assertion proving provider denial is active before server-required suites begin.

**Closure evidence required**

- Certification process-env test.
- Fake/denied provider assertion.
- Successful complete pre-deploy run with zero external provider effects.

---

### ADS-01 — Offline conversion export is accessible to ordinary dashboard agents

| Field | Value |
|---|---|
| Lane | Ads / Attribution / CRM Authorization |
| Severity | `P1` |
| Status | `MERGED — admin/manager restriction present; runtime role verification pending` |
| Discovered / reconfirmed at SHA | `8c88fd13126e8a87efbbb728a59a6a68e348a186` |
| Endpoint | `GET /api/acquisition/offline-conversions/export` |
| Primary file | `server/routes/acquisition.ts` |

**Finding**  
The offline-conversion export uses `isDashboardUser`, which permits `admin`, `manager`, and `agent`. The export includes conversion data suitable for Google Ads import and reads contact identifiers including email and GCLID.

**Why it matters**  
Bulk ad-attribution/conversion export is an administrative/growth-operations function and exposes data beyond what ordinary sales agents need for daily CRM work.

**Required correction**

- Restrict the bulk export to the approved administrative roles (expected: admin/manager unless a narrower governed role is established).
- Keep ordinary read-only acquisition metrics separately scoped if agents legitimately need them.
- Add role-matrix coverage for export vs non-export acquisition endpoints.

**Closure evidence required**

- Route-role tests.
- Runtime role verification.

---

### REL-03 — Exact deployed runtime SHA is not yet independently proven

| Field | Value |
|---|---|
| Lane | Platform / Release Identity |
| Severity | `EVIDENCE` |
| Status | `OPEN — GitHub head is publish-marked, but exact serving runtime identity remains unverified` |
| Current main | `74a5307b2c4dcfd9e5e09fefa3ce1a14603e0827` |
| Latest publish-marked commit observed in GitHub | `74a5307b2c4dcfd9e5e09fefa3ce1a14603e0827` |
| Distance | Same GitHub commit; exact serving runtime SHA still requires runtime identity evidence |

**Finding / evidence gap**  
GitHub proves the repository state and commit history but does not by itself prove the exact SHA currently serving `libertybancard.com` / the production CRM.

The four commits after the latest publish-marked commit include changes to:

- the selected background-worker profile;
- continuous SFP discovery/validation;
- SFP provider operations;
- runtime attestation refresh.

**Why it matters**  
Live/runtime audit findings must be attributed to the code actually serving traffic, not assumed from `main`.

**Required evidence**

- Production health/release identity exposing exact deployed SHA.
- Migration head.
- worker/profile identity.
- confirmation of whether current `main` changes are deployed before relying on them as runtime truth.

**Closure rule**  
Do not close until exact deployed runtime identity is independently verified. This is intentionally deferred until runtime/browser audit stages and final release certification.

---

## 4. Historical Findings Revalidated During This Fresh Audit

These rows remain in the ledger permanently. Their current status reflects only what the fresh source audit proved.

### ENR-H01 — Task #2002 `sunbiz-full-backfill` selective worker-profile omission

| Field | Value |
|---|---|
| Lane | Prospecting / Enrichment / Workers |
| Severity when found | `P1` |
| Current status | `MERGED` — runtime closure not yet independently verified |
| Original defect | `sunbiz-full-backfill` existed but was not assigned to any selectable capability group, so a selective deployment could mark backfill running without a consuming worker. |
| Current code evidence | Dedicated `sunbiz-backfill` capability group now maps to `sunbiz-full-backfill`. Checked-in selective profile includes `sunbiz-backfill`. |

**Do not delete this row.**  
Final closure still requires runtime proof that the deployed profile actually instantiates the queue/worker and the cursor advances safely.

---

### ENR-H02 — SFP `ready_held` campaign-staging intent had no governed paused-enrollment consumer

| Field | Value |
|---|---|
| Lane | Prospecting / Campaigns / Enrollment |
| Severity when found | `P1` |
| Current status | `MERGED` — runtime closure not yet independently verified |
| Current code | `server/services/cro03/sfp-enrollment-bridge.ts`; admin bridge route in `server/routes/lead-ops.ts` |

**Current source evidence**

The bridge now:

- converts a governed `ready_held` intent into a **paused** sequence enrollment;
- does not activate/send;
- refuses synthetic placeholder email creation;
- checks real/corroborated identity;
- rechecks promotion/suppression/existing-customer eligibility;
- rejects conflict with an already active enrollment;
- uses locking/idempotency protections;
- carries dedicated disposable certification coverage.

**Remaining closure proof**

- exact deployed SHA;
- real runtime canary with isolated test/canary records;
- prove zero unauthorized send;
- prove pause/hold state in UI and data.

---

### SEC-H01 — September AI/CRM authorization regression

| Field | Value |
|---|---|
| Lane | Platform / Security / AI CRM |
| Original status | P0/P1 authorization concern |
| Current status | `PARTIALLY CLOSED` |

**Fresh source evidence now confirms**

- company-wide AI insight/task/onboarding scans are admin/manager constrained;
- dashboard AI actions use `isDashboardUser` where appropriate;
- body-supplied contact/deal/ticket IDs have explicit ownership checks in audited paths;
- proposal bearer tokens are fingerprinted before audit logging;
- public proposal token routes have rate limiting;
- stale `sales` role checks were changed to the actual `agent` role in proposal-related mutations;
- chargeback copilot paths now check linked deal/contact access.

**Still open from this family**

- `SEC-01` internal proposal read route remains only `isAuthenticated`.

Therefore the historical family cannot yet be marked fully `CLOSED`.

---

## 5. Latent / Configuration Risk Register

These are not all proven active production defects, but they are important conditions that can become dangerous if topology or release configuration changes.

### CFG-01 — Legacy outreach/orchestrator flags remain armed in checked-in Replit configuration

| Field | Value |
|---|---|
| Lane | Runtime / Outreach Safety |
| Severity | `P2` |
| Status | `MERGED — checked-in legacy flags now safe-off; deployed runtime environment verification pending` |
| Observed values at current source | `LEGACY_OUTREACH_ENABLED=false`; `ORCHESTRATOR_ENABLED=false`; `NIGHTLY_DISCOVERY_ENABLED=false` |

**Post-merge state**  
The checked-in Replit defaults are now fail-safe for the legacy discovery/outreach/orchestrator switches. Final closure still requires confirming that the deployed runtime environment has not overridden those checked-in defaults and that selective profile resolution does not instantiate excluded outbound capabilities.

---

## 6. Release / Repository Governance Observations

### GOV-01 — Repository is public

| Field | Value |
|---|---|
| Status | `OBSERVATION` |
| Repository visibility | `public` |

Public visibility is not automatically a defect, but secret containment and generated-artifact hygiene must therefore be treated as hard requirements.

### GOV-02 — No repository rulesets returned by GitHub API

| Field | Value |
|---|---|
| Status | `EVIDENCE GAP / GOVERNANCE REVIEW` |

The GitHub API returned an empty ruleset list. Traditional branch-protection configuration could not be read with the connected GitHub integration because the integration lacks the necessary administration permission.

**Do not infer** that branch protection is absent solely from that 403. Final governance review still needs authoritative branch-protection evidence.

### GOV-03 — Quick source token-prefix search found no obvious GitHub/OpenAI/Google API tokens

| Field | Value |
|---|---|
| Status | `PARTIAL EVIDENCE ONLY` |

This was a bounded source search, not a complete secret scan. Final security certification still requires the full repository/build-artifact secret-scanning gate to execute successfully.

---

## 7. Audit Coverage Register

**Current sequencing authority:** Section 14 records the owner’s 2026-10-01 update: Stages 1 and 2 are completed, fixed, and merged; Stage 3 is next. Older findings and evidence gaps remain historical audit evidence until independently reverified.

This register answers **what was actually tested**, not what the code claims to support.

| Audit lane | Current status | What has been done | What is still required |
|---|---|---|---|
| Safety & Environment Preflight | `COMPLETED / FIXED / MERGED — OWNER CONFIRMED 2026-10-01; FINAL CERTIFICATION PENDING` | GL-01 fixes independently verified in current publish-marked head; clean-runner install now succeeds; session/proposal/export/config/pre-deploy corrections preserved | Current head CI must be green; exact serving runtime SHA/profile/migration/queue evidence; role/runtime failure-injection checks |
| Public Website & Inbound | `COMPLETED / FIXED / MERGED — OWNER CONFIRMED 2026-10-01; FINAL CERTIFICATION PENDING` | GL-02 major fixes verified in current publish-marked head: optional PEWC/marketing consent, consent-aware tracking, stable idempotency, callback ambiguity handling, core claim cleanup | Residual public claim drift; strict validation gaps; raw Meta/Microsoft click-ID authority; CI registration of GL-02 regression suites; interactive browser/mobile/network canaries; production assignment policy |
| CRM & Sales Operations | `NEXT — STAGE 3; FRESH LIVE AUDIT NOT STARTED` | Historical CRM audits exist | Discover current roles; authenticated walkthrough of every accessible route/tab/action by role; loading/empty/error/degraded states; data reconciliation; mobile/desktop; mutations where safely testable |
| Prospecting / Enrichment / Campaigns | `PARTIAL SOURCE REVALIDATION` | #2002 profile fix verified in current source; SFP enrollment bridge verified in current source; current capability/profile topology inspected | Exact deployed topology; real source→canonical→free enrichment→paid waterfall→validation→eligibility→staging→paused enrollment canary; cost/yield; queue/retry/failure tests |
| Application / Underwriting / Processor Boarding | `NOT STARTED — FRESH E2E` | Historical architecture exists | Isolated full statement→proposal→application→protected data→underwriting→RFI→processor sandbox→approval→MID journey |
| Merchant Onboarding / Support / Revenue | `NOT STARTED — FRESH E2E` | Historical architecture exists | MID activation; equipment/onboarding; portal; support; chargebacks/RFI; processor activity; residual import; reconciliation; commissions/revenue |
| Ads / Attribution | `PARTIAL SOURCE AUDIT` | Acquisition routes reviewed; `ADS-01` found | Landing pages; UTM/click IDs; GCLID; consent-aware tags; browser/server event dedupe; Enhanced Conversions for Leads; Data Manager; offline feedback; ad-account/billing/permissions/budgets/brand safety; capped launch thresholds |
| Sales Training / AI Operational Readiness | `NOT STARTED — FRESH` | Historical training/AI assets exist | Versioned rep enablement package; real-role onboarding; daily workflow; talk tracks; objections; compliance; practice/certification; AI evidence/permission/no-autosend validation |
| Platform / Security / Release — FINAL | `DEFERRED` | Early safety preflight in progress | After product remediation: freeze exact SHA; full clean CI; security/role/IDOR/migration/build gates; publish exact SHA; verify live; queue/provider/kill switch/rollback/incident certification |
| Final Lane-Specific Certification | `NOT STARTED` | — | Issue independent final verdicts for all nine launch lanes; no vague company-wide GO |

---

## 8. Final Lane Verdict Register

**These verdicts are intentionally blank until remediation and certification are complete.**

| Final certification lane | Verdict | Certified SHA | Evidence |
|---|---|---|---|
| Platform / Security / Release | `NOT YET CERTIFIED` | — | — |
| Public Website & Inbound | `NOT YET CERTIFIED` | — | — |
| CRM & Sales Operations | `NOT YET CERTIFIED` | — | — |
| Prospecting & Enrichment | `NOT YET CERTIFIED` | — | — |
| Campaigns & Outbound | `NOT YET CERTIFIED` | — | — |
| Merchant Application & Processor Boarding | `NOT YET CERTIFIED` | — | — |
| Merchant Onboarding / Support / Revenue | `NOT YET CERTIFIED` | — | — |
| Ads & Attribution | `NOT YET CERTIFIED` | — | — |
| Sales Training & Operational Ownership | `NOT YET CERTIFIED` | — | — |

---

## 9. Finding Closure Template

Copy this block for every new finding.

```md
### <ID> — <Short title>

| Field | Value |
|---|---|
| Lane | |
| Severity | |
| Status | `OPEN` |
| Discovered at SHA | |
| Discovered date | |
| Primary routes/files | |
| Owning task | |

**Finding**

**Why it matters**

**Exact evidence**

**Required correction**

**Regression tests required**

**Merge evidence**

**Deployment evidence**

**Runtime verification**

**Closed date**
```

---

## 10. Change Log

### 2026-10-01 — Reference audits and GHL sync posture added to Stage 3

Added a bottom section to the Stage 3 plan requiring full verification/reconciliation of both supplied October dashboard audits, including reported bugs, positive claims, cleanup history, GHL observations and conflicting snapshots. Owner specifies outbound emails remain paused while GHL data sync stays enabled and operational. Reference recommendations to unpause email, raise send caps or run cleanup are not adopted as authorization. No live state was changed or independently verified. See Section 16.

### 2026-10-01 — Stage 3 audit and redesign game plan authored

Created the Stage 3 CRM audit and redesign game plan with five passes: complete inventory; role/route/tab/action verification; sales journeys and data reconciliation; navigation/UI design; prioritized remediation and re-test. Added Section 15 with scope, deliverables, proposed navigation, and stage ownership. No new repository/runtime verification or defect closure occurred. Stage 3 remains next, with the live audit pending.

### 2026-10-01 — Owner stage completion and sequence update

Owner confirms Stages 1 and 2 have been completed, fixed, and merged. Added the authoritative ten-stage sequence in Section 14, set Stage 3 as the next audit, and established mandatory ledger updates after every task and audit. This is an owner-status update, not a new repository/runtime audit. Prior discovery evidence and unresolved independent-verification requirements are retained. Section 14 supersedes the older Stage 3 deferral in Section 13.3. No new SHA, CI result, deployment, or runtime verdict is asserted.

### 2026-10-01 — Stage 1/2 post-merge re-audit

Re-pinned to current publish-marked `main` `74a5307b2c4dcfd9e5e09fefa3ce1a14603e0827` and migration head `0312_contact_business_system_links`. Verified GL-01 fixes remain implemented and the old clean-runner dependency-install failure is closed. Found current CI red on stale SFP structural assertions after a safer implementation refactor and found GL-02 residuals in public claim governance, strict public-form validation, raw click-ID authority, and CI registration of GL-02 regression tests. Stage 3 remains deferred until this bounded closure pass is complete.

### 2026-09-28 — Ledger created

Seeded from the fresh GitHub/current-code Safety & Environment Preflight plus revalidated historical go-live findings.

Initial current findings recorded:

- `SEC-01` — internal deal proposal read authorization defect.
- `SEC-02` — session validity authority fails open on lookup error.
- `REL-01` — GitHub CI blocked by Replit-internal package URLs in lockfile.
- `REL-02` — pre-deploy provider-deny boundary mismatch.
- `ADS-01` — offline conversion export over-broad to agents.
- `REL-03` — exact deployed runtime SHA not independently proven.
- `CFG-01` — latent armed legacy outreach/orchestrator configuration.

Historical findings revalidated and retained:

- `ENR-H01` — #2002 Sunbiz backfill worker-profile omission fixed in current source; runtime closure pending.
- `ENR-H02` — SFP `ready_held` → paused enrollment bridge now implemented; runtime closure pending.
- `SEC-H01` — September AI/CRM authorization family substantially remediated, with `SEC-01` still open.

Coverage register initialized for the full fresh go-live audit program.

---

## 11. Next Audit Entry

**Next lane:** Stage 3 — CRM & Sales Operations
**Execution plan:** [Stage 3 CRM Audit and Redesign Game Plan](https://chatgpt.com/space/page_bdb0fc8cc3bc8191bf890e19796ccbbc); authored 2026-10-01. Live audit pending.  
**Method requirement:** Fresh current repository + authenticated CRM walkthrough by real role + sales-workflow/data tracing; historical reports are checklists/evidence only, never treated as current truth.  
**Do not close this lane until:** accessible CRM routes, tabs, filters, actions/mutations, object permissions, loading/error/empty/degraded states, mobile/desktop behavior, and the rep workflow have actual evidence. See Section 14 for the current sequencing authority.


---

## 12. Public Website & Inbound — Fresh Audit Entry (2026-09-28)

**Audit SHA:** `8bf8318762963eb2298aad386b136c7361de54e0`  
**Methods used:** current GitHub source + deployed public-site HTTP/HTML inspection.  
**Not performed:** no Replit interaction; no production mutation; no real-lead form submissions; no authenticated cloud-browser session. Interactive browser/mobile/console certification remains pending because that execution surface was unavailable in this chat.

### WEB-01 — Public merchant terms contradict each other on contracts and early termination fees

| Field | Value |
|---|---|
| Lane | Public Website / Commercial Claims |
| Severity | `P1` |
| Status | `PARTIAL — core conversion pages corrected; affiliate/partner public claim residuals remain` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary surfaces | Homepage, Get Started, Merchant Application, FAQ/Help, Terms, Refund Policy |

**Finding**  
Customer-facing pages state variants of `Cancel Anytime. No Early Termination Fee. No Penalty.` and `no cancellation fees`, while the Terms/Refund Policy and global footer state that agreements may have 1–3 year terms and early termination fees may apply, including a stated typical range of roughly $295–$595.

**Why it matters**  
These are contradictory statements about a material commercial term. A merchant should not receive a categorical no-ETF promise on a conversion page while the governing/legal pages say an ETF may apply.

**Required correction**  
Establish one governed contract/ETF claim and use conditional language everywhere unless the exact offer is guaranteed to be a no-ETF program. Bind marketing copy, FAQ/help, application copy, AI/knowledge content, SSR pages, and legal disclosures to that authority.

---

### WEB-02 — Merchant application forces PEWC/TCPA marketing consent despite saying consent is not required for service

| Field | Value |
|---|---|
| Lane | Public Website / Application / Consent |
| Severity | `P1` |
| Status | `MERGED — PEWC no longer required to submit; browser/runtime verification pending` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary file | `client/src/pages/MerchantApplication.tsx` |

**Finding**  
Final-step progression requires `reviewConfirmed && pewcConsent`. The immediately adjacent PEWC disclosure says the applicant understands this consent is **not required to obtain services**. The server finalize DTO itself treats `pewcConsent` as optional, so the mandatory behavior is a frontend constraint rather than a backend necessity.

**Required correction**  
Separate application/underwriting assent from optional automated marketing/contact consent. A user must be able to submit the merchant application after accepting required application terms without being forced to grant optional PEWC marketing consent.

---

### WEB-03 — Free Analysis requires marketing-contact consent to obtain the advertised free analysis

| Field | Value |
|---|---|
| Lane | Public Website / Lead Capture / Consent |
| Severity | `P1` |
| Status | `MERGED — marketing consent no longer required to obtain Free Analysis; runtime verification pending` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary file | `client/src/pages/FreeAnalysis.tsx` |

**Finding**  
The final Free Analysis step cannot proceed unless the marketing checkbox is checked. The checkbox grants calls, texts, and email marketing communications. This makes marketing consent a condition of receiving the advertised free analysis, while other forms correctly treat PEWC as optional.

**Required correction**  
Separate the requested service response from optional marketing-channel consent. Preserve transactional response authority without converting service submission into mandatory promotional consent.

---

### PRIV-01 — Cookie preferences do not control GA4/Meta loading; Google Consent Mode is absent

| Field | Value |
|---|---|
| Lane | Public Website / Privacy / Ads |
| Severity | `P1` |
| Status | `MERGED — Consent Mode/tag gating implemented; browser network verification pending` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary files | `client/src/components/CookieConsent.tsx`; `client/src/lib/tracking.ts` |

**Finding**  
The cookie banner stores `necessary/analytics/marketing/functional` choices in localStorage. The tracking module initializes at module load and injects GA4 and Meta Pixel whenever their IDs are configured. It does not read the stored preferences and contains no Google Consent Mode calls (`gtag('consent', ...)`).

**Why it matters**  
`Reject Non-Essential` / custom preferences are not currently demonstrated to control analytics/marketing tag execution. The banner and the actual tag behavior are separate systems.

**Required correction**  
Default analytics/marketing consent appropriately before tag initialization, wire banner state to the tag layer, implement/validate Consent Mode where required, and add browser tests proving tag/network behavior for accept/reject/custom states.

---

### ATTR-01 — Click-ID attribution is incomplete and inconsistent across public conversion paths

| Field | Value |
|---|---|
| Lane | Public Website / Attribution / Ads |
| Severity | `P1` |
| Status | `PARTIAL — GCLID/booking continuity improved; raw FBCLID/MSCLKID authority remains unresolved` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary files | `client/src/lib/utm.ts`; `client/src/pages/FreeAnalysis.tsx`; booking URL helper; acquisition reporting |

**Finding**  
The canonical UTM helper stores raw `gclid`, but only boolean presence for `fbclid` and `msclkid`; raw Meta/Microsoft click IDs are not preserved. Booking links propagate UTM values but not click IDs. Free Analysis manually captures only UTM query keys into its local state, then sends `utmParams.gclid`, which is never populated by that local capture path. Acquisition readiness also contains historical/stale `gclidCaptureActive: false` reporting despite other forms now capturing GCLID.

**Required correction**  
Define one governed acquisition-attribution payload and use it on every public form and booking handoff. Preserve supported raw click IDs where policy allows, report capture truthfully, and test source continuity from landing page through contact/deal and offline conversion export.

---

### INB-01 — Callback intake has weak identity/deduplication semantics

| Field | Value |
|---|---|
| Lane | Public Website / Inbound CRM |
| Severity | `P1` |
| Status | `MERGED — phone identity/ambiguity review implemented; isolated runtime canary pending` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary route | `POST /api/public/callback` |

**Finding**  
Callback intake has no email identifier and always calls `writeContact()` with `email: ""`. The public-form consolidation service explicitly exempts callback from the normal existing-contact path. Repeated legitimate callback submissions with different idempotency keys can therefore create multiple contacts/deals for the same phone/person unless a deeper writer constraint happens to stop them. Current clients validate only non-empty name/phone, not a normalized telephone identity.

**Required correction**  
Give callback requests an explicit phone-based identity/review policy rather than blind create. Preserve distinct request occurrences while linking them to the same canonical contact when identity is sufficiently strong, and route ambiguity to review rather than duplicating contacts.

---

### INB-02 — Several public clients generate idempotency keys per HTTP attempt, not per logical submission

| Field | Value |
|---|---|
| Lane | Public Website / Inbound Reliability |
| Severity | `P2` |
| Status | `MERGED — stable logical-submission keys implemented across audited public clients; replay canary pending` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary file | `client/src/lib/queryClient.ts` |

**Finding**  
The server-side inbound claim system is strong, but the generic `apiRequest()` creates a new UUID whenever a public POST is issued without an explicit key. Get Started, Estimate, callback widgets, support and other callers do not all retain a key across an ambiguous timeout/retry. Statement Upload and Free Analysis do retain a logical-submission key and demonstrate the safer pattern.

**Why it matters**  
If the first request commits but the browser loses the response, a user retry can receive a new key and become a second request occurrence, defeating replay protection at the client boundary.

**Required correction**  
Generate one key per logical form submission and retain it through retries until definitive success/reset for every durable public mutation.

---

### INB-03 — Server-side hostile-input validation is inconsistent across public lead forms

| Field | Value |
|---|---|
| Lane | Public Website / Inbound Validation |
| Severity | `P1` |
| Status | `PARTIAL — estimate/support/get-started improved; callback and Free Analysis still lack full strict bounded server schemas` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |

**Finding**  
Several frontends have useful Zod/client validation, but equivalent server schemas are not uniformly enforced. Examples: Free Analysis checks only first name + email at route entry; callback accepts non-empty strings; estimate/get-started/support handlers destructure request bodies without a route-level Zod contract. Public rate limiting and field allowlists reduce blast radius but do not replace server validation.

**Required correction**  
Create canonical server-side schemas for every public form: bounded lengths, normalized email/phone, allowed enums, numeric/range constraints, unexpected-field policy, and safe error codes. Keep frontend validation as UX, not authority.

---

### WEB-04 — Merchant application contains unresolved `[Bank Partner]` production placeholder

| Field | Value |
|---|---|
| Lane | Public Website / Legal / Trust |
| Severity | `P1` |
| Status | `MERGED — placeholder removed and source regression scan added` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary file | `client/src/pages/MerchantApplication.tsx` |

**Finding**  
The application review/success UI still renders `Liberty Bancard is a registered ISO of [Bank Partner]` in current source.

**Required correction**  
Replace with the approved exact disclosure, or remove the unsupported bank-partner wording until a canonical legal disclosure is available. No placeholder may ship on the production application journey.

---

### WEB-05 — Public claims have multiple content authorities and are already drifting

| Field | Value |
|---|---|
| Lane | Public Website / SEO / Claim Governance |
| Severity | `P1` |
| Status | `PARTIAL — homepage authority improved; public affiliate/partner claims remain outside canonical claim governance` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |
| Primary files | `client/src/lib/site-content.ts`; `client/src/pages/Home.tsx`; `server/ssr/home.ts`; `server/ssr/pages.ts`; compare/help/legal content |

**Finding**  
`site-content.ts` declares itself the canonical public marketing-claim contract, but major pages and SSR files still hardcode statistics, savings claims, testimonials, contract claims, and offer language independently. Current live HTML and source show materially different claim sets across routes. Examples include a hardcoded homepage fees-identified statistic outside the canonical stats object and multiple different savings ranges on Statement Upload, Estimate, comparison and other pages.

**Required correction**  
Create one versioned claim registry/provenance contract for commercial claims used by client pages, SSR, FAQ/help, sales content and AI knowledge. Claims should carry source/effective date/qualifiers and fail review when unsupported or contradictory.

---

### WEB-06 — Current public accessibility/performance certification is not executable evidence

| Field | Value |
|---|---|
| Lane | Public Website / UX / Accessibility / Performance |
| Severity | `EVIDENCE` |
| Status | `OPEN` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |

**Finding / gap**  
The repository contains historical visual QA and an SEO crawler, but no current Axe/Pa11y/Lighthouse-style accessibility/performance gate was found. Source contains many good accessibility practices, but that does not prove keyboard order, contrast, focus behavior, responsive overflow, CLS/LCP/INP, console errors, or real mobile usability on the current deployed build.

**Required evidence**  
Interactive browser certification at representative mobile/desktop widths plus automated accessibility/performance measurements on the final candidate.

---

### INB-E01 — Production inbound assignment policy is not proven from GitHub

| Field | Value |
|---|---|
| Lane | Public Website / Inbound Sales Handoff |
| Severity | `EVIDENCE` |
| Status | `OPEN` |
| Discovered at SHA | `8bf8318762963eb2298aad386b136c7361de54e0` |

**Source result**  
The current inbound authority correctly creates assignment evidence, one request-owned task and an SLA deadline derived from source receipt time. Missing/invalid assignment policy or exhausted capacity leaves the request review-required instead of falsely claiming assignment.

**Evidence still required**  
GitHub does not contain the live value of `INBOUND_ASSIGNMENT_POLICY_JSON`. Production must prove that the actual reps, active flags, territories, capacities and ownership identifiers are configured and that one isolated inbound canary lands on the intended rep/task/SLA.

---

### Public-site positive controls verified in source

The following are retained as positive evidence, not findings:

- Public lead endpoints are rate-limited in production.
- JSON public intake is durably claimed before business mutation.
- Statement Upload has a stable client idempotency key, content fingerprint and durable command handoff.
- Statement file uploads are memory-bounded to 10 MB and MIME-filtered.
- Existing email-identified public contacts use a protected merge path that prevents public forms from overwriting DNC/status/readiness/GHL/compliance fields.
- Sales-form requests create request-owned work links and SLA evidence.
- Missing assignment authority does not silently report a successful assignment.
- Statement Upload, Get Started and Estimate allow PEWC to remain unchecked; the forced-consent defects are not universal.
- Production CSP no longer includes `unsafe-inline` for scripts; development retains it only for HMR.

### Public Website & Inbound closure state

**Current lane status: `NOT CERTIFIED — POST-MERGE RESIDUALS + INTERACTIVE RUNTIME EVIDENCE REQUIRED`.**

Source/HTTP audit is complete enough to identify the current structural defects above. Final lane certification still requires:

1. exact deployed SHA identity;
2. interactive desktop/mobile walkthrough of all public route families;
3. browser console/network evidence;
4. consent-banner accept/reject/custom network proof;
5. isolated form canaries proving contact/deal/ticket creation, dedupe, assignment, task/SLA and receipt replay;
6. failure/degraded rehearsal without real prospect sends;
7. current accessibility/performance measurements;
8. revalidation after remediation.


---

## 13. Stage 1 + Stage 2 Post-Merge Verification — 2026-10-01

**Audited current GitHub `main`:** `74a5307b2c4dcfd9e5e09fefa3ce1a14603e0827`  
**Commit title:** `Published your App`  
**Migration journal:** 317 entries; head `0312_contact_business_system_links`  
**Method:** independent current-tree review plus GitHub Actions evidence. No Replit messaging and no production mutation.

### 13.1 GL-01 / Stage 1 implementation result

Owning merged commit: `420f15f363480c3c422f98d36209964e85e7c4f3`.

The six GL-01 corrections are still present in the current publish-marked tree:

- `SEC-01`: internal deal proposal read now uses `isDashboardUser` plus `authorizeDealAccess()`.
- `SEC-02`: session-validity authority failure now returns `session_validation_unavailable` and protected guards fail closed with a retryable `503` rather than treating authority failure as valid.
- `REL-01`: GitHub-hosted `npm ci` now succeeds and the Replit-internal tarball-host defect is absent from the active lockfile. CI run `#407` completed dependency installation and locked-dependency policy successfully.
- `REL-02`: `scripts/run-pre-deploy.sh` now establishes the repository's provider-deny/zero-egress boundary around the server-required certification process rather than only enabling GHL fail-fast.
- `ADS-01`: offline-conversion export is now `admin`/`manager` only.
- `CFG-01`: checked-in `NIGHTLY_DISCOVERY_ENABLED`, `LEGACY_OUTREACH_ENABLED`, and `ORCHESTRATOR_ENABLED` are all `false`.

**Stage 1 implementation verdict:** `MERGED AND PRESERVED IN CURRENT HEAD`.

This is **not** the same as final Platform / Security / Release certification. Exact production identity, runtime role behavior, runtime environment overrides, and a green full current-head CI are still required.

### REL-04 — Current publish-marked head is release-red because the SFP structural regression test is stale against the safer current implementation

| Field | Value |
|---|---|
| Lane | Platform / Release + Prospecting / Enrichment |
| Severity | `P1` |
| Status | `OPEN — RELEASE GATE / TEST DRIFT` |
| Observed at SHA | `74a5307b2c4dcfd9e5e09fefa3ce1a14603e0827` |
| GitHub Actions | CI run `#407`, run id `36844957258` |
| Failing suite | `scripts/test-sfp-pipeline-correction.mjs` |

**Evidence**

The old clean-install blocker is fixed: dependency install, locked dependency policy, and manifest validation all passed. The deterministic suite then failed on two source-shape assertions.

A deeper current-tree inspection shows the intended safety properties are present:

1. `sfp-validation.ts` awaits `db.transaction(...)`, whose callback returns `openSfpCandidatePlaintext(...)`; plaintext remains inside the audited callback/transaction boundary and the boundary itself rejects plaintext escape. The static test still requires the obsolete literal shape `await openSfpCandidatePlaintext(`.
2. `sfp-validation.ts` calls `isCanonicallySuppressed([emailHash, contactEmailTokenHash], tx)` before provider use and again after provider wait. The static test regex expects a one-argument `isCanonicallySuppressed([...])` source shape and therefore fails when the transaction executor is passed as the second argument.

Because the static job failed, the external dependency/build-scan steps after it and the Integration Tests job did not complete.

**Interpretation**

This is a **release-gate/test-drift defect**, not currently evidence that the SFP runtime implementation lost the two safety properties. The test must be updated to assert the current behavioral/structural contract without pinning an obsolete call-site spelling. The safety assertions themselves must not be removed.

**Required closure**

- Update `scripts/test-sfp-pipeline-correction.mjs` so it recognizes the current audited transaction/plaintext-boundary call and the two-hash suppression call with its transaction executor.
- Keep assertions that plaintext cannot escape and that both candidate + contact hashes are suppression-checked before and after provider wait.
- Re-run the exact current-head CI through static, external-security, build-scan, and integration stages.

### 13.2 GL-02 / Stage 2 implementation result

Owning merged commit identified during the audit: `5885c35d582108cbb9f4aaaec17ef3a89d5de75e`.

**Confirmed landed and preserved**

- Merchant application PEWC is optional; required review/application assent remains separate.
- Free Analysis no longer requires marketing consent to proceed.
- Cookie consent now drives Google Consent Mode state and Meta initialization rather than being a storage-only banner.
- Explicit unchecked optional consent is no longer automatically converted into an opt-out in the corrected audited paths.
- Public clients audited by GL-02 now retain stable per-logical-submission idempotency keys instead of relying on a new generic key per HTTP retry.
- Callback intake now normalizes phone identity, reuses one unambiguous contact, and sends multiple-match ambiguity into durable review rather than picking/duplicating blindly.
- The merchant application `[Bank Partner]` placeholder is removed.
- Homepage headline/stat rendering now consumes the canonical public-site content registry rather than the old hard-coded count-up values.
- Estimate, Support, and Get Started now have bounded server-side schemas.

**Stage 2 implementation verdict:** `PARTIAL — MATERIAL RESIDUALS REMAIN`.

### WEB-01R — Public contract/ETF claim drift remains on affiliate/partner public surfaces

| Field | Value |
|---|---|
| Lane | Public Website / Commercial Claims |
| Severity | `P1` |
| Status | `OPEN` |
| Current evidence | `client/src/pages/AffiliateProgram.tsx`; `client/src/pages/PartnerBrandedPage.tsx` |

The core Get Started and Merchant Application blanket no-ETF copy was corrected, but current public source still contains:

- Affiliate Program sales talking point: `No long-term contracts or early termination fees`.
- Public partner-branded page: `Zero Risk to Switch` / `No early termination risk`.

These remain inconsistent with the governed Terms/Refund disclosures that some programs can carry 1–3 year terms and ETFs.

**Required closure:** route the affiliate/partner claims through the same conditional commercial-term authority and extend claim regression coverage beyond the two original pages.

### WEB-05R — Claim authority is still incomplete outside the homepage/core forms

| Field | Value |
|---|---|
| Lane | Public Website / Claim Governance |
| Severity | `P1` |
| Status | `OPEN` |
| Current evidence | `client/src/pages/PartnerBrandedPage.tsx`; `client/src/pages/AffiliateProgram.tsx`; `client/src/lib/site-content.ts` |

The canonical registry now owns the homepage statistics, but public partner/affiliate content still hard-codes broader commercial/savings claims such as `Most businesses save 20–40% when they switch`. The current `test-claim-authority.ts` does not prove that all public claim-bearing surfaces consume the canonical authority.

**Required closure:** extend canonical claim ownership/provenance and the scanner to the complete public route/content inventory rather than only the original Get Started/Merchant Application/Home examples.

### INB-03R — Strict server validation is still incomplete for callback and Free Analysis

| Field | Value |
|---|---|
| Lane | Public Website / Inbound Validation |
| Severity | `P1` |
| Status | `OPEN` |
| Current evidence | `server/routes/public.ts` callback handler; `server/routes/imports.ts` free-analysis handler |

Estimate, Support, and Get Started now use explicit bounded Zod schemas. Callback still destructures the public body before an equivalent strict bounded schema, and Free Analysis still begins from raw request fields with only a small required-field check before downstream processing.

**Required closure:** apply the GL-02 strict-schema contract to those remaining lead-intake handlers, including field bounds, normalized phone/email, enums/ranges, unexpected-field policy, and safe error responses.

### ATTR-01R — Raw Meta/Microsoft click-ID authority remains unresolved

| Field | Value |
|---|---|
| Lane | Public Website / Attribution / Ads |
| Severity | `P1` |
| Status | `OPEN` |
| Current evidence | `client/src/lib/utm.ts`; `shared/schema.ts`; booking attribution helper |

GL-02 improved GCLID persistence and now propagates GCLID/landing page through booking handoffs. `fbclid` and `msclkid`, however, are still reduced to presence booleans in the common helper rather than retained as governed raw click IDs. No matching canonical raw fields or explicit corrected presence-only attribution contract was found.

**Required closure:** either preserve the approved raw click IDs end-to-end for the later ads/offline-feedback authority, or explicitly define and test a different canonical contract that does not require them. Do not leave the implementation halfway between those models.

### WEB-07 — GL-02 regression suites are not registered in the canonical CI suite manifest

| Field | Value |
|---|---|
| Lane | Public Website / Release Assurance |
| Severity | `P1` |
| Status | `OPEN` |
| Current evidence | `scripts/ci-suite-manifest.ts` plus GL-02 test files |

GL-02 added focused tests including:

- `scripts/test-claim-authority.ts`
- `scripts/test-cookie-consent-tracking.ts`
- `scripts/test-consent-unchecked-not-optout.ts`
- `scripts/test-callback-identity.ts`
- `scripts/test-callback-review-disposable.ts`
- `scripts/test-public-route-validation.ts`

The current canonical CI suite manifest does not register these task-owned regression suites. A developer can therefore regress GL-02 behavior without the canonical current CI necessarily exercising those tests.

**Required closure:** register the applicable deterministic/static/disposable suites in the canonical manifest with correct isolation metadata; prove CI actually executes them.

### 13.3 Stage transition decision

**Historical decision — superseded for sequencing by the owner’s completion update in Section 14.** Preserve the findings and verification requirements below; they do not override the current instruction to proceed to Stage 3.

Do **not** mark Stage 2 certified and do **not** start Stage 3 as though the inbound/public baseline were closed.

The bounded next closure pass is:

1. close `WEB-01R` / `WEB-05R` public claim residuals;
2. close `INB-03R` callback + Free Analysis strict validation;
3. close or explicitly resolve `ATTR-01R` before the later Ads/Attribution lane;
4. register GL-02 regression tests (`WEB-07`);
5. repair `REL-04` stale SFP structural regression assertions without weakening the intended safety contract;
6. re-run current-head CI and Stage 1/2 source verification;
7. perform the remaining interactive browser/runtime canaries when that execution surface is available;
8. then begin Stage 3 CRM & Sales Operations against the corrected baseline.


---

## 14. Authoritative Go-Live Stage Sequence and Owner Update — 2026-10-01

**Authority:** Owner instruction in the current conversation.  
**Update type:** Program sequencing and reported task-completion status; no fresh source or runtime audit was performed for this update.  
**Ledger role:** Continuing reference and working record for all remaining Go-Live tasks and audits. Update this same document after every task and every audit.

### 14.1 Current progress

- **Stage 1:** Completed, fixed, and merged — owner confirmed.
- **Stage 2:** Completed, fixed, and merged — owner confirmed.
- **Stage 3:** Next audit stage; game plan authored 2026-10-01; live audit not yet performed. See Section 15.
- **Stages 4–8:** Remaining staged work; historical source reviews do not establish fresh end-to-end completion.
- **Stage 9:** Final certification intentionally deferred until prior product lanes have finished remediation. No release SHA freeze now.
- **Stage 10:** Final nine lane-specific GO/NO-GO verdicts remain pending.

The owner’s completion report supersedes the earlier instruction in Section 13.3 to defer Stage 3. Preserve the older residual findings and discovery evidence. Do not label them independently CLOSED merely from this status update. At the next relevant verification, append their fixing task/merge SHA, deployment evidence, regression results, and runtime evidence, or retain an explicit verification gap. This does not reopen owner-completed tasks merely because old evidence has not yet been refreshed.

### 14.2 Fixed sequence

| Stage | Audit / task stage | Required scope | Current program status |
|---|---|---|---|
| 1 | Current-state safety preflight | Confirm production is stable enough to test: auth is not catastrophically open; outbound/send gates paused; provider spend controlled; test data isolated; DB/Redis healthy enough; approximate running version known. This is an audit-safety check, with no SHA freeze. | COMPLETED / FIXED / MERGED — owner confirmed |
| 2 | Public website + inbound acquisition | Exercise every form, CTA, attribution path, consent state, validation/error behavior, CRM creation, assignment, dedupe, SLA/task creation, mobile behavior, and degraded integration case. | COMPLETED / FIXED / MERGED — owner confirmed |
| 3 | CRM + sales operations | Walk the authenticated CRM by real role; exercise actual routes, tabs, filters, buttons, mutations, loading/error/empty states, permissions, mobile/desktop, and the rep workflow. | NEXT |
| 4 | Prospecting/enrichment + campaigns/outbound | Prove #1998–#2002, Sunbiz, free enrichment, Serper/OpenAI/Apollo/Outscraper/ZeroBounce, the five verticals, campaign staging, enrollment, suppression, bounce/reply handling, worker profiles, and schedules end to end. | PENDING — historical partial source evidence retained |
| 5 | Application → underwriting → processor → MID | Exercise the merchant application lifecycle with protected test records and processor sandbox/canaries. | PENDING |
| 6 | Onboarding → support → processor activity → residuals → commissions/revenue | Prove the post-sale business closes the loop across these workflows. | PENDING |
| 7 | Ads, attribution and conversion measurement | Finish landing pages, UTM/click IDs, GA4, Google/Meta, offline conversions, consent behavior, deduplication, conversion taxonomy, budgets, and stop thresholds. | PENDING — historical partial source evidence retained |
| 8 | Sales training + AI operational readiness | Finalize the rep workflow, approved claims, talk tracks, AI permissions, coaching, certification, and documentation against the CRM that now exists. | PENDING |
| 9 | Platform / Security / Release FINAL certification | Stop feature changes; fix remaining security/release defects from all prior lanes; freeze one SHA; run full CI/security/migration/role/IDOR/build suites; publish that exact SHA; verify it live; verify workers/queues/Redis/integrations/kill switches; test rollback/recovery; bind all certification evidence to that release. | DEFERRED UNTIL PRIOR LANES COMPLETE |
| 10 | Final lane-specific GO/NO-GO | Issue nine separate verdicts using Section 8, each with its certified SHA and evidence. | PENDING |

Stage 4 covers both Prospecting & Enrichment and Campaigns & Outbound; those receive separate final verdicts. Stage 1 is the preliminary safety pass; Stage 9 provides the final Platform / Security / Release verdict. Thus ten ordered stages produce the nine final lane verdicts already listed in Section 8.

### 14.3 Mandatory update after every task and audit

1. Record the date, stage number, task/audit identity, exact SHA reviewed, and methods used. If no code was reviewed, say so; do not reuse an old SHA as though newly audited.
2. Append new findings with stable IDs and evidence. Preserve original discovery evidence and previously recorded fixes.
3. For existing findings, record task ownership, merge SHA, deployment identity, tests actually executed, runtime verification, and the resulting status. Distinguish owner-reported completion from independent verification.
4. Update the coverage register, current stage progress, next audit entry, and change log. Keep unexercised paths explicitly UNTESTED and unavailable evidence explicit.
5. Carry unresolved cross-lane items to the relevant later stage and final certification without silently losing them or restarting completed tasks without fresh evidence of a remaining defect.
6. Save the updated version to this same existing file after every task/audit. Preserve file identity and version history.
7. Keep Section 8 verdicts uncertified until lane evidence and final release binding support them. Never substitute a single company-wide readiness claim for the nine verdicts.

**Next action when the Stage 3 audit is invoked:** Refresh repository/runtime identity and role inventory, then perform the authenticated CRM + sales operations audit. Record all resulting findings and coverage here. No live audit, production mutation, provider activation, or outbound action is authorized merely by this ledger-reference update.


---

## 15. Stage 3 CRM Audit and Redesign Game Plan — 2026-10-01

**Status:** `PLAN AUTHORED — LIVE AUDIT PENDING`.  
**Task:** Stage 3 game-plan authoring requested by the owner. No build task number assigned.  
**Plan:** [Liberty Bancard Stage 3 CRM Audit and Redesign Game Plan](https://chatgpt.com/space/page_bdb0fc8cc3bc8191bf890e19796ccbbc).  
**Companion file:** `LIBERTY_BANCARD_STAGE_3_CRM_AUDIT_AND_REDESIGN_GAMEPLAN.md`.  
**Methods:** Read the historical CRM UI/tab audit, canonical-source audit, execution roadmap, end-to-end lifecycle roadmap, and the current ledger. Designed the execution plan and proposed reconciliation from those references and the owner’s scope.  
**SHA reviewed during this authoring task:** None. Historical reference SHAs are labelled in the plan; the last independently audited baseline in Section 2 is unchanged.  
**Runtime/browser tests:** Not performed. No source, production, provider, outbound or permission changes made.

### 15.1 Execution passes

| Pass | Scope | Required evidence/output |
|---|---|---|
| 1 | Refresh current source/runtime identity and inventory all routes, navigation, tabs and actions | Full register with current denominator, roles, APIs, authority and lifecycle |
| 2 | Authenticated role walkthrough and direct route/API/action verification | Expected/actual, persisted effect, failure/retry and role/object access results |
| 3 | Controlled rep/manager sales journeys and data reconciliation | Workflow breaks, count/identity/ownership truth, click/time/performance baseline |
| 4 | Navigation reconciliation and UI/workflow design | Exact old-to-new route/tab/action map; shared design specification; desktop/mobile prototype |
| 5 | Prioritized bounded repairs, implementation and re-test | Task/merge/deployment/runtime evidence, regression coverage, updated ledger |

### 15.2 Proposed navigation

Initial candidates, pending current inventory and user-workflow validation:

- Work and Sales: My Day, People, Businesses, Pipeline, Inbox, Tasks/Calendar, Ready for Outreach, Statements/Proposals.
- Lead Operations: raw inventory/sources, imports, discovery, enrichment, identity review, classification, data quality, run history.
- Campaigns and Delivery: campaigns, sequences, audience/preflight, delivery analytics, deliverability.
- Merchant Operations: applications, underwriting, boarding/onboarding, portfolio, support/RFIs, merchant health, residuals/commissions.
- Reporting: sales, team operations, acquisition, outreach, merchant/revenue.
- Administration and System: users/access, integrations, automation, queues/incidents, data integrity, consent/compliance, audit/release.
- Resources: knowledge, playbooks, collateral, training and scoped AI.

Preserve scoped partner/merchant portals and distinct partner/content/growth workspaces where the current inventory establishes their purpose. Keep a small daily navigation for agents, with contextual shortcuts to the canonical destination. Do not delete or merge modules merely from this proposal.

### 15.3 Coverage and closure requirements

Every current route, tab and action receives a tested or explicit blocked/untested/disposed result. Prove meaningful actions through the correct service and persisted outcome, not only clickability/toasts. Include ownership/role denials, direct URLs, invalid/stale/double/retry behavior, loaded/empty/error states, accessible desktop/mobile use, deep-link preservation and record/report consistency.

Stage 3 inspects the CRM surfaces for later-stage enrichment, campaign, application, processor, revenue and attribution workflows, but their full external operational proof stays in Stages 4–7. Training certification stays in Stage 8. Final release freeze/certification stays in Stage 9. Final nine lane verdicts remain uncertified.

**Next:** Run the Stage 3 current repository and authenticated CRM audit using the linked game plan; append findings with current source/runtime evidence. No audit results or independent closures are inferred from writing this plan.


---

## 16. Stage 3 Reference Audit Reconciliation and GHL Sync Instruction — 2026-10-01

**Status:** `PLAN UPDATED — REFERENCE FINDINGS UNVERIFIED`.  
**Owner instruction:** Use the two attached dashboard audits ONLY for reference; add a bottom section requiring verification and reconciliation of all findings. Keep outbound emails paused without turning GHL sync off.  
**Plan updated:** Section 13 of [Stage 3 CRM Audit and Redesign Game Plan](https://chatgpt.com/space/page_bdb0fc8cc3bc8191bf890e19796ccbbc), plus the opening operating-posture paragraph.  
**Sources read:** `Liberty Bancard — Dashboard Audit: Findings, Bugs & Fix List.docx`; `What's Broken (Oct 2026).docx`. Both are source claims, not current independent verification.  
**Source/runtime audit SHA:** None for this document update. No authenticated CRM/GHL testing, production configuration changes, cleanup or sends performed.

### 16.1 Required operating posture

- Outbound email stays paused across CRM and GHL-triggered paths.
- GHL data sync stays enabled and operational as a separate capability. Check actual effective configuration, worker progress, mapping and receipts. If currently off, identify the defect and recovery path; do not falsely mark it active.
- Synchronization must not cause downstream email through tags/stages/workflow enrollment that bypasses the pause. Verify local transport and external workflow effects separately.
- UI must show separate truthful sync and sending states; stale/unavailable sync cannot be “All Systems Healthy.”
- Do not broadly enable killed jobs, publish workflows, raise sending caps, push raw inventory, or recreate reported fake opportunities from stale IDs.

### 16.2 Reference coverage added

The plan now explicitly crosswalks D1–D22, DEV-23–DEV-29, the reported miswired Delete Contact control, the developer P0-05 relationship-view requirement, G1–G11, all mirror comparisons, remaining section/route observations, claimed positive tests, sample-quality/scoring/activity assertions, recommendations and reported cleanup mutations.

For each claim require current evidence and a disposition: confirmed, partly confirmed, fixed verified, not reproduced, disproved, expected control, proposed upgrade, superseded state, or blocked/untested. Preserve original source IDs and dates. Reassess severity rather than copying a reference’s P0 label. Link duplicate claims to one canonical ledger finding without losing source traceability.

### 16.3 Conflicts and recommendations requiring special handling

- Email tests denied by a deliberate pause may be correct; do not unpause to pass them.
- The full audit’s earlier 1,175 GHL opportunities and the developer recap’s later reported zero after deletion must be reconciled. Do not migrate/restore those reported fake deals. A reported restore window is not an irreversible purge.
- Refresh cleanup counts, archive/delete/pause results and stalled real-sequence memberships; attachments grant no new destructive cleanup authorization.
- Resolve the explicitly corrected ticket identities, task/deal/notification count scopes, failed-create-after-commit behavior and sending-identity removal/reseed history.
- Local and GHL stage/workflow/user counts need semantic ownership/mapping, not forced numerical equality.
- Sample plausibility does not establish database-wide validated identity, email validity, target fit or eligibility. QQ-domain/numeric-local-part alone does not prove a bogus email.
- Do not purge immutable consent/audit evidence merely because IP/UA resembles a test.
- Form builders, one-to-one composer, invite/deactivate/archive controls and the complete merchant relationship view require current capability assessment; missing preferred controls are not automatically defects.

**Next:** Execute Stage 3 using the updated plan and settle all reference claims with current evidence. Stage 3 remains live-audit pending; final lane verdicts and reviewed-source baseline are unchanged.


---

## 17. Stage 3 Live CRM and Repository Audit — 2026-10-01

**Status:** `DISCOVERY / ACCESSIBLE ADMIN WALKTHROUGH RECORDED — STAGE 3 NO-GO; REMEDIATION AND CERTIFICATION OPEN`.
**Owner authorization:** Proceed with the full updated Stage 3 CRM audit through the cloud browser and audit the repo. Two dashboard audits remain reference-only.
**Report:** [Stage 3 CRM Audit Results and Redesign Specification](https://chatgpt.com/space/page_50935c4368b48191a57998a7e69abe8d).
**Companion artifacts:** `LIBERTY_BANCARD_STAGE_3_CRM_AUDIT_RESULTS.md`, five CSV registers, `CRM_WORKSPACE_DESIGN_PROTOTYPE.html`, `STAGE_3_CRM_AUDIT_EVIDENCE.zip`; the existing Stage 3 game-plan file/Page is updated with the execution status.
**New implementation task numbers:** None assigned.

### 17.1 Current baseline and controls

| Item | Independently observed evidence |
|---|---|
| Repository/source | `scottpstevenson/Liberty-Bancard-Website-and-CRM`, main `37ad19cb8c73492dbc3bf37ed7b50739b48c3315` |
| Reviewed tree | `9c25c9807349a7d2d7fc7daeadaae03bf64fd8b4` |
| Production health | `ok`, SHA `119079c9b52e06c36e8b7a7666ba0aec5791fa23`, built `2026-10-01T21:29:51.616Z`, production |
| Serving-source gap | Reported runtime SHA differs from GitHub; fetch returned “not our ref.” Source conclusions remain bound to reviewed SHA; deployed equivalence unproved. |
| Live role | Admin only; other roles reviewed in source and remain untested live. |
| Outbound | Global pause observed; no sends or unpause. |
| GHL sync | Found already killed, last run 26 days ago; data writes gated by send authority in reviewed source. Required independent sync remains OPEN. This audit did not disable it. |
| Automations | Current UI 12/19 killed; old 12/20 denominator superseded. Enabled status alone does not prove fresh execution. |
| Source / production mutation | No source fixes, commit, PR, deployment, cleanup, permissions/settings change, invitation, worker activation or provider run. Browser navigation/filter/dialog and rejected blank-input tests only. |
| Final SHA freeze | NO; Stage 9 only. |

### 17.2 Coverage and proof boundaries

146 explicit dashboard registrations: all 142 static paths reached; contact, canonical-business and mobile-contact fixtures cover three of four parameterized patterns (**145/146 route patterns traversed**). Company Detail fixture/consumer remains missing. Primary hubs, 22 Contact Detail sections and 46 operator panels explored. Operator click navigation is broken; panel review used parent-preserving deep links.

542 browser observations are preserved with evidence IDs; 309 tab/panel observation-context rows and 8,704 visible-control context rows are inventory entries, **not unique capability counts or mutation passes**. Selected dialog/required-field and search/status-filter behavior proved. Successful persisted mutations, full role/object allow/deny, mobile responsive/touch and native GHL data-canary/no-downstream-email proof remain blocked/untested. No percentage of all actions or roles is claimed.

### 17.3 New Stage 3 finding register

| Finding | Severity / proof limit | Discovery | State |
|---|---|---|---|
| CRM3-01 | EVIDENCE / release blocker | Production cannot be bound to the reviewed source | OPEN |
| CRM3-02 | P1 | Stock CI cannot install its lockfile | OPEN |
| CRM3-03 | P1 | GHL sync is killed and data writes share the send pause | OPEN |
| CRM3-04 | P1 | Connected/configured badges falsely imply operational health | OPEN |
| CRM3-05 | P1 | Work counts and AI briefing contradict actionable tasks | OPEN |
| CRM3-06 | P1 | Permissions audit silently returns zero routes | OPEN |
| CRM3-07 | P1 | Queue Holds crashes on its response contract | OPEN |
| CRM3-08 | P1 | Provider Results tab routes back to Businesses | OPEN |
| CRM3-09 | P1 | Operator navigation exits its parent hub | OPEN |
| CRM3-10 | P2 | Financial aliases select the wrong report | OPEN |
| CRM3-11 | P1 | Scope mismatches make lists and reports disagree | OPEN |
| CRM3-12 | P1 | Terminal ROI represents test/new-lead equipment as deployed | OPEN |
| CRM3-13 | P1 | Readiness and contactability advice disagree with actual permission | OPEN |
| CRM3-14 | P1, source-confirmed; live role proof pending | Cold-lead collection and bulk re-engagement lack agent scope | OPEN |
| CRM3-15 | P1 | Re-engagement audience label and value math are unsupported | OPEN |
| CRM3-16 | P1 | Sequence report counts are multiplied by a join | OPEN |
| CRM3-17 | P1, source-confirmed; manager runtime pending | Manager enrollment fetch contract produces misleading empty counts | OPEN |
| CRM3-18 | P1 | Assignment and SLA handoff do not create an actionable rep queue | OPEN |
| CRM3-19 | P1 | Launch probes contain schema-invalid queries | OPEN |
| CRM3-20 | P1, shared Stage 4/9 dependency | Enrichment runtime owner and worker health are not proved | OPEN |
| CRM3-21 | P2 | Dense workspaces bury the rep's next action | OPEN |
| CRM3-22 | P2 | Large panels and bundles need bounded loading | OPEN |
| CRM3-23 | P2 | Provisioning exists but is hard to discover; deactivation must be proved | OPEN |
| CRM3-24 | P2 | Empty and filtered states confuse missing data with missing matches | OPEN |
| CRM3-25 | P1 / EVIDENCE | Security and training readiness remain explicit follow-up items | OPEN |
| CRM3-26 | P2, shared Stages 5–6 | Lifecycle relationship workspace is incomplete | OPEN |

Detailed reproduction, reviewed-source causes, acceptance tests and later-stage ownership are in the report and findings register. These rows are discovery entries, not merged/deployed/closed fixes. Source-only role concerns require controlled live/runtime proof; do not label the site catastrophically open from an empty permissions audit.

### 17.4 Material data and health reconciliations

- Settled Home: 3,073 pending / 3,072 overdue; briefing 3,082 overdue; Tasks one future-due unassigned inbound follow-up. KPI/briefing predicates and AI prompt differ from active task storage.
- Production People default: 153,980; all-class email-health total: 154,382, including 402 Test. Production pipeline zero versus legacy/all-scope 1,572 deals needs explicit scope, not fake-deal restoration.
- GHL settings: 1,915 synced, 152,467 unsynced; read connection works, while killed/stale/error states contradict “All Systems Healthy.” Historical error totals are not asserted as current 24-hour failures.
- Sequence report step × enrollment join inflates counts. Reported 2,097 stalled / roughly 2,040 Referral Flywheel rows are not proved unique real contacts. No cleanup/resume based on them.
- Queue Holds response record/array mismatch crashes; Provider Results URL allowlist omission selects Businesses; operator view clicks lose parent hub tab; financial aliases select Revenue.

### 17.5 Validation evidence

Stock GitHub run 36926922128 / Static Checks job 110586426532 fails at dependency installation; integration skipped. Four lockfile URLs target the private Replit registry. Local stock install also fails. An isolated audit dependency copy rewrote only those four URLs, retaining integrity; repository lockfile/source unchanged.

With the documented workaround: CRM #2056 UI contracts, protected-object static authority, CR-04 static authority, GHL #1629 route pause gates (71 assertions), and Task #1721 structural checks PASS; TypeScript PASS with expanded heap; production client/server build PASS with recorded warnings. Audit runtime Node 24.19.0/npm 11.9.0 differs from prescribed Node 22.22.x/npm 10.9.4. DB/Redis-backed role/mutation/full security suite not run. No final CI/release certification claimed.

### 17.6 Reference reconciliation and design decisions

All D1–D22, DEV-23–DEV-29, unnumbered Delete Contact, P0-05 relationship upgrade, G1–G11, additional positive/negative claims and cleanup families have 69 reference-register rows and explicit dispositions. Native GHL/profile/phone/analytics states and per-record historical cleanup receipts remain blocked. Current counts supersede older snapshots only where observed. Missing composer/invite claims are disproved as absolute UI/capability claims; operational send/invite proof remains open.

No immutable consent/audit logs purged, no user/contact/ticket/sequence/opportunity deletion, no Referral Flywheel clearing, no 532,626-row source job/ZeroBounce batch and no fake GHL-deal rehydration.

Proposed Work/Sales, Lead Operations, Campaigns/Delivery, Merchant Operations, Reporting, Admin/System and Resources groupings retain current canonical authorities and working URLs first. Every route has a proposed group/disposition. Contact Detail becomes five areas plus persistent History. The fictional-data design preview demonstrates contextual note/task and readable related-record links; it proves no live API behavior.

### 17.7 Next work and closure rule

1. Repair access/control/navigation/DTO defects and portable dependency CI; establish accessible serving-source provenance.
2. Reconcile metrics, classes, readiness, sequence math and current worker/probe evidence. Decouple and recover safe data sync with all outbound email held and downstream GHL no-send proof.
3. Implement the scoped core sales workspace; execute protected successful mutations and actual manager/two-agent/merchant/partner/anonymous/session tests.
4. Close Company Detail, mobile/keyboard/accessibility, failure/retry and measured performance gaps; retest the complete registers.
5. Append actual task/PR/merge, deployed build and runtime closure evidence after every task/audit. Preserve this discovery history and earlier stages.

**Stage 3 NO-GO remains.** Stage 3 is not fully executed/certified by broad admin route coverage. Stages 4–8 retain their operational obligations; Stage 9 freezes one exact release; Stage 10 issues nine separate lane verdicts.

---

## 18. Stage 3 consolidated implementation specification — 2026-10-02

**State:** Discovery/reconciliation at documented scope complete; implementation and full functional certification NOT COMPLETE. No repair was implemented, merged, deployed or closed in this consolidation. Stages 1–2 remain completed/fixed/merged in the user’s go-live sequence. Stage 3 remains without an unconditional GO.

**Current working document:** [Liberty Bancard — Stage 3 consolidated implementation specification](https://chatgpt.com/space/page_01d5de8fcd688191a708d3ce9474077c). The accompanying file is `LIBERTY_BANCARD_STAGE_3_CONSOLIDATED_IMPLEMENTATION_SPEC.md`; evidence is `STAGE_3_CONSOLIDATED_EVIDENCE.zip`. Prior plan/report and their evidence remain historical.

### 18.1 Updated source and production baseline

- GitHub main / reviewed source: `51edb7fb3b5698366faf05346f52cbb3a8461973`; tree `4e487f84ca16b002e306a9a190baf4778accf0c4`. Clean detached checkout; compared against original `37ad19cb8c73492dbc3bf37ed7b50739b48c3315`.
- Serving `/api/health`: `26a7da8bf96d80eb7a125bb6521e6140e3b5c8d5`, production, built `2026-10-02T10:36:34.721Z`, publishBuildId `ba1896d0-facc-417c-acb1-74c7ab780f89`, `ghlTransportFailFast=false`.
- GitHub fetch of serving commit returned No Commit Found (422). Serving source and reviewed main are not bound. Build identity now exists, superseding the older absence of a publishBuildId; provenance gap CRM3-01 remains open. This is not the Stage 9 SHA freeze.
- 19 source files changed, 566 additions/7 deletions, mainly SFP runtime/build identity/docs. CRM pages/routes/CSS, contacts/campaigns and package-lock unchanged. Confirmed old source cause anchors remain present; deployed equivalence still unproved.
- User restored cloud-browser sign-in. Scott admin session inspected; 26 fresh C-001–C-026 observations, including loading intermediates. Only settled observations support conclusions.

### 18.2 Consolidation accounting and dispositions

26 Stage 3 tracked entries + 69 reference claim families = 95 **source entries**, with substantial overlap. The specification assigns every entry one primary owner across **14 repair groups** and **four implementation tasks**. Neither 95 nor 14 is a verified unique defect total. Design proposals and pending claims are explicitly separate from confirmed causes.

The original 69 reference dispositions are preserved: 7 confirmed, 19 partial, 6 disproved, 20 blocked/untested, 3 superseded, 4 expected controls, 8 upgrades, 1 not reproduced, 1 declined recommendation. Fresh checks strengthen several rows without proving every subclaim. The bottom reference crosswalk retains all 69 claims and exact evidence/next actions. No unverified historical action is silently closed by count agreement or code existence.

The complete proposal includes all 146 dashboard route patterns and 309 observed panel entries. It preserves role boundaries, query/object context and legacy compatibility; proposes nine principal employee destinations plus Administration/Resources; five-area Contact and Lead Ops views; five Admin groups; shared metric authorities; exact current Liberty tokens/layout/typography; prioritized workflow upgrades and action acceptance contracts.

### 18.3 Fresh confirmed observations

- CRM3-06: Permissions still reports 0 of 0 registered API routes. Express 5 source uses `_router` extraction.
- CRM3-07: Queue Holds still crashes; visible error `(t.desiredLogicalHolds ?? []).map is not a function`. Source UI expects array while coordinator returns Record.
- CRM3-08: Provider Results click changes URL but Businesses stays selected. Source valid-tab list omits provider-results.
- CRM3-09: Worker Heartbeats click loses `tab=monitor`; System Readiness becomes selected.
- CRM3-10: Forecasting and Terminal ROI aliases both select Revenue. Source expects `financialTab`.
- CRM3-05: Home pending 3,075 / overdue 3,072; briefing overdue 3,082 with AI saying no immediate overdue alerts; settled Tasks shows 3 pending unassigned due October 6. Shared scope/status/deletion/asOf reconciliation still needed.
- CRM3-11: Contacts All/KPI 154,407 vs Production 154,005 and Test 402. Home production total 154,005. Different populations are real; same-label/scoped metrics must not obscure them.
- CRM3-13: Contact #159443 internal no-email placeholder earns 25/25 email readiness points while NBA correctly blocks global pause. Data readiness and send permission require separate truthful UI.
- CRM3-18: Current pipeline 2 and task 3 records are unassigned. Pipeline records display Liberty QATest; classification/intended fixture/archive receipts remain pending before any cleanup. Contact shows 3 linked deals vs 2 active pipeline; do not force unlike counts equal.
- CRM3-03/04: GHL Sync killed. Registry 19 automations / 12 killed. Integration says All Systems Healthy while entity rows have stale timestamps and 159 task / 6,929 deal / 1,174 company / 68,549 contact errors. Displayed counters are not unique current failed objects. Sync 1,915 / 154,407 and unsynced 152,492 use unclear predicates; another count 154,411 has unclear asOf/scope.
- Mapping now shows 2/19 local resolved and 4 external stages. Won/lost display same shortened external identifier; full IDs/semantic trigger behavior unverified. GHL stage counts are not required to equal local stage counts.
- CRM3-20: recent active enrichment zero-record run does not prove runtime ownership or queue/provider success. Later Stage 4/9 receipts remain required.

### 18.4 Proposed execution packages

| Task | Scope | Closure requirement |
| --- | --- | --- |
| A — shared authorities, access and sync policy | Source/build/CI; collection/bulk authorization; record and metric scope; enrollment aggregation; manager query contract; independent safe data sync | Portable clean CI, schema/scope tests, exact source/build mapping, fake transport no-send proof, reviewed native trigger safety before isolated sync enablement |
| B — rep workflow and recoverable lifecycle | Task/briefing/assignment/notifications; Inbox and permission; user provisioning/lifecycle; verified relationships; consent/privacy; archive/restore | Durable protected fixtures, eligible routing/dedupe/SLA receipts, correct permissions, cancellation/idempotency/cache/audit/restore proof |
| C1 — routes and shared UI foundation | Destination registry, legacy/tab compatibility, Liberty primitives, loading rules | All route/panel owners; role-safe aliases; tested responsive template; no premature shell cutover |
| C2 — daily sales workspace | Today, Records/contact, Pipeline, Inbox, Work; integrate A/B contracts | Durable rep actions, scoped metrics, real-role/mobile/state/context tests |
| C3 — Prospecting and Campaigns | Five Lead Ops areas, Provider Results, campaign local groups | Correct tabs/aliases and truthful staging/provider states; no-send/no-spend navigation |
| C4 — Merchant Operations and Reports | Lifecycle destinations, financial aliases, shared reporting layouts | Verified links and metric scopes; portal boundaries; Stage 5–6 execution remains separate |
| C5 — Administration, Resources and shell cutover | Five admin groups; Permissions/Queue Holds/Heartbeats; 11-entry shell | Functioning destinations first; safe roles/aliases; diagnostics; measured responsive/accessibility/performance proof |
| D — integrated reconciliation and Stage 3 closure | All reference findings, actual serving build, real roles/actions/metrics/mobile/degraded cases, native GHL/later-lane obligations | Complete evidence matrix and explicit scoped verdict; same document/ledger updated; remaining Stage 4–9 work retains separate owners |

Each task may contain small reviewed commits and its own checks; all testing is not deferred to D. Merged alone is not closed. No hard route removal without consumer inventory and compatibility retirement evidence. No identity merge by display name. No purge of immutable consent/audit records. No unsupported revenue/deliverability/stalled-count conclusions.

### 18.5 Safety and unproved coverage

Outbound communications remain intentionally paused. GHL data synchronization is required to work independently but is currently observed killed and shares the pause boundary. R03 / Task A defines capability separation, allowed noncommunicating fields, external trigger checks, independent sync worker and receipts. This session did not turn on workers, run Sync All, change a kill switch, purchase enrichment, enroll a sequence, send a message, change roles or delete/archive production data.

Real manager/agent/merchant/partner sessions, anonymous/IDOR negative mutations, narrow viewport/touch, durable CRUD/lifecycle, degraded integration responses, native GHL and no-send sync canaries remain unproved. The original 8,704 control observations are not unique button passes; 145/146 route reach and 309 panels are traversal evidence only. No new full CI/security/database/build/role certification is claimed.

**Next authorized scope:** use the consolidated document to execute the grouped implementation work with explicit acceptance and evidence. The current task produced a reviewable specification, not a production release. Stage 3 cannot receive unconditional GO while these workflow/access/sync/metric defects or critical coverage gaps remain. Later Stage 9 certifies one frozen release; Stage 10 issues nine lane verdicts.


## 19. Stage 3 delivery sizing revision — 2026-10-02

The owner requested that the oversized navigation/design task be split. Task C is now a parent scope with five execution tasks C1–C5. A, B and D retain their existing scopes, producing eight proposed execution tasks in total. No Replit task IDs are assigned by this revision.

The consolidated specification Section 10 now contains exact delivery boundaries, source-finding slices, dependencies, acceptance/handoff evidence and staged cutover gates. C1 establishes ownership/components; C2 migrates daily sales; C3 Prospecting/Campaigns; C4 Merchant Operations/Reports; C5 Administration/Resources and final shell cutover. A/B retain backend authority and workflow repairs; C tasks integrate these rather than duplicate them. D verifies the combined serving build after each preceding task has already passed its own checks.

Coverage remains 26 Stage 3 entries plus 69 reference-audit entries, 95 traceable source entries in 14 repair groups. Original dispositions, code anchors, route/panel inventories and closure obligations are preserved. The 146 route patterns and 309 observed panel entries are inventories, not unique screens or functional passes. Splitting C adds no findings and closes none.

The interactive Liberty preview is a design draft using sample data. Its local navigation, notes/tasks/drafts and shared sample counts are not production verification. No source code, runtime setting, GHL switch, outbound gate, provider job, role or production record was changed by this planning revision. Outbound stays paused; safe GHL data sync remains an independent repair requirement. No new live audit or CI certification is claimed.

Next implementation order: agree A/C1 contracts → relevant B contracts and C2 → C3/C4 → C5 guarded shell cutover → D integrated Stage 3 verification. Stage 9 release freeze and Stage 10 lane verdicts remain separate. Update this ledger and the consolidated specification after each task/audit; merged is not closed without the required runtime receipts.


## 20. GHL repair follow-up — 2026-10-02

Fresh repo main: 07898f15d242a8e75aae4aef7ad89b223c7912b9. GHL repairs: 2b276db and 7e9b8425b6ab61c454b59b9a8d8f315bd0dd4d68. Public health now reports the latter SHA, production environment, builtAt 2026-10-02T16:51:26.540Z and publishBuildId 7d09a107-0a12-41ac-9f36-06b6d7f04757. That serving commit is accessible in fetched history; the earlier source mismatch is historical for the old build. Health alone does not prove import/worker completion or pause/control settings.

The current incoming contact repair is one-way GHL → Liberty database: preserve nonblank values, fill missing details, add identifiable unmatched contacts, exact ID/email collision checks, leased/hash/idempotent preview/apply and a local-only no-echo writer. It does not update GHL records, qualify recipients or establish canonical business links/consent. Native-workflow review is not an incoming-read/local-import prerequisite. Separate optional provider-write controls exist but must not be enabled merely to meet incoming requirements.

CRM3-03 is source-remediated with runtime closure pending. CRM3-04 is partially source-remediated; the broad healthy label is replaced with a health-probe label and timestamp. REF-008/009/069 receive qualified follow-up dispositions in the report. GHL runtime fencing improves the GHL slice of CRM3-20 but does not verify SFP enrichment. R06 metric denominators/backlog eligibility, semantic mappings, REF-003 create behavior and native/later-lane claims remain open. No finding is fully runtime-closed from this source review.

Six focused suites rerun and passed: capability policy, truth utilities, inbound sanitization/identity, incoming route guards (42 middleware + 5 input checks), isolated runtime boundary and incoming UI static states (10 checks). Used available dependencies, test mode and a nonworking localhost database URL; no production/provider writes or worker activation. No migrated disposable DB was available for integration certification. No full CI/build or signed-in live browser check is claimed.

Section 12 of the consolidated specification owns the detailed source trace, revised dispositions and exact remaining proof. Task A now verifies/reconciles the implemented incoming flow rather than rebuilds separation. C5 reuses the new components and separates Incoming contact updates / Optional GHL writes / Outbound communications. D verifies production actual counts, durable fields and no echo/send/enrollment. All 95 source entries and 14 repair groups remain; eight execution tasks remain. Original sections 18–19 observations are historical where Section 20/Report Section 12 supersede them.


## 21. Stage 3 current live/source verification — 2026-10-02

Stage 3 remains **OPEN / NOT CERTIFIED**. Current report Section 13 supersedes conflicting older Section 18–20/baseline dispositions. Reviewed main 74c15805a5cbdb3e0a82183c8c56104999075671; serving SHA 4cd62b589cef10a773909414aebe9e71d164dfd8 is accessible, content-equivalent to HEAD, built 2026-10-02T20:12:06.875Z; publishBuildId 88034800-7804-4deb-8a1a-be20a2c279fd. The earlier inaccessible serving-source finding is superseded for this build, but private lockfile install fails current npm ci. No Stage 9 freeze or release certification.

**22 distinct confirmed repair causes** are documented with current source destinations, specific evidence, exact repairs and task mapping. This is a bounded confirmed register, not a final unique-defect count across every composite claim. All 26 Stage 3 +69 reference rows (95 source entries), 14 repair groups and eight tasks A/B/C1–C5/D remain. New repair causes: incoming GHL pagination failure, consent event-kind mislabeling, Knowledge source-list invalid Drizzle call, workflow create/update/run management-role omission. Sequence FK deletion and report join multiplication are reproduced using actual methods/SQL on disposable fixtures. Notification target-resolution and fixed sequence runtime copy sharpen prior reference claims.

**Verified repaired:** Provider Results click/deep-link/reload selects its actual panel; CRM3-08 navigation slice closed. Current incoming GHL control is Enabled, outbound Paused, proposal auto-send Hold for Review. One-way incoming separation and health-probe wording are observed live; do not rebuild them or globally unpause. Current persisted incoming run b9289cb4-c35e-4930-925a-f66ff03a08a2 failed after reading 3,994 with GHL_INBOUND_PAGINATION_INVALID and 0 actual updates/additions. Successful durable import/webhook receipt/no-echo remains open.

Actual contact archive/restore persists with two audit receipts; governed disposable test-class deletion snapshot/preview/execute succeeds with idempotent retry and production-class denial. Those prove actual components/handlers, not all production UI actions. Workflow Edit/Cancel, contact search/menu and selected tabs work; no production Save/Delete/Run/activation was submitted.

All 40 previously unresolved reference entries now have individual current dispositions and attempted evidence checks in report Section 13. Native GHL sign-in did not complete; native profile/token/campaign/channel/historical opportunity claims remain blocked. Historical cleanup/identity fixes require exact immutable IDs and receipts, not population-count guesses. Composite partial rows remain qualified; no assertion that all 40 or every tab/button/role/mobile flow was verified.

Focused GHL/inbox/consent tests pass; separate disposable tests reproduce counts/schema/query/guard/FK defects and prove safe contact lifecycle handlers. Audit-only public dependency directory and PGlite current-schema fixture were used after stock install failed. Node/runtime differs from declared supported versions; no full canonical migration, stock CI, build, native PostgreSQL concurrency or live role suite certified. No repository source/lockfile modification, merge, deployment, provider send, enrollment, purchase or production purge.

Keep 11 proposed destinations and exact Liberty design tokens/layout contract; retain C1–C5 delivery split. Amend A for pagination and workflow authority, B for actual handlers/consent/knowledge/notification/sequence policies, C3 for runtime count/truth, C4 for actual financial semantics, C5 for diagnostics/error states. D must prove final actual serving build with real roles, protected durable UI fixtures, mobile, degraded cases, same-scope metrics and no-send/no-echo receipts. Stages 1–2 remain recorded completed; no later lane certified by this audit. Update ledger/report after each task and audit.


## 22. Stage 3 Task A/B master prompts and current-source preflight — 2026-10-02

Created two master Replit preflight+build prompts grounded in a fresh clone of main 74c15805a5cbdb3e0a82183c8c56104999075671 and current handler/authority/CI source inspection. Serving health has changed to 1fe28bc0d1ff9ad86e777c96b67902701f159fd8, built 2026-10-02T21:40:33.861Z, publish ID a17e3a59-81fe-4ad6-80ab-0b2b27b8ec61; reported commit fetch fails not our ref. Prior 4cd62b source equivalence is historical, not current certification. A must reconcile current Replit serving source/lockfile/build receipts; safe reviewed source work continues with explicit provenance limits.

Task A owns reproducible lockfile/CI, shared contact/task/report authority, cold-lead and workflow authorization, sequence aggregation/manager read, financial truth and existing incoming pagination/no-echo repair. Task B consumes A contracts and owns durable tasks/briefing/routing/SLA/notifications, readiness/inbox drafts, consent/privacy request states, recoverable contact/sequence/campaign/ticket/user lifecycle, relationships/workflow consumer actions and actual Knowledge SQL/error repair. Full UI/navigation/token rollout remains C1–C5; native/historical/integrated obligations remain D/later stages. All assigned confirmed/partial/unverified/disproved/upgrade/history rows retain individual proof requirements and exact owner boundaries.

Prompts: LIBERTY_STAGE3_TASK_A_PREFLIGHT_BUILD_MASTER_PROMPT.md; LIBERTY_STAGE3_TASK_B_PREFLIGHT_BUILD_MASTER_PROMPT.md. Both contain current-source VFC tables, kill lines, scope/files/implementation steps, rg checks, guarded PostgreSQL/Redis/session/actual-handler tests, desktop/mobile action readback, stock CI gates and mandatory ledger/report updates. No new full CI/migration/live browser mutation/repair/merge/deployment performed. No 95-defect claim or unsupported source-status recount. Outbound remains required Paused; incoming contact sync required Enabled; actual control state was not newly re-observed in authenticated UI this authoring pass. No sends/enrollment/spend/purge permitted. Stages 1–2 remain recorded complete; Stage 3 implementation/certification remains open.


## 23. Task #2061 review against original Stage 3 authority audit — 2026-10-03

Reviewed attached Stage 3 Authority Repairs task against freshly fetched main 7fd447ada822cdd363d567e78f29b3a976714d05 and original Task A/specification. Current serving health c893360a439dbbc829a3bb6b66a11453fc41315d, built 2026-10-03T11:27:47.302Z, publish ID 6302bdac-3bd2-42be-bc7d-15008e9ed986; accessible serving/main trees equal 35a913ebfb017501a996da7c50aed257f1b8c0ce, no tracked diff. Previous inaccessible serving-source gap superseded for this build; artifact/install equivalence remains distinct.

Task scope aligned; all 33 original A parent rows retained, zero missing parent IDs, not 33 unique defects or all 95 verified. Retain newer GHL parser/no-echo, single numeric-path middleware, manager-owned read restriction and workflow schema/no-invented-owner qualifications. Real strict lock-policy inspection fails eight policy checks (4 private-host/4 HTTP, two per resolution). Pure pagination/source assertions pass; local-only fetch transport fixture follows 302. Node 24/npm 11 audit is supplemental, not supported stock CI; no full DB/Redis/session/browser mutation/source fix/merge/deploy performed. Replit clean-install/SRI receipt claims remain supplied and unrerun here.

Five bounded amendments: supply canonical report/ledger; A adopts shared task predicates in actual backend readers while B owns UI/AI/workflow; explicitly repair SequenceReport hardcoded pause/SMTP statements; fix false replit_direct enrolled accounting and action-before-tag authority; reject unvalidated incoming HTTP redirects with actual fake-service fixtures. Details and copy-paste addendum in LIBERTY_TASK_2061_REPO_AND_ORIGINAL_AUDIT_REVIEW.md. No new tasks/defect totals or C navigation scope expansion. Keep outbound Paused, incoming Enabled/no-echo and proposals Hold for Review; controls not newly authenticated-observed. Apply addendum, build same #2061, then update ledger/report with real gates and source-fixed/tested/merged/deployed/live outcomes. Stage 3 remains open; original 95 findings and all later owners retained.

## 24. Stage 3 A intermediate workspace implementation — 2026-10-03

**Stage 3 OPEN. Task A INCOMPLETE / NOT RELEASE-READY.** No merge, deployment,
production DDL, sends/enrollment, provider spend, native writes, cleanup or worker
activation. Outbound Paused, incoming independently Enabled/no-echo and proposals
Hold for Review remain required policy; disposable incoming tests did not change
real controls. No repaired live/runtime control certification is asserted.

Receipts/commands/contracts/changed paths:
`.local/tasks/liberty-stage3-task-a-execution-receipts.md`. Supported Node22.22.0/
npm10.9.4 stock public-registry install, real-lock strict source policy, focused
actual session/DB/incoming-service/render fixtures, typecheck/build and manifest
validation pass. Security audit FAILS seven high Tailwind-chain findings
(GHSA-vfj7-8cjw-p6xm includes public latest braces3.0.3); stock static CI separately
previously failed the baseline SFP assertion `assertPaidBudgetAuthorized`. The user
confirmed paid approval and paid limits were intentionally removed. The stale
expectation now checks their absence, retaining activation/reservation/dispatch
checks; the focused source suite passes all 21 assertions. No runtime paid gate or
limit was restored; complete stock jobs remain uncertified. No major package
downgrade/migration or policy exception was silently applied. Both full stock jobs,
exhaustive A gates and repaired deployment provenance remain pending.

All original 95 findings/evidence qualifications remain above. This table retains
the 33 original A parent IDs individually; none is a blanket composite closure.
Expanded outcome/proof and remaining owners are also appended to the exact
supplied canonical specification, not substituted by an older audit.

| Original A parent | Workspace outcome / bounded proof | Remaining obligation and owner |
| --- | --- | --- |
| CRM3-01 | Dirty source/manifest/lock and successful local artifact identified; prior serving build predates repairs. | A clean final source; D/platform repaired serving artifact/install/live equivalence. |
| CRM3-02 | Portable npm-generated lock, supported stock install, strict real-lock and policy/inventory tests PASS; audit FAIL. Stale paid-approval SFP expectation corrected, focused 21-assertion PASS; complete stock jobs remain uncertified. | A approved dependency remediation/full required CI; historic install failure not reproduced. |
| CRM3-03 | Existing inbound parser/no-echo preserved; actual fake GET service/epoch/lease/webhook/replay PASS; redirect denied. Create recovery source only. | A timeout/429/retry and create fault matrix; B consumers; D native/history/fleet. |
| CRM3-04 | Typed configured/pause/unknown/error runtime facts; 27 static permutations + failed read PASS; no hardcoded SMTP/compliance claims. | A interacting UI/owner map; D actual worker/native/probe/delivery evidence. |
| CRM3-05 | Shared task predicate/state/metric adopted by storage/routes/overview/report/briefing; static same-fixture list/metric/deletion/state/asOf DB comparison PASS. | A full cross-reader snapshots/class/archive/owner/timezone; B UI/AI factual/fallback/actions/assignment/SLA/notifications; D history. |
| CRM3-11 | Scoped cold rows/count before pagination; owned/unassigned/nonowned real handler fixture PASS; differing populations retained. | A count/facet/export/cache/analytics completeness; C2/C4; D historic IDs. |
| CRM3-12 | Full recommendation forecast + bounded details; 5,001 additional rows PASS; actual deployment/cash/paid-off unavailable. | A missing/empty/archive/test/order/shipment permutations; Stage 6 verified actual ledger. |
| CRM3-14 | Whole selected-set locks/recheck; role/CSRF/mixed denial/retry no tags/enrolled=0 PASS; numeric guard retained. | A races/full action/fake false bridge/true receipt cases; B lifecycle; Stage 9. |
| CRM3-15 | Unsupported audience dollars removed; actual handler has no estimatedValue. | A browser/labels; C2/C4; audience is not send eligibility or revenue. |
| CRM3-16 | Actual DB 2 steps/3 active+cancelled+completed memberships/1 unique contact PASS, not fanout six. | A zero-child/manager/browser fixtures; B archive/cancel; C3; D native history. |
| CRM3-17 | Owned manager endpoint/client and error/loading labels; no global access expansion. | A real owned-manager/global-denied/API-failure/browser proof; B lifecycle. |
| CRM3-20 | Stored incoming lease/checkpoint/update truth separated from worker consumption; unknown explicit. | A complete owner map/browser; D/Stage 4 enrichment runtime receipts. |
| CRM3-23 | No A provisioning/invitation/deactivation feature or closure. | B lifecycle/discoverability; C5; Stage 9. |
| CRM3-25 | Actual session workflow role/input denial and zero workflow run/provider fetch PASS only. | A positive/executor/race matrix; B Knowledge; C5/D/Stages 8–9. |
| REF-003 | Local durable 202 degraded identity/canonical incomplete replay source implemented; accepted/completed no-op. | A full postcommit/link/task/effect/audit/queue/concurrent fault fixtures; B UI; D original incident. |
| REF-006 | Class/archive/link populations retained; no historic empty-pipeline reproduction. | A object/deal metric parity; C2/C4; D immutable same-scope deal IDs. |
| REF-008 | Actual incoming service/no-echo and redirect refusal PASS; historic root cause not inferred. | A timeout/429/retry; D sanitized original metadata/backlog/stage semantics. |
| REF-009 | No activations or historical 12/20-as-current claim; checkpoint isn't fleet health. | A exact source/owner map; D/Stage 4 heartbeat/ownership/checkpoint. |
| REF-011 | DB fanout correction and typed runtime static permutations PASS; active not permission/delivery. | A remaining zero/manager/browser; B lifecycle; C3; D native39/stalled identities. |
| REF-014 | No paid model/index request or invented consumption proof. | B Knowledge; D actual runtime; Stage 8 model/index receipts. |
| REF-015 | Disposable test Redis is not production-worker receipt; connected≠consumed retained. | A remaining map; D production Redis/queue/worker proof. |
| REF-017 | Incoming/manual/webhook observation separated; no native workflow IDs guessed. | A owner labels; D/Stage 4 approved dependency inventory. |
| REF-018 | Production/synthetic-QA filters preserved; no production cleanup/current historical-count assertion. | A exhaustive class/archive fixtures; B users; D historic/live census. |
| REF-020 | Disproved “no Invite” qualification retained; no invite sent. | B discoverability/lifecycle; C5/Stage 9. |
| REF-029 | Membership vs contact counters/paused meaning corrected; no cleanup performed. | A remaining counter fixtures; B governed cleanup; Stage 4. |
| REF-041 | External/local stage counts not forced equal; no mapping guessed. | D native semantic approval/Stage 4; A unmapped-label browser proof. |
| REF-046 | Old6,471/superseded UI not current denominator; scoped source only. | A object/event metric labels; C2/C4; D current view. |
| REF-052 | Six actual password-session roles and changed route/CSRF denial PASS, not universal auth/2FA/deactivation. | A full registered-server/browser gates; B lifecycle; Stage 9. |
| REF-059 | Rejected plausibility→83% validity inference retained; no purge. | Stage 5/8 evidence, no new A cause. |
| REF-060 | QQ/numeric invalidity inference rejected; identities preserved. | Validation authority, not appearance-based purge. |
| REF-061 | No immutable original email/name examples or cleanup. | D historic IDs; B/C2 separately assigned display. |
| REF-066 | Actual membership/contact distinction proved, not old2,094/2,097/~2,040 native census. | A remaining fixture matrix; B governed lifecycle; D history. |
| REF-069 | Local no-echo/preservation fixtures PASS; native contact/stage/user/form/phone inventory not obtained. | A remaining runtime/pagination; D native/Stage 4; no numerical parity. |

Assigned subclaims: REF-016/V18 SMTP/global pause/reason unknown/error static proof
is partial A evidence, not cap/delivery closure (A interacting UI; D/Stage4 actual
delivery; C3). REF-056/V22 workflow role/ID/zero-run session fixture PASS is not
complete executor/security readiness (A remaining cases; B editor; Stage9).
REF-037/038/065 native deletion/restore and REF-064/067 actor/time/before-after
history remain D-owned and unverified. No composite findings or later stages
have been closed by these workspace tests.

## Latest Task A ledger update — 2026-10-03

**INCOMPLETE / NOT READY FOR REVIEW OR RELEASE.** Focused source tests do not
override failed stock CI/security or missing production/native/history evidence.
All 95 original finding IDs and their qualifications remain; the 33-parent
dispositions below supersede only the earlier intermediate A update.

Receipts: `.local/tasks/liberty-stage3-task-a-execution-receipts.md` and
`.local/tasks/stage3-a-final/`. HTTP = actual password-session/CSRF/DB authority
handlers and contact/related-deal lock races; TASK = adopted backend task and
same-clock static-fixture cross-reader proof; SEQ = actual DB/owned-manager/error
reads; FIN = >5,000 full-population forecast/missing-value fixtures; CREATE =
registered writer/request faults and concurrent replay; GET = actual fake-service
incoming/redirect/timeout/429/checkpoint/lease/epoch/webhook/no-echo proof; UI =
typed renders plus signed-in desktop/phone viewport in existing desktop-view mode.
These are receipt labels, not new findings. Native mobile queues are unverified.

| Original A parent | Latest individual A outcome | Remaining owner / qualification |
| --- | --- | --- |
| CRM3-01 | Final isolated build/typecheck/inventory/redacting scan PASS; uncommitted source identity recorded. | A clean candidate/full gates; D/platform repaired serving artifact/install/live proof. |
| CRM3-02 | Stock public install/real-lock policy PASS; writable-build 1/1 PASS; audit FAIL 7 high; nine unchanged-baseline API mismatches; integration clean/diff gate blocked. | A dependency remediation/full stock CI. Not release-ready. |
| CRM3-03 | GET/CREATE PASS, including later-page timeout/429 checkpoints and committed-identity recovery. | B consumers; D historic incident/native/fleet; A full stock gates. |
| CRM3-04 | UI PASS; runtime visible with zero identities; configuration/active state not permission, throughput or delivery. | D real probe/delivery/worker facts; C3 design. |
| CRM3-05 | TASK PASS for actual storage/list/overview/analytics/briefing adoption and class/archive/link/state/date parity. | B UI/AI input/fallback/actions/assignment/SLA/notifications; D history. Parent PARTIAL. |
| CRM3-11 | Shared scoped contact/deal scalar comparisons and HTTP owned/unassigned reads PASS. | A broader facet/export/cache matrix; C2/C4; D native immutable census. |
| CRM3-12 | FIN PASS; missing cost unavailable, archived/test excluded, rejected recommendation only forecast, actual deployment/cash null. | Stage 6 authoritative shipment/deployment/cash evidence. |
| CRM3-14 | HTTP PASS for complete mixed-set denial, contact/related-deal race rechecks, consent block and repeat enrolled=0; no deceptive tags/provider effects. | B lifecycle; Stage 9 broader security. No live enrollment added. |
| CRM3-15 | HTTP/UI PASS; unsupported audience dollars removed. | C2/C4 design; no revenue/consent/purge inference. |
| CRM3-16 | SEQ PASS: 2 steps/3 memberships/1 unique contact, zero children and terminal history. | B lifecycle; C3; D historical native identities/delivery. |
| CRM3-17 | SEQ PASS: owned manager read, global/other denial, injected failure not empty. | B lifecycle; A broader manager-card browser proof. |
| CRM3-20 | Typed stored source/owner mode/checkpoint/lease/freshness observations, not fleet consumption. | D/Stage 4 live fleet facts; A broader diagnostic UI. |
| CRM3-23 | No provisioning/invitation/deactivation feature or certification added. | B lifecycle/discoverability; C5; Stage 9. |
| CRM3-25 | HTTP workflow role/ID/zero-denied-run and valid empty-action management run PASS. | B editor/trigger/action work; Stage 9 full executor/security. |
| REF-003 | CREATE pre/postcommit/task/link/work-link/effect faults, stable identity/one task/concurrent retry and visible pending projection PASS. | D historic incident; B modal/workflow consumers. No provider delivery proof. |
| REF-006 | TASK and scoped contact/deal scalar comparisons PASS. | A broader facet/export/cache parity; D native linked same-scope IDs. |
| REF-008 | GET redirects/timeout/429/resume/replay PASS; incoming independently Enabled. | D historical metadata/backlog/approved stage semantics. |
| REF-009 | No worker activation or blanket healthy/consumed assertion. | D/Stage 4 exact current owner/heartbeat/checkpoint. |
| REF-011 | SEQ/UI fanout/zero/history/unknown/error proof PASS. | B lifecycle; C3; D native historic stalled identities/delivery. |
| REF-014 | No paid model/index call or claimed consumed-work proof. | B Knowledge; D observations; Stage 8. |
| REF-015 | Disposable Redis only supports isolated tests, not production health. | D live Redis/workers; A broader diagnostic map. |
| REF-017 | Incoming/manual/webhook sources distinct; no guessed workflow inventory. | D/Stage 4 approved native IDs; A broader owner-class UI. |
| REF-018 | Class/archive/owner fixtures PASS; synthetic-QA filters preserved; no production census/cleanup. | B users; D historical/live counts. |
| REF-020 | Disproved missing-Invite allegation retained; no invitation sent. | B lifecycle/discoverability; C5/Stage 9. |
| REF-029 | SEQ membership/contact/paused/terminal distinctions PASS; no cleanup. | B governed cleanup; Stage 4. Upgrade, not new cause. |
| REF-041 | No native/local stage equivalence or mapping inferred. | D native IDs/semantic approval; Stage 4; A broader unmapped UI. |
| REF-046 | Scoped scalar tests, not dated global inventory denominator. | A broader object/event labels; C2/C4; D current-view receipt. |
| REF-052 | Six real role sessions, CSRF/handler denial and signed-in report/cold UI PASS. | Stage 9 universal auth/2FA/deactivation; B lifecycle; A full stock server/browser gates. |
| REF-059 | Appearance-based validity inference rejected; no purge/reclassification. | Stage 5/8 validation authority. |
| REF-060 | QQ/numeric invalidity inference rejected; source identity preserved. | Validation authority, not appearance-based purge. |
| REF-061 | No immutable historical identity examples or raw identity rewrite. | D IDs/history; B/C2 display work. |
| REF-066 | Actual membership/contact distinction PASS, not dated native census equivalence. | B lifecycle; D immutable history. |
| REF-069 | GET local preserve/fill/create/dedupe/no-echo/continuation PASS. | D native contacts/stages/users/forms/phone inventory; Stage 4. |

REF-016/V18 UI runtime slice PASS does not close cap/delivery (D/Stage 4/C3).
REF-056/V22 HTTP slice PASS does not close editor/full executor/security (B/Stage 9).
REF-037/038/065 and REF-064/067 native deletion/restore/actor/time/before-after
obligations remain D-owned. No composite parent or later-stage finding is closed.
Outbound remains Paused, incoming independently Enabled, proposals Hold for Review.
No production deployment/DDL, real send/enrollment, native write, provider spend
or held-intent release was performed for these fixtures.

### Final scoped A handoff correction — 2026-10-03

User-confirmed implementation/focused-certification closure; no further unrelated
legacy test repair. **NOT RELEASE-READY:** full stock integration/server checks
remain failed. No deployment or live/Stage 3 certification. Preserve all original
95 findings and composite B/C/D/later-stage ownership. These individual corrections
supersede only the outdated cells of the preceding 33-parent A matrix; all other
rows and qualifications remain unchanged.

| Original A parent | Final A outcome / receipt | Remaining owner or qualification |
| --- | --- | --- |
| CRM3-01 | Implementation committed at 255d25bbbf6d014ed34a18ca5e46aae0be1278df; isolated typecheck/build/inventory/redacting scan PASS. | D/platform repaired serving/install/live proof; full CI remains blocked. |
| CRM3-02 | Supported public install, strict real-lock policy (939 fingerprints), API census, security (zero high/critical; 7 moderate/1 low), static 57/57 and writable-build 1/1 PASS. | Full integration fails at CR-06 Redis reservation; server fails at New-Lead Enrollment Policy B9/B22/B23. No full-CI or baseline-equivalence claim. |
| CRM3-11 | Same-clock scalar and actual session list/facet/cache/export population parity PASS; approved owned/unassigned scope preserved. | C2/C4 presentation; D immutable native census. |
| CRM3-17 | Manager owned-positive/global-and-other-denied PASS; signed-in read failure explicitly unavailable, not zero. | B lifecycle; no comprehensive work-queue UI claim. |
| CRM3-20 | Incoming observations distinct from explicit unavailable legacy GHL/enrichment/SLA/communications owners and native mapping; 27 permutations plus unavailable-read PASS. | D/Stage 4 actual fleet observations, not inferred consumption. |
| REF-006 | TASK/scalar and actual session list/facet/cache/export parity PASS; different populations named. | D native same-scope linked IDs. |
| REF-015 | Explicit unavailable legacy owner UI/render proof PASS; disposable Redis is not production queue-health proof. | D production Redis/worker observations. |
| REF-017 | Manual incoming/webhook facts distinguished; native mapping/legacy owners explicitly unavailable, never guessed. | D/Stage 4 native inventory. |
| REF-041 | Native mapping proof explicitly unavailable in diagnostics; no stage parity/semantics inferred. | D approved native IDs/semantics; Stage 4. |
| REF-046 | Scoped scalar/list/facet/export/cache populations tested; censuses distinct from performed-action/event claims. | C2/C4 workspace; D current-view receipt. |
| REF-052 | Focused role/session/CSRF/denial and signed-in reporting browser proof PASS; full server-required job FAILED separately. | B lifecycle; Stage 9 universal auth/2FA/deactivation; full-CI release blocker. |

Receipts and exported-contract/path handoff:
`.local/tasks/liberty-stage3-task-a-execution-receipts.md`, final scoped section
and `stage3-a-final/handoff-*`. Existing original A rows not listed in this
correction retain their individually qualified outcomes, not blanket PASS.
Outbound remains Paused; incoming independently Enabled; proposals Hold for Review.
No production deployment/DDL, real send/enrollment, native write, provider spend
or held-intent release was performed.

## Task B implementation and acceptance checkpoint — 2026-10-06

**Stage3 Task B remains INCOMPLETE. No release/production deployment or company-wide readiness is certified.** Existing older ledger verdicts and historical/native/C/later-stage obligations remain unchanged.

Durable task/ticket commands, current routing identity and request-owned review fallback, namespaced versioned drafts, actor-local notification state/audiences/typed destinations, truthful factual snapshots, placeholder completeness, recoverable contact/account/sequence lifecycle, consent/privacy administration, contextual notes/company authorization, workflow concurrency/retained history and parameterized Knowledge repair have focused local measured receipts. Exact12-gate handoff and individually retained56 original outcomes: .local/tasks/liberty-stage3-task-b-local-handoff.md and .local/tasks/liberty-stage3-task-b-row-outcomes.md; specification Section13.7 embeds the56 fourth-cell outcomes.

Latest selected canonical disposable batch10/10 passed; account/auth2/2, installed-consent/provenance/child-retention1/1 and actual protected/public SSR Chromium1/1 passed separately. Existing-workspace canonical writable-build1/1 passed. Source policy948 packages and registered SSR120 layered rules passed. None is stock-install proof. Zero real sends/invitations/AI/provider spend/native GHL writes/enrollment/resume/production DDL/deployment. Incoming/no-echo authority preserved. Archive/restore and recoverable paused retirement remain available; permanent product erasure stays blocked independently of fixture labels.

Fresh blockers: clean stock install HTTP403 for security-blocked proxy-addr2.0.7, reproduced on baseline; full dependency audit1 critical/2 high, baseline production scope1 critical/1 high(proxy-addr/sharp); unchanged package/lock identities; deterministic-static SFP assertion missing verifyEmail(realEmail), reproduced on unchanged baseline. No bypass, suppressed failure, capability downgrade, package/lock rewrite or production action. Full clean-install canonical integration/server gates remain uncertified, with remaining acceptance work kept in Task B.

Next authorized step is an approved narrow dependency/security repair followed by stock install and remaining canonical acceptance; no automatic scope expansion or completed-task claim.


## Canonical execution continuation (supersedes the earlier stop for dependency approval)

Task B scope is retained: no dependency/lockfile upgrades and no unrelated assertion repair. C14 requires executing and reporting the canonical commands with baseline comparison, not widening this task until unrelated repository failures disappear. The earlier request to expand scope is withdrawn; no approval was received or assumed.

Both canonical guarded migration commands ran successfully against an empty owned PostgreSQL16 database and its reserved private Redis namespace. The actual canonical server wrapper reached seeded readiness on a nonce-proved127.0.0.1 listener. The server-required roster executed and stopped at CSV Import Reconciliation:97 assertions passed and2 provider-header deferral assertions failed. This is a measured failing gate, not a pass. The imports handler is unchanged relative to the comparison checkout; that source equality is not a fresh baseline runtime reproduction. Exact logs: /tmp/stage3-b-canonical-rehearsal-final.log and .local/tasks/liberty-stage3-task-b-canonical-rehearsal.json. Whole-disposable-DB and owned-process teardown had0 errors.

Canonical integration execution exposed B-owned fixture issues that bounded per-suite runs had not caught: nested Redis reservation, a desktop-view hard-navigation race, and global-count assertions on a shared canonical disposable DB. These are repaired without changing suite capabilities or weakening any product authority: fixtures reserve a new high-entropy descendant namespace; the browser waits for the actual Overview landing before reopening context; assertions count their own explicit actor/entity cohort. The private HTTP host/nonce now survives the existing child environment scrubber; tests prove provider credentials remain scrubbed. This prevents the canonical server wrapper from dropping the already-proved private-listener posture. No provider, auth, role or network permission was widened.


### Canonical B suite closure and related manual-intake correction
The full canonical deterministic-integration roster ran its first13 B suites successfully (not a filtered substitute): /tmp/stage3-b-canonical-integration-delivery.log. It then stopped at Stage3A Registered Session Authority and Metrics. Focused actual-handler diagnosis reproduced the failure in a fresh owned database and found a B-owned regression, not an unrelated baseline assertion: unknown-class manual first-party contact occurrences were refused instead of receiving the exact occurrence-owned management-review obligation.

The repair extends only the existing immutable-occurrence proof to manual_crm/dashboard with event_key manual:<request-id>, alongside the existing first-party form proof. Contact/deal production admission, assignment, archive denial, forged source rejection and external holds remain unchanged. The original A replay/fault/concurrency fixture now asserts the request→work link and verifies unknown classification is retained, contact admission is absent and canonical assignee remains null. This is directly related consumer-contract repair, not unrelated suite suppression. Pool fixture setup likewise declares its single-candidate precondition through real versioned membership commands while preserving users, past assignments and history.


## Final Task B completion-review receipt — 2026-10-06

**B implementation and bounded verification are ready for completion review. Whole-repository/release acceptance is NOT GREEN; no production or Stage3 certification is claimed.**

Latest canonical command: npx tsx .local/tasks/liberty-stage3-task-b-ci-rehearsal.ts --integration-only. It invokes the unchanged run-ci-suites.ts --capability deterministic-integration, with the full83-entry manifest and no filtered/capability changes. Both preceding run-guarded-canonical-migration.ts invocations passed on a new owned PostgreSQL16 database. The first21 canonical suites passed, including all13 Task B registered DB/session/browser suites, the related Task A actual-handler authority/retry/concurrency suite, three incoming/no-echo GHL suites, three CRO03A suites and BT12 integration. Suite22, South Florida Prospecting Corrections Certification, stopped at VFC-01b: its existing Task1999-only dirty-tree rule rejects14 current Task B/reporting/memory paths. This is an actual working-tree isolation rejection, not a passing suite or a demonstrated product regression. The remaining61 suites did not execute. No unrelated allowlist/assertion repair or capability reclassification was performed. Exact log: /tmp/stage3-b-canonical-final-acceptance.log; machine receipt: .local/tasks/liberty-stage3-task-b-canonical-integration.json. Whole-disposable infrastructure cleanup errors:0. The related manual-intake regression described above is fixed and its original fault/replay/concurrency consumer passes in this run; it is not being passed off as a baseline failure.

The earlier actual canonical server-required attempt remains a failing receipt: owned nonce-proved private server ready; CSV Import Reconciliation97 passed/2 provider-deferral failures; the remainder did not execute. No fresh baseline runtime reproduction is asserted for those2 failures. Source equality of the unchanged imports handler is explicitly weaker evidence. /tmp/stage3-b-canonical-rehearsal-final.log and .local/tasks/liberty-stage3-task-b-canonical-rehearsal.json retain the actual results.

Latest npm run check and git diff --check: exit0 (/tmp/stage3-b-final-acceptance-types.log). Certification environment scrubber regression and B static/source contracts: pass. Earlier actual canonical writable-build receipt passed with the existing installation; it is not a successful clean stock install. Stock install HTTP403, full audit1 critical/2 high and baseline-reproduced static verifyEmail(realEmail) assertion remain failed gates with their distinct comparisons preserved above. Source HEAD79d1175fed69c2d7cda23becd0d7035304e3ace0 plus the recorded Task B working-tree edits was tested; no clean merged/serving/deployed identity is asserted. Manifest SHA256ee31b22d58d5d1a03d7f2606560504ffdc160430021cf8fdc32ec6fe6ec4706c and lock SHA2563fa1797f812dff3117bdd95408b34fd7283618d7307d71e6272177bdc89e63c4 remain unchanged.

All56 individual retained original rows keep their dated claims and assigned owners. Their B fixtures establish bounded local outcomes only; composite parents and C/D/Stages4–9 historical/native/security/release obligations remain open. No duplicate follow-up is proposed for those already assigned downstream boundaries. Permanent contact erasure remains explicitly unavailable because the full retention contract has not been certified; this preserves protected evidence rather than treating a fixture label as disposal permission. Actual tested external transports/sends/invitations/AI/provider/native effects:0. Recovery does not release outbound holds. No main/shared workflow startup, production DDL/deployment, incoming-control toggle, dependency upgrade, lockfile change or Mockup Sandbox change occurred.


### Completion-validation role-guard repair and final measured pass
The first completion attempt passed API coverage and independent completion code review, but its configured npx tsx scripts/smoke-role-guards.ts command failed before route tests: a legacy source assertion required storage.archiveContact instead of the new fenced command. This was a directly related B consumer regression, not a baseline failure. The assertion now checks the actual archive command delegation and also forbids GHL deletion and DB deletion in its delegated service. A pre-import disposable PostgreSQL/Redis guard prevents this mutating script from using shared/default infrastructure.

The exact original role suite was then executed through the existing canonical dedicated launcher. Its stale archive/sequence positive and ownership-negative callers required real current principal/account/record version and command identity envelopes; they now submit those fields on the suite’s own records. Empty input400 is not treated as proof of ownership denial. The new sequence command’s non-disclosing ownership404 and unavailable seeded-note-context404 are asserted exactly; merchant/agent denials and retained-row/no-effect checks remain. No status wildcard or fixture bypass was added. Latest actual command: npx tsx scripts/run-sfp2060-predeploy-disposable.ts --only scripts/smoke-role-guards.ts. Exit0,139/139 role routes across anon/merchant/agent/manager/admin, stateful manager archive/restore and ownership checks passed;1/1 full selected suite, child/setup/teardown/launcher failures0. Exact log: /tmp/stage3-b-owned-role-guards2.log. Final type check and diff check exit0: /tmp/stage3-b-role-guards-types.log.

The existing registered role-guards validation now uses that SAME isolated launcher and exact SAME complete script. This changes infrastructure setup, not the suite’s server-required capability, selected assertions or acceptance outcome. Raw shared-preview mutation is no longer the configured validation path. Main-project rebase had only generated asset-list conflicts; incoming asset records were preserved and Task B downloads regenerated. Application code did not change in that rebase; the rebased type check also passed. Full repository install/security/static/CSV and original release limitations remain as recorded; this new role-gate pass does not erase them.

## C4 provisional implementation — no GO verdict

C4 remains incomplete.39 assigned routes/70 historical panels are presentation lineage, not passed controls. Current work and qualified source/compiled identities are recorded in `certification/stage3-c4/working-status.md`; earlier audits/receipts remain historical. Current isolated handler evidence includes stable chargeback acceptance/replay, an executed post-commit response-loss fault, uncapped parent/member/MID relationships and stable local Inbox/Portfolio pagination, not real native execution or full action acceptance.

Grouped merchant/report presentation and narrow read/consumer fixes do not establish clean-candidate, deployed bundled-server, actual financial ingestion or integrated serving proof. The user approved linked handoff for manual kickoff: keep the eligible Closed Won Sales record, create/reuse a linked Onboarding record and retry unfinished local preparation only. Its bounded implementation evidence does not close the full conditional transition matrix or authorize native activation/resume. Same-filter metrics/exports, independent source completeness and full role/action/fault/geometry/accessibility matrix remain open under existing owners. C2 compact Contact header is preserved; C3 reuses C4 Outreach presentation; C5 final sidebar and D serving/native/release obligations remain separate. No publication, activation/resume, sending, real provider/native work, shared/prod mutation or normal workflow/control change was performed.

## 36. C3 Prospecting, Canonical Enrichment and Campaigns — implementation receipt, 2026-10-19 (no GO verdict)

C3 source repairs F01–F08 and the shell parts of F09–F14 are implemented (see consolidated specification Section 28). This is a **source** receipt; it is not serving, role, browser or production acceptance. Older five-view / 21-route / old-taxonomy ledger text is historical.

| Gate | Status |
| --- | --- |
| G01 source/serving identity, public smoke | Not exercised. No candidate hashes or serving receipts recorded. |
| G02 24 routes / 28 rows / six views / dynamic controls | Codec round trips, invalid and duplicate cases exercised in `test-stage3-c3-contracts.ts` (171 assertions, including conflicting canonicalView/view selectors). In the real-browser suite (`test-stage3-c3-browser.ts`, admin, compiled client, disposable DB) the six canonical views round-trip through click, reload and Back and conflicting selectors report an issue. The other route patterns and dynamic controls were not exercised. |
| G03 role matrix | Real-browser merchant and partner sessions are redirected and see no Source Prospects aggregates. Executed on a disposable database with real sessions/CSRF (`test-stage3-c3-roles.ts`): aggregate reads for admin/manager/agent/merchant/affiliate/partner/unauthenticated and denial of every non-admin on release/process commands with no audit rows written. `test-stage3-c3-browser-sequences.ts` adds a real-browser seven-role entrance matrix on the Sequences page and a mid-session manager demotion (reads refused, direct POST 403). Other pages' live matrix and a role change on non-Sequence pages were not exercised. |
| G04 real create/edit/save/archive with readback | Sequence create, step add, edit with step IDs/config, replay, stale and omitted-step refusal executed with DB readback (`test-stage3-c3-sequences.ts`). The import flow is exercised in jsdom and in the real browser up to the review step (no upload before review). Browser-driven Sequence create/edit/hydration-failure (`test-stage3-c3-browser-sequences.ts`) and draft Campaign create plus Signature edit/failure recovery (`test-stage3-c3-browser-campaigns.ts`) executed with DB readback. Campaign edit/archive/cancel, business and lifecycle controls were not exercised in the browser. |
| G05 F01 resolved or truthfully scoped; F03 fixtures; >500 pagination | >500 pagination executed (`test-stage3-c3-prospects.ts`, 620 rows). Mounted tests prove independent Backlog/Launch/Release unavailable states. Backlog/Readiness production faults not reproduced; no root cause claimed. Audit-after-commit fault injection executed for release-policy and revoke (`test-stage3-c3-post-commit.ts`: `committed:true, audit:"failed"` with durable readback). Process-enqueue fault injection, late-response and actor-switch tests not run. In the real browser an injected backlog 503 left the release panel visible and was not shown as zero. |
| G06 metric agreement and October ledger bridge | Not exercised. Labels state scope; no same-snapshot agreement test. |
| G07 widths, themes, zoom, keyboard, contrast | Partly exercised (admin only): no horizontal body overflow at 320/390/768/1440 on canonical, source prospects and imports; a dark-class check; one Tab-focus check; one H1 per page. Also exercised: emulated 200% zoom (640 CSS px at scale 2, no overflow) and computed WCAG AA contrast of main-region text on Source Prospects in light and dark. Not exercised: real browser zoom, phone hardware, screen reader, contrast on other pages, reduced-motion beyond emulation. |
| G08 performance and heavy-query budgets | Not exercised. Automatic heavy polling removed in source only. |
| G09 guarded backend suites on disposable DB/Redis | Executed through the isolated launcher: canonical-release-authority, vertical-acceptance-policy, staged-email-materialization and first-party-native-install PASS. serper-lookup-memory FAILS ("First pass settles without scope errors") and intake-review-pages FAILS (full-page source namespace probe; the known baseline failure). No Serper or intake code was changed by C3; the Serper failure also occurs with C3's only server-storage change reverted (baseline). The six certification suites were added to the explicit-selection roster only (not the default roster). |
| G10 toolchain, manifest, build | Executed: whole-project `tsc --noEmit` clean; C1 (339), C2 (286), C3 (171) and C4 contract scripts pass; C3 mounted jsdom suites and the bounded real-browser suite pass; `ci-suite-manifest.ts --check` valid with the C3 suites registered; supported `npm run build` completed (not published). Full CI and pre-deploy roster were not run. |
| G11 published candidate verification | Not exercised. Nothing published; outbound remains paused; incoming GHL sync untouched. |
| G12 lineage reconciliation | Older appendices labelled historical. Open items named in Section 28 remain with C3; C5 sidebar and D serving/native proof untouched. |

No production write, provider run, import, enrollment, release, send, unpause, schema push, startup DDL or dependency change was made.

### 36.1 C3 follow-up receipt, 2026-10-20 (no GO verdict)

Follow-up scope (formerly separate tasks for the remaining import/release-state screens and the mounted-browser proof) was audited against the merged C3 source. UploadLedger on the protected cancellable hooks with URL-addressable execution and filter, the intake-versus-fulfillment import wizard, ReleasePanel denied/expired/revoked states, the scoped open-deal label on Outreach Command, and the Business detail rail with Back-to-list were already present. One gap was closed: a repeated release request now shows a persistent "Replayed" state (previously a transient notice only), covered by the mounted Canonical Backlog suite. Release limits, schemas and the outbound pause were not changed.

Executed after that change: whole-project `tsc --noEmit` clean; C3 contracts (171 assertions) and the three mounted component suites pass; on disposable databases through the isolated launcher, C3 role matrix, sequence DTO/recovery, Source Prospects pagination and audit-after-commit suites pass; after `npm run build`, the three C3 real-browser suites (bounded browser, sequences and roles, campaigns and signatures) pass. Receipts under `docs/certification/stage3-c3/` were regenerated by those runs.

Still not exercised and not claimed: process-enqueue fault injection (no queue manager in the fixture), late-response and actor-switch browser tests, Campaign edit/archive/cancel in the browser, role matrices on other pages, G06 same-snapshot metric agreement, and G01/G07/G08/G11 (serving identity, native zoom/hardware, performance budgets, published candidate).

### 36.2 C3 final corrections receipt, 2026-10-20 (no GO verdict)

Scope: completion of the existing #2075 C3 scope after the post-publication review. No new audit ladder; delivered screens were not rebuilt. Release limits, strict schemas, the outbound global pause and channel pauses were not changed, and nothing here enrolled, sent or called a provider.

**Implemented in source (candidate, not yet published):**
- R1: contact detail `/api/contacts/:id` explicitly defers literal collection readers registered later (`readiness-stats`, `verticals`, `duplicates` and the rest of the set) so they are never shadowed. The retired duplicates reader answers 410 from its own handler.
- R2: `POST /api/sequences` is a single-transaction command (principal check, advisory lock, receipt replay with 409 on payload mismatch, paused row, `sequence_created` audit, receipt). The editor retains the command per actor and account version, recovers the committed ID after a lost response, double click, close or reload, reads persisted steps back and refuses (names) a differing saved step, and posts only missing steps. Fields are locked while an intent exists.
- R3: Backlog process uses a retained command intent and a real producer-only queue add; thrown-enqueue fault read back.
- R4: Businesses renders the inventory first; privileged matching, advanced reconciliation and coverage sit in a collapsed admin disclosure that mounts only after first open.
- R5: tab and child changes on Lead Ops and Outbound Center use one typed helper: only registered entity context and a safe fragment survive, stale list/paging/arbitrary parameters are dropped, history is pushed (Back/Forward restore).
- R6: "Open sales deals" has one definition (open sales-lead stages); scope is named in the payload and labels (Command company-wide, KPI all-owners for admin/manager and owned-or-unassigned for others).
- R7: Backlog process and readiness-stats results are decoded defensively (missing legacy counters are null, not zero).

**Executed on this candidate (receipts under `docs/certification/stage3-c3/`):** whole-project `tsc --noEmit` clean; C3 contracts (211 assertions); mounted component suites; disposable-database suites for sequences (create replay/conflict/audit/actor/account), Backlog command, open-deal definition (pinned population), role matrix, post-commit and prospects; role-guards smoke with the new literal-route cases; after `npm run build`, real-browser suites: bounded (62 checks: Businesses inventory-first at 1280/768/390, lazy disclosure, typed tab context with Back/Forward), sequences (49 checks: lost-response retry, close/reload confirmation, partial steps with differing saved step, account-version change quarantine, plus role entrance matrix and demotion) and campaigns (27 checks: draft create, step edit cancel/failed save/409 non-draft conflict/durable save, signatures).

**Not executed and not claimed:** a per-reader failure-injection test for readiness-stats beyond the unavailable-state decoding; late-response guards for protected source/import/ledger queries in a mounted browser (only the Sequence editor hydration guard is implemented, not browser-proven); campaign-level edit/archive/cancel (the Campaigns page has no such controls; only step edit and status toggle exist, and step edits have no version token); (the full pre-deploy roster and baseline dispositions are now recorded in Section 36.3); native zoom, hardware, contrast and performance budgets; the published-candidate serving identity check. C3 is therefore not recorded as fully accepted. The global sidebar remains C5, integrated closure D, native/provider outbound proof Stage 4 and the frozen-SHA release Stage 9.


### 36.3 Full pre-deploy roster and baseline dispositions, 2026-10-20 (no GO verdict)

Run on the published candidate (published identity `86b022ab`, local HEAD `db74eb5d`, which contains `ba25f315` and only an attached review document). Runner: `scripts/run-sfp2060-predeploy-disposable.ts` with no `--only`, one private PostgreSQL clone, Redis and port per entry; no production database, no provider calls, outbound pause unchanged. A fresh `npm run build` preceded the run. Raw logs are kept locally under the gitignored `generated-artifacts/` directory (not committed).

**Result: 161 of 197 mandatory roster entries passed; 36 failed.** Separately, 8 certification-fixture suites that are only reachable with `--only` were run: 5 passed, 3 failed.

**Caveat found during the run:** the whole-roster run leaves modified tracked evidence files under `docs/certification/` (172 paths), which makes later diff-isolation checks see a dirty tree. After restoring the tree, the 36 failures were re-run one at a time on a clean tree:
- 2 passed on re-run: `scripts/test-sfp-disposable-certification.ts` (its diff-isolation check failed only because of the dirty tree) and `server/tests/auth-actions.integration.test.ts` (passed in isolation; it needs its explicit disposable opt-in).
- 34 failed again on the clean candidate.

**Baseline comparison.** The 34 reproduced failures, plus the three failing fixture suites, were then run with the same runner against the commit before any C3 work in this series (`709a4fad`, 186-entry roster). Every one of the 34 roster failures also fails there with the same first failing assertion; for the multi-assertion suites (sequence compliance, new-lead enrollment policy, CRO-03 HTTP authorization, CRM operator experience, forms) the set of failing assertions is identical apart from random fixture identifiers. For `check-queue-compliance`, `check-contact-merge-manifest` and `test-reconciliation-certification` only the exit status was compared, because their output carries no assertion text. Therefore none of the 34 is attributable to C3 changes; none was fixed, and none is claimed passing.

Reproduced on both candidate and baseline (exit 1): the Stage 3 C1 browser suite (real-pointer target on the edit-first-name input) and the Stage 3 B browser suite (compose-email control) failed with identical assertions; the C4 Bounded Mounted Browser fails for the missing `c4-performance-baseline` candidate-integrity prerequisite (at baseline for the missing local build instead, so the cause is the same class but not the same file); the compliance scan reports the same one UNKNOWN email call site (`server/services/sfp-seed-test.ts`); sequence compliance and contactability fail with `mismatched_email_token`; the CRO-03/03B/03C, CR06, CRO07 and SFP2000/2001 certifications, ledger/seed-convergence checks, outbound boundary 1626, pause fence (no `outbound_pause_control` row on the private clone), NBA, forms, transport dispatch, and the canonical registry/provider-import certifications fail with unchanged messages. Browser suites at baseline had no baseline build; the identical assertion text is recorded but the baseline build identity was not independently verified.

Fixture suites: provider-import-recovery fails on both candidate and baseline (exit 1 each). Serper lookup memory and intake review pages fail on the candidate (`First pass settles without scope errors`; `Full-page source namespace probe must execute its index`), but those suites do not exist at the baseline commit, so no baseline comparison is possible; they remain candidate failures with unknown cause, not reproduced-at-baseline. The other five fixture suites passed. `test-outbound-pause-authority.ts` passed on its private database.

**Not claimed:** this is not production acceptance, it does not clear the 34 + 3 failures, and a failing gate means the pre-deploy gate as a whole would still report FAILED. C3 remains not fully accepted. No code was changed by this run.



## 37. C5 Administration, Resources and final shell — implementation receipt, 2026-10-20 (NOT READY, no GO verdict)

Source implementation of Pass 1 to 4 on `f1fb96a3`: truthful permissions inventory (Express 5 mount/method/guard provenance, unknown never public), Queue Holds DTO decoder and keyed render, readiness probe registry (migrated schema, existing authorities, failed evidence never a pass), separated GHL operational cards and database-bounded audit reads, consistent Replit-ownership guidance and reclassified workflow-ID diagnostic, Resources reader states and JSON-decoded receipts, URL-addressable selectors through the shared codec (`tab`, `integrationsView`, proposed `area`), manager gating by real endpoint permission, read-only incoming-sync summary, isolated mounted GHL Settings test, five-area Administration, Resources navigation and the eleven-entry role-filtered sidebar with legacy entrances behind Dev Mode.

Executed: 8 GiB typecheck, C1 (339), C3 (211), C4, style isolation (120), five new C5 suites, local production build, manifest (206 mandatory entries), workflow restart. Also executed: real-browser admin/manager/agent shell smoke (76 checks, disposable fixture, APIs answering 501: route, sidebar order/highlight, Administration area fallback; receipt in docs/certification/stage3-c5/browser). Workflow-ID guidance now distinguishes reference-only sequence IDs from handoff-workflow IDs that are skipped when missing. Also executed on a disposable migrated database: data-bearing Administration/Resources panels (real handlers; permissions 290/290 routes, Queue Holds real DTO, readiness 26 probes without schema failure, Knowledge labels/editor 190px/URL tabs), compiled style and overflow at 1280/768/390, GHL Settings mounted in a real browser for five incoming-sync states, and a matched pre-C5 client performance comparison (candidate not slower). Not executed: remaining panels' data walks, merchant/partner sessions, dark theme/zoom/screen-reader/contrast, live-provider GHL recheck, full roster (historical 161/197 unchanged and not relabeled). The GHL Settings stall was not reproduced in jsdom or in a real browser; its cause is unclaimed.

Remaining-panel walk (709 checks, disposable fixture, six real roles, all 46 Operator views, five integrations selectors, Content/Blaze/Playbooks/Training children, light/dark contrast on 3,322 elements per theme with 0 failures, real 200% zoom, keyboard and accessibility tree) passed after fixing defects it found (AI Health crash on failed response, unnamed controls, duplicate h1, admin-only requests from Overview, low-contrast text). Not a real screen-reader run; unregistered sources answered 501. Manifest now 210 mandatory entries. Evidence and exact remaining owners: `docs/certification/stage3-c5/README.md`; inventory: `docs/certification/stage3-c5/actions.csv` (268 rows). Incoming GHL remains enabled and outbound paused; no send, seed, release, provider write, DDL or deployment occurred.

## 38. Task #2076 / C5 live-source and CRM audit — 2026-10-20 UTC

**Scope/decision:** Audited the supplied Task #2076/C5 (Administration, Resources, diagnostics and final employee shell) against the original C5 prompt, current code and authenticated production CRM. Continue the same implementation task with the consolidated corrections; C5 is not accepted or deployed by this audit. See `LIBERTY_TASK_2076_C5_LIVE_REPO_CRM_AUDIT_AND_CORRECTIONS_2026-10-20.md` for exact code repairs, role/navigation/UI contracts, acceptance amendments, all 59 route patterns and all 181 assigned historical panel rows.

- Initial main `447e59cb8d7a2659258243107ec6454106fb3f6a`; closing source drift reviewed through `ef6434207ed8c8d08156a9c70d57e702c4a40314`. The later 13-path enrichment/queue-preparation change adds three integration suites; no C5 page/registry/diagnostic, lockfile or migration change. Preserve concurrent fixes. Current mandatory roster is 200; the retained full-run receipt was 197, not 200.
- Production public health reports `86b022ab33e7094d7aa9395500d4c8ef120b2f58`, build `a7f570e8-25e9-41af-943c-41fc0827c815`, built2026-10-20T03:50:52.981Z. Eight selected built C5 client chunks matched production bytes. This does not certify complete server/schema/native parity.
- Live admin desktop: legacy sidebar and eleven AdminHub tabs remain; five-area Administration/Resources/final eleven-menu consolidation is unbuilt scope. Permissions still says0/0. Queue Holds crashes with desiredLogicalHolds.map not a function. Full readiness displays25 while returning26 (16pass/7warn/3fail), includes failing schema queries and Pass despite a Communications activity query failure. Knowledge/Training child deep links ignore their tab; current C1 Operator parent/legacy/reload repair and hidden bulk-enroll rejection work in observed cases.
- Nine bundles contain current confirmed defects: permissions/provenance/error honesty; Queue Holds DTO; readiness schema/populations/canonical pause; operational status/bounded audit-history truth; complete GHL guidance and native-ID diagnostic; Knowledge/Content error states and JSON mutation receipts; typed C5 URL state; manager-visible admin-only actions; form labels/editor/visual adoption. Two further bundles specify unbuilt workspace/shell scope; one separates passive status from existing incoming-import continuation behavior. Twelve bundles are repair scopes, not twelve new independent additions to95 source claims. GHL Settings stalled browser inspection after one reload; cause remains unverified and requires complete-page mounted/candidate proof.
- Fresh stored incoming status at2026-10-20T10:07:10.514Z: production/configured/incoming enabled true; outbound paused true; retained import ready/nextAction null/applied0, last updateOct3, stale freshness/no observed owner/heartbeat. Configuration and an unapplied preview do not prove current delivery/consumption. Optional GHL sync control and circuit/connection must remain separately labelled. No incoming toggle or outbound change was made.
- Supported stock dependency install, whole-project typecheck with8GiB heap, actual production build, C1 foundation339, C3 contracts211, SSR style isolation120rules and manifest checks passed on the initial reviewed source. Closing source check/build/manifest results are separately recorded in the audit report. Full pre-deploy was not rerun here. Repo Section36.3 reports161/197 initial passes/36failures; clean retries left34 reproduced failures; additional fixture suites5pass/3fail, with baseline qualifications. It remains a failed gate, not accepted baseline defects.
- Full59-route/181-panel dynamic-control/alternate-role/mutation-readback/browser/mobile/dark/real-zoom/accessibility/performance/rollback/native acceptance is not claimed. Independent C5 work proceeds; final affected navigation targets need functioning authorized candidate handoffs. Unrelated later-stage certification is not a blanket prerequisite. Preserve C2/C3/C4 interiors/authorities, all historical source IDs, incoming-enabled/outbound-paused separation and D/Stages4–9 evidence ownership.

No application code, production setting/account/data, schema, worker schedule, provider send, enrollment/release, merge/push or deployment was changed/submitted by this audit. Existing mounted page reads may perform connectivity probes; no claim of zero provider reads. Replit read-only inspection was busy/not queued. The canonical ten-stage Go Live sequence and95-source-entry lineage remain unchanged.

Closing verification: on ef643420, whole-project TypeScript (8GiB heap), actual production build and the200-entry manifest check passed. The new local build is79a3a9a4-dcf9-4209-88e2-178859126691; it was not published. Closing public health still reports production86b022ab/builda7f570e8-25e9-41af-943c-41fc0827c815. Previous Section37 C3 source allegations R1–R7 are superseded where current repaired source/Section36.2 receipts establish the fix (literal routes, retained sequence creation, backlog bounds/enqueue/decoding, inventory-first UI, typed tab history, open-stage definition). Retain qualified acceptance obligations; do not carry obsolete source defects as blanket C5 blockers.


---

## 39. Integrated post-C1–C5 repository and published CRM audit — 2026-10-22 UTC

The owner reports C1–C5 merged/published. This audit confirms the final employee shell, Administration areas and retained compatibility navigation are serving. It does **not** establish full Stage 3 integrated acceptance or a Stage 9 release verdict.

Tested source `c0f05223be70102904063cb1c0afc5af92f278b9`; serving application `5ccb3be4ecff51f83ff5a38fec5123107e14fd15`, build `c745f679-686e-4a58-b83f-bf57f6e585a7` (`2026-10-21T22:22:52.402Z`). That tested snapshot differs from serving source only in documentation. Seven selected compiled client assets matched production; complete deployed-server/schema/native parity is not claimed.

Closing main advanced to `46878111a870a329381dc2c7108471c4095ac0de`; its eleven-file enrichment continuation diff was reviewed separately. Final health still reports the preceding serving build. Preserve its improved historical/estimate labels and default-closed domain/location automation; no worker activation, mutation, candidate build or runtime proof is claimed. D04 additionally covers its distinct-contact count labelled as paused memberships and available-empty ready-held groups displayed as unavailable. The nine repair bundles and 147 UI route patterns remain unchanged. Fresh check results below belong to `c0f05223`, not closing main. See the report's closing-source qualification for the exact additional gates.

Live admin walkthrough opened all 147 route patterns, including context records, compatibility aliases and separate mobile/portal entrances. It exercised the eleven sidebar targets, 46 Operator view selectors, five Contact areas/20 available sections, fourteen Lead Ops selectors and six Canonical Enrichment views, plus Administration/Reports/Resources/service entrances. Some records are navigation/loading observations; this is not a pass for all 309 historical panel rows, every data reader, every role, or every mutation. Detailed route coverage accompanies `Liberty-CRM-Audit-2026-10-22.md`.

Read-only authority observations: outbound **paused**, database source, epoch **1**; incoming GHL updates **enabled**, configured true, outboundPaused true. Retained incoming import remains an October 3 unapplied ready preview; runtime heartbeat/backlog/owner consumption is not proved. Queue Holds renders without its former DTO crash. Permissions enumerates 1,738 registrations (1,311 role, 284 authenticated, 143 unknown; unknown not public). Full Launch Readiness returns 26 probes, **18 pass / 7 warn / 1 fail**, with no old missing-table/column errors. Queue/Redis degraded evidence and stale sync remain qualified; the Sales Rep Operations failure retains Stage 8 ownership. GHL Settings rendered 100 recent-activity rows without the earlier all-log stall. Review aggregate 110 is separate from pending dead-letter history 2,988. Partner Referrals loaded after its earlier route repair.

Nine grouped confirmed repairs remain: D01 unsafe Data Health subprocess/command and false safe-operation copy; D02 incomplete GHL execution ownership/readiness guidance; D03 sales metric definition drift and zero-denominator performance claims; D04 loaded-window/raw-status/population labelling; D05 remaining raw hub URL callers; D06 missing/duplicate composed H1s; D07 textarea selector specificity (86px Notes/44px computed floor versus 96px contract); D08 unnamed ticket checkboxes, dark KPI contrast (1.82:1) and dark wordmark treatment; D09 unbounded company picker (1,227 buttons/13,458 nodes). Six optional UI/workflow proposals are separate from defects. These repair bundles **are not nine net-new additions to the original 95**. Prior C5 R01/R02, core R03, R09/R10 and specific GHL history/circuit repairs are superseded where current evidence proves the fix; R05/R07 and remaining presentation acceptance stay open. Preserve all original IDs and the ten-stage sequence.

Fresh supported checks: stock install 764 packages, whole TypeScript, actual local production build, C1 foundation339/query-runtime, C2 contracts286, C3 contracts211, C4 contracts, four C5 static suites, style isolation120 and manifest219 passed. Two nested npx/tsx mounted launchers failed on local IPC EPERM before component execution; direct execution of UploadLedger/CanonicalBacklog/LeadImports/GhlSettings component files passed. The failed launchers are not relabelled. Full 219-suite CI/DB/Redis/security/real-role/rollback roster was not rerun. Historical161/197 and baseline qualifications remain historical, not a current green gate.

Remaining acceptance is grouped as real-role workflows; disposable mutation/replay/fault/readback; widths/real zoom/assistive technology/contrast/performance; operational/native and financial provenance; clean delivery/full gate/rollback. Actual zoom was not achieved by this browser's key controls. C4's repository receipt still records incomplete user-requested closure; C5 README still says NOT READY and its referenced actions.csv was absent from the tracked evidence directory inspected. Publication does not retroactively close those evidence gaps.

Proceed under existing Stage 3 D with D-R1 data/actions/truth, D-R2 shared UI/workflow and D-V integrated acceptance. Preserve incoming ON/outbound paused, command/identity/consent authorities, public-site style isolation and concurrent enrichment work. No application code, production setting/account/schema, provider command/send, enrollment/import/approval/release, merge/push or deployment was changed. Canonical document files updated here; carry this receipt into repository docs during the repair handback.

### 39.1 Stage 3 D-R1 implementation receipt — source only, not yet published (no GO verdict)

Scope: CRM-D01 to CRM-D05. D-R2 (D06 heading ownership, D07 textarea specificity, D08 accessible names/contrast/inverse logo, D09 bounded company picker, UI-01 to UI-06) and D-V (integrated acceptance) are **tracked and not started**. The 95 source entries and 14 repair groups are unchanged; D01–D05 are repair bundles, not new findings, and no original finding is closed by this receipt.

| Bundle | Change | Executed proof | Not claimed |
| --- | --- | --- | --- |
| D01 | The immediate Data Health subprocess is removed (`scripts/reconcile-orphans.ts` deleted). Admin-only read-only plan, explicit selected-action apply with per-action row lock, recheck and same-transaction audit, durable receipt per operation. Only `deal_link` (unique email match, never ambiguity-first) and `enrollment_cancel` actions exist. The lifecycle backfill action was dropped because `contacts.lifecycle_state` is NOT NULL with a default, so a null population cannot exist; it is reported only. `next_action_at` is never changed and no enrollment is created. | Disposable-database cert `test-data-health-reconcile.ts`: 46 checks (read-only plan, ambiguity/archived/non-production/no-email unresolved, apply, forged key, replay, conflict, concurrency, drift, audit-failure rollback, stale resume, no provider network). Role-guard smoke 162/162 including plan/apply/operation guards. | Browser run of the new Data Health plan/confirm/receipt UI; response-loss fault injection; any production execution. Direct SQL is used inside the transaction because the existing storage authorities are not transaction-capable. |
| D02 | `shared/ghl-ownership-guidance.ts` now lists the 15 supported handoff workflows that have real callers and treats the other 24 registry IDs as reference-only. System Readiness reports only missing supported handoffs, naming the caller; Marketing/GHL guide copy no longer says missing workflow IDs make all automation fail. No activation or unpause guidance. | `test-ghl-ownership-readiness.ts` 73 checks (39 registry, 15 supported, 24 reference-only; source census). `test-stage3-c5-diagnostics.ts` passes. | Rendered readiness page in a browser. The existing "no unpause guidance" check has exemptions for three files and is weak. |
| D03 | One rate contract (`shared/metric-contract.ts`). Reports "Active Pipeline" now uses `OPEN_SALES_LEAD_STAGES`; Nurture and unrecognized stages are reported separately; stalling uses open stages. Win rates (Reports and Chargebacks) are unavailable with numerator/denominator when nothing is decided, shown as "Not enough outcomes" / "No decided deals" instead of 0% / below target. | Disposable-database cert `test-pipeline-metric-contract.ts`: 16 checks (New Lead, Nurture, unknown stage, Closed Won/Lost, archived, non-production, other owner; privileged and rep scope; empty denominator versus real 0%; chargeback rate). `test-cro01-revenue-contract-static.ts` passes. | Browser rendering; other surfaces that compute their own rates. |
| D04 | Audit Log card is "Entries loaded" for the current window; Contacts count states "matching the current filters" with as-of; raw email status `active` is labeled "Active status" / "status only, not validated"; Data Health returns populations; Lead Ops counts paused **contacts** and paused **enrollments** separately (old `readyHeldPausedMemberships` removed), an available empty `ready_held` returns exact 0, failed blocks stay unavailable with `blockErrors`, and each funnel block reports availability and as-of. Newer funnel labels from the enrichment continuation are kept. | Source assertions; production build; role-guard smoke. | A DB-backed test for the lead-ops funnel block statuses; browser verification. |
| D05 | GHL Integration, Content, Playbooks, SDR and Deliverability hubs decode `tab` once through `hubTabState` (duplicate, invalid and role-forbidden values fall back and show a notice) and change tabs through `typedTabUrl` (history push, registered context such as `contactId` and hash kept, arbitrary keys dropped). Generated route/query registry refreshed (five `tab` entries). Legacy entrances unchanged. | `test-stage3-d-hub-tabs.ts` 33 checks; C1 foundation 339; C2 contracts 286; C3 contracts 211; C4 contracts; C5 route inventory, resources, sidebar; manifest check; `api-coverage` workflow; local production build. | Reload, Back/Forward and keyboard behavior in a real browser (D-V). |

No full-project TypeScript check was run (project instruction); compilation was covered by the local production build and per-file syntax checks only. Production is unchanged until the owner publishes this group; serving identity will be recorded separately below after publication.

## 39.2 D-R1 publication identity and signed-in production walkthrough — 2026-10-22 UTC

**Serving identity (read from `https://libertybancard.com/api/health`):** source `4e1b3788…` (the D-R1 commit), build `a8cc7afd-b8f8-4308-81c7-939a209a246e`, built 2026-10-22T09:57:50Z. Publication was performed by the owner.

**Verified in a signed-in production browser (admin session, read-only actions only; no production write was made):**

| Item | Observed |
|---|---|
| D01 | Data Health renders; "Build read-only plan" reports 0 safe actions; 5 active enrollments without a next-action time and null lifecycle (0) are reported only. The apply path was not exercised in production because there was nothing to apply. |
| D02 | System Readiness shows supported handoff workflow IDs 0/15 with caller-specific messages; the 24 reference-only IDs are labelled as not affecting readiness or sequence sending. |
| D03 | Reports show Win Rate "Not enough outcomes — 0 won of 0 decided", Active Pipeline 2, Chargebacks "No decided deals". |
| D04 | Audit Log card is "Entries loaded (this view, capped at 100)"; Contacts shows "160,226 contacts matching the current filters" with an as-of time; "Active status" is labelled status only; Lead Ops SFP blocks all available with as-of and no block errors. |
| D05 | All five hubs fall back and show the selection notice for invalid or duplicate `tab`; real tab clicks push history, keep an integer `contactId` and hash, and drop junk keys; Back/Forward/reload and keyboard arrows behave. Legacy `ghl-settings` and `ghl-workflows` entrances redirect to the right tab. |
| General | 14 pages loaded with zero console exceptions and zero `/api` 4xx/5xx responses. |

**Findings from the walkthrough:**

1. **Unknown-class deals are excluded from Reports.** Only 2 sales deals are `record_class = 'production'`; 1,569 New Lead, 2 Proposal Sent and 2 onboarding deals are class `unknown` and are excluded by the existing revenue-read-authority rule. Not changed. Data Health's "active production deals" wording counted unknown-class deals (1,441), so the label now says "active and not classed test, demo or synthetic (this includes deals whose record class is still unknown, which Reports does not count)".
2. **Stale GHL setup guide text.** The Workflow IDs tab still told operators that "GHL then handles all delivery" and to "unpause the sequences you want running". Both contradicted the ownership model and the pause. Rewritten (steps 2 and 5), and the unpause-wording check in `test-ghl-ownership-readiness.ts` no longer exempts that file (73 checks pass).
3. **Domain/location automation makes almost no progress per tick.** It is enabled (by an administrator), has made 28 assignments, 0 paid calls, no error, but after three ticks the cursor was still 0. It runs only inside the 30-minute discovery job, and a tick that stopped on its time budget did not save its place, so each tick re-evaluated the same first contacts. The tick now saves the last contact handled when it stops on its budget and resumes after it. New certification checks (60 pass on a disposable database) prove cursor advance and no re-evaluation. This takes effect only after publication.
4. **Serper contact-page stage** was observed enabled (25 requests per run) by someone other than this session: 41 requests/credits, 5 businesses with a staged email, 0 qualified. No setting was changed.

**Not verified in this walkthrough:** D-R1 apply path in production, responsive/mobile and the non-admin role matrix (D-V), C4/C5 browser suites after publication (known baseline failures, §36.3). D-R2 and D-V remain tracked and not started. Outbound pause unchanged (paused, epoch 1); no sends, enrollments, releases or provider enabling.

### 39.2.1 Follow-up publication confirmed — 2026-10-22 UTC

Production `/api/health` serves source `67b6226c2f4b5d5a70306704c8b26b803b59e8d2`, build `10f68a14-6651-4f87-a6f1-2f64f7488ff9`, built 2026-10-22T11:07:26Z. First domain/location tick after publication (11:08:34Z): cursor moved from 0 to 281 (scanned 407, committed 31, no error), so resumable ticks work in production. The rest of the first window and later windows are still pending; one tick runs per 30-minute discovery job. D-R2 and D-V remain tracked and not started.

## 40. Stage 3 D-R2 — source implementation and local verification, 2026-10-22 UTC (not published; no GO verdict)

D-R2 changes presentation, heading ownership and one read-only search route. No outbound pause, provider budget, worker schedule, enrollment, release or deal classification was changed; the ~1,570 unknown-class deals were not touched.

| Item | What changed | Verification actually run |
|---|---|---|
| CRM-D06 | The page `h1` is a runtime claim. `PageTitle`, `PageHeader` and `CrmPageHeader` at level 1 register a claim; the shell title (`ShellPageTitle`) is the single fallback `h1` only while no claim exists. The error-boundary fallback is itself a level-1 title, so a crashed page or route has one `h1`. Loading skeleton is a `role=status` region, not a page. Hubs embed children at `h2`; unrelated section headings are never suppressed. | `scripts/test-stage3-d-r2-headings.ts` (jsdom, mounted, 14 checks, in the pre-deploy roster): shell-only, shell-to-page hand-off, page switch, tab re-key, hub with embedded children, unmount, crash inside shell, crash with no shell, recovery, and a MutationObserver sampling that never saw two `h1`. Browser monitor on direct entrances, tab clicks and contact 404/500 never showed two `h1`; zero `h1` appears only before the shell mounts and while a route chunk's fallback shows (no loading-time `h1` was added deliberately, to avoid a text swap). |
| CRM-D07 | Ordinary CRM/portal `textarea` floor 96px (removed from the 44px control rule), prose editor 200px; scoped to `.crm-theme`/`.crm-portal`. No public CSS changed. | Computed styles in a signed-in browser, light and dark: ordinary 96px, prose 200px. |
| CRM-D08 | Ticket-row checkbox name `Select ticket #id`; Prospects select-all and Outreach Queue bulk checkbox named; separate `--crm-danger-text` token for `.text-destructive`; employee sidebar renders blue logo in light and white logo in dark. | Computed danger text: light `rgb(175,29,29)` on `rgb(252,250,248)`; dark `rgb(244,113,113)` on `rgb(15,23,41)` (both above 4.5:1 by calculation). Dark shows only the white logo, light only the blue. |
| CRM-D09 | `GET /api/companies/search`: actor predicate in SQL before order and limit, default 25 / max 50, order `lower(legal_name), id`, opaque keyset cursor, exact authorized `total`, `excludeContactId` re-pins contact authority, strict query schema, registered before `/api/companies/:id`. `readCompanies(bindWorkActor(...))` and link/create command versions are unchanged. Picker uses a debounced, abortable, generation-guarded hook; states Loading / No match / Unavailable+Retry / Show more / selected summary kept by exact ID; ArrowDown/ArrowUp move between options. | Disposable-DB suite with 1,150 companies (19 checks): exact total above 1,000, full cursor walk without gaps or duplicates, agent total/page limited to authorized rows, another agent disjoint, cursor from another actor never widens, literal `%` and `_`, malformed cursors → 400, stale auth epoch → 404, unauthorized contact scope → 404. Browser: 25 of 1,222 shown, No match, Show more to 50, selection kept, keyboard focus moves option → option → input. |
| UI-01 | Contact keeps header, owner, pause state and area links while a section loads. Only the contact core is retained (`RetainedContactCore`), keyed by protected actor scope, permission generation and contact ID; no section payload is reused. The core is dropped on any error, actor/permission change or record change, and a response that arrives after such a change is discarded. | `scripts/test-retained-contact-core.ts` (10 checks: actor change, permission change, record change, late response after each, error drop, no section payload). C2 header suite rebuilt and passed with stronger geometry assertions (Back and breadcrumb on one row, exactly one `h1`, area navigation after the status block, mobile 390x844 navigation bottom within the viewport as originally certified). |
| UI-02 | Campaigns already has one `h1`, four areas and one contextual row; Canonical Enrichment view rail made single-line (descriptions moved to titles). URL keys and aliases unchanged. | Crawl and browser. |
| UI-03 | Today: "Next actions" worklist directly after the summary (each count states Unavailable rather than 0 when unread); AI copilot/digest controls collapsed into a details element; pause and capability notices stay visible. | Browser, light and dark. |
| UI-04 | Shared presentation adopted where its contract fits (table below). `PageHeader` is now a thin wrapper over `CrmPageHeader` (single header implementation; test ids kept). Sixteen destinations now use `CrmPage`; ten of them also use `CrmPageHeader`; My Earnings, Partner Portal and Partner Referral Pipeline KPI blocks use `ScopedMetricStrip`. Metric rail numerals are Sans with tabular figures; Mono stays for IDs. | `scripts/stage3-d-r2-ui04-inventory.ts` (56 routes, output saved in `docs/certification/stage3-d-r2/ui04-inventory-after.txt`); contract suite asserts each adopted page and that every shared tag in use is imported (a missing import in Arbitration Log was found by browser and fixed). Browser: 17 migrated screens at 1280 and 390 px, one `h1` each, no horizontal overflow. |
| UI-05 | People: one toolbar, selected-filter chips with remove buttons, quick filters moved into the existing filter panel (all filters and URL keys retained). Merchant Operations keeps 5 groups / 16 destinations; current group emphasized. | Browser: chips render from URL; panel contains chip-never-contacted; 5 groups, 16 links, current group "Delivery" on Onboarding. |
| UI-06 | Contact Back returns to the remembered filtered People URL (per user, validated pattern); breadcrumb "Records / Contact" sits on the Back row. Business Back no longer uses browser history: the inventory remembers its search, filters and page (`bq`, `bvertical`, `bemail`, `boffset`) per user and Back opens that URL, or the default inventory when none is remembered. Collateral labelled "public library" in Resources with a "Back to Resources" line for signed-in employees on `/assets`; no employee CSS on public assets. | Browser: inventory with `bq=llc` -> business -> Back restored the URL, search input and the same 50 rows; direct entrance with 9 history entries -> Back opened the default inventory (not the previous page); reload on the business page with remembered context -> Back restored the filtered list. Static contract and validator checks for inventory URLs. |

**Suites:** `scripts/test-stage3-d-r2-contracts.ts` (46 checks), `scripts/test-stage3-d-r2-headings.ts` (14), `scripts/test-retained-contact-core.ts` (10) and `scripts/test-company-search-authority.ts` (19, disposable DB) are in the pre-deploy roster and manifest. D hub-tab (33), C2/C3/C4 contract suites, C5 sidebar/resources and the API-coverage check pass.

**Private-browser suites (rebuilt `dist`, isolated disposable DB/Redis, one suite per run):** C2 contact header, C2 post-merge browser, C2 actions, C2 browser (.mjs), C5 panels, C5 role-negative requests, C5 GHL stored run, C5 walk, C5 browser and C5 mounted all passed (10/10; summary in `docs/certification/stage3-d-r2/private-browser-suites.txt`). `test-stage3-c5-performance.ts` is an explicit opt-in and was not run (D-V). A first run against a build that predated an import fix also passed 9/10; the one failure was my own new header assertion reading elements the test script had not yet captured, not a product defect.

**Corrections to earlier statements:** the earlier claim that `test-c2-contact-header.ts` fails on a clean baseline was wrong. The failure came from a stale `dist/public`, then from a breadcrumb placed on its own row; after rebuild and moving the breadcrumb onto the Back row the certified geometry holds (mobile navigation bottom 842 within 844). The private-browser suites were not skipped; results are above.

**UI-04 destination disposition** (flags: P=CrmPage, H=CrmPageHeader, M=ScopedMetricStrip, S=CrmDataState, W=WorklistToolbar, T=CrmDataTable; full list in the saved inventory):
- Already compliant before this change: Overview, My Day, Next Best Action, Contacts (with table), Contact, Company, Pipeline, Work (tasks/appointments), Reporting hub, Admin hub.
- Changed to the shared contracts: Co-Branded Proposals, Partner Organizations, Arbitration Log, Knowledge Admin, Knowledge Base, My Portfolio, Referral Program, My Earnings (+ metric strip), Ready for Outreach, Queue Holds (page + header); Boarding Tracker, Merchant Applications, Document Vault, Leaderboard (page root); Partner Portal and Partner Referral Pipeline (page root + metric strip).
- Deliberately retained: thin hubs that delegate presentation to children (GHL Integration, System Health, Merchant Risk, Merchant Success, Support, Content, Playbooks, Contacts and Leads, My Leads); redirect routes and sidebar aliases (no UI of their own); Comms Hub keeps a hard-coded `crm-page` root because the inbox workspace needs its own layout class; large bespoke screens left unchanged to avoid risk (Activation Panel, Lead Operations Center, Training, Statement Review, Settings Integrations, Canonical Enrichment, Prospect Import, Underwriting, Onboarding Kickoff, Business Detail, Outbound Center); `WorklistToolbar` is used nowhere because People uses the filter panel with chips, which the toolbar contract does not fit. Provenance paragraphs on these retained screens were not shortened in this pass; that remains open under D-V/UI follow-up.

**Not verified:** published behavior (D-R2 is not published at the time of writing), non-admin role matrix and full performance evidence (D-V), narrow-viewport inspection beyond the screens named above. D-V remains tracked and must also verify that D01's direct SQL preserves authorization, identity and lifecycle invariants. Stage 3 D remains open.

## 41. Stage 3 D-V — integrated acceptance, 2026-10-22 UTC (source; not yet published; no GO verdict)

D-V closed the three D-R2 observations, ran integrated acceptance, and repaired the defects that acceptance found. No outbound pause, provider budget, worker schedule, enrollment, release, GHL apply or deal classification was changed; the ~1,570 unknown-class deals were not touched. Production was read-only (health and public GETs only). The previous published build is `f22318cb31797e7484075b10c4586c5492d21b48` (built 2026-10-22T16:34:47Z, verified at `https://libertybancard.com/api/health`). This section describes the next commit, which is not live until the owner publishes it.

### 41.1 D-R2 observations

| Observation | Result | Evidence |
|---|---|---|
| Knowledge Admin at 1280, heading and error state | No defect. Six loads (3 direct, 1 in-app navigation, 1 reload) each end with one H1 "Knowledge Base Admin" once the lazy chunk loads (0.9–1.6 s typical, one 5.8 s cold dev compile; the earlier "missing H1" was still loading at a 4.5 s window). With `/api/knowledge*` blocked the H1 stays and two `role=alert` states appear ("Whole-library statistics unavailable", "Knowledge sources are unavailable. This is not an empty library."). | Browser run on dev serving build. |
| Company picker selection, pagination, keyboard | No defect on current source. Contact 192678: 25 of 1,222 shown; no match → "No match"; clear restores; Show more → 50; ArrowDown/ArrowUp moves through options and back to the input; selection summary names company and ID with submit enabled; no horizontal overflow at 390 px. First dev load needs about 14 s. | Browser run on dev serving build. |
| UI-04 provenance presentation | Added `ProvenanceNote` (visible summary + expandable "Data source and limits"). Leaderboard, Document Vault and Canonical Enrichment now show a short scope / as-of / uncertainty line (Leaderboard keeps period, as-of, deals loaded/total, completeness and "not observed revenue or native receipts"; Document Vault keeps "not complete relationship coverage"); diagnostics are inside the expandable detail. A 45-route crawl found one h1 everywhere; remaining long text is operational data (tables, queue holds header, GHL inbound sync card, settings/integrations, system health) and was left unchanged. | `scripts/test-stage3-d-r2-contracts.ts` (58 checks) and browser expand/collapse on the three pages. |

### 41.2 Defects found by acceptance and repaired

| Defect | Repair | Proof |
|---|---|---|
| `GET /api/dashboard/stats` counted the first 500 rows of deals, contacts and tickets and returned them as totals (dev: contacts 500 of 154,889). No page consumes it, but it is a role-guarded API. | Deals use `readPipelineAnalytics` (production, non-archived, open stages from `OPEN_SALES_LEAD_STAGES`), contacts use the authorized production total, tickets use an uncapped open count. Response adds `population` and `asOf`. | Dev after restart: deals 90 / activeSales 90 (matches `/api/analytics/pipeline` and `/api/kpi/summary`), contacts 154,889 (matches lifecycle distribution), tickets 5 (matches KPI). Contract check in the D-R2 suite. Role-guard smoke 162/162 includes this route. |
| `/sitemap-compare.xml` listed `/compare/{shopify-payments,heartland,worldpay,fiserv,gravity-payments}`, which have no comparison page and answered an empty 404. | Sitemap lists a `/compare/<slug>` URL only when the page exists. | All 539 sitemap URLs return 200 on dev after the fix (was 11 non-200 across two causes). |
| `/industries/{dental,med-spa,legal,accounting,fitness,hospitality}-payment-processing` answered an empty 404 from the server although the client app renders them. | Listed industry slugs without a server-rendered page fall through to the client app. | Same 539-URL check. |
| Controls without an accessible name found by the crawl: People contact links for records with no person name, People Show Archived switch, three Pipeline toggles, Partner Referral Pipeline email icon link, 15 Knowledge Admin archive buttons. | Name fallback (company, email, then `Contact #id`), `aria-label` on the others. | Crawl rerun: 45 routes, 0 failures; real unnamed controls 0 (the 6 reported on Onboarding Kickoff are aria-hidden Radix mirrors). |

### 41.3 D01 direct-SQL invariants

`server/services/data-health-reconcile.ts` applies each action in its own transaction with row locks and a same-transaction audit row, rechecks unique active exact-email identity under the lock, and does not go through `LifecycleService` (the storage layer's own deal and enrollment updates do not either, so behavior is at parity). Authorization is route-level admin-only.

- `scripts/certification/test-data-health-reconcile.ts` now also snapshots invariants around apply: contact rows and lifecycle state unchanged, deal fields other than the link unchanged, enrollment schedule fields unchanged, no `communication_events` written, pause settings unchanged. Disposable database: 50 checks passed.
- New `scripts/test-stage3-d-v-data-health-browser.ts` (registered in `scripts/pre-deploy.ts` and `scripts/ci-suite-manifest.ts`): real browser, real admin route module, disposable migrated database, real admin/manager/agent sessions. Plan → select → review → confirm; a real post-commit truncated response (executed fault event recorded) leaves the page saying "Result not confirmed" with no receipt; the saved effect is durable and has exactly one audit row; re-submitting the same operation shows "Result (saved)" and does not apply or audit twice; contact lifecycle/record, deal stage and pause settings unchanged; no provider call. Manager sees no plan controls and the plan route returns 403; agent plan request returns 403. 24 checks passed. A connection-reset fault was tried first: Chrome retried the POST by itself with the same operation id and the page showed the saved result, so the truncated-response fault is the one that exercises the visible failure path. Receipt: `docs/certification/stage3-d-v/data-health-browser-receipt.json`.

### 41.4 Suites executed on the final dev/disposable build (all passed)

Built with `node --import tsx script/build.ts` after the last source edit; each suite verifies the candidate identity.

- Disposable-database browser/route suites: D-V Data Health browser; C5 walk; C5 role-negative requests (admin-only routes denied to manager, agent and anonymous); C5 data-bearing panels; C5 browser; C2 contact header; C2 post-merge browser; C2 actions; C5 GHL settings stored run; C2 post-merge repairs.
- Static/mounted suites: C5 route inventory, diagnostics, hub tabs (33 checks, tab deep links), D-R2 contracts (58), D-R2 headings (jsdom; React `act` warning only), C5 resources, sidebar, mounted GHL settings, C2 contracts.
- `smoke-role-guards`: 162/162. `check-api-coverage`: no new client endpoint without a server handler (860 client endpoints, 1,739 handlers). `test-public-route-validation`: 12 passed. SEO audit: 421 routes, 0 failed, 12 with warnings.
- Matched performance (`scripts/test-stage3-c5-performance.ts`, baseline = pre-C5 client from commit 1422503b built into `generated-artifacts/c5-baseline-client`): medians baseline → candidate, `/dashboard` 349 → 346 ms, admin hub 385 → 232 ms, knowledge base 346 → 326 ms, permissions 467 → 355 ms; all within the bound. Scope: same disposable API/DB/machine, cold navigation, cache disabled, 7 runs; not a production or network measurement.
- Responsive and accessibility crawl: 45 routes × 1280/768/390: one h1, no page overflow, no error text, no duplicate ids, no missing alt (`docs/certification/stage3-d-v/route-control-coverage.md`).

### 41.5 Metric parity checked

Dev, admin session: open sales pipeline = 90 in `/api/analytics/pipeline`, `/api/kpi/summary` and (after repair) `/api/dashboard/stats`, and equals the SQL count of non-archived production sales deals (the dev table holds 2,076 sales deals in total; the rest are archived or non-production). Production contacts = 154,889 in the lifecycle distribution and `/api/dashboard/stats`, matching SQL. `/api/outreach/status` reports 164,267 contacts because it counts every non-archived contact regardless of record class. The two populations differ by definition; whether each screen labels its population was not audited here.

### 41.6 Not executed or not established

- Post-publication smoke of this commit: not run, because the commit is unpublished. Required after publish: `/api/health` sha equals the pushed commit, public page GETs, an admin sign-in walk of the dashboard routes (h1, overflow, console errors), `/api/dashboard/stats` returns whole-population counts, `/sitemap-compare.xml` lists only existing pages, the six `/industries/*` URLs return 200.
- Live (production) role matrix and live apply were not run; role evidence is from disposable-database sessions and the role-guard smoke.
- Performance is a local matched comparison only.
- axe-core is not installed; contrast rests on the calculations in Section 40; no screen-reader testing.
- The accessibility crawl covers 45 routes at rest. `Label`-without-`htmlFor` next to `Switch` exists in other files (29 files use `Switch`); only switches reachable on the 45 routes were checked.
- Other routes still read capped samples (`storage.getDeals/getContacts/getTickets({limit: 500})` in `server/routes/ai.ts`, `crm-operations.ts`, `deals.ts`, `conversation-ai-config.ts`). They feed AI context and operational helpers, not the metric destinations compared above, and were not changed.
- The full pre-deploy roster was not run; only the suites listed in 41.4.

## 42. D-V independent review of b0335a0b — dispositions (2026-10-22; source, not published)

Code under test: commit `d584bdf7` (F01 is the preceding commit on the same branch). All suites below ran on the disposable database against a production build of that code. The final commit adds only this ledger, the spec note and regenerated receipts. Stage 3 is not closed by this section; it needs publication and the post-publication smoke in 42.4.

### 42.1 Dispositions

| Finding | Disposition | Evidence |
|---|---|---|
| F01 Data Health apply authority | Source repair. Each action re-pins ownership token and generation and admin authority in its own transaction; the deal link takes the same per-mailbox advisory lock as `writeContact`; receipts are fenced and actor-scoped; reload recovery offers check, re-submit and discard. | `test-data-health-reconcile.ts` (74 checks), `test-stage3-d-v-data-health-browser.ts` (37 checks), both re-run on d584bdf7. |
| F02 failed reads shown as zero or empty | Source repair. Both partner pages and the expanded referral list throw on a non-OK read and render denied or unavailable with Retry; metric availability derives from the read; "Unavailable" replaces zeros, including the pipeline-value card. Overview active deals use `OPEN_SALES_LEAD_STAGES`. | `test-stage3-d-v-contracts.ts`; `test-stage3-d-v-landmarks-browser.ts` (real 501 read on both pages). Denied (403) rendering and a real successful partner read were not driven in a browser. |
| M1 `/api/dashboard/stats` population | Source repair. The single whole-payload label is replaced by a per-field `populations` object. Tickets are labelled all tickets with a status other than Resolved or Closed, not role-scoped, matching `/api/kpi/summary`. No second ticket policy was introduced. | Contract suite. |
| M2 contact total labels | Source repair. Outreach Command and mobile name the population (all unarchived contacts, all record classes, all owners); `/api/outreach/status` returns `contactsScope`. | Contract suite. |
| F03 Today destinations | Source repair. Overdue and pending task actions open Tasks with `due=overdue` or `taskState=pending`; the new-leads action opens Pipeline with `created=7d`, backed by a server filter `createdLast7Days` on the same predicate as the KPI. Tasks and Pipeline derive the cohort from the URL, show it, and offer a clear control. The overdue predicate is shared by the Today figure's definition and the Tasks filter. | `test-stage3-d-v-cohort-browser.ts`: direct entry, reload, in-app change, Back and Forward on Tasks; Pipeline chip, clear and Back. |
| F04 retained Contact core | Source repair. Only the projected contact core and capability flags are stored; section arrays, notes, deals, tickets, tasks and loaded flags never enter the retained value. | `test-stage3-d-v-contact-core-browser.ts` drives the real Contact component with deferred and failed section responses. A second signed-in actor and a permission-generation change were not driven in a browser; they rest on the protected-scope key and `test-retained-contact-core.ts`. No cross-actor disclosure is claimed. |
| E1 capped exports | Source repair. `/api/export/{contacts,deals,tickets}` have no client consumer; they now stream bounded keyset pages by ascending id with no 500-row cap. Contacts use the People read predicate (archived excluded, role scope, optional `search`, `status`, `assignedTo`, `recordClass`); deals use the Pipeline predicate and resolve contacts by linked ids per page; tickets export all tickets. A failure after streaming starts destroys the connection instead of ending a short file. | `test-stage3-d-v-exports.ts` (18 checks): 1,250 contacts, 1,099 deals with contacts across pages, 1,010 tickets, quote/comma/newline round trip, ascending order, role denial, first-page and mid-stream failure. |
| U1 duplicate main | Source repair. Canonical Enrichment renders a section when not embedded. The crawl tool now fails when a page has a main count other than one. | `test-stage3-d-v-landmarks-browser.ts`: one main and one h1 on the direct page and embedded in Lead Ops. The 45-route crawl was not re-run on this candidate. It forces desktop, uses bare hub URLs and heuristic control names, and is not a mobile, tab, dialog or role matrix. |
| Performance gate | Source repair. Every sample asserts shell readiness and data readiness (no loading indicator for two consecutive polls); a timeout fails the run instead of counting as a sample. Shell and data medians are recorded separately, with candidate identity and the baseline index hash. Legitimate empty or unavailable states count as ready. | Re-run on d584bdf7, 7 alternating samples, same API, database and machine. Data-ready medians, baseline then candidate: `/dashboard` 353 → 491 ms (+138 ms, passes only through the 25% + 150 ms allowance), admin hub 502 → 297, knowledge base 393 → 478, permissions 473 → 254. The `/dashboard` regression is within the bound, not absent; its cause was not investigated. |

### 42.2 Other suites on d584bdf7

`test-stage3-d-r2-contracts.ts` (58), `test-retained-contact-core.ts` (10), `test-stage3-d-v-contracts.ts` (33), `smoke-role-guards.ts` (disposable), `check-api-coverage.ts`, `test-c2-postmerge-browser.ts`, `test-c2-contact-header.ts`. The new suites are registered in `scripts/pre-deploy.ts`.

### 42.3 Not established

- The full pre-deploy roster, the SEO audit and the public-route validation were not re-run; no public route was changed.
- Remaining capped `limit: 500` reads in `server/routes/ai.ts` are unchanged and remain assigned to the AI readiness scope, not to D-V.
- `/api/dashboard/stats` tickets keep the same unscoped definition as the KPI summary; role-scoping tickets would be a separate policy decision.
- Evidence runs used a desktop viewport and an admin session unless a suite states otherwise.

### 42.4 After publication (required before Stage 3 is closed)

`/api/health` SHA equals the pushed commit; authenticated admin smoke of Today actions, Tasks `?due=overdue`, Pipeline `?created=7d`, a Contact section switch, both partner pages and the three exports (row counts against SQL); Data Health apply is not run against production; confirm the outbound pause and incoming GHL sync from their actual control authorities.

## 43. D-V published-review follow-up: partner credential exposure, F01 mailbox-lock gap, F02 remainder (2026-10-22; source, not yet published)

Stage 3 stays open. This section records source and test dispositions only; live dispositions are added after publish and the final authenticated smoke.

| Item | Disposition | Evidence |
|---|---|---|
| Partner credential exposure on six routes (`GET /api/partners`, `GET /api/partners/:id`, `POST /api/partners`, `PATCH /api/partners/:id`, `GET /api/partners/referral-pipeline`, `PATCH /api/partners/:id/tracking`) | Source-fixed. Every response is built from one explicit field allowlist (`shared/partner-response.ts`, `server/utils/partner-response.ts`); nothing is copied by spreading a storage row. Password hash, reset token and expiry, invite token and expiry, `paypalEmail`, stored derived counters and the follow-up task id are not in any response. `link-referral` also returns the allowlisted partner. `Cache-Control: private, no-store`. Internal auth storage (`getPartnerByEmail`, login, reset, invite) is unchanged and still reads full rows. Roles are unchanged (list and detail: dashboard users including agents; create/update: admin; pipeline and tracking: admin/manager); no role receives credential fields. The create route no longer echoes database error text. | `scripts/test-stage3-d-v-partner-response.ts` (71 checks): actual registered handlers, fake populated credentials and a fake future internal column on a storage result, root and nested key checks, success and error bodies, anonymous/merchant/partner/affiliate/agent/manager/admin matrix, required UI fields still present, stored credentials unchanged. Registered in pre-deploy. |
| Frontend types | Storage-row types replaced by `PartnerOperatorRecord` / `PartnerPipelineRecord` in the Partner Portal admin, Referral Pipeline and Referral Program screens. | Editor diagnostics clean on all edited files; `scripts/test-stage3-d-v-partner-browser.ts`. |
| F01 remaining: `storage.updateContact` email change took graph locks but not the reconcile mailbox lock (reachable from the partner-org proposal send) | Source-fixed. `storage.updateContact` and `storage.createContact` take the per-mailbox transaction advisory lock first (old and new address, sorted to avoid deadlock), before any row or graph lock, using the same key as `writeContact` and Data Health apply (`lockContactMailboxes`). No unique-email constraint was added. Known limit: the pre-transaction read of the old email is not repeated inside the transaction; a concurrent change of the old address between that read and the lock is not covered. | Two-connection check in `scripts/certification/test-data-health-reconcile.ts` (78 checks): an updater using real `storage.updateContact` waits while another connection holds the mailbox lock, then updater and reconcile linearize (link applied only before the second match existed, or refused). The `writeContact` concurrency check is retained. |
| F02 remaining: partner "Pipeline Value" used the first 10 contacts and first 5 deals per partner | Replaced by one SQL aggregate over all referred contacts: `openPipelineVolume` (processing volume of distinct open sales-stage, production, non-archived deals; not revenue) and `openPipelineDealCount`; the label reads "Open Pipeline Volume". Admin and manager see all owners. Agent scope labels now read "owned or unassigned" deals and "assigned, unassigned, or linked to an owned deal" contacts. | Partner response suite: 12 referred contacts, 7 deals each, a repeated referral, malformed volume, archived/test/unknown/closed/onboarding rows excluded (85 deals, 84,000), and an empty partner. Partner browser suite: success, truly empty, 403, 500, Retry recovery, expanded referrals success/403/500, on both partner pages, no credential value rendered or received (12 checks). |
| Smoke selector | The API selector is `createdLast7Days=true`; `created=7d` is the page selector only. | Cohort browser suite adds an API check for the recent-deal selector. |
| Suites run on this source | partner response, partner browser, Data Health reconcile, cohort browser, landmarks browser, contracts, exports, role guards, API coverage: all pass. Data Health browser not rerun (UI and apply behavior unchanged). | Disposable runner output. |

Pending (not claimed): publish, serving-SHA check, final authenticated smoke, outbound-pause and inbound-GHL control reads, bounded non-null exposure counts for partner credential columns, owner decision on any credential rotation.

### 43.1 Live dispositions after publish (2026-10-22, serving SHA 8194202c)

- `/api/health` reports production at `8194202c8c4675008999d1d574239fe57cf11cc5`.
- Authenticated admin: `GET /api/partners`, `/api/partners/:id` and `/api/partners/referral-pipeline` return 200 with `private, no-store`, zero credential-pattern keys (23 and 27 keys), and `openPipelineVolume` as a number with no `pipelineValue`. Role-denied behavior is covered by the source role matrix; no agent or manager session was driven in production.
- Controls (read only, never changed): `GET /api/admin/pause-state` reports `paused:true`; `GET /api/admin/ghl/inbound-contact-sync` reports `inboundEnabled:true`, `outboundPaused:true`, with its stored run in state `ready`. The webhook control is part of that response and was not separately toggled or exercised.
- `GET /api/deals?pipeline=sales&createdLast7Days=true` total 0, matching read-only production SQL (0). Exports: deals 2 rows, tickets 8 rows, contacts about 160,700 lines streamed and counted without storing (consistent with 160,690 unique rows plus multi-line fields).
- Data Health: no `DATA_HEALTH%` audit rows in production; nothing applied.
- Exposure assessment (counts only, no values): 3 partners; 2 have a stored password hash; 0 reset tokens, 0 invite tokens, 0 active reset or invite tokens, 0 PayPal emails. Before this publish, the partner list, detail and pipeline routes returned the hash to every dashboard role that could call them (list and detail included agents). No bearer-style token was exposed, so no urgent token revocation is needed; whether to require those two partners to reset passwords is an owner decision. Nothing was reset.
- Not re-driven after this publish: the Today action page in a browser and a signed-in partner-state browser walk in production (covered by the disposable browser suites on the same source).

## 44. D-V remaining repairs after live verification of 8194202c (2026-10-22; source, not yet published)

| Item | Disposition | Evidence |
|---|---|---|
| F01: `updateContactLocalFirst` had no mailbox lock (Contact PUT, incoming GHL apply) | Source repaired. The function takes sorted mailbox locks (address left, address taken) before its contact row lock and re-checks the address after the row lock. `storage.updateContact` re-reads inside its transaction. The incoming GHL apply takes the source-email mailbox lock before its identity row locks. | New suite `test-stage3-d-v-mailbox-and-stats.ts` (real `updateContactLocalFirst`, real Contact PUT handler, `storage.updateContact`, two connections): the writer waits while another transaction holds the destination or old mailbox lock, the contact row is unlocked while it waits, one audit row, stale compare-and-set rejected without writes, case-only change keeps the generation, two concurrent changes into one mailbox complete without deadlock. `test-ghl-inbound-sync-integration.ts` adds a real incoming apply of a blank-email contact: it waits on the mailbox holder without holding the row lock, then completes and fills the email. Data Health reconcile suite (80 checks) pins the lock order in source. |
| F02 regex: partner pipeline SQL used a cooked single backslash, so `.` was a wildcard (accepted `1,000` pattern gaps, `1x25`; `::numeric` could fail the whole aggregate; `$1,000` was silently 0) | Source repaired. One amount contract (`shared/amount-contract.ts`, `server/utils/amount-sql.ts`) with a bracketed literal dot; invalid and blank amounts are counted as unknown deals, never summed as zero; the response carries `openPipelineVolumeUnknownDeals` and `openPipelineVolumeStatus`, and `openPipelineVolume` is `null` when no open deal has a usable amount. The KPI summary volume and profit sums use the same expression (their output no longer concatenates stray digits from malformed text; invalid amounts are excluded there without a separate indicator). | Partner response suite (77 checks) on real SQL: `$1,000`, `1,250.50`, plain amounts are summed; `1x25`, `1.2.3`, `1,00` and blank are unknown; partial, unavailable and complete partners; no route-wide cast failure; TypeScript and SQL verdicts agree on 18 samples. Partner browser suite shows the partial label on both pages. Production read-only check: 2 open production deals, both blank amounts, 0 invalid, 0 formatted, so live totals are expected to show 0 deals with a usable amount for those. |
| Stats contacts predicate | Source repaired (not wording only). `/api/dashboard/stats` contacts count uses the People list population (`readContactPopulationCount`), which includes the agent-owned-deal branch. Admin/manager numbers use the same production, non-archived, non-synthetic definition as the People list. | Agent fixture: assigned, unassigned and foreign-assigned linked to an agent-owned non-archived deal are counted (+3); foreign-assigned without a deal, foreign-assigned with only an archived agent deal, archived and non-production rows are not; stats delta, People list ids and count reader agree; admin and manager +5; merchant denied. |
| Suites on this source | New mailbox/stats suite, GHL inbound integration, partner response, partner browser (rebuilt first), Data Health reconcile, contracts, role guards, API coverage: pass. | Disposable runner output; partner browser evidence receipt and screenshots refreshed. |

Pending (not claimed): publish, serving-SHA check, authenticated live smoke of the partner pipeline keys and control reads. Agent-specific stats parity cannot be exercised with the admin account in production.

## 45. D-V lifecycle contact-count inconsistency after live verification of debf0ded (2026-10-23; source, not yet published)

Original 95-finding lineage and the three completed `debf0ded` repairs (§44) are unchanged. This is the F02/M1 contact-count definition: an independent production check on the published `debf0ded` observed Dashboard stats, People production facets and Today → Contacts by Lifecycle State disagreeing by one contact (dated observations of 160,345, 160,345 and 160,346; not fixed expectations).

| Item | Disposition | Evidence |
|---|---|---|
| `/api/analytics/lifecycle-distribution` filtered only `record_class='production'` and non-archived. It omitted the synthetic-QA exclusion and the role/ownership predicate used by People and dashboard stats. | Source repaired. A shared reader `readLifecycleDistribution` in `server/services/revenue-read-authority.ts` builds its population from `contactReadPredicate` with the same actor and production/non-archived filters as `readContactPopulationCount`. The route keeps its 2,500 ms statement timeout, the 503 unavailable body (`distribution:null`, `total:null`, `available:false`, `error`), the existing fields (`distribution`, `total`, `available`, `sampledAt`) and the `unknown` bucket for null lifecycle state; it adds a `population` field. The Overview chart now states its population, total and as-of time, and a failed read shows an unavailable message instead of vanishing or showing zero. | Disposable actual-handler suite `scripts/test-stage3-d-v-mailbox-and-stats.ts` (now 30 checks): admin, manager and agent distributions sum to their returned totals; totals equal dashboard stats and the canonical count reader for the same actor; admin/manager add exactly the five production non-archived non-QA fixtures; agent adds assigned, unassigned and foreign-assigned contacts linked to an owned non-archived deal, and excludes forbidden, archived-deal, archived, nonproduction and legacy-QA rows; per-state counts move only by in-scope fixtures; merchant denied; a real statement timeout under a table lock returns 503 with null distribution and total, and the next read recovers. Role guards (162/162), API coverage and the static classification check pass. |

These are disposable role-test results; no production write, Data Health apply, contact deletion or reclassification, outbound change or GHL change was made. Pending (not claimed): publish, serving-SHA check, and a production comparison of lifecycle total, People production facets and dashboard stats at matching scope and time.
