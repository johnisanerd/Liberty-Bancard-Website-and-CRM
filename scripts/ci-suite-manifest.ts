#!/usr/bin/env npx tsx
/**
 * ci-suite-manifest.ts — Capability-classified CI suite manifest
 *
 * Classifies every suite registered in pre-deploy.ts MANDATORY_SUITES into
 * one of four capability tiers. CI jobs must only run suites appropriate for
 * their tier — required suites cannot be omitted, skipped, or substituted
 * without a documented capability gate change here.
 *
 * Capability tiers:
 *   deterministic-static      — pure-function / AST scan; no server, no DB,
 *                               no network. Always deterministic. Runs in the
 *                               CI `static` job.
 *   deterministic-integration — requires disposable PostgreSQL and/or Redis;
 *                               no live provider calls. GHL is blocked via
 *                               GHL_TRANSPORT_FAILFAST=true. Runs in the CI
 *                               `integration` job.
 *   server-required           — needs a running dev server at localhost:5000
 *                               AND a live database. Hard-fails if server is
 *                               not reachable. Runs in CI `integration` job
 *                               after server startup.
 *   server-optional           — needs a running server but is skipped (not
 *                               failed) when the server is absent. These suites
 *                               test live-mode provider integrations (OpenAI,
 *                               GHL, etc.) that require real credentials. NOT
 *                               run in automated CI; must be run by an operator
 *                               with live credentials before each production deploy.
 *
 * Provider denial controls (deterministic suites only):
 *   GHL         — GHL_TRANSPORT_FAILFAST=true installs the server-level fail-fast
 *                 transport; any real GHL call throws TestTransportError.
 *                 Verified by test-forms.ts via /api/health.
 *   Serper      — Covered by SERPER_GATEWAY_ENABLED flag and scan-serper-raw-fetch.ts.
 *   OpenAI      — Not called in deterministic suites (AI boundaries are server-optional).
 *   SMTP        — Not called by suites (SMTP sends go through gated compliance paths
 *                 which are themselves gated by outboundGlobalPaused=true).
 *   Sunbiz      — Blocked by SUNBIZ_ENRICHMENT_ENABLED=false default in test env.
 *
 * Runner guarantees:
 *   - pre-deploy.ts verifies outboundGlobalPaused=true before and after every suite.
 *   - All suites are run as child processes (spawnSync) — no shared in-process state.
 *   - Required suites exit nonzero to fail the parent gate; cannot be silently skipped.
 *
 * Usage (self-validation):
 *   npx tsx scripts/ci-suite-manifest.ts [--check]
 *   --check: exits nonzero if the manifest is inconsistent.
 */

import fs from "fs";
import path from "path";

export type SuiteCapability =
  | "deterministic-static"
  | "deterministic-integration"
  | "server-required"
  | "server-optional"
  | "external-security"
  | "writable-build";

export interface SuiteManifestEntry {
  name: string;
  script: string;
  capability: SuiteCapability;
  database: "none" | "disposable";
  redis: "none" | "suite-isolated" | "server-shared";
  server: "none" | "required" | "optional";
  network: "denied-loopback" | "npm-registry-only" | "operator-controlled";
  workspace: "read-only" | "repository-build";
  completion: "runner-owned" | "module-receipt";
  preDeploy: "execute" | "delegated-disposable";
  /** Own fresh local PG/Redis per suite, rather than the integration group's DB. */
  isolateInfrastructure?: boolean;
  /** Whole-workload budget; individual browser performance gates remain unchanged. */
  executionTimeoutMs?: number;
  requiredEnv?: Readonly<Record<string, string>>;
  /** For server-optional: why real credentials are needed */
  providerNote?: string;
  /** For deterministic suites: which providers are denied and how */
  providerDenial?: string;
}

type SuiteManifestDefinition = Omit<
  SuiteManifestEntry,
  "database" | "redis" | "server" | "network" | "workspace" | "completion" | "preDeploy"
>;

const RAW_SUITE_MANIFEST: SuiteManifestDefinition[] = [
  {name:"Stage 3 C3 Destination Codec and Source Contracts",script:"scripts/test-stage3-c3-contracts.ts",
    capability:"deterministic-static",providerDenial:"pure codecs and source assertions only; no DB, server, browser or provider; not mounted-behavior or request/readback proof"},
  {name:"Stage 3 C3 Sequence DTO and Recovery Handlers",script:"scripts/test-stage3-c3-sequences.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/isolated Redis; actual sessions/CSRF and strict schemas; no enrollment, send or external call"},
  {name:"Stage 3 C3 Backlog Command Intent and Queue",script:"scripts/test-stage3-c3-backlog-command.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG and private Redis; producer-only BullMQ queue, no worker, provider, send or enrollment"},
  {name:"Stage 3 C3 Open Sales Deal Definition",script:"scripts/test-stage3-c3-open-deals.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/isolated Redis; one pinned deal population; no send, enrollment or external call"},
  {name:"Stage 3 C3 Role Matrix",script:"scripts/test-stage3-c3-roles.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/isolated Redis; actual sessions/CSRF; denied commands only, no effect, no external call"},
  {name:"Stage 3 C3 Source Prospects Pagination",script:"scripts/test-stage3-c3-prospects.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/isolated Redis; actual sessions; read-only route, no external call"},
  {name:"Stage 3 C3 Committed Effect Versus Audit Failure",script:"scripts/test-stage3-c3-post-commit.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/isolated Redis; actual sessions/CSRF; local policy setting only, no enrollment, send or external call"},
  {name:"Stage 3 C3 Bounded Mounted Browser",script:"scripts/test-stage3-c3-browser.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client, actual admin session, disposable readers; unregistered sources answer 501; no provider, enrollment or send path; admin desktop only"},
  {name:"Stage 3 C3 Browser Sequences And Roles",script:"scripts/test-stage3-c3-browser-sequences.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client, real sessions for seven roles, disposable database; only campaigns routes registered; no enrollment, activation, send or provider path"},
  {name:"Stage 3 C3 Browser Campaigns And Signatures",script:"scripts/test-stage3-c3-browser-campaigns.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client, manager session, disposable database; draft campaign create and signature edit only; no activation, enrollment, queueing or send path"},
  {name:"Stage 3 C3 Mounted Component Behavior",script:"scripts/test-stage3-c3-mounted.ts",
    capability:"deterministic-static",providerDenial:"jsdom mounted components with injected fetch; no real session, DB, server or provider; not role-matrix or request/readback proof"},
  {name:"Stage 3 C4 Source and Codec Contracts",script:"scripts/test-stage3-c4-contracts.ts",
    capability:"deterministic-static",providerDenial:"source/codec only; no DB, browser, server or provider"},
  {name:"Stage 3 C5 Route Inventory Provenance",script:"scripts/test-stage3-c5-route-inventory.ts",
    capability:"deterministic-static",providerDenial:"real Express 5 registration in-process; no DB, server listen, browser or provider"},
  {name:"Stage 3 C5 Diagnostics Contracts",script:"scripts/test-stage3-c5-diagnostics.ts",
    capability:"deterministic-static",providerDenial:"DTO decoders and source assertions; no DB, browser, server or provider"},
  {name:"Stage 3 C5 Resources And Selectors",script:"scripts/test-stage3-c5-resources.ts",
    capability:"deterministic-static",providerDenial:"codec, decoder, reader-state and source assertions; no DB, browser, server or provider"},
  {name:"Stage 3 C5 Final Sidebar",script:"scripts/test-stage3-c5-sidebar.ts",
    capability:"deterministic-static",providerDenial:"pure sidebar data against the generated route registry; no DB, browser, server or provider"},
  {name:"Stage 3 C5 Mounted GHL Settings",script:"scripts/test-stage3-c5-mounted.ts",
    capability:"deterministic-static",providerDenial:"jsdom mounted GHL Integration Hub with injected fetch; no real session, DB, server or provider; reproduces no live stall"},
  {name:"Stage 3 C5 Data-Bearing Panels And GHL Settings",script:"scripts/test-stage3-c5-panels.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client, real admin session, disposable migrated database; real handlers for permissions/queue-holds/readiness/knowledge reads; GHL incoming-sync is an owned stub; provider egress denied by the fixture; no write is submitted to a real handler"},
  {name:"Stage 3 C5 Remaining Panels, Roles, Theme, Contrast, Zoom",script:"scripts/test-stage3-c5-walk.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client, real sessions for six roles, disposable migrated database; real handlers for admin/knowledge/documents/permissions/integrations/content/information-flow/sdr, other sources answer 501; read-only; provider egress denied by the fixture; accessibility tree and keyboard, not a screen reader"},
  {name:"Stage 3 C5 Role Negative Requests",script:"scripts/test-stage3-c5-role-negative-requests.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"real route modules and guards, real persisted admin/manager/agent sessions, disposable migrated database; admin-only routes requested as manager, agent and unauthenticated and must deny; provider egress denied by the fixture"},
  {name:"Dead-Letter History Archive",script:"scripts/test-dead-letter-archive.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"real review-queue routes and guards, real persisted admin/manager/agent sessions, disposable migrated database; no provider is called"},
  {name:"Stage 3 C5 GHL Settings Stored Run Profile",script:"scripts/test-stage3-c5-ghl-stored-run.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client, real incoming-sync handlers and service on a disposable database with persisted production-sized runs; GHL contact pages come from an in-process fake, egress is denied by the fixture; outbound stays paused"},
  {name:"Stage 3 C5 Matched Client Performance",script:"scripts/test-stage3-c5-performance.ts",capability:"deterministic-integration",
    providerDenial:"Explicit disposable certification: serves the pre-C5 client (built locally into generated-artifacts) and the candidate against the same loopback API/DB; no provider calls"},
  {name:"Stage 3 C5 Cutover Browser Smoke",script:"scripts/test-stage3-c5-browser.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client, real sessions for admin/manager/agent, disposable database; every non-session API answers 501; navigation and read-only observation only; no write, send or provider path"},
  {name:"Stage 3 C4 Real Handler Actions",script:"scripts/test-stage3-c4-actions.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/Redis; denied external transport; simulated delayed ledger states, no native execution"},
  {name:"Stage 3 C4 Bounded Mounted Browser",script:"scripts/test-stage3-c4-browser.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled client/authenticated disposable readers and local preparation POST/readback/retry; named source faults, scoped report/Calendar/agent links, Review Queue native overlay keys and 304 route/panel role surfaces; control appearances remain untested actions, external/native transport denied"},
  {name:"Stage 3 C4 Focused Health Read Browser",script:"scripts/test-stage3-c4-health-browser.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"private compiled admin Health read/source handlers only; isolated PG/Redis, actual session and named 503s; non-seeding config GET; other sources explicit 501, computation/native/external denied; not whole C4"},
  {name:"C2 Postmerge Date and Task Helper Contracts",script:"scripts/test-c2-postmerge-repairs.ts",
    capability:"deterministic-static",providerDenial:"AST/helpers/injected callbacks only; not registered-handler or browser proof"},
  {name:"C2 Postmerge Real Handler and Mounted Browser",script:"scripts/test-c2-postmerge-browser.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/Redis/private Chromium; actual handlers, external transport denied"},
  {name:"C2 Compact Contact Header Mounted Browser",script:"scripts/test-c2-contact-header.ts",
    isolateInfrastructure:true,
    capability:"deterministic-integration",providerDenial:"guarded disposable PG/Redis/private Chromium; provider attempts denied before egress"},
  {name:"Toast Viewport Frontend Browser",script:"scripts/test-toast-viewport-layout.mjs",
    capability:"deterministic-integration",providerDenial:"Vite/private Chromium loopback fixture; no DB, login or providers"},
  {name:"Stage 3 C2 Destination and Source Contracts",script:"scripts/test-stage3-c2-contracts.ts",capability:"deterministic-static",
    providerDenial:"Pure codecs/time windows/provider payloads and temporary output tamper tests; no DB or provider I/O"},
  {name:"Stage 3 C2 Real Handler Actions",script:"scripts/test-stage3-c2-actions.ts",capability:"deterministic-integration",
    providerDenial:"Disposable DB and reserved private Redis before imports; actual sessions/CSRF/object guards; outbound/public egress denied"},
  {name:"Stage 3 C2 Protected Workspace Browser",script:"scripts/test-stage3-c2-browser.mjs",capability:"deterministic-integration",
    executionTimeoutMs:1_200_000,
    providerDenial:"Compiled current candidate; private migrated DB/Redis, actual fresh browser sign-in/CSRF and real handlers; public egress denied. Full-workload timeout 1200s; useful-list 2500ms and local-input 200ms gates unchanged"},
  {name:"Stage 3 C1 Protected Query Runtime",script:"scripts/test-stage3-c1-query-runtime.mjs",capability:"deterministic-static",
    providerDenial:"Mounted jsdom hooks and injected delayed fetch; no real sessions, DB or providers"},
  {name:"Stage 3 C1 Typed Foundation",script:"scripts/test-stage3-c1-foundation.ts",capability:"deterministic-static",
    providerDenial:"Pure complete-set/codecs/portable hashes; no DB, transport or action claims"},
  {name:"Stage 3 C1 Authenticated Candidate Browser",script:"scripts/test-stage3-c1-browser.mjs",capability:"deterministic-integration",
    providerDenial:"Private disposable DB/Redis; actual empty-profile UI login, real handlers; all non-loopback browser/server fetch denied"},
  {name:"Stage 3 B Fake Auth Continuations",script:"scripts/test-stage3-b-auth-continuations.ts",capability:"deterministic-integration",
    providerDenial:"Guarded disposable DB and Redis; fake all account-security/MFA transports; actual current auth handlers/sessions"},
  {name:"Stage 3 B Protected Browser Proof",script:"scripts/test-stage3-b-browser.ts",capability:"deterministic-integration",
    providerDenial:"Explicit disposable browser certification requires current client build and compatible Chromium; real persisted sessions, loopback-only network"},
  {name:"Stage 3 B Registered Intake and Routing",script:"scripts/test-stage3-b-intake.ts",capability:"deterministic-integration",
    providerDenial:"Canonical disposable DB and isolated Redis; real public/session handlers; zero external calls, held effects"},
  {name:"Stage 3 B Fake Invitation Handlers",script:"scripts/test-stage3-b-invitations.ts",capability:"deterministic-integration",
    providerDenial:"Guarded disposable infrastructure; fake invitation mail dependency; actual auth sessions/CSRF; no real mail"},
  {name:"Stage 3 B Recoverable Sequences",script:"scripts/test-stage3-b-sequences.ts",
    capability:"deterministic-integration",providerDenial:"Guarded disposable DB/isolated Redis; actual sessions/CSRF; no enrollment admitted or external effects"},
  {name:"Stage 3 B Contextual Notes and Companies",script:"scripts/test-stage3-b-context.ts",
    capability:"deterministic-integration",providerDenial:"Guarded disposable DB/isolated Redis and actual sessions/CSRF; fake extraction; no external calls"},
  {
    name:"Stage 3 B Contact and Privacy Lifecycle",
    script:"scripts/test-stage3-b-lifecycle.ts",
    capability:"deterministic-integration",
    providerDenial:"Guarded disposable DB and reserved Redis, actual sessions/CSRF, external calls denied; no deletion executed",
  },
  {
    name:"Stage 3 B Notification Authority",
    script:"scripts/test-stage3-b-notifications.ts",
    capability:"deterministic-integration",
    providerDenial:"Pre-import disposable DB/isolated Redis guard; actual sessions/CSRF; external fetch denied",
  },
  {
    name:"Stage 3 B Registered Inbox Work",
    script:"scripts/test-stage3-b-inbox-work.ts",
    capability:"deterministic-integration",
    providerDenial:"Pre-import disposable DB/isolated Redis guard; actual persisted sessions/CSRF; all external fetch denied",
  },
  {
    name: "Stage 3 B Offline Work Contracts",
    script: "scripts/test-stage3-b-offline.ts",
    capability: "deterministic-static",
    providerDenial: "Pure injected storage/transport/actor tests; no DB import or network",
  },
  {
    name: "Stage 3 B Source Contracts",
    script: "scripts/test-stage3-b-source-contracts.ts",
    capability: "deterministic-static",
    providerDenial: "Pure retention/consent and source assertions; no DB import or network",
  },
  {
    name: "Stage 3 B Registered Draft and Knowledge Handlers",
    script: "scripts/test-stage3-b-drafts.ts",
    capability: "deterministic-integration",
    providerDenial: "Pre-import disposable DB/Redis guard; local password/session/CSRF handlers; provider fetch denied",
  },
  {
    name: "Stage 3 B Recoverable Account Authority",
    script: "scripts/test-stage3-b-accounts.ts",
    capability: "deterministic-integration",
    providerDenial: "Pre-import disposable DB/Redis guard; actual local sessions/CSRF; outbound fetch denied; no auth mail invoked",
  },
  {
    name: "Stage 3 B Atomic Work Commands",
    script: "scripts/test-stage3-b-work-commands.ts",
    capability: "deterministic-integration",
    providerDenial: "Pre-import disposable DB/Redis guard; registered session/CSRF handlers; fake native transport; all external fetch denied",
  },
  {
    name: "Stage 3 B Trusted Work Producers",
    script: "scripts/test-stage3-b-work-adapters.ts",
    capability: "deterministic-integration",
    providerDenial: "Pre-import disposable DB/Redis guard; direct actual GHL ingestion with fixture payload; registered terminal sessions; isolated SLA seam, no worker tick or external calls",
  },
  {
    name: "SSR Style Isolation",
    script: "scripts/test-ssr-style-isolation.ts",
    capability: "deterministic-static",
    providerDenial: "Local shell/PostCSS assertions only; no DB, server or network",
  },
  {
    name: "Stage 3 A Registered Session Authority and Metrics",
    script: "scripts/test-stage3-a-authority.ts",
    capability: "deterministic-integration",
    providerDenial: "pre-import disposable DB guard; actual local password sessions and ephemeral loopback server; provider fetches denied",
  },
  {
    name: "GHL Inbound Pagination Parser",
    script: "scripts/test-ghl-inbound-pagination.ts",
    capability: "deterministic-static",
    providerDenial: "pure parser and source assertions; no service/DB imports, no network",
  },
  {
    name: "GHL Inbound Focused Sanitizer and Source Checks",
    script: "scripts/test-ghl-inbound-sync.ts",
    capability: "deterministic-integration",
    providerDenial: "pre-import disposable DB guard; DB-bound service sanitizer/source assertions only, not HTTP/session proof",
  },
  {
    name: "GHL Inbound Route Middleware",
    script: "scripts/test-ghl-inbound-route-guards.ts",
    capability: "deterministic-integration",
    providerDenial: "pre-import disposable DB guard; registered middleware/validation only, not persisted sessions",
  },
  {
    name: "GHL Inbound Service and Redirect Certification",
    script: "scripts/test-ghl-inbound-sync-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable DB; fake GHL GETs and actual loopback redirect server; no provider POST/PATCH/send/enrollment",
  },
  {
    name: "GHL Inbound UI Static Render",
    script: "scripts/test-ghl-inbound-ui-render.mjs",
    capability: "deterministic-static",
    providerDenial: "React server render fixtures; no API requests, browser interactions or DB",
  },
  {
    name: "Stage 3 A Sequence Runtime UI Static Render",
    script: "scripts/test-stage3-a-runtime-render.mjs",
    capability: "deterministic-static",
    providerDenial: "27 typed configuration/pause permutations plus unavailable-read render; no probe, send or DB",
  },
  // ── deterministic-static ─────────────────────────────────────────────────
  {
    name: "South Florida Enrichment Pipeline Correction",
    script: "scripts/test-sfp-pipeline-correction.mjs",
    capability: "deterministic-static",
    providerDenial: "pure source and migration scan; no DB, network, server, or provider transport",
  },
  {
    name: "REV-05A Processor Boarding Kill Lines",
    script: "scripts/check-processor-kill-lines.ts",
    capability: "deterministic-static",
    providerDenial: "pure source scan; no DB, no providers, no server",
  },
  {
    name: "CRO-03A South Florida Candidate Qualification",
    script: "scripts/test-cro03a-static.ts",
    capability: "deterministic-static",
    providerDenial: "pure source adapters, geography, fit, and source-boundary scans; no providers",
  },
  {
    name: "CRO-03A Geography Reference v2",
    script: "scripts/test-cro03a-geography.ts",
    capability: "deterministic-static",
    providerDenial: "pure geography evaluator; no DB, no providers",
  },
  {
    name: "CRO-03A Batch Processor Semantic Equivalence",
    script: "scripts/test-cro03a-batch-equivalence.ts",
    capability: "deterministic-integration",
    providerDenial: "guarded disposable source receipts; qualification-service batch processor vs per-item evaluator; no HTTP server or provider transport",
  },
  {
    name: "CRO-03A Batch Processor Performance & Recovery",
    script: "scripts/test-cro03a-batch-performance.ts",
    capability: "deterministic-integration",
    providerDenial: "batch processor timing, idempotency, crash-resume, cancellation; no GHL/SMTP",
  },
  {
    name: "CRO-03A Policy Comparison Service",
    script: "scripts/test-cro03a-policy-comparison.ts",
    capability: "deterministic-integration",
    providerDenial: "seeds source occurrences and a draft policy document in the server DB; comparison service is read-only (no activateCro03aPolicy() call); no GHL, SMTP, or live provider transport",
  },
  {
    name: "BT-12 Revenue State Reconciliation Authority Guard",
    script: "scripts/test-bt12-revenue-state-reconciliation.ts",
    capability: "deterministic-static",
    providerDenial: "source-backed authority guard; no providers",
  },
  {
    name: "Fresh Snapshot Completion Guard",
    script: "scripts/test-fresh-snapshot-completion.ts",
    capability: "deterministic-static",
    providerDenial: "pure migration-boundary behavior with a fake SQL client; no providers or database",
  },
  {
    name: "BT-12 Revenue State Reconciliation Integration",
    script: "scripts/test-bt12-revenue-state-reconciliation-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "requires TEST_DATABASE_URL disposable database; no provider transports are constructed",
  },
  {
    name: "South Florida Prospecting Corrections Certification",
    script: "scripts/test-sfp-disposable-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "requires TEST_DATABASE_URL disposable database; classifier/geography resolver are pure functions; program is never activated and no free-discovery/paid-waterfall/validation/campaign-staging call is made; no provider transports are constructed",
  },
  {
    name: "Task #1999 Post-Merge Audit Certification",
    script: "scripts/test-sfp1999-postmerge-audit-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "requires TEST_DATABASE_URL disposable database; runs real migrations and database guards with CRO03 provider transport unset; no provider or outreach calls",
  },
  {
    name: "Task #2000 SFP Validation & Outreach Eligibility Certification",
    script: "scripts/test-sfp2000-disposable-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "requires TEST_DATABASE_URL disposable database with a network-denied fake provider boundary; ZeroBounce validated via injected transport only; proves unified free+paid candidate consumption, real-vs-masked decryption, freshness reuse, snapshot-bound execute, atomic finalization, and the Task-2001 staging fence; no live provider or outreach calls",
  },
  {
    name: "Task #2001 SFP Campaign Staging Certification",
    script: "scripts/test-sfp2001-campaign-staging-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "requires TEST_DATABASE_URL disposable database; validates free/paid ready_held staging, exact command replay, payload mismatch, stale-snapshot rejection, migration-state compatibility, and no-send import boundaries; no live provider, outreach, or GHL calls",
  },
  {
    name: "Task #1999 Final Closeout Guard",
    script: "scripts/test-sfp1999-final-closeout.mjs",
    capability: "deterministic-static",
    providerDenial: "pure source scan for settlement, budget, and evidence-gap contracts; no DB, network, server, or provider transport",
  },
  {
    name: "South Florida Prospecting UI Idempotency Persistence",
    script: "scripts/test-sfp-ui-idempotency-persistence.ts",
    capability: "deterministic-static",
    providerDenial: "real-renders the panel in jsdom with fetch stubbed to reject; no network, database, or provider calls of any kind",
  },
  {
    name: "Canonical Identity Writer Guard",
    script: "scripts/check-contact-identity-writers.ts",
    capability: "deterministic-static",
    providerDenial: "source-only transactional writer ownership scan",
  },
  {
    name: "Canonical Intake Authority",
    script: "scripts/test-canonical-intake-authority.ts",
    capability: "deterministic-static",
    providerDenial: "source-backed authority boundary checks; no providers",
  },
  {
    name: "Canonical address ownership and receipt/native contracts",
    script: "scripts/certification/test-canonical-address-validation.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL only; no provider transport or network calls",
  },
  {
    name: "Canonical cohort-free recipient preparation",
    script: "scripts/certification/test-canonical-recipient-preparation.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL with fatal external-network denial; no send or provider operations",
  },
  {
    name: "Recipient preparation lane reservation",
    script: "scripts/certification/test-recipient-preparation-lane-reserve.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL with fatal external-network denial; no send or provider operations",
  },
  {
    name: "Upload-cohort preparation and path cost",
    script: "scripts/certification/test-preparation-upload-cohort.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL with fatal external-network denial; no send or provider operations",
  },
  {
    name: "SFP geography recovery",
    script: "scripts/certification/test-sfp-geography-recovery.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL with fatal external-network denial; website reads are injected, no provider operations",
  },
  {
    name: "Partner route registration order",
    script: "scripts/test-partner-route-order.ts",
    capability: "deterministic-integration",
    providerDenial: "real partner and onboarding route modules registered in production order; no request, database query or provider call is made",
  },
  {
    name: "Retained Sunbiz business completion",
    script: "scripts/certification/test-retained-sunbiz-business-completion.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL with fatal external-network denial; no send or provider operations",
  },
  {
    name: "Effective vertical projection slicing",
    script: "scripts/certification/test-effective-vertical-projection-slicing.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL with fatal external-network denial; no send or provider operations",
  },
  {
    name:"Audited retained original identity and fair recovery",
    script:"scripts/certification/test-audited-retained-import-recovery.ts",
    capability:"deterministic-integration",
    providerDenial:"private migrated PostgreSQL with fatal external transport denial; no paid providers or sends",
  },
  {
    name:"Canonical native transaction and lease boundaries",
    script:"scripts/certification/test-canonical-transaction-leases.ts",
    capability:"deterministic-integration",
    providerDenial:"private PostgreSQL with external transport denied; native lock, timeout and token-negative fixtures only",
  },
  {
    name:"Canonical bounded deadlock-only transaction retries",
    script:"scripts/test-canonical-transaction-retry.ts",
    capability:"deterministic-static",
    providerDenial:"injected transaction callbacks only; no database connection or provider transport",
  },
  {
    name:"Canonical provider intake and recovery",
    script:"scripts/certification/test-canonical-provider-import.ts",
    capability:"deterministic-integration",
    providerDenial:"disposable PostgreSQL with fatal network denial; canonical local intake only",
  },
  {
    name:"Canonical full-population projection coverage",
    script:"scripts/certification/test-canonical-projection-coverage.ts",
    capability:"deterministic-integration",
    providerDenial:"disposable PostgreSQL with fatal network denial; no paid queues, cohorts or messages",
  },
  {
    name:"Canonical source outbox accounting",
    script:"scripts/certification/test-canonical-source-outbox.ts",
    capability:"deterministic-integration",
    providerDenial:"disposable PostgreSQL with fatal network denial; no purchases, cohorts or messages",
  },
  {
    name:"Canonical registry entity projection",
    script:"scripts/certification/test-canonical-registry-projection.ts",
    capability:"deterministic-integration",
    providerDenial:"disposable PostgreSQL with fatal network denial; local businesses only",
  },
  {
    name:"Canonical registry original retention",
    script:"scripts/certification/test-canonical-registry-originals.ts",
    capability:"deterministic-integration",
    providerDenial:"disposable PostgreSQL with fatal network denial; original encrypted rows only",
  },
  {
    name:"Canonical address/preparation owner delivery",
    script:"scripts/certification/test-canonical-address-preparation-owner-repair.ts",
    capability:"deterministic-integration",
    providerDenial:"disposable PostgreSQL with fatal network denial; schema-only owner delivery",
  },
  {
    name:"Canonical contact linking automation",
    script:"scripts/certification/test-crm-contact-link-automation.ts",
    capability:"deterministic-integration",
    providerDenial:"disposable PostgreSQL and private runtime fixtures; no provider I/O",
  },
  {
    name: "CSV Import Reconciliation",
    script: "scripts/test-import-reconciliation.ts",
    capability: "server-required",
    providerDenial: "server-backed import fixtures; outbound providers are fail-closed",
  },
  {
    name: "Canonical Merge Manifest Guard",
    script: "scripts/check-contact-merge-manifest.ts",
    capability: "deterministic-integration",
    providerDenial: "PostgreSQL catalog inspection only; no providers",
  },
  {
    name: "Canonical Identity Merge Contract",
    script: "scripts/test-canonical-identity-merge.ts",
    capability: "deterministic-integration",
    providerDenial: "GHL_TRANSPORT_FAILFAST=true; no provider calls",
  },
  {
    name: "South Florida Prospecting Cohort Certification",
    script: "scripts/sfp-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "seeds/cleans its own canonical businesses in the server DB; ZeroBounce validated via fake transport injection (no live ZB key); no GHL/SMTP/campaign/sequence writes; asserts zero-outreach on every staging call",
  },
  {
    name: "Identity Crosswalk Certification (#1830)",
    script: "scripts/test-identity-crosswalk.ts",
    capability: "server-required",
    providerDenial: "read-only evidence sweep; no GHL/SMTP/OpenAI calls; BACKGROUND_JOB_PROFILE=off enforced",
  },
  {
    name: "Migration Integrity Check",
    script: "scripts/check-migration-integrity.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure file scan)",
  },
  {
    name: "Root Dependency Policy",
    script: "scripts/check-dependency-policy.ts",
    capability: "deterministic-static",
    providerDenial: "offline root lock/source/integrity scan; no providers",
  },
  {
    name: "Migration Seed Registration Guard (#1750)",
    script: "scripts/check-migration-seed-registration.ts",
    capability: "deterministic-static",
    providerDenial: "pure file scan of migrations/*.sql plus a static import of SEED_TARGETS; no DB queries, no providers",
  },
  {
    name: "CRO-03 Ledger Convergence Under Live Triggers (#1750)",
    script: "scripts/test-cro03-ledger-convergence.ts",
    capability: "deterministic-integration",
    providerDenial: "no provider calls (DB-only fixture proving the seed-convergence repair coexists with the real cro03_ledger_immutable/cro03_ledger_lineage_guard triggers and unique indexes)",
  },
  {
    name: "Seed Convergence Verifier Detects Deletion/Substitution (#1750)",
    script: "scripts/test-seed-convergence-verifier-integrity.ts",
    capability: "deterministic-integration",
    providerDenial: "no provider calls (DB-only fixture that deletes/substitutes each tightened canonical seed row, bypassing that table's own immutability trigger for the duration of the test, and asserts verifyProductionSeedConvergence flips to critical, then restores original state)",
  },
  {
    name: "Dependency Policy Negative Fixtures",
    script: "scripts/test-dependency-policy-evidence.ts",
    capability: "deterministic-static",
    providerDenial: "synthetic lock fixtures only; no network or providers",
  },
  {
    name: "Dependency Lifecycle and Native Probes",
    script: "scripts/test-dependency-lifecycle.ts",
    capability: "deterministic-static",
    providerDenial: "loads local installed modules only; no network or providers",
  },
  {
    name: "Artifact Dependency Inventory Fixtures",
    script: "scripts/test-inventory-artifact-dependencies.ts",
    capability: "deterministic-static",
    providerDenial: "synthetic bundle source only; no network or providers",
  },
  {
    name: "Dependency Audit Policy",
    script: "scripts/dependency-audit-policy.ts",
    capability: "external-security",
    providerDenial: "public npm advisory registry only; no application providers",
  },
  {
    name: "Dependency Audit Policy Fixtures",
    script: "scripts/test-dependency-audit-policy.ts",
    capability: "deterministic-static",
    providerDenial: "synthetic audit JSON only; no network or providers",
  },
  {
    name: "Provider Manifest and Readiness Kill Lines",
    script: "scripts/test-provider-readiness-controls.ts",
    capability: "deterministic-static",
    providerDenial: "pure manifest and eligibility decisions; no transport is constructed",
  },
  {
    name: "Paid Provider Adapter Scan",
    script: "scripts/scan-paid-provider-adapters.ts",
    capability: "deterministic-static",
    providerDenial: "source-only URL/import scanner; no providers",
  },
  {
    name: "Free-Enrichment Column Preflight",
    script: "scripts/check-free-enrichment-columns.ts",
    capability: "deterministic-integration",
    providerDenial: "EXPLAIN dry-runs only; no enrichment adapters, GHL, SMTP, Serper, or paid providers",
  },
  {
    name: "Tracked-File Exposure Scan",
    script: "scripts/scan-tracked-files.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure file scan)",
  },
  {
    name: "Tracked-File Exposure Scanner Regression",
    script: "scripts/test-scan-tracked-files.ts",
    capability: "deterministic-static",
    providerDenial: "synthetic local Git repositories only; no database, network, or provider transports",
  },
  {
    name: "CSP, CORS, JSON-LD Security Controls",
    script: "scripts/test-security-controls.ts",
    capability: "deterministic-static",
    providerDenial: "isolated Express fixture and pure renderer/source checks; no providers",
  },
  {
    name: "RVR-03 Security Static Recurrence Scanner",
    script: "scripts/test-rvr03-security-static.ts",
    capability: "deterministic-static",
    providerDenial: "synthetic source fixtures and deterministic lexical callsite scan; no providers",
  },
  {
    name: "RVR-03 Auth Action Source Contract",
    script: "server/tests/auth-actions.source.test.ts",
    capability: "deterministic-static",
    providerDenial: "source and schema contract assertions only; no database or providers",
  },
  {
    name: "RVR-03 Auth Action Concurrency",
    script: "server/tests/auth-actions.integration.test.ts",
    capability: "deterministic-integration",
    providerDenial: "TEST_DATABASE_URL disposable PostgreSQL schema only; no providers",
  },
  {
    name: "RVR-03 OG Cache Hardening",
    script: "server/tests/og-cache-hardening.test.ts",
    capability: "deterministic-static",
    providerDenial: "isolated temporary filesystem cache and pure helpers; no providers",
  },
  {
    name: "CR-04 Channel Cohort Authority Contract",
    script: "scripts/test-cr04-authority-static.ts",
    capability: "deterministic-static",
    providerDenial: "source and migration contract assertions only; no database, network, queues, or providers",
  },
  {
    name: "CR-05 Reporting Boundary and Exactness Contract",
    script: "scripts/test-reporting-boundaries.ts",
    capability: "deterministic-static",
    providerDenial: "source-only role, metric, URL-state, and exactness assertions; no database, network, queues, or providers",
  },
  {
    name: "CR-05 Task, Inbox, and Statement Authority Contract",
    script: "scripts/test-task1721-inbox-statement-structure.ts",
    capability: "deterministic-static",
    providerDenial: "source and migration authority assertions only; no database, network, queues, or providers",
  },
  {
    name: "Task 1720 DLQ History and Alert Feed Contract",
    script: "scripts/test-task1720-dlq-alert-static.ts",
    capability: "deterministic-static",
    providerDenial: "pure sanitizer and source contract assertions; no database, network, queues, or providers",
  },
  {
    name: "Slack Pause Boundary",
    script: "scripts/test-slack-pause-boundary.ts",
    capability: "deterministic-static",
    providerDenial: "injected authority and webhook spy; no database, network, queues, or providers",
  },
  {
    name: "CR-06 Content, Cadence, and Deterministic Renderer Certification",
    script: "scripts/test-cr06-governance.ts",
    capability: "deterministic-integration",
    providerDenial: "loads the DB-bound CR-06 service graph against disposable PostgreSQL; provider denial proves content/cadence/rendering assertions create no provider traffic",
  },
  {
    name: "CR-06 Promotional Enrollment Boundary Inventory",
    script: "server/tests/cr06-promotional-boundary-inventory.source.test.ts",
    capability: "deterministic-static",
    providerDenial: "source-only exhaustive enrollment and release mutation inventory; no database, queues, network, or providers",
  },
  {
    name: "CR-06 Feedback Privacy and History Contract",
    script: "server/tests/cr06-feedback-strict.source.test.ts",
    capability: "deterministic-static",
    providerDenial: "source-only strict feedback allowlist, replay, terminalization, and immutable-history assertions; no database, network, queues, or providers",
  },
  {
    name: "CR-06 Disposable Authority Certification",
    script: "scripts/test-cr06-disposable-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL and suite-isolated Redis only; certification wrapper denies all provider and public-network transports, and CR-06 dispatch is unavailable",
  },
  {
    name: "CR-06 HTTP Authorization, CSRF, and Opaque-ID Contract",
    script: "scripts/test-cr06-http-authorization.ts",
    capability: "server-required",
    providerDenial: "localhost isolated-test-auth requests only; CR-06 release remains unavailable and no provider transport is invoked",
  },
  {
    name: "CR-06 Clean-Zero and Prior-0183 Migration Upgrade Proof",
    script: "scripts/test-cr06-migration-upgrade.ts",
    capability: "deterministic-integration",
    providerDenial: "two freshly created disposable PostgreSQL databases; production migration harness only and no providers",
  },
  {
    name: "CRO-07 Controlled Delivery, Reply, Growth & Conversion Feedback Certification",
    script: "scripts/test-cro07-disposable-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL and suite-isolated Redis only; denied-by-default transport adapter never accepts a real send, CR-06 dispatch remains unavailable, and no provider or public-network transport is invoked",
  },
  {
    name: "Release Artifact Gate",
    script: "scripts/release-artifact-gate.ts",
    capability: "writable-build",
    providerDenial: "local typecheck/build/artifact scan only; no provider calls",
  },
  {
    name: "Merchant Migration Safety",
    script: "scripts/test-merchant-migration-safety.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure AST/file check)",
  },
  {
    name: "Queue Compliance",
    script: "scripts/check-queue-compliance.ts",
    capability: "deterministic-static",
    providerDenial: "source and logical queue ownership manifest validation only; no providers",
  },
  {
    name: "Compliance Scan",
    script: "scripts/compliance-scan.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure AST/file scan)",
  },
  {
    name: "CSRF Fetch Scanner",
    script: "scripts/scan-csrf-fetch.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure file scan)",
  },
  {
    name: "GHL Route Pause Gates",
    script: "scripts/test-ghl-route-pause-gates-1629.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure code scan — no runtime calls)",
  },
  {
    name: "Sender Policy",
    script: "scripts/test-sender-policy.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure code scan — no runtime calls)",
  },
  {
    name: "Serper Raw-Fetch Scan",
    script: "scripts/scan-serper-raw-fetch.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure AST scan)",
  },
  {
    name: "API Coverage",
    script: "scripts/check-api-coverage.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure file scan)",
  },
  {
    name: "Commercial Classification Static Gates",
    script: "scripts/test-commercial-classification-static.ts",
    capability: "deterministic-static",
    providerDenial: "none (pure authority, route, schema, and migration scan)",
  },
  {
    name: "Commercial Cleanup Guard",
    script: "scripts/test-cleanup-guard.ts",
    capability: "deterministic-static",
    providerDenial: "child processes refuse before any database mutation",
  },
  {
    name: "CRO-01 Revenue Contract Static",
    script: "scripts/test-cro01-revenue-contract-static.ts",
    capability: "deterministic-static",
    providerDenial: "source-only revenue authority contract; no provider transports",
  },

  // ── deterministic-integration (DB + optional Redis, no live providers) ───
  {
    name: "Serper Gateway",
    script: "scripts/test-serper-gateway.ts",
    capability: "deterministic-integration",
    providerDenial: "Serper: fake transports injected by test",
  },
  {
    name: "Serper Business Identity",
    script: "scripts/test-serper-business-identity.ts",
    capability: "deterministic-static",
    providerDenial: "Serper: fake gateway injected; no DB, no real HTTP",
  },
  {
    name: "Sunbiz Timeout & Recovery",
    script: "scripts/test-sunbiz-timeout.ts",
    capability: "deterministic-integration",
    providerDenial: "Sunbiz: disposable PostgreSQL only; no real network",
  },
  {
    name: "Prospect Import Idempotency",
    script: "scripts/test-import-idempotency.ts",
    capability: "deterministic-integration",
    providerDenial: "PostgreSQL catalog/storage contract on disposable infrastructure; no providers",
  },
  {
    name: "Contactability Engine",
    script: "scripts/test-contactability.ts",
    capability: "server-required",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true; SMTP: outboundGlobalPaused=true",
  },
  {
    name: "Commercial Classification",
    script: "scripts/test-commercial-classification.ts",
    capability: "deterministic-integration",
    providerDenial: "no provider calls; isolated Postgres only",
  },
  {
    name: "Intake Provenance",
    script: "scripts/test-intake-provenance.ts",
    capability: "deterministic-integration",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true",
  },
  {
    name: "Speed-to-Lead Pipeline",
    script: "scripts/test-speed-to-lead.ts",
    capability: "server-required",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true; outboundGlobalPaused=true",
  },
  {
    name: "Lifecycle State Machine",
    script: "scripts/test-lifecycle.ts",
    capability: "deterministic-integration",
    providerDenial: "no provider calls (lifecycle state transitions only)",
  },
  {
    name: "Transport Dispatch",
    script: "scripts/test-transport-dispatch.ts",
    capability: "deterministic-integration",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true; SMTP: outboundGlobalPaused=true",
  },
  {
    name: "GHL Inbound Webhooks",
    script: "scripts/test-ghl-webhooks.ts",
    capability: "deterministic-integration",
    providerDenial: "GHL: no outbound calls (inbound webhook parsing only)",
  },
  {
    name: "GHL CRM Decoupling",
    script: "scripts/test-ghl-decoupling.ts",
    capability: "deterministic-integration",
    providerDenial: "GHL: shadow-mode test; GHL_TRANSPORT_FAILFAST=true",
  },
  {
    name: "Appointment-to-Statement",
    script: "scripts/test-appointment-statement.ts",
    capability: "deterministic-integration",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true; SMTP: outboundGlobalPaused=true",
  },
  {
    name: "BullMQ Resilience",
    script: "scripts/test-bullmq-resilience.ts",
    capability: "deterministic-integration",
    providerDenial: "Redis: uses test prefix; no provider calls",
  },
  {
    name: "Queue Lease Fencing",
    script: "scripts/test-stale-job-lock.ts",
    capability: "deterministic-integration",
    providerDenial: "PostgreSQL registry rows use unique test job names; no providers",
  },
  {
    name: "Statement Command Durability",
    script: "server/tests/statement-command-worker.test.ts",
    capability: "deterministic-integration",
    providerDenial: "intentionally missing protected objects; statement chain and all providers are unreachable",
  },
  {
    name: "Redis Queue Topology",
    script: "scripts/test-redis-topology.ts",
    capability: "deterministic-integration",
    providerDenial: "Redis topology is inspected through an isolated test run; no providers",
  },
  {
    name: "Email Signature Coverage",
    script: "scripts/test-email-signatures.ts",
    capability: "deterministic-integration",
    providerDenial: "SMTP: outboundGlobalPaused=true (no real sends)",
  },
  {
    name: "Communication Arbitration",
    script: "scripts/test-arbitration.ts",
    capability: "deterministic-integration",
    providerDenial: "no provider calls (arbitration decision logic only)",
  },
  {
    name: "Channel Orchestrator",
    script: "scripts/test-channel-orchestrator.ts",
    capability: "deterministic-integration",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true; transport: fake adapters",
  },
  {
    name: "Attrition Monitor Cooldown",
    script: "scripts/smoke-attrition-cooldown.ts",
    capability: "deterministic-integration",
    providerDenial: "no provider calls (DB suppression logic only)",
  },
  {
    name: "Backlog Preview",
    script: "scripts/test-backlog-preview.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL fixtures and injected source failures; no providers",
  },
  {
    name: "CRO-01 Revenue Contract Integration",
    script: "scripts/test-cro01-revenue-contract-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "TEST_DATABASE_URL disposable PostgreSQL TEMP tables with rollback; no providers",
  },
  {
    name: "CRO-02 Classification Authority",
    script: "scripts/check-cro02-authority.ts",
    capability: "deterministic-static",
    providerDenial: "source-backed shadow authority check; no providers",
  },
  {
    name: "CRO-02 Graph and Import Integration",
    script: "scripts/test-cro02-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable database graph/import contract only; no providers",
  },
  {
    name: "CRO-02 HTTP Privacy and Provider Denial",
    script: "scripts/test-cro02-http.ts",
    capability: "server-required",
    providerDenial: "localhost contract only; no provider transport is invoked",
  },
  {
    name: "CRO-03 Durable Enrichment Factory",
    script: "scripts/test-cro03-static.ts",
    capability: "deterministic-static",
    providerDenial: "injected transports and source checks only; live provider/network transport denied",
  },
  {
    name: "CRO-03B Unified Recipe and Canonical Projection",
    script: "scripts/test-cro03b-static.ts",
    capability: "deterministic-static",
    providerDenial: "source and injected-transport checks only; live provider/public network transport denied",
  },
  {
    name: "CRO-03C Governed Live Activation (provider denied)",
    script: "scripts/test-cro03c-static.ts",
    capability: "deterministic-integration",
    providerDenial: "loads the DB-bound live-execution graph only against disposable PostgreSQL; realistic secret names run with denied provider/public transport",
  },
  {
    name: "CRO-03D Ceremony Scope Derivation and Ephemeral Signing Tool",
    script: "scripts/test-cro03d-ceremony-static.ts",
    capability: "deterministic-static",
    providerDenial: "pure scope/signing tool; no database, network, or provider transport; ephemeral key material confined to local temp dirs",
  },
  {
    name: "CRO-03C Initial Continuation Bridge Contract",
    script: "scripts/test-cro03c-initial-continuation-static.ts",
    capability: "deterministic-static",
    providerDenial: "source and migration contract only; no database, queue, network, or provider transport",
  },
  {
    name: "CRO-03C Worker, Lease, and Safe-Egress Contract",
    script: "scripts/test-cro03c-worker-static.ts",
    capability: "deterministic-integration",
    providerDenial: "loads the DB-bound live-execution graph against disposable PostgreSQL; SafeEgress transport is injected and provider/public transport remains denied",
  },
  {
    name: "CRO-05A Inbound Revenue Operations Static Certification",
    script: "scripts/test-cro05a-static.ts",
    capability: "deterministic-static",
    providerDenial: "source, schema, and migration certification only; no database, queue, network, or provider transport",
  },
  {
    name: "CRO-05A DB-bound Lifecycle Decision Contract",
    script: "server/tests/inbound-request-lifecycle.test.ts",
    capability: "deterministic-integration",
    providerDenial: "pre-import disposable DB guard for the authority import graph; lifecycle decision assertions only, not persisted-effect proof; no provider transport",
  },
  {
    name: "CRO-05A Non-Public Adapter Classification Certification",
    script: "scripts/test-cro05a-nonpublic-static.ts",
    capability: "deterministic-static",
    providerDenial: "source classification only; no database, queue, network, or provider transport",
  },
  {
    name: "CRO-03C Live Dispatch Durability",
    script: "scripts/test-cro03c-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL and suite-isolated Redis; all provider and public-network transport is denied",
  },
  {
    name: "CRO-03C Provider Executor Hardening",
    script: "scripts/test-cro03c-provider-executors.ts",
    capability: "deterministic-integration",
    providerDenial: "loads the DB-bound live provider executor graph against disposable PostgreSQL; no provider client method is invoked",
  },
  {
    name: "MI-09 Pricing Artifact & Snapshot Seed Certification",
    script: "scripts/test-mi09-pricing-seed-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL only; no provider client, HTTP transport, queue, or scheduler is touched",
  },
  {
    name: "CRO-03C OpenAI Bundle DB-bound Unit Certification",
    script: "scripts/test-cro03c-openai-bundle-static.ts",
    capability: "deterministic-integration",
    providerDenial: "pre-import disposable DB guard for the eager service graph; constructor/approval/validator unit assertions only, not dispatch proof; no provider transport",
  },
  {
    name: "CRO-03B Durable Recipe Lifecycle",
    script: "scripts/test-cro03b-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "database-backed certification mode suppresses queue transport; provider/public network transport remains denied",
  },
  {
    name: "CRO-03B CSV Handoff Certification — Business-Only, Contact, Safe-Hold, DBPR-HR, Cross-Source Dedup, and countyFips Conflict Paths",
    script: "scripts/certify-cro03b-csv-handoff.ts",
    capability: "deterministic-integration",
    providerDenial: "database-backed certification mode; all external recipe stages (public-web, rdap, jsonld, serper, outscraper, openai, apollo) are recorded as transport_denied with zero units; no live GHL, SMTP, or provider call is made; Paths D/E/F exercise the real DBPR-HR adapter path, cross-source dedup via resolveOrganization() phone/name+location matching, and concurrent projection race; Path G certifies CRO03B_COUNTY_FIPS_CONFLICT guard with real DB rows — all without any live provider transport",
  },
  {
    name: "CRO-03B Legacy Writer Inventory",
    script: "scripts/check-cro03b-legacy-writers.ts",
    capability: "deterministic-static",
    providerDenial: "source-only canonical-writer inventory; no providers, database, queues, or network",
  },
  {
    name: "CRO-03 Ledger Drift Repair Apply and Replay",
    script: "scripts/test-cro03-ledger-drift-repair.ts",
    capability: "deterministic-integration",
    providerDenial: "approved staging/test PostgreSQL transaction only; migration replay is rolled back and no provider transport is constructed",
  },
  {
    name: "CRO-03 Apollo Organization Resolution",
    script: "scripts/test-apollo-organization-resolution.ts",
    capability: "deterministic-integration",
    providerDenial: "loads the DB-bound SDR Apollo graph against disposable PostgreSQL; transport is mocked and the production wrapper is verified fail-closed",
  },
  {
    name: "CRO-03 Retired Client Endpoint Scan",
    script: "scripts/scan-cro03-client-endpoints.ts",
    capability: "deterministic-static",
    providerDenial: "source-only endpoint scan; no provider transport",
  },
  {
    name: "CRO-03 Durable Enrichment Factory Concurrency and Recovery",
    script: "scripts/test-cro03-integration.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL and isolated Redis; provider and public-network transport denied by certification wrapper",
  },
  {
    name: "CRO-03 HTTP Authorization and Ownership",
    script: "scripts/test-cro03-http-authorization.ts",
    capability: "server-required",
    providerDenial: "localhost authorization contract; CRO-03 providers remain disabled",
  },
  {
    name: "SEC-02 Session Validity Fail-Closed",
    script: "scripts/test-session-validity-fail-closed.ts",
    capability: "deterministic-integration",
    providerDenial: "pre-import disposable DB guard; real guards with authStorage monkey-patched in-process, not persisted-session proof; no server or provider transport",
  },
  // ── server-required (live server + DB; hard-fails if server absent) ──────
  {
    name: "CRM Operator Experience",
    script: "scripts/test-crm-operator-experience.ts",
    capability: "server-required",
    providerDenial: "no provider calls (two-agent ownership fixture and response-contract regression scan)",
  },
  {
    name: "Sequence Compliance",
    script: "scripts/test-sequence-compliance.ts",
    capability: "server-required",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true; SMTP: outboundGlobalPaused=true",
  },
  {
    name: "Sequence Terminalization Advisory-Lock Race",
    script: "scripts/test-sequence-terminalization-race.ts",
    capability: "deterministic-integration",
    providerDenial: "no provider calls (disposable DB race only)",
  },
  {
    name: "New-Lead Enrollment Policy",
    script: "scripts/test-new-lead-enrollment-policy.ts",
    capability: "server-required",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true",
  },
  {
    name: "Role Guards",
    script: "scripts/smoke-role-guards.ts",
    capability: "server-required",
    providerDenial: "none (HTTP role-gate testing only)",
  },
  {
    name: "SEO Audit",
    script: "scripts/seo-audit.ts",
    capability: "server-required",
    providerDenial: "none (HTML crawl only)",
  },
  {
    name: "Statement Acquisition",
    script: "scripts/test-statement-acquisition.ts",
    capability: "server-required",
    providerDenial: "GHL: GHL_TRANSPORT_FAILFAST=true; SMTP: persisted pause",
  },
  {
    name: "NBA Engine",
    script: "scripts/test-nba.ts",
    capability: "server-required",
    providerDenial: "no provider calls (startup-initialized pause state + NBA decision engine only)",
  },
  {
    name: "Outbound Pause Authority",
    script: "scripts/test-outbound-pause-authority.ts",
    capability: "server-required",
    providerDenial: "no provider calls (startup-seeded pause-authority state machine only)",
  },
  {
    name: "Outbound Boundary Denial",
    script: "scripts/test-outbound-boundary-1626.ts",
    capability: "server-required",
    providerDenial: "GHL: dummy in-process config + rejecting fetch spy; SMTP: persisted pause",
  },
  {
    name: "Outbound Pause Fence",
    script: "scripts/test-pause-fence.ts",
    capability: "server-required",
    providerDenial: "no provider calls (startup-seeded pause-control rows only)",
  },
  {
    name: "CRO-01 Provider/Staging Denial",
    script: "scripts/test-cro01-provider-denial.ts",
    capability: "server-required",
    providerDenial: "localhost isolated-test-auth requests only; denied PUT returns before provider or queue work",
  },

  // ── server-optional (skipped when server absent; requires live credentials) ─
  {
    name: "Live Health Monitor",
    script: "scripts/test-live-health.ts",
    capability: "server-optional",
    providerNote: "Requires OpenAI key (AI probe) and live Redis; skip in CI",
  },
  {
    name: "Chat Business Hours",
    script: "scripts/test-chat-business-hours.ts",
    capability: "server-optional",
    providerNote: "Tests live-mode AI handoff timing; requires real server config",
  },
  {
    name: "AI Assistant Boundaries",
    script: "scripts/test-ai-assistant-boundaries.ts",
    capability: "server-optional",
    providerNote: "Tests live AI provider responses; requires OpenAI key",
  },
  {
    name: "Public Forms",
    script: "scripts/test-forms.ts",
    capability: "server-optional",
    providerNote: "GHL isolated via GHL_TRANSPORT_FAILFAST; requires ADMIN credentials",
  },
  {
    name: "Portfolio Scoping",
    script: "scripts/smoke-portfolio.ts",
    capability: "server-optional",
    providerNote: "Ownership boundary tests; requires ADMIN + agent credentials",
  },
  {
    name: "Go-Live Gate",
    script: "scripts/smoke-golive-gate.ts",
    capability: "server-optional",
    providerNote: "422 gate and admin override tests; requires ADMIN credentials",
  },
  // ── Contact Reconciliation ─────────────────────────────────────────────────
  {
    name: "Reconciliation Classifier",
    script: "scripts/test-reconciliation-classifier.ts",
    capability: "deterministic-static",
    providerDenial: "pure-function classifier; no database, network, or provider",
  },
  {
    name: "Reconciliation Certification",
    script: "scripts/test-reconciliation-certification.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL only; no network or provider transports",
  },
  {
    name: "Reconciliation Performance",
    script: "scripts/test-reconciliation-performance.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL only; no network or provider transports",
  },
  {
    name: "CRO-03A Autowire and Stale-Occurrence Watchdog Certification",
    script: "scripts/certify-cro03a-autowire.ts",
    capability: "deterministic-integration",
    providerDenial: "disposable PostgreSQL only; no provider transports, no network, no live DB",
  },
];

function defineSuite(definition: SuiteManifestDefinition): SuiteManifestEntry {
  const stateful =
    definition.capability === "deterministic-integration" ||
    definition.capability === "server-required";
  return {
    ...definition,
    database: definition.script==="scripts/test-toast-viewport-layout.mjs" ? "none" : stateful ? "disposable" : "none",
    redis:
      definition.script==="scripts/test-toast-viewport-layout.mjs" ? "none" : definition.capability === "deterministic-integration"
        ? "suite-isolated"
        : definition.capability === "server-required"
          ? "server-shared"
          : "none",
    server:
      definition.capability === "server-required"
        ? "required"
        : definition.capability === "server-optional"
          ? "optional"
          : "none",
    network:
      definition.capability === "external-security"
        ? "npm-registry-only"
        : definition.capability === "server-optional"
          ? "operator-controlled"
          : "denied-loopback",
    workspace:
      definition.capability === "writable-build" ? "repository-build" : "read-only",
    completion: stateful ? "module-receipt" : "runner-owned",
    preDeploy:
      definition.script === "scripts/test-backlog-preview.ts"
        ? "delegated-disposable"
        : "execute",
    requiredEnv:
      definition.script === "server/tests/auth-actions.integration.test.ts"
        ? { AUTH_ACTION_DB_TEST_OPT_IN: "1" }
        : undefined,
  };
}

export const SUITE_MANIFEST: SuiteManifestEntry[] =
  RAW_SUITE_MANIFEST.map(defineSuite);

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Extract script paths from MANDATORY_SUITES in pre-deploy.ts.
 * Uses a simple regex over the source text; this avoids importing pre-deploy.ts
 * (which has side effects) while staying accurate for the `script: "..."` pattern
 * that every suite entry uses.
 */
function extractPreDeployScripts(): string[] {
  const preDeployPath = path.join(process.cwd(), "scripts", "pre-deploy.ts");
  if (!fs.existsSync(preDeployPath)) {
    throw new Error("scripts/pre-deploy.ts not found — cannot compare against MANDATORY_SUITES");
  }
  const src = fs.readFileSync(preDeployPath, "utf8");
  // Extract all `script: "..."` values within the MANDATORY_SUITES array.
  // Start extraction from MANDATORY_SUITES declaration; stop at the first `];`.
  const start = src.indexOf("MANDATORY_SUITES");
  if (start === -1) throw new Error("MANDATORY_SUITES not found in pre-deploy.ts");
  const end = src.indexOf("];", start);
  const suiteBlock = end !== -1 ? src.slice(start, end) : src.slice(start);
  const matches = [...suiteBlock.matchAll(/\bscript\s*:\s*"([^"]+)"/g)];
  return matches.map(m => m[1]);
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");

  const byCapability = new Map<SuiteCapability, SuiteManifestEntry[]>();
  for (const suite of SUITE_MANIFEST) {
    const bucket = byCapability.get(suite.capability) ?? [];
    bucket.push(suite);
    byCapability.set(suite.capability, bucket);
  }

  console.log("\n── CI Suite Capability Manifest ────────────────────────────────\n");
  const tiers: SuiteCapability[] = [
    "deterministic-static",
    "deterministic-integration",
    "server-required",
    "server-optional",
    "external-security",
    "writable-build",
  ];

  for (const tier of tiers) {
    const suites = byCapability.get(tier) ?? [];
    console.log(`\n  ${tier.toUpperCase()} (${suites.length} suite${suites.length !== 1 ? "s" : ""}):`);
    for (const s of suites) {
      console.log(`    ${s.script}`);
      if (s.providerDenial) console.log(`      providers: ${s.providerDenial}`);
      if (s.providerNote) console.log(`      note: ${s.providerNote}`);
    }
  }

  console.log(`\n  Total: ${SUITE_MANIFEST.length} suites classified`);

  // ── Internal manifest integrity checks ──
  let errors = 0;

  // No suite should appear twice in the manifest.
  const manifestScripts = SUITE_MANIFEST.map(s => s.script);
  const manifestScriptSet = new Set(manifestScripts);
  if (manifestScriptSet.size !== manifestScripts.length) {
    console.error("  ✗ MANIFEST ERROR: duplicate script entries in SUITE_MANIFEST");
    errors++;
  } else {
    console.log("  ✓ No duplicate script entries in manifest");
  }

  for (const suite of SUITE_MANIFEST) {
    if (!fs.existsSync(path.join(process.cwd(), suite.script))) {
      console.error(`  ✗ MANIFEST ERROR: suite file does not exist: ${suite.script}`);
      errors++;
    }
    if (suite.server === "required" && suite.capability !== "server-required") {
      console.error(`  ✗ MANIFEST ERROR: ${suite.script} has an inconsistent server contract`);
      errors++;
    }
    if (suite.network === "npm-registry-only" && suite.capability !== "external-security") {
      console.error(`  ✗ MANIFEST ERROR: ${suite.script} has an inconsistent network contract`);
      errors++;
    }
    if (suite.workspace === "repository-build" && suite.capability !== "writable-build") {
      console.error(`  ✗ MANIFEST ERROR: ${suite.script} has an inconsistent workspace contract`);
      errors++;
    }
  }

  // server-optional suites must not also be in server-required.
  const serverOptionalSet = new Set(
    SUITE_MANIFEST.filter(s => s.capability === "server-optional").map(s => s.script)
  );
  const serverRequiredSet = new Set(
    SUITE_MANIFEST.filter(s => s.capability === "server-required").map(s => s.script)
  );
  const overlap = [...serverOptionalSet].filter(s => serverRequiredSet.has(s));
  if (overlap.length > 0) {
    console.error(`  ✗ MANIFEST ERROR: suites in both server-optional and server-required: ${overlap.join(", ")}`);
    errors++;
  } else {
    console.log("  ✓ No server-optional/server-required overlap");
  }

  // All deterministic suites must have a providerDenial entry.
  const deterministicMissingDenial = SUITE_MANIFEST.filter(
    s =>
      (s.capability === "deterministic-static" ||
        s.capability === "deterministic-integration") &&
      !s.providerDenial
  );
  if (deterministicMissingDenial.length > 0) {
    console.error(
      `  ✗ MANIFEST ERROR: deterministic suites missing providerDenial: ${deterministicMissingDenial.map(s => s.script).join(", ")}`
    );
    errors++;
  } else {
    console.log("  ✓ All deterministic suites have provider denial documentation");
  }

  // ── Registry comparison: manifest vs. pre-deploy.ts MANDATORY_SUITES ──
  // Every script in pre-deploy.ts MANDATORY_SUITES must be classified in the
  // manifest; any unclassified script is a coverage gap.
  console.log("\n  Comparing manifest against scripts/pre-deploy.ts MANDATORY_SUITES:");
  let preDeployScripts: string[];
  try {
    preDeployScripts = extractPreDeployScripts();
  } catch (err: any) {
    console.error(`  ✗ MANIFEST ERROR: could not read pre-deploy.ts — ${err.message}`);
    errors++;
    preDeployScripts = [];
  }

  if (preDeployScripts.length > 0) {
    // Suites in pre-deploy but not in manifest (need classification)
    const unclassified = preDeployScripts.filter(s => !manifestScriptSet.has(s));
    if (unclassified.length > 0) {
      for (const s of unclassified) {
        console.error(`  ✗ MANIFEST GAP: '${s}' is in MANDATORY_SUITES but not classified in SUITE_MANIFEST`);
      }
      errors++;
    } else {
      console.log(
        `  ✓ All ${preDeployScripts.length} MANDATORY_SUITES scripts are classified in the manifest`
      );
    }

    // Suites in manifest but not in pre-deploy (stale / not registered)
    const stale = manifestScripts.filter(s => !preDeployScripts.includes(s));
    if (stale.length > 0) {
      for (const s of stale) {
        console.error(`  ✗ MANIFEST STALE: '${s}' is in SUITE_MANIFEST but not in MANDATORY_SUITES`);
        errors++;
      }
    } else {
      console.log("  ✓ No stale manifest entries (all manifest scripts are in MANDATORY_SUITES)");
    }
  }

  if (errors > 0) {
    console.error(`\n✗ Suite manifest INVALID: ${errors} error(s)`);
    if (checkMode) process.exit(1);
    // In non-check mode just report
  } else {
    console.log("\n✅ Suite manifest valid\n");
  }
}

// The manifest is also imported by scripts/run-ci-suites.ts. Avoid executing
// validation/reporting as an import side effect; CI invokes --check explicitly.
if (process.argv[1]?.endsWith("ci-suite-manifest.ts")) {
  main();
}
