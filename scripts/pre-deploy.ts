#!/usr/bin/env tsx
/**
 * scripts/pre-deploy.ts — Unified launch gate
 *
 * Runs every mandatory test suite in sequence. For each suite:
 *   1. Verifies outboundGlobalPaused=true in the DB before starting
 *   2. Runs the suite as a child process (npx tsx <script>)
 *   3. Verifies outboundGlobalPaused=true again after the suite completes
 *   4. Restores pause=true if a suite temporarily lifted it
 *
 * After all suites, reports external provider configuration gaps as
 * non-blocking warnings (Gmail, GHL, OpenAI, SMTP, A2P, webhook key, etc.).
 *
 * Exits 0 only when every required executed suite exits 0, no mandatory suite
 * is delegated/unverified, and pause checks/restoration all succeed. Explicit
 * opt-in and live-only skips are reported separately from child exits.
 *
 * ── SERVER REQUIREMENT ────────────────────────────────────────────────────────
 * Server-required suites (including Role Guards, SEO Audit, Sequence Compliance,
 * New-Lead Enrollment Policy, and Identity Crosswalk) cannot be silently skipped.
 * If a selected server-required suite cannot reach the server, the gate fails.
 *
 * Run the gate through the provided wrapper instead of calling this script
 * directly — the wrapper starts the server, waits for readiness, then runs the
 * gate and tears the server down on exit:
 *
 *   bash scripts/run-pre-deploy.sh
 *
 * A bounded exact suite selector is available only through the private
 * disposable launcher, which gives every selected suite fresh private DB,
 * Redis, and HTTP resources:
 *
 *   npx tsx scripts/run-sfp2060-predeploy-disposable.ts --only scripts/test-mi09-pricing-seed-integration.ts
 *
 * Never use --only as a production release override. It rejects any environment
 * that is not the audited, loopback-only disposable test configuration.
 *
 * Alternatively, start the dev server first and then run this script:
 *
 *   npm run dev &           # or use the "Start application" workflow
 *   npx tsx scripts/pre-deploy.ts
 *
 * Three suites (Chat Business Hours, AI Assistant Boundaries, Public Forms) are
 * also server-dependent but are skipped when the server is not in live mode —
 * they test provider integrations that require real credentials.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The script never deploys. It only validates.
 */

import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  certificationHttpReadinessFields,
  isVerifiedPrivateDisposablePostgresUrl,
  recordCertificationHttpListener,
  resolveCertificationHttpContract,
} from "../server/lib/certification-http-contract";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const TEST_BASE_URL = process.env.TEST_BASE_URL ?? BASE_URL;
let db: typeof import("../server/db").db;
let dbPool: typeof import("../server/db").pool | undefined;
let systemSettings: typeof import("../shared/schema").systemSettings;

export interface Suite {
  name: string;
  script: string;
  env?: Record<string, string>;
  timeoutSecs?: number;
  requiresServer?: boolean;
  /** Runs only when the caller explicitly selects this suite in disposable test mode. */
  explicitDisposableOptIn?: boolean;
  /**
   * Stateful certification that must never inherit the release/development DB.
   * It runs here only when the caller explicitly supplies the same clearly
   * disposable DATABASE_URL/TEST_DATABASE_URL under NODE_ENV=test. The
   * deterministic-integration CI capability is its normal execution owner.
   */
  requiresDisposableTestDatabase?: boolean;
  /**
   * When true, the suite is silently skipped if the server is unreachable (e.g.
   * it tests live-mode provider integrations that need real credentials).
   * When false/absent and requiresServer is true, an unreachable server causes
   * a hard gate failure — the suite must not be silently skipped.
   */
  skipWhenServerDown?: boolean;
}

// Capability classification for all suites is in scripts/ci-suite-manifest.ts.
// That file classifies each suite as: deterministic-static, deterministic-integration,
// server-required, or server-optional. CI jobs must run only the deterministic classes.
// To verify the manifest: npx tsx scripts/ci-suite-manifest.ts --check
// Private uploaded workbooks are not checked into CI/deployment artifacts.
// Explicit local certification uses the SAME isolated launcher, without making
// missing private fixtures a new mandatory release failure.
export const CERTIFICATION_FIXTURE_SUITES: Suite[] = [
  {name:"Original provider-import restart and immutable retained evidence",
    script:"scripts/certification/test-provider-import-recovery.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"Full actual canonical workbook intake",script:"scripts/certification/test-canonical-workbook-intake.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
  // C3 reuse: explicit --only selection only (not part of the default roster).
  {name:"Canonical release authority",script:"scripts/certification/test-canonical-release-authority.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"Vertical acceptance policy",script:"scripts/certification/test-vertical-acceptance-policy.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"Staged email materialization",script:"scripts/certification/test-staged-email-materialization.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"Serper lookup memory",script:"scripts/certification/test-serper-lookup-memory.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"First-party native install",script:"scripts/certification/test-first-party-native-install.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"Intake review pages",script:"scripts/certification/test-intake-review-pages.ts",
    timeoutSecs:900,requiresDisposableTestDatabase:true},
];
export const MANDATORY_SUITES: Suite[] = [
  {name:"Stage 3 C3 Destination Codec and Source Contracts",script:"scripts/test-stage3-c3-contracts.ts",timeoutSecs:60},
  {name:"Stage 3 C3 Sequence DTO and Recovery Handlers",script:"scripts/test-stage3-c3-sequences.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Role Matrix",script:"scripts/test-stage3-c3-roles.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Backlog Command Intent and Queue",script:"scripts/test-stage3-c3-backlog-command.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Open Sales Deal Definition",script:"scripts/test-stage3-c3-open-deals.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Source Prospects Pagination",script:"scripts/test-stage3-c3-prospects.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Committed Effect Versus Audit Failure",script:"scripts/test-stage3-c3-post-commit.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Bounded Mounted Browser",script:"scripts/test-stage3-c3-browser.ts",timeoutSecs:480,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Browser Sequences And Roles",script:"scripts/test-stage3-c3-browser-sequences.ts",timeoutSecs:480,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Browser Campaigns And Signatures",script:"scripts/test-stage3-c3-browser-campaigns.ts",timeoutSecs:480,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C3 Mounted Component Behavior",script:"scripts/test-stage3-c3-mounted.ts",timeoutSecs:420},
  {name:"Stage 3 C5 Route Inventory Provenance",script:"scripts/test-stage3-c5-route-inventory.ts",timeoutSecs:120},
  {name:"Stage 3 C5 Diagnostics Contracts",script:"scripts/test-stage3-c5-diagnostics.ts",timeoutSecs:120},
  {name:"Stage 3 D GHL Ownership Readiness",script:"scripts/test-ghl-ownership-readiness.ts",timeoutSecs:60},
  {name:"Stage 3 D Hub Tab URL State",script:"scripts/test-stage3-d-hub-tabs.ts",timeoutSecs:60},
  {name:"Stage 3 D-R2 Contracts",script:"scripts/test-stage3-d-r2-contracts.ts",timeoutSecs:60},
  {name:"Stage 3 D-V Contracts",script:"scripts/test-stage3-d-v-contracts.ts",timeoutSecs:90},
  {name:"Stage 3 D-R2 Retained Contact Core",script:"scripts/test-retained-contact-core.ts",timeoutSecs:60},
  {name:"Stage 3 D-R2 Heading Ownership Mounted",script:"scripts/test-stage3-d-r2-headings.ts",timeoutSecs:120},
  {name:"Stage 3 D-R2 Company Search Authority",script:"scripts/test-company-search-authority.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C5 Resources And Selectors",script:"scripts/test-stage3-c5-resources.ts",timeoutSecs:60},
  {name:"Stage 3 C5 Final Sidebar",script:"scripts/test-stage3-c5-sidebar.ts",timeoutSecs:60},
  {name:"Stage 3 C5 Mounted GHL Settings",script:"scripts/test-stage3-c5-mounted.ts",timeoutSecs:420},
  {name:"Stage 3 C5 Data-Bearing Panels And GHL Settings",script:"scripts/test-stage3-c5-panels.ts",timeoutSecs:600,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C5 Role Negative Requests",script:"scripts/test-stage3-c5-role-negative-requests.ts",timeoutSecs:600,requiresDisposableTestDatabase:true},
  {name:"Stage 3 D-V Landmarks Browser",script:"scripts/test-stage3-d-v-landmarks-browser.ts",timeoutSecs:300,requiresDisposableTestDatabase:true},
  {name:"Stage 3 D-V Contact Core Browser",script:"scripts/test-stage3-d-v-contact-core-browser.ts",timeoutSecs:300,requiresDisposableTestDatabase:true},
  {name:"Stage 3 D-V Cohort Browser",script:"scripts/test-stage3-d-v-cohort-browser.ts",timeoutSecs:300,requiresDisposableTestDatabase:true},
  {name:"Stage 3 D-V Data Health Browser",script:"scripts/test-stage3-d-v-data-health-browser.ts",timeoutSecs:600,requiresDisposableTestDatabase:true},
  {name:"Stage 3 D-V Exports",script:"scripts/test-stage3-d-v-exports.ts",timeoutSecs:300,requiresDisposableTestDatabase:true},
  {name:"Dead-Letter History Archive",script:"scripts/test-dead-letter-archive.ts",timeoutSecs:300,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C5 GHL Settings Stored Run Profile",script:"scripts/test-stage3-c5-ghl-stored-run.ts",timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C5 Remaining Panels, Roles, Theme, Contrast, Zoom",script:"scripts/test-stage3-c5-walk.ts",timeoutSecs:900,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C5 Matched Client Performance",script:"scripts/test-stage3-c5-performance.ts",timeoutSecs:600,requiresDisposableTestDatabase:true,explicitDisposableOptIn:true},
  {name:"Stage 3 C5 Cutover Browser Smoke",script:"scripts/test-stage3-c5-browser.ts",timeoutSecs:480,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C4 Source and Codec Contracts",script:"scripts/test-stage3-c4-contracts.ts",timeoutSecs:60},
  {name:"Stage 3 C4 Real Handler Actions",script:"scripts/test-stage3-c4-actions.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C4 Bounded Mounted Browser",script:"scripts/test-stage3-c4-browser.ts",timeoutSecs:480,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C4 Focused Health Read Browser",script:"scripts/test-stage3-c4-health-browser.ts",timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"C2 Postmerge Date and Task Helper Contracts",script:"scripts/test-c2-postmerge-repairs.ts",timeoutSecs:60},
  {name:"C2 Postmerge Real Handler and Mounted Browser",script:"scripts/test-c2-postmerge-browser.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"C2 Compact Contact Header Mounted Browser",script:"scripts/test-c2-contact-header.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  {name:"Toast Viewport Frontend Browser",script:"scripts/test-toast-viewport-layout.mjs",timeoutSecs:120},
  {name:"Stage 3 C1 Protected Query Runtime",script:"scripts/test-stage3-c1-query-runtime.mjs",timeoutSecs:60},
  {name:"Stage 3 C2 Destination and Source Contracts",script:"scripts/test-stage3-c2-contracts.ts",timeoutSecs:60},
  {name:"Stage 3 C2 Real Handler Actions",script:"scripts/test-stage3-c2-actions.ts",timeoutSecs:240,requiresDisposableTestDatabase:true},
  // Full role/action/viewport workload; not the per-list or input latency limit.
  {name:"Stage 3 C2 Protected Workspace Browser",script:"scripts/test-stage3-c2-browser.mjs",timeoutSecs:1200,requiresDisposableTestDatabase:true},
  {name:"Stage 3 C1 Typed Foundation",script:"scripts/test-stage3-c1-foundation.ts",timeoutSecs:60},
  {name:"Stage 3 C1 Authenticated Candidate Browser",script:"scripts/test-stage3-c1-browser.mjs",
    timeoutSecs:600,requiresDisposableTestDatabase:true},
  {name:"Canonical native transaction and lease boundaries",
    script:"scripts/certification/test-canonical-transaction-leases.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"Canonical bounded deadlock-only transaction retries",
    script:"scripts/test-canonical-transaction-retry.ts",timeoutSecs:60},
  {name:"Audited retained original identity and fair recovery",
    script:"scripts/certification/test-audited-retained-import-recovery.ts",
    timeoutSecs:300,requiresDisposableTestDatabase:true},
  {name:"Canonical address/preparation owner delivery",script:"scripts/certification/test-canonical-address-preparation-owner-repair.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"Canonical registry original retention",script:"scripts/certification/test-canonical-registry-originals.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"Canonical registry entity projection",script:"scripts/certification/test-canonical-registry-projection.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"Canonical source outbox accounting",script:"scripts/certification/test-canonical-source-outbox.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"Canonical full-population projection coverage",script:"scripts/certification/test-canonical-projection-coverage.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"Canonical contact linking automation",script:"scripts/certification/test-crm-contact-link-automation.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  {name:"Canonical provider intake and recovery",script:"scripts/certification/test-canonical-provider-import.ts",
    timeoutSecs:180,requiresDisposableTestDatabase:true},
  { name: "Canonical cohort-free recipient preparation",
    script: "scripts/certification/test-canonical-recipient-preparation.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "Recipient preparation lane reservation",
    script: "scripts/certification/test-recipient-preparation-lane-reserve.ts",
    timeoutSecs: 240, requiresDisposableTestDatabase: true },
  { name: "Upload-cohort preparation and path cost",
    script: "scripts/certification/test-preparation-upload-cohort.ts",
    timeoutSecs: 240, requiresDisposableTestDatabase: true },
  { name: "SFP geography recovery",
    script: "scripts/certification/test-sfp-geography-recovery.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "ZeroBounce ambiguous recovery",
    script: "scripts/certification/test-zerobounce-ambiguous-recovery.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "ZeroBounce ambiguous recovery real worker",
    script: "scripts/certification/test-zerobounce-ambiguous-recovery-worker.ts",
    timeoutSecs: 240, requiresDisposableTestDatabase: true },
  { name: "Independent domain/location contact assignment",
    script: "scripts/certification/test-domain-location-assignment.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "Governed Data Health reconcile",
    script: "scripts/certification/test-data-health-reconcile.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "Pipeline metric contract",
    script: "scripts/certification/test-pipeline-metric-contract.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "Serper contact-page stage",
    script: "scripts/certification/test-serper-contact-page-stage.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "Partner route registration order",
    script: "scripts/test-partner-route-order.ts", timeoutSecs: 120 },
  { name: "Retained Sunbiz business completion",
    script: "scripts/certification/test-retained-sunbiz-business-completion.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "Effective vertical projection slicing",
    script: "scripts/certification/test-effective-vertical-projection-slicing.ts",
    timeoutSecs: 180, requiresDisposableTestDatabase: true },
  { name: "Canonical address ownership and receipt/native contracts",
    script: "scripts/certification/test-canonical-address-validation.ts",
    timeoutSecs: 120, requiresDisposableTestDatabase: true },
  { name: "Stage 3 A Registered Session Authority and Metrics", script: "scripts/test-stage3-a-authority.ts", timeoutSecs: 180 },
  { name: "Stage 3 B Source Contracts", script: "scripts/test-stage3-b-source-contracts.ts", timeoutSecs: 60 },
  { name:"Stage 3 B Offline Work Contracts",script:"scripts/test-stage3-b-offline.ts",timeoutSecs:60 },
  { name:"Stage 3 B Registered Inbox Work",script:"scripts/test-stage3-b-inbox-work.ts",timeoutSecs:180 },
  { name:"Stage 3 B Notification Authority",script:"scripts/test-stage3-b-notifications.ts",timeoutSecs:180 },
  { name:"Stage 3 B Contact and Privacy Lifecycle",script:"scripts/test-stage3-b-lifecycle.ts",timeoutSecs:180 },
  {name:"Stage 3 B Contextual Notes and Companies",script:"scripts/test-stage3-b-context.ts",timeoutSecs:180},
  {name:"Stage 3 B Recoverable Sequences",script:"scripts/test-stage3-b-sequences.ts",timeoutSecs:180},
  {name:"Stage 3 B Fake Invitation Handlers",script:"scripts/test-stage3-b-invitations.ts",timeoutSecs:180},
  {name:"Stage 3 B Registered Intake and Routing",script:"scripts/test-stage3-b-intake.ts",timeoutSecs:180},
  {name:"Stage 3 B Protected Browser Proof",script:"scripts/test-stage3-b-browser.ts",timeoutSecs:180,explicitDisposableOptIn:true},
  {name:"Stage 3 B Fake Auth Continuations",script:"scripts/test-stage3-b-auth-continuations.ts",timeoutSecs:180},
  { name: "Stage 3 B Registered Draft and Knowledge Handlers", script: "scripts/test-stage3-b-drafts.ts", timeoutSecs: 180 },
  { name: "Stage 3 B Recoverable Account Authority", script: "scripts/test-stage3-b-accounts.ts", timeoutSecs: 180 },
  { name: "Stage 3 B Atomic Work Commands", script: "scripts/test-stage3-b-work-commands.ts", timeoutSecs: 180 },
  { name: "Stage 3 B Trusted Work Producers", script: "scripts/test-stage3-b-work-adapters.ts", timeoutSecs: 180 },
  { name: "SSR Style Isolation", script: "scripts/test-ssr-style-isolation.ts", timeoutSecs: 60 },
  { name: "GHL Inbound Pagination Parser", script: "scripts/test-ghl-inbound-pagination.ts", timeoutSecs: 60 },
  { name: "GHL Inbound Focused Sanitizer and Source Checks", script: "scripts/test-ghl-inbound-sync.ts", timeoutSecs: 60 },
  { name: "GHL Inbound Route Middleware", script: "scripts/test-ghl-inbound-route-guards.ts", timeoutSecs: 60 },
  { name: "GHL Inbound Service and Redirect Certification", script: "scripts/test-ghl-inbound-sync-integration.ts", timeoutSecs: 180 },
  { name: "GHL Inbound UI Static Render", script: "scripts/test-ghl-inbound-ui-render.mjs", timeoutSecs: 60 },
  { name: "Stage 3 A Sequence Runtime UI Static Render", script: "scripts/test-stage3-a-runtime-render.mjs", timeoutSecs: 60 },
  // ── Static / pure-function suites (no server required) ───────────────────
  {
    name: "Migration Integrity Check (journal consistency, unjournaled files, high-water enforcement)",
    script: "scripts/check-migration-integrity.ts",
    timeoutSecs: 60,
  },
  {
    name: "South Florida Enrichment Pipeline Correction",
    script: "scripts/test-sfp-pipeline-correction.mjs",
    timeoutSecs: 60,
  },
  {
    name: "REV-05A Processor Boarding Kill Lines (simulation paths, ping() 404-success, ambiguous retry, raw MID audit, deals.mid outside canonical service)",
    script: "scripts/check-processor-kill-lines.ts",
    timeoutSecs: 60,
  },
  {
    name: "Root Dependency Policy (portable HTTPS lock, freshness, integrity)",
    script: "scripts/check-dependency-policy.ts",
    timeoutSecs: 60,
  },
  {
    name: "Migration Seed Registration Guard (#1750 — every migration seed/backfill write is a registered convergence target or an exempted historical write)",
    script: "scripts/check-migration-seed-registration.ts",
    timeoutSecs: 60,
  },
  {
    name: "Dependency Policy Negative Fixtures",
    script: "scripts/test-dependency-policy-evidence.ts",
    timeoutSecs: 60,
  },
  {
    name: "Dependency Lifecycle and Native Probes",
    script: "scripts/test-dependency-lifecycle.ts",
    timeoutSecs: 60,
  },
  {
    name: "Artifact Dependency Inventory Fixtures",
    script: "scripts/test-inventory-artifact-dependencies.ts",
    timeoutSecs: 60,
  },
  {
    name: "Dependency Audit Policy (fail closed on critical/high)",
    script: "scripts/dependency-audit-policy.ts",
    timeoutSecs: 120,
  },
  {
    name: "Dependency Audit Policy Fixtures",
    script: "scripts/test-dependency-audit-policy.ts",
    timeoutSecs: 60,
  },
  {
    name: "BT-12 Revenue State Reconciliation Authority Guard",
    script: "scripts/test-bt12-revenue-state-reconciliation.ts",
    timeoutSecs: 60,
  },
  {
    name: "South Florida Prospecting Corrections Certification (classifier/geography-resolver determinism, real policy versions, full-manifest cohort hash, frozen-snapshot reconciliation, frozen/voided immutability, atomic failure persistence)",
    script: "scripts/test-sfp-disposable-certification.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Task #1999 Post-Merge Audit Certification (migration contracts, evidence immutability/pinning, stale-preview fence, gap vector, and provider denial)",
    script: "scripts/test-sfp1999-postmerge-audit-certification.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Task #2000 SFP Validation & Outreach Eligibility Certification (unified free+paid candidates, real-vs-masked decryption, freshness reuse, snapshot-bound execute, atomic finalization, Task-2001 staging fence, exact reporting)",
    script: "scripts/test-sfp2000-disposable-certification.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Task #2001 SFP Campaign Staging Certification (free/paid package-pinned ready_held, idempotent commands, stale snapshot and no-send boundaries)",
    script: "scripts/test-sfp2001-campaign-staging-certification.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Task #1999 Final Closeout Guard (settlement replay, aggregate reservations, identity/decision-maker/geography gaps)",
    script: "scripts/test-sfp1999-final-closeout.mjs",
    timeoutSecs: 60,
  },
  {
    name: "South Florida Prospecting UI Idempotency Persistence (freeze key survives reload; only 'Start new cohort' rotates it)",
    script: "scripts/test-sfp-ui-idempotency-persistence.ts",
    timeoutSecs: 60,
  },
  {
    name: "Fresh Snapshot Completion Guard",
    script: "scripts/test-fresh-snapshot-completion.ts",
    timeoutSecs: 60,
  },
  {
    name: "BT-12 Revenue State Reconciliation Integration",
    script: "scripts/test-bt12-revenue-state-reconciliation-integration.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Canonical Identity Writer Guard (all production identity writers observed)",
    script: "scripts/check-contact-identity-writers.ts",
    timeoutSecs: 60,
  },
  {
    name: "Canonical Intake Authority (local-first contact, durable import, provider projection)",
    script: "scripts/test-canonical-intake-authority.ts",
    timeoutSecs: 60,
  },
  {
    name: "CSV Import Reconciliation (durable execution replay and ledger totals)",
    script: "scripts/test-import-reconciliation.ts",
    timeoutSecs: 180,
    requiresServer: true,
  },
  {
    name: "Canonical Merge Manifest Guard (complete relationship disposition)",
    script: "scripts/check-contact-merge-manifest.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Canonical Identity Merge Contract",
    script: "scripts/test-canonical-identity-merge.ts",
    env: { GHL_TRANSPORT_FAILFAST: "true" },
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CSRF Fetch Scanner (authenticated raw fetch() mutations must attach getCsrfToken())",
    script: "scripts/scan-csrf-fetch.ts",
    timeoutSecs: 60,
  },
  {
    name: "Tracked-File Exposure Scan (no backups/exports/dumps in git)",
    script: "scripts/scan-tracked-files.ts",
    timeoutSecs: 60,
  },
  {
    name: "Tracked-File Exposure Scanner Regression (forced-add and ratchet semantics)",
    script: "scripts/test-scan-tracked-files.ts",
    timeoutSecs: 60,
  },
  {
    name: "CSP, CORS, JSON-LD Security Controls (source-backed CSP, typed CORS denial, safe structured data)",
    script: "scripts/test-security-controls.ts",
    timeoutSecs: 60,
  },
  {
    name: "RVR-03 Security Static Recurrence Scanner (credential, identity, token, and channel-audit callsites)",
    script: "scripts/test-rvr03-security-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "RVR-03 Auth Action Source Contract",
    script: "server/tests/auth-actions.source.test.ts",
    timeoutSecs: 60,
  },
  {
    name: "RVR-03 Auth Action Concurrency",
    script: "server/tests/auth-actions.integration.test.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
    explicitDisposableOptIn: true,
  },
  {
    name: "RVR-03 OG Cache Hardening",
    script: "server/tests/og-cache-hardening.test.ts",
    timeoutSecs: 60,
  },
  {
    name: "Release Artifact Gate (typecheck, production build, redacting artifact secret scan)",
    script: "scripts/release-artifact-gate.ts",
    timeoutSecs: 300,
  },
  {
    name: "Merchant Migration Safety (dual-auth, no-value-logging, envelope inventory, restart-safe)",
    script: "scripts/test-merchant-migration-safety.ts",
    timeoutSecs: 60,
  },
  {
    name: "Queue Compliance (logical dispatch ownership and worker initialization boundaries)",
    script: "scripts/check-queue-compliance.ts",
    timeoutSecs: 60,
  },
  {
    name: "Compliance Scan (send-gate coverage)",
    script: "scripts/compliance-scan.ts",
    timeoutSecs: 120,
  },
  {
    name: "GHL Route Pause Gates (#1629: typed denial + per-call-site regression)",
    script: "scripts/test-ghl-route-pause-gates-1629.ts",
    timeoutSecs: 60,
  },
  {
    name: "Sender Policy (From/Reply-To/prohibited-sender)",
    script: "scripts/test-sender-policy.ts",
    timeoutSecs: 60,
  },
  {
    name: "Serper Raw-Fetch Scan (canonical gateway compliance)",
    script: "scripts/scan-serper-raw-fetch.ts",
    timeoutSecs: 60,
  },
  {
    name: "Paid Provider Adapter Scan (manifest-only provider URLs/imports)",
    script: "scripts/scan-paid-provider-adapters.ts",
    timeoutSecs: 60,
  },
  {
    name: "Free-Enrichment Column Preflight (businesses table columns + EXPLAIN dry-run of claim UPDATE)",
    script: "scripts/check-free-enrichment-columns.ts",
    timeoutSecs: 30,
  },
  {
    name: "Provider Health and Readiness Kill Lines",
    script: "scripts/test-provider-readiness-controls.ts",
    timeoutSecs: 60,
  },
  {
    name: "Serper Gateway (circuit breaker / budget / rollover — fake transports)",
    script: "scripts/test-serper-gateway.ts",
    timeoutSecs: 120,
  },
  {
    name: "Serper Business Identity (normalizer / scorer / lookup waterfall — fake transports)",
    script: "scripts/test-serper-business-identity.ts",
    timeoutSecs: 60,
  },
  {
    name: "Sequence Compliance (114 cases: consent/DNC/cap/kill-switch/CAN-SPAM)",
    script: "scripts/test-sequence-compliance.ts",
    timeoutSecs: 120,
    requiresServer: true,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Sequence Terminalization Advisory-Lock Race",
    script: "scripts/test-sequence-terminalization-race.ts",
    timeoutSecs: 60,
  },
  {
    name: "Contactability Engine",
    script: "scripts/test-contactability.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Commercial Classification (unknown quarantine, approval, replay, evidence safety)",
    script: "scripts/test-commercial-classification.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "New-Lead Enrollment Policy",
    script: "scripts/test-new-lead-enrollment-policy.ts",
    timeoutSecs: 120,
    requiresServer: true,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Intake Provenance",
    script: "scripts/test-intake-provenance.ts",
    timeoutSecs: 60,
  },
  {
    name: "Speed-to-Lead Pipeline (score → lifecycle → NBA → SLA timer within 60s)",
    script: "scripts/test-speed-to-lead.ts",
    timeoutSecs: 90,
  },
  {
    name: "Lifecycle State Machine (all transitions, prohibited moves, idempotency, history rows)",
    script: "scripts/test-lifecycle.ts",
    timeoutSecs: 60,
  },
  {
    name: "South Florida Prospecting Cohort Certification",
    script: "scripts/sfp-certification.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Transport Dispatch (Gmail/SMTP/GHL routing + unsubscribe URL)",
    script: "scripts/test-transport-dispatch.ts",
    timeoutSecs: 120,
  },
  {
    name: "GHL Inbound Webhooks (reply/bounce/opt-out/STOP/dedup/signature)",
    script: "scripts/test-ghl-webhooks.ts",
    timeoutSecs: 120,
  },
  {
    name: "GHL CRM Decoupling (shadow-mode gate, Liberty data integrity, no-op disabled mode)",
    script: "scripts/test-ghl-decoupling.ts",
    timeoutSecs: 60,
  },
  {
    name: "Appointment-to-Statement (positive call outcome auto-triggers statement request)",
    script: "scripts/test-appointment-statement.ts",
    timeoutSecs: 180,
  },
  {
    name: "BullMQ Resilience (retry/backoff/DLQ/operator-visibility)",
    script: "scripts/test-bullmq-resilience.ts",
    timeoutSecs: 60,
  },
  {
    name: "Queue Lease Fencing (stale takeover and telemetry isolation)",
    script: "scripts/test-stale-job-lock.ts",
    timeoutSecs: 60,
  },
  {
    name: "Statement Command Durability (missing upload, duplicate delivery, lease takeover)",
    script: "server/tests/statement-command-worker.test.ts",
    timeoutSecs: 60,
  },
  {
    name: "Redis Queue Topology (24-config ownership contract)",
    script: "scripts/test-redis-topology.ts",
    timeoutSecs: 60,
  },
  {
    name: "Sunbiz Timeout & Recovery (no real network)",
    script: "scripts/test-sunbiz-timeout.ts",
    timeoutSecs: 60,
  },
  {
    name: "Commercial Classification Static Gates (authority boundary, cleanup denial, public-schema protection)",
    script: "scripts/test-commercial-classification-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "Commercial Cleanup Guard (destructive utility scripts refuse non-test databases)",
    script: "scripts/test-cleanup-guard.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-01 Revenue Contract Static (canonical stages, cardinality, reconciliation, conversion authority)",
    script: "scripts/test-cro01-revenue-contract-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-01 Revenue Contract Integration (disposable PostgreSQL aggregate semantics)",
    script: "scripts/test-cro01-revenue-contract-integration.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-02 Classification Authority (shadow graph structural ownership)",
    script: "scripts/check-cro02-authority.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-02 Graph and Import Integration (disposable graph/vector/lease fencing)",
    script: "scripts/test-cro02-integration.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-02 HTTP Privacy and Provider Denial",
    script: "scripts/test-cro02-http.ts",
    timeoutSecs: 60,
    requiresServer: true,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03 Durable Enrichment Factory (static transport, privacy, routing, and ownership gates)",
    script: "scripts/test-cro03-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03A South Florida Candidate Qualification (source census, policy, effects boundary)",
    script: "scripts/test-cro03a-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03B Unified Recipe, Admission, Arbitration, and Local Projection",
    script: "scripts/test-cro03b-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03C Governed Live Activation (provider denied)",
    script: "scripts/test-cro03c-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03D Ceremony Scope Derivation and Ephemeral Signing Tool",
    script: "scripts/test-cro03d-ceremony-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03C Initial Continuation Bridge Contract",
    script: "scripts/test-cro03c-initial-continuation-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03C Worker, Lease, and Safe-Egress Contract",
    script: "scripts/test-cro03c-worker-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-05A Inbound Revenue Operations Static Certification",
    script: "scripts/test-cro05a-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-05A Inbound Lifecycle Pure Contract",
    script: "server/tests/inbound-request-lifecycle.test.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-05A Non-Public Adapter Classification Certification",
    script: "scripts/test-cro05a-nonpublic-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03C Live Dispatch Durability (disposable PostgreSQL/Redis, provider-denied)",
    script: "scripts/test-cro03c-integration.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03C Provider Executor Hardening (Apollo fail-closed, prompt authority, redacted receipts)",
    script: "scripts/test-cro03c-provider-executors.ts",
    timeoutSecs: 60,
  },
  {
    name: "MI-09 Pricing Artifact & Snapshot Seed Certification (replay idempotency, hash reproducibility)",
    script: "scripts/test-mi09-pricing-seed-integration.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03C OpenAI Bundle Static Certification (template allowlist, token reservation, structured-response validation)",
    script: "scripts/test-cro03c-openai-bundle-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03B Durable Recipe Lifecycle (database-backed, provider-denied)",
    script: "scripts/test-cro03b-integration.ts",
    timeoutSecs: 120,
    env: { NODE_ENV: "test" },
  },
  {
    name: "CRO-03B CSV Handoff Certification — Business-Only, Contact, and Safe-Hold Paths",
    script: "scripts/certify-cro03b-csv-handoff.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
    env: { NODE_ENV: "test" },
  },
  {
    name: "CRO-03 Ledger Convergence Under Live Triggers (#1750 — production-seed-convergence repair vs. real cro03_ledger_immutable/cro03_ledger_lineage_guard triggers and unique indexes)",
    script: "scripts/test-cro03-ledger-convergence.ts",
    timeoutSecs: 60,
  },
  {
    name: "Seed Convergence Verifier Detects Deletion/Substitution (#1750)",
    script: "scripts/test-seed-convergence-verifier-integrity.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03B Legacy Writer Inventory",
    script: "scripts/check-cro03b-legacy-writers.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03 Ledger Drift Repair Apply and Replay",
    script: "scripts/test-cro03-ledger-drift-repair.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CR-04 Channel Cohort Authority Contract",
    script: "scripts/test-cr04-authority-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CR-05 Reporting Boundary and Exactness Contract",
    script: "scripts/test-reporting-boundaries.ts",
    timeoutSecs: 60,
  },
  {
    name: "CR-05 Task, Inbox, and Statement Authority Contract",
    script: "scripts/test-task1721-inbox-statement-structure.ts",
    timeoutSecs: 60,
  },
  {
    name: "Task 1720 DLQ History and Alert Feed Contract",
    script: "scripts/test-task1720-dlq-alert-static.ts",
    timeoutSecs: 60,
  },
  {
    name: "CR-06 Content, Cadence, and Deterministic Renderer Certification",
    script: "scripts/test-cr06-governance.ts",
    timeoutSecs: 60,
  },
  {
    name: "CR-06 Promotional Enrollment Boundary Inventory",
    script: "server/tests/cr06-promotional-boundary-inventory.source.test.ts",
    timeoutSecs: 60,
  },
  {
    name: "CR-06 Feedback Privacy and History Contract",
    script: "server/tests/cr06-feedback-strict.source.test.ts",
    timeoutSecs: 60,
  },
  {
    name: "CR-06 Disposable Authority Certification (Task 1722 corrections 7-9)",
    script: "scripts/test-cr06-disposable-certification.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CR-06 HTTP Authorization, CSRF, and Opaque-ID Contract",
    script: "scripts/test-cr06-http-authorization.ts",
    timeoutSecs: 120,
    requiresServer: true,
  },
  {
    name: "CR-06 Clean-Zero and Prior-0183 Migration Upgrade Proof",
    script: "scripts/test-cr06-migration-upgrade.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-07 Controlled Delivery, Reply, Growth & Conversion Feedback Certification",
    script: "scripts/test-cro07-disposable-certification.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03 Apollo Organization Resolution",
    script: "scripts/test-apollo-organization-resolution.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03 Retired Client Endpoint Scan",
    script: "scripts/scan-cro03-client-endpoints.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRO-03 Durable Enrichment Factory Concurrency and Recovery (disposable PostgreSQL/Redis certification)",
    script: "scripts/test-cro03-integration.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03 HTTP Authorization and Ownership",
    script: "scripts/test-cro03-http-authorization.ts",
    timeoutSecs: 120,
    requiresServer: true,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Role Guards",
    script: "scripts/smoke-role-guards.ts",
    timeoutSecs: 120,
    requiresServer: true,
  },
  {
    name: "SEC-02 Session Validity Fail-Closed",
    script: "scripts/test-session-validity-fail-closed.ts",
    timeoutSecs: 60,
  },
  {
    name: "CRM Operator Experience",
    script: "scripts/test-crm-operator-experience.ts",
    timeoutSecs: 60,
    requiresServer: true,
  },
  {
    name: "CRO-01 Provider/Staging Denial (isolated auth; no provider or queue effects)",
    script: "scripts/test-cro01-provider-denial.ts",
    timeoutSecs: 60,
    requiresServer: true,
  },
  {
    name: "Contact Reconciliation Classifier (pure-function 85 assertions, no server/DB)",
    script: "scripts/test-reconciliation-classifier.ts",
    timeoutSecs: 60,
  },
  {
    name: "Contact Reconciliation Certification (lifecycle, CAS, allowlist, schema — disposable DB)",
    script: "scripts/test-reconciliation-certification.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Contact Reconciliation Performance (155K synthetic contacts ≥100K/sec, heap <50MB)",
    script: "scripts/test-reconciliation-performance.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "API Coverage",
    script: "scripts/check-api-coverage.ts",
    timeoutSecs: 60,
  },
  {
    name: "Live Health Monitor (background workers + AI responding)",
    script: "scripts/test-live-health.ts",
    timeoutSecs: 120,
    requiresServer: true,
    // Requires live server + real credentials (OpenAI probe, DB, Redis).
    // Skipped when server is down so a cold-start env doesn't block the gate.
    skipWhenServerDown: true,
    env: { BASE_URL },
  },
  {
    name: "SEO Audit",
    script: "scripts/seo-audit.ts",
    timeoutSecs: 60,
    requiresServer: true,
  },
  {
    name: "Chat Business Hours (AI 24/7, human-handoff hours-gated)",
    script: "scripts/test-chat-business-hours.ts",
    timeoutSecs: 30,
    requiresServer: true,
    skipWhenServerDown: true, // tests live-mode handoff timing; skipped when server absent
  },
  {
    name: "Outbound Pause Fence (persisted DB rows, not code defaults, + control authority table)",
    script: "scripts/test-pause-fence.ts",
    timeoutSecs: 30,
  },
  {
    name: "Outbound Pause Authority (#1531: fail-closed semantics, epoch, atomicity, no skipGlobalPauseCheck)",
    script: "scripts/test-outbound-pause-authority.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Slack Pause Boundary (no webhook after pause during alert preparation)",
    script: "scripts/test-slack-pause-boundary.ts",
    timeoutSecs: 30,
  },
  {
    name: "Outbound Boundary Denial (#1626: form-sync/delete/SMTP pause denial, drain fail-closed, epoch interleaving, audit sanitizer)",
    script: "scripts/test-outbound-boundary-1626.ts",
    timeoutSecs: 60,
  },
  {
    name: "Email Signature Coverage (all 6 types, CAN-SPAM footer, sender policy, call-site checks)",
    script: "scripts/test-email-signatures.ts",
    timeoutSecs: 30,
  },
  {
    name: "Communication Arbitration (human-touch suppression, auto-send cooldown, skip flags)",
    script: "scripts/test-arbitration.ts",
    timeoutSecs: 60,
  },
  {
    name: "Statement Acquisition (STATEMENT_REQUESTED → enrollment → stop on upload → STATEMENT_ANALYZED)",
    script: "scripts/test-statement-acquisition.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Channel Orchestrator (Wave 1A: transport interfaces, global-pause fence, deal-stage authority guard)",
    script: "scripts/test-channel-orchestrator.ts",
    timeoutSecs: 60,
  },
  {
    name: "NBA Engine (Wave 1B: 12 cases — lifecycle→action, DNC, pause, sequence collision, execute/dismiss, history, priority queue)",
    script: "scripts/test-nba.ts",
    timeoutSecs: 90,
  },
  // ── Server-required suites (skipped when server absent; need live credentials) ─
  {
    name: "AI Assistant Boundaries (auth/role/schema/no-action)",
    script: "scripts/test-ai-assistant-boundaries.ts",
    env: { BASE_URL },
    timeoutSecs: 120,
    requiresServer: true,
    skipWhenServerDown: true, // tests live AI provider responses; skipped when server absent
  },
  {
    name: "Public Forms (GHL isolated via fail-fast test transport)",
    script: "scripts/test-forms.ts",
    // C-03 (#1626): GHL isolation is enforced by the server-level fail-fast
    // transport (GHL_TRANSPORT_FAILFAST, installed by run-pre-deploy.sh) and
    // VERIFIED by test-forms.ts against /api/health — no acknowledgment flag.
    env: { BASE_URL },
    timeoutSecs: 120,
    requiresServer: true,
    skipWhenServerDown: true, // tests GHL-isolated form submission; skipped when server absent
    requiresDisposableTestDatabase: true,
  },
  // ── #1320 — Portfolio scoping smoke (ownership boundaries, hostile ?owner= override) ──
  {
    name: "Portfolio Scoping (agent sees only own merchants; admin sees all)",
    script: "scripts/smoke-portfolio.ts",
    env: { BASE_URL },
    timeoutSecs: 120,
    requiresServer: true,
    skipWhenServerDown: true,
  },
  // ── #1297 — Go-Live gate smoke (422 gate + admin override path) ──────────────
  {
    name: "Go-Live Gate (422 on missing MID/checklist; admin override writes audit log)",
    script: "scripts/smoke-golive-gate.ts",
    env: { BASE_URL },
    timeoutSecs: 120,
    requiresServer: true,
    skipWhenServerDown: true,
  },
  // ── #1338 — Attrition monitor cooldown (30-day per-merchant suppression) ─────
  {
    name: "Attrition Monitor Cooldown (30-day per-merchant, per-type suppression)",
    script: "scripts/smoke-attrition-cooldown.ts",
    timeoutSecs: 60,
  },
  // ── Backlog preview — disposable DB healthy aggregate + truthful outage envelopes ──
  {
    name: "Backlog Preview (migrated aggregate, stable outage envelopes, non-additive)",
    script: "scripts/test-backlog-preview.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Prospect Import Idempotency (catalog, storage ownership, status matrix, race)",
    script: "scripts/test-import-idempotency.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03A Autowire and Stale-Occurrence Watchdog Certification (disposable DB fixtures a/b/c)",
    script: "scripts/certify-cro03a-autowire.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03A South Florida Geography Scoring (county FIPS, geo evidence classes, freshness, tier assignments)",
    script: "scripts/test-cro03a-geography.ts",
    timeoutSecs: 60,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03A Batch Processor Semantic Equivalence",
    script: "scripts/test-cro03a-batch-equivalence.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03A Batch Processor Performance & Recovery",
    script: "scripts/test-cro03a-batch-performance.ts",
    timeoutSecs: 180,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "CRO-03A Policy Comparison Service",
    script: "scripts/test-cro03a-policy-comparison.ts",
    timeoutSecs: 120,
    requiresDisposableTestDatabase: true,
  },
  {
    name: "Identity Crosswalk Gen-1 (read-only evidence sweep, fail-close guards, contact promotion gates)",
    script: "scripts/test-identity-crosswalk.ts",
    timeoutSecs: 120,
    requiresServer: true,
    requiresDisposableTestDatabase: true,
  },
];

export interface SuiteSelection {
  suites: Suite[];
  requestedScripts: string[];
  explicit: boolean;
  operatorIntent: "default-full" | "exact-selection" | "full-auth-concurrency";
}

const OPERATOR_INTENTS = new Set<SuiteSelection["operatorIntent"]>([
  "default-full",
  "exact-selection",
  "full-auth-concurrency",
]);

/**
 * Select exact suite paths while keeping the operator's real intent separate
 * from an internal per-child --only selector. The disposable launcher passes
 * --operator-intent alongside its internal selector so a default full-roster
 * child cannot accidentally satisfy the auth-concurrency opt-in.
 */
export function selectMandatorySuites(args: readonly string[], roster: readonly Suite[] = MANDATORY_SUITES): SuiteSelection {
  const requestedScripts: string[] = [];
  let includeAuthConcurrency = false;
  let operatorIntentOverride: SuiteSelection["operatorIntent"] | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--include-auth-concurrency") {
      if (includeAuthConcurrency) throw new Error("Duplicate --include-auth-concurrency flag.");
      includeAuthConcurrency = true;
      continue;
    }
    if (args[i] === "--operator-intent") {
      const value = args[i + 1];
      if (!value || !OPERATOR_INTENTS.has(value as SuiteSelection["operatorIntent"])) {
        throw new Error("Usage: pre-deploy.ts [--only <exact-suite-script-path> ...] [--include-auth-concurrency]");
      }
      if (operatorIntentOverride) throw new Error("Duplicate --operator-intent flag.");
      operatorIntentOverride = value as SuiteSelection["operatorIntent"];
      i += 1;
      continue;
    }
    if (args[i] !== "--only" || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(
        "Usage: pre-deploy.ts [--only <exact-suite-script-path> ...] [--include-auth-concurrency]",
      );
    }
    const script = args[i + 1];
    if (requestedScripts.includes(script)) {
      throw new Error(`Duplicate pre-deploy suite selector: ${script}`);
    }
    requestedScripts.push(script);
    i += 1;
  }
  const explicit = requestedScripts.length > 0;
  if (includeAuthConcurrency && explicit) {
    throw new Error("--include-auth-concurrency is a full-roster option and cannot be combined with --only.");
  }
  if (includeAuthConcurrency && operatorIntentOverride) {
    throw new Error("--include-auth-concurrency cannot be combined with an internal --operator-intent.");
  }
  if (operatorIntentOverride === "exact-selection" && !explicit) {
    throw new Error("The exact-selection operator intent requires at least one exact --only selector.");
  }
  if (operatorIntentOverride === "full-auth-concurrency" && includeAuthConcurrency) {
    throw new Error("Conflicting auth-concurrency operator intent flags.");
  }
  const operatorIntent =
    operatorIntentOverride ??
    (explicit
      ? "exact-selection"
      : includeAuthConcurrency
        ? "full-auth-concurrency"
        : "default-full");
  const suites = requestedScripts.map((script) => {
    const matches = [...roster,...(roster===MANDATORY_SUITES ? CERTIFICATION_FIXTURE_SUITES : [])]
      .filter((suite) => suite.script === script);
    if (matches.length === 0) {
      throw new Error(`Unknown pre-deploy suite script path: ${script}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous pre-deploy suite script path: ${script}; this script appears more than once in the roster.`);
    }
    return matches[0];
  });
  return {
    suites: explicit ? suites : [...roster],
    requestedScripts,
    explicit,
    operatorIntent,
  };
}

export function resolveSuiteExitStatus(exitCode: number): "executed_pass" | "executed_fail" {
  return exitCode === 0 ? "executed_pass" : "executed_fail";
}

export function shouldSkipExplicitDisposableOptIn(
  suite: Suite,
  operatorIntent: SuiteSelection["operatorIntent"],
): boolean {
  return Boolean(suite.explicitDisposableOptIn) &&
    operatorIntent !== "exact-selection" &&
    operatorIntent !== "full-auth-concurrency";
}

export function summarizeGateResults(
  results: ReadonlyArray<{ status: string; exitCode: number }>,
  gateControlFailures: readonly string[] = [],
) {
  const failedCount = results.filter((result) => result.status === "executed_fail").length;
  const delegatedCount = results.filter((result) => result.status === "delegated_unverified").length;
  const passedCount = results.filter((result) => result.status === "executed_pass").length;
  const skippedCount = results.filter((result) => result.status === "skipped_optional").length;
  const optInSkippedCount = results.filter((result) => result.status === "skipped_opt_in").length;
  return {
    failedCount,
    delegatedCount,
    passedCount,
    skippedCount,
    optInSkippedCount,
    gateControlFailures: [...gateControlFailures],
    passed: failedCount === 0 && delegatedCount === 0 && optInSkippedCount === 0 && gateControlFailures.length === 0,
  };
}

export function isPrivateDisposableGateEnvironment(env: NodeJS.ProcessEnv): boolean {
  const databaseUrl = env.DATABASE_URL ?? "";
  const testDatabaseUrl = env.TEST_DATABASE_URL ?? "";
  if (
    !databaseUrl ||
    databaseUrl !== testDatabaseUrl ||
    env.NODE_ENV !== "test" ||
    env.VG_PROVIDER_DENY_MODE !== "1" ||
    env.GHL_TRANSPORT_FAILFAST !== "true" ||
    env.EMAIL_TRANSPORT_FAILFAST !== "true" ||
    env.SMS_TRANSPORT_FAILFAST !== "true" ||
    env.SUNBIZ_ENRICHMENT_ENABLED !== "false" ||
    env.SERPER_GATEWAY_ENABLED !== "false" ||
    env.OPENAI_API_KEY !== "sfp2060-disposable-constructor-only" ||
    env.AI_INTEGRATIONS_OPENAI_API_KEY !== "sfp2060-disposable-constructor-only" ||
    env.OPENAI_BASE_URL !== "http://127.0.0.1:1/v1" ||
    env.AI_INTEGRATIONS_OPENAI_BASE_URL !== "http://127.0.0.1:1/v1" ||
    !isVerifiedPrivateDisposablePostgresUrl(env) ||
    env.GHL_PRIVATE_INTEGRATION_TOKEN ||
    env.SMTP_PASS ||
    env.TEST_REDIS_PREFIX === undefined ||
    !/^ci_sfp2060_[a-f0-9]{32}_$/.test(env.TEST_REDIS_PREFIX)
  ) {
    return false;
  }
  try {
    const parsed = new URL(databaseUrl);
    const socketPath = parsed.searchParams.get("host") ?? "";
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    const redisUrl = new URL(env.REDIS_URL ?? "");
    const baseUrl = new URL(env.BASE_URL ?? "");
    return (
      parsed.protocol === "postgresql:" &&
      parsed.hostname === "localhost" &&
      parsed.pathname.length > 1 &&
      parsed.pathname !== "/postgres" &&
      socketPath.startsWith(tempRoot) &&
      path.basename(path.dirname(socketPath)).startsWith("local-rehearsal-") &&
      redisUrl.protocol === "redis:" &&
      redisUrl.hostname === "127.0.0.1" &&
      !redisUrl.username &&
      !redisUrl.password &&
      resolveCertificationHttpContract(env).privateCertification &&
      isLoopbackHttpUrl(env.BASE_URL) &&
      env.TEST_BASE_URL === env.BASE_URL &&
      env.PORT === baseUrl.port
    );
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function runPureRegressionTests(): void {
  assert.equal(dbPool, undefined, "pure selector tests must not import or leave a live database pool");
  const defaultSelection = selectMandatorySuites([]);
  assert.equal(defaultSelection.explicit, false);
  assert.equal(defaultSelection.operatorIntent, "default-full");
  assert.deepEqual(defaultSelection.suites, MANDATORY_SUITES, "default selection must retain the full mandatory roster");
  assert.equal(defaultSelection.suites.length, MANDATORY_SUITES.length);
  assert.throws(() => selectMandatorySuites(["--only", "scripts/not-in-roster.ts"]), /Unknown pre-deploy suite/);
  assert.throws(() => selectMandatorySuites(["--only", "scripts/test-mi09-pricing-seed-integration.ts", "--only", "scripts/test-mi09-pricing-seed-integration.ts"]), /Duplicate/);
  assert.deepEqual(
    selectMandatorySuites(["--only", "scripts/test-mi09-pricing-seed-integration.ts"]).suites.map((suite) => suite.script),
    ["scripts/test-mi09-pricing-seed-integration.ts"],
  );
  assert.equal(resolveSuiteExitStatus(0), "executed_pass");
  assert.equal(resolveSuiteExitStatus(1), "executed_fail");
  const mixedResult = summarizeGateResults([
    { status: resolveSuiteExitStatus(0), exitCode: 0 },
    { status: "delegated_unverified", exitCode: 0 },
  ]);
  assert.equal(mixedResult.passedCount, 1, "an exit-0 child remains accurately reported as passed");
  assert.equal(mixedResult.delegatedCount, 1, "unverified suites are accounted separately from child exits");
  assert.equal(mixedResult.passed, false, "an unverified mandatory suite keeps the terminal gate failed despite another child passing");
  assert.equal(
    summarizeGateResults([{ status: "executed_pass", exitCode: 0 }], ["pause restoration failed"]).passed,
    false,
    "gate-control failures must prevent a pass even when a child exits zero",
  );
  const privateTestEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://tester@localhost/test_sfp2060_selector_test?host=/tmp/local-rehearsal-fixture/socket&port=23456",
    TEST_DATABASE_URL: "postgresql://tester@localhost/test_sfp2060_selector_test?host=/tmp/local-rehearsal-fixture/socket&port=23456",
    VG_PROVIDER_DENY_MODE: "1",
    GHL_TRANSPORT_FAILFAST: "true",
    EMAIL_TRANSPORT_FAILFAST: "true",
    SMS_TRANSPORT_FAILFAST: "true",
    SUNBIZ_ENRICHMENT_ENABLED: "false",
    SERPER_GATEWAY_ENABLED: "false",
    REDIS_URL: "redis://127.0.0.1:23457",
    TEST_REDIS_PREFIX: "ci_sfp2060_0123456789abcdef0123456789abcdef_",
    BASE_URL: "http://127.0.0.1:34567",
    TEST_BASE_URL: "http://127.0.0.1:34567",
    CERTIFICATION_HTTP_HOST: "127.0.0.1",
    CERTIFICATION_HTTP_NONCE: "0123456789abcdef".repeat(4),
    PORT: "34567",
    OPENAI_API_KEY: "sfp2060-disposable-constructor-only",
    AI_INTEGRATIONS_OPENAI_API_KEY: "sfp2060-disposable-constructor-only",
    OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
  };
  assert.equal(isVerifiedPrivateDisposablePostgresUrl(privateTestEnv), true);
  assert.equal(
    isVerifiedPrivateDisposablePostgresUrl({ ...privateTestEnv, DATABASE_URL: "postgresql://prod@db.example.com/prod" }),
    false,
    "private HTTP contract must reject a network database",
  );
  assert.equal(
    isVerifiedPrivateDisposablePostgresUrl({ ...privateTestEnv, VG_PROVIDER_DENY_MODE: "0" }),
    false,
    "private HTTP contract must require provider denial",
  );
  assert.deepEqual(resolveCertificationHttpContract({}), {
    host: "0.0.0.0",
    reusePort: true,
    privateCertification: false,
    nonce: null,
  });
  assert.throws(
    () => resolveCertificationHttpContract({ ...privateTestEnv, CERTIFICATION_HTTP_HOST: "0.0.0.0" }),
    /CERTIFICATION_HTTP_PRIVATE_POSTURE_REJECTED/,
  );
  assert.throws(
    () => resolveCertificationHttpContract({ ...privateTestEnv, DATABASE_URL: "postgresql://prod@db.example.com/prod" }),
    /CERTIFICATION_HTTP_PRIVATE_POSTURE_REJECTED/,
  );
  assert.deepEqual(certificationHttpReadinessFields({ NODE_ENV: "production" }), {});
  assert.deepEqual(certificationHttpReadinessFields(privateTestEnv), {
    certificationHttpNonce: privateTestEnv.CERTIFICATION_HTTP_NONCE,
    certificationHttpListenerAddress: null,
    certificationHttpListenerPort: null,
    certificationHttpReusePort: null,
  });
  recordCertificationHttpListener("127.0.0.1", 34567, false);
  assert.deepEqual(certificationHttpReadinessFields(privateTestEnv), {
    certificationHttpNonce: privateTestEnv.CERTIFICATION_HTTP_NONCE,
    certificationHttpListenerAddress: "127.0.0.1",
    certificationHttpListenerPort: 34567,
    certificationHttpReusePort: false,
  });
  assert.equal(isPrivateDisposableGateEnvironment(privateTestEnv), true);
  assert.equal(
    isPrivateDisposableGateEnvironment({ ...privateTestEnv, DATABASE_URL: "postgresql://prod@db.example.com/prod" }),
    false,
    "bounded selection must reject production database overrides",
  );
  assert.equal(
    isPrivateDisposableGateEnvironment({ ...privateTestEnv, REDIS_URL: "redis://shared.example.com:6379" }),
    false,
    "bounded selection must reject a shared/non-loopback Redis endpoint",
  );
  assert.equal(
    isPrivateDisposableGateEnvironment({ ...privateTestEnv, TEST_BASE_URL: "https://production.example.com" }),
    false,
    "bounded selection must reject production HTTP base URL overrides",
  );
  assert.equal(
    isPrivateDisposableGateEnvironment({ ...privateTestEnv, OPENAI_BASE_URL: "https://api.openai.com/v1" }),
    false,
    "bounded selection must keep provider SDKs on an inert loopback endpoint",
  );
  assert.equal(
    isPrivateDisposableGateEnvironment({ ...privateTestEnv, CERTIFICATION_HTTP_HOST: "0.0.0.0" }),
    false,
    "certification HTTP posture must reject non-loopback listener requests",
  );
  assert.equal(
    isPrivateDisposableGateEnvironment({ ...privateTestEnv, CERTIFICATION_HTTP_NONCE: undefined }),
    false,
    "certification HTTP posture requires its per-child readiness nonce",
  );
  const authConcurrency = MANDATORY_SUITES.find((suite) => suite.explicitDisposableOptIn);
  assert.equal(authConcurrency?.script, "server/tests/auth-actions.integration.test.ts");
  assert.equal(shouldSkipExplicitDisposableOptIn(authConcurrency!, "default-full"), true);
  assert.equal(
    shouldSkipExplicitDisposableOptIn(authConcurrency!, "default-full"),
    true,
    "an internal per-suite --only selector must not satisfy the operator opt-in",
  );
  assert.equal(shouldSkipExplicitDisposableOptIn(authConcurrency!, "exact-selection"), false);
  assert.equal(
    shouldSkipExplicitDisposableOptIn(authConcurrency!, "full-auth-concurrency"),
    false,
    "the explicit full-roster opt-in enables auth concurrency",
  );
  const fullAuthOptIn = selectMandatorySuites(["--include-auth-concurrency"]);
  assert.equal(fullAuthOptIn.explicit, false);
  assert.equal(fullAuthOptIn.operatorIntent, "full-auth-concurrency");
  assert.equal(fullAuthOptIn.suites.length, MANDATORY_SUITES.length);
  const defaultFullAuthChild = selectMandatorySuites([
    "--operator-intent",
    "default-full",
    "--only",
    authConcurrency!.script,
  ]);
  assert.equal(defaultFullAuthChild.operatorIntent, "default-full");
  assert.equal(
    shouldSkipExplicitDisposableOptIn(authConcurrency!, defaultFullAuthChild.operatorIntent),
    true,
    "the runner's internal one-suite selector cannot transform a default full run into an auth opt-in",
  );
  assert.throws(
    () => selectMandatorySuites(["--include-auth-concurrency", "--only", authConcurrency!.script]),
    /cannot be combined/,
  );
}

// ── External config items — non-blocking, reported separately ─────────────────

interface ConfigItem {
  key: string;
  label: string;
  category: string;
  /** Alternative env var whose presence satisfies this requirement (e.g. Replit integration key). */
  satisfiedByEnv?: string;
  /** When this env var is set, the item is optional (not a gap) — shown as covered, not missing. */
  optionalWhenEnv?: string;
  /** Note displayed when optionalWhenEnv is present. */
  optionalNote?: string;
}

const EXTERNAL_CONFIG: ConfigItem[] = [
  // Email / transport
  { key: "GOOGLE_CLIENT_ID",     label: "Gmail OAuth client ID (staff transactional sends)",   category: "email" },
  { key: "GOOGLE_CLIENT_SECRET", label: "Gmail OAuth client secret",                            category: "email" },
  // SMTP is the cold-email fallback when GHL is the primary transport.
  // When GHL_PRIVATE_INTEGRATION_TOKEN is set, SMTP items are optional — not gaps.
  { key: "SMTP_HOST",            label: "SMTP host (cold-email fallback; optional when GHL configured)",  category: "email",
    optionalWhenEnv: "GHL_PRIVATE_INTEGRATION_TOKEN", optionalNote: "GHL is primary cold-email transport" },
  { key: "SMTP_USER",            label: "SMTP username (optional when GHL configured)",         category: "email",
    optionalWhenEnv: "GHL_PRIVATE_INTEGRATION_TOKEN", optionalNote: "GHL is primary cold-email transport" },
  { key: "SMTP_PASS",            label: "SMTP password (optional when GHL configured)",         category: "email",
    optionalWhenEnv: "GHL_PRIVATE_INTEGRATION_TOKEN", optionalNote: "GHL is primary cold-email transport" },
  // GHL
  { key: "GHL_PRIVATE_INTEGRATION_TOKEN", label: "GHL Private Integration Token",              category: "ghl" },
  { key: "GHL_LOCATION_ID",               label: "GHL location ID",                            category: "ghl" },
  { key: "GHL_WEBHOOK_SECRET",            label: "GHL webhook signing secret",                 category: "ghl" },
  // OpenAI — Replit AI integration (AI_INTEGRATIONS_OPENAI_API_KEY) satisfies this requirement.
  { key: "OPENAI_API_KEY",       label: "OpenAI API key",                                      category: "openai",
    satisfiedByEnv: "AI_INTEGRATIONS_OPENAI_API_KEY" },
  // Sender domain / compliance
  { key: "APP_URL",              label: "APP_URL (required for unsubscribe links in emails)",   category: "sender-domain" },
  { key: "SENDER_DOMAIN_SPF_VERIFIED",    label: "Sender domain SPF/DKIM verified (manual check)", category: "sender-domain" },
  // A2P / SMS
  { key: "A2P_REGISTRATION_ID",  label: "A2P 10DLC registration ID (required for SMS sends)",  category: "a2p" },
  { key: "GHL_PHONE_NUMBER_ID",  label: "GHL phone number ID (A2P-registered)",                category: "a2p" },
  // Redis
  { key: "REDIS_URL",            label: "REDIS_URL (production BullMQ durability)",            category: "infra" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPauseSetting(): Promise<boolean> {
  try {
    const rows = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "outboundGlobalPaused"))
      .limit(1);
    const v = rows[0]?.value;
    return v === true || v === "true" || v === 1;
  } catch {
    return false;
  }
}

async function setPauseSetting(value: boolean): Promise<void> {
  try {
    await db.insert(systemSettings)
      .values({ key: "outboundGlobalPaused", value: String(value) })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: String(value) } });
  } catch (err: any) {
    console.warn(`  [pause-restore] Could not set outboundGlobalPaused=${value}: ${err?.message}`);
  }
}

function checkServerReachable(): boolean {
  const result = spawnSync("curl", ["-sf", "--max-time", "3", `${BASE_URL}/api/health`], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0;
}

function runSuite(
  suite: Suite,
  operatorIntent: SuiteSelection["operatorIntent"],
): { exitCode: number; durationMs: number; diagnostic: string | null } {
  const start = Date.now();
  const env = { ...process.env, ...(suite.env ?? {}) };
  if (
    suite.explicitDisposableOptIn &&
    (operatorIntent === "exact-selection" || operatorIntent === "full-auth-concurrency")
  ) {
    env.AUTH_ACTION_DB_TEST_OPT_IN = "1";
  } else {
    delete env.AUTH_ACTION_DB_TEST_OPT_IN;
  }
  const result = spawnSync(
    process.execPath,
    suite.script.endsWith(".mjs") ? [suite.script] :
      [path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), suite.script],
    {
    env,
    stdio: "inherit",
    encoding: "utf8",
    timeout: (suite.timeoutSecs ?? 120) * 1000,
    },
  );
  const durationMs = Date.now() - start;
  const diagnostic = result.error
    ? result.error.message
    : result.signal
      ? `terminated by signal ${result.signal}`
      : result.status === null
        ? "child process returned no exit status"
        : null;
  return {
    exitCode: result.status ?? 1,
    durationMs,
    diagnostic,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printBanner(text: string) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log(` ${text}`);
  console.log(line);
}

function printSectionHeader(text: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(` ${text}`);
  console.log("─".repeat(60));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const selection = selectMandatorySuites(process.argv.slice(2));
  if (
    (selection.explicit || selection.operatorIntent === "full-auth-concurrency") &&
    !isPrivateDisposableGateEnvironment(process.env)
  ) {
    throw new Error(
      "Exact suite selection is allowed only with a private local disposable database, test-mode provider denial, and loopback BASE_URL/TEST_BASE_URL.",
    );
  }

  const [databaseModule, schemaModule] = await Promise.all([
    import("../server/db"),
    import("../shared/schema"),
  ]);
  db = databaseModule.db;
  dbPool = databaseModule.pool;
  systemSettings = schemaModule.systemSettings;

  // ── RELEASE_SHA assertion — must pass before any other gate work ─────────────
  // RELEASE_SHA must identify the exact checked-out revision that these gates
  // test. A syntactically valid but unrelated SHA would make post-deploy health
  // verification meaningless, so bind it to `git rev-parse HEAD` first.
  const SHA_PATTERN = /^[0-9a-f]{40}$/i;
  const releaseSha = process.env.RELEASE_SHA ?? "";
  if (!SHA_PATTERN.test(releaseSha)) {
    console.error("╔══════════════════════════════════════════════════════════════╗");
    console.error("║  KILL: RELEASE_SHA assertion failed                          ║");
    console.error("╚══════════════════════════════════════════════════════════════╝");
    console.error("");
    console.error("  RELEASE_SHA must be a 40-character hex SHA (e.g. git rev-parse HEAD).");
    console.error("  Set it in the deployment environment before running the pre-deploy gate.");
    console.error("");
    console.error("  Example:");
    console.error("    RELEASE_SHA=$(git rev-parse HEAD) bash scripts/run-pre-deploy.sh");
    console.error("");
    console.error(`  Current value: ${releaseSha ? JSON.stringify(releaseSha) : "(not set)"}`);
    process.exit(1);
  }
  const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const checkedOutSha = gitHead.status === 0 ? gitHead.stdout.trim() : "";
  if (!SHA_PATTERN.test(checkedOutSha) || checkedOutSha.toLowerCase() !== releaseSha.toLowerCase()) {
    console.error("╔══════════════════════════════════════════════════════════════╗");
    console.error("║  KILL: RELEASE_SHA does not match the tested checkout        ║");
    console.error("╚══════════════════════════════════════════════════════════════╝");
    console.error("  Set RELEASE_SHA to the current checked-out SHA before release validation.");
    console.error("  Example: RELEASE_SHA=$(git rev-parse HEAD) bash scripts/run-pre-deploy.sh");
    process.exit(1);
  }
  console.log(`\n  ✓ RELEASE_SHA matches checked-out tested commit: ${releaseSha}`);

  // ── MERCHANT_DATA_ENCRYPTION_KEY assertion (production release gate) ──────
  // Required for production release: the merchant key must be present and valid.
  // Dev builds do NOT require this key — only the pre-deploy gate enforces it.
  // The key value is NEVER printed.
  const merchantKey = process.env.MERCHANT_DATA_ENCRYPTION_KEY ?? "";
  const isMerchantKeyValid =
    /^[0-9a-fA-F]{64}$/.test(merchantKey.trim()) ||
    Buffer.from(merchantKey.trim(), "base64").length === 32;
  if (!merchantKey || !isMerchantKeyValid) {
    console.error("╔══════════════════════════════════════════════════════════════╗");
    console.error("║  KILL: MERCHANT_DATA_ENCRYPTION_KEY assertion failed         ║");
    console.error("╚══════════════════════════════════════════════════════════════╝");
    console.error("");
    console.error("  MERCHANT_DATA_ENCRYPTION_KEY must be a valid 32-byte key:");
    console.error("    • 64-character hex string, OR");
    console.error("    • 44-character base64 string");
    console.error("");
    console.error("  This key is required to encrypt/decrypt merchant protected data");
    console.error("  (EIN, SSN, DOB, bank routing/account numbers).");
    console.error("");
    console.error("  Add it to Secrets and restart before running the pre-deploy gate.");
    console.error("  See docs/merchant-data-key-rotation.md for key generation and");
    console.error("  rotation procedures.");
    console.error("");
    console.error(`  Current status: ${merchantKey ? "SET but invalid format" : "NOT SET"}`);
    // Note: key value is never printed.
    process.exit(1);
  }
  console.log("  ✓ MERCHANT_DATA_ENCRYPTION_KEY present and valid (value not printed)");

  printBanner("Liberty Bancard — Pre-Deploy Launch Gate");
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`  Server: ${BASE_URL}`);
  console.log(
    selection.explicit
      ? `  Scope: ${selection.suites.length} exact suite(s) selected from ${MANDATORY_SUITES.length} mandatory roster entries`
      : `  Suites: ${MANDATORY_SUITES.length} mandatory roster entries (full default selection)`,
  );
  if (selection.explicit) {
    for (const script of selection.requestedScripts) console.log(`    • ${script}`);
  }
  console.log(`  HTTP test base: ${TEST_BASE_URL}`);
  console.log("\n  ⚠  This gate makes NO real provider calls.");
  console.log("  ⚠  Global outbound pause is verified before and after every suite.\n");

  // ── 0. Initial pause state verification & channel pause seeding ───────────
  printSectionHeader("Pre-flight: outbound pause state");

  // Seed all channel pause keys (fail-closed). Mirrors the startup seeder in
  // server/index.ts so the pre-deploy gate doesn't require a server restart
  // before the test-pause-fence suite can verify persisted rows.
  const CHANNEL_PAUSE_KEYS = [
    "outboundGlobalPaused",
    "emailChannelPaused",
    "smsChannelPaused",
    "coldEmailChannelPaused",
  ] as const;

  for (const key of CHANNEL_PAUSE_KEYS) {
    try {
      const existing = await db.select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, key))
        .limit(1);
      // Always ensure the key is present and set to true before running suites.
      // If missing → insert; if already true → no-op via onConflict; if false → update to true.
      await db.insert(systemSettings)
        .values({ key, value: "true" })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: "true" } });
      if (!existing[0]) {
        console.log(`  [seed] ${key}=true seeded (fail-closed default)`);
      } else if (existing[0].value !== "true" && existing[0].value !== true) {
        console.log(`  [seed] ${key} was ${JSON.stringify(existing[0].value)} — restored to true for gate`);
      }
    } catch (err: any) {
      console.warn(`  [seed] Could not seed ${key}: ${err?.message}`);
    }
  }

  const initialPaused = await getPauseSetting();
  if (!initialPaused) {
    console.error("  ✗ KILL: outboundGlobalPaused is NOT true at gate start.");
    console.error("    Set it to true before running the pre-deploy gate.");
    console.error("    SQL: UPDATE system_settings SET value='true' WHERE key='outboundGlobalPaused';");
    process.exit(1);
  }
  console.log("  ✓ outboundGlobalPaused=true confirmed before suite run");

  // ── 0b. Static scan: global-pause gates in outbound workers ───────────────
  // Task #1377 — Dynamic discovery: instead of a fixed list of 3 worker
  // files, we scan ALL TypeScript files under server/services/ (and
  // server/routes/) that contain at least one outbound send call.
  // Any file that sends without the normalised outboundGlobalPaused check
  // automatically fails the gate, even if it was added after this script.
  //
  // EXEMPTIONS:
  //   • Files in the PAUSE_CHECK_EXEMPTIONS set are deliberate bypasses:
  //     transport adapters, recovery paths, admin test routes, unsubscribe
  //     handlers, and inbound webhook acknowledgements.  Add new exemptions
  //     here with a one-line justification comment — DO NOT add exemptions
  //     silently.
  //   • Pattern: normalized comparison required (=== true | === "true" etc.)
  //     A bare `if (raw)` truthy test treats the string "false" as paused.

  printSectionHeader("Static scan: outboundGlobalPaused in all outbound workers");

  // Outbound send call tokens — same set used by compliance-scan.ts.
  const OUTBOUND_SEND_TOKENS = [
    "sendGhlSms",
    "sendSmsReply",
    "unifiedSendSms",
    "triggerAiCall",
    "enrollContactInGhlWorkflow",
    "triggerWorkflow",
    "sendGhlEmail",
    "sendGhlEmailForMerchant",
    "sendSmtpEmail",
    "sendEmailReply",
    "unifiedSendEmail",
    "enrollInGhlWorkflow(",         // direct enrollment (not compliant wrapper)
    "enrollInGhlWorkflowCompliant(",
  ];

  // Files that intentionally bypass the global pause gate — each entry
  // must carry a justification.
  const PAUSE_CHECK_EXEMPTIONS = new Set<string>([
    // ── Transport adapters — raw send API wrappers; callers own the gate ─────
    "server/services/transports/ghl-email-transport.ts",
    "server/services/transports/ghl-sms-transport.ts",
    "server/services/transports/ghl-rvm-transport.ts",
    "server/services/transports/index.ts",        // ChannelOrchestrator — gate is applied by callers
    "server/services/transports/sms-transport.ts",
    "server/services/transports/email-transport.ts",
    "server/services/smtp-email.ts",              // Raw SMTP transport; callers gate
    // ── GHL CRM utilities — sync, enrollment API wrappers, not marketing sends ─
    "server/services/ghl.ts",                     // Unsubscribe handler + inbound webhook ack
    "server/services/ghl-enrollment-recovery.ts", // Recovery path — intentional bypass
    "server/services/ghl-sync.ts",                // CRM field sync, not marketing
    "server/services/ghl-form-sync.ts",           // Form sync utility
    "server/services/ghl-workflow-enrollment.ts", // Low-level enrollment wrapper
    // ── Compliance / contactability — gating layer itself ────────────────────
    "server/services/contactability.ts",
    // ── Campaign engine — gated via evaluateContactability() which checks global pause ──
    "server/services/campaign-engine.ts",
    // ── Transactional notification services — not marketing automation ───────
    "server/services/co-branded-proposal.ts",     // Proposal delivery (accounts/transactional)
    "server/services/merchant-application-status.ts",
    "server/services/merchant-portal-invite.ts",
    "server/services/merchant-welcome.ts",        // Onboarding welcome (triggered by rep action)
    "server/services/partner-notifications.ts",   // Partner alerts (transactional)
    "server/services/partner-welcome.ts",
    "server/services/nps-email.ts",               // NPS survey (lifecycle, not cold outreach)
    "server/services/pipeline-silence-check.ts",  // Internal rep alert, not contact-facing
    "server/services/statement-analyzer.ts",      // Analysis utility — no contact-facing sends
    "server/services/statement-upload-chain.ts",  // Statement processing — transactional
    "server/services/sla-worker.ts",              // SLA escalation — internal alerts to reps
    "server/services/workflow-executor.ts",       // Workflow runner — pause gate in orchestration
    // ── Digest / reporting — internal sends only ─────────────────────────────
    "server/services/digest-service.ts",
    "server/services/weekly-digest.ts",
    // ── Serper gateway — has its own enabled/disabled gate that fires before any provider call ──
    "server/services/serper-gateway.ts",   // enable flag at line 203 is structurally equivalent to the global pause gate
    // ── SDR utilities — called from the SDR orchestrator which owns the gate ─
    "server/services/sdr/chat-handlers.ts",
    "server/services/sdr/ghl-client.ts",
    "server/services/sdr/operator-digest.ts",
    "server/services/sdr/reply-intelligence.ts",
    "server/services/sdr/scheduling.ts",          // Scheduling helper — gate in orchestrator
    "server/services/sdr/statement-flow.ts",
    "server/services/sdr/terminal-shipping.ts",   // Terminal order — transactional
    "server/services/sdr/voice-orchestrator.ts",  // Voice AI — own gate mechanism
    // ── Inbound webhook / reply handlers ─────────────────────────────────────
    "server/routes/sdr.ts",
    "server/routes/ghl.ts",
    // ── All route files — HTTP request handlers are human-initiated, not automated workers ──
    // The global pause gate applies to scheduled/queue workers, not per-request routes.
    // Routes that call enrollInGhlWorkflowCompliant already go through the compliance wrapper.
    "server/routes/acquisition.ts", "server/routes/activation.ts", "server/routes/activity.ts",
    "server/routes/admin.ts", "server/routes/ai.ts", "server/routes/analytics.ts",
    "server/routes/boarding.ts", "server/routes/campaigns.ts", "server/routes/chargebacks.ts",
    "server/routes/chat-assistant.ts", "server/routes/churn.ts", "server/routes/contacts.ts",
    "server/routes/content.ts", "server/routes/conversation-ai-config.ts",
    "server/routes/crm-operations.ts", "server/routes/deals.ts", "server/routes/documents.ts",
    "server/routes/executive.ts", "server/routes/glossary.ts", "server/routes/gmail-oauth.ts",
    "server/routes/helpers.ts", "server/routes/imports.ts", "server/routes/inbox-ownership.ts",
    "server/routes/inbox.ts", "server/routes/information-flow.ts", "server/routes/integrations.ts",
    "server/routes/knowledge-admin.ts", "server/routes/lifecycle.ts", "server/routes/live-chat.ts",
    "server/routes/merchant-portal-invite.ts", "server/routes/merchants.ts",
    "server/routes/my-day.ts", "server/routes/nba.ts", "server/routes/notifications.ts",
    "server/routes/og.ts", "server/routes/onboarding-stages.ts", "server/routes/partner-orgs.ts",
    "server/routes/partners.ts", "server/routes/permissions-audit.ts", "server/routes/portfolio.ts",
    "server/routes/prospects.ts", "server/routes/public.ts", "server/routes/push.ts",
    "server/routes/queue-metrics.ts", "server/routes/rate-review.ts",
    "server/routes/registry-import.ts", "server/routes/relationships.ts",
    "server/routes/residuals.ts", "server/routes/review-queue.ts", "server/routes/savings.ts",
    "server/routes/sdr.ts", "server/routes/search.ts", "server/routes/seo-admin.ts",
    "server/routes/social.ts", "server/routes/ssr-routes.ts",
    "server/routes/statement-review.ts", "server/routes/system-audit.ts",
    "server/routes/templates-settings.ts", "server/routes/terminal-economics.ts",
    "server/routes/tickets-tasks.ts", "server/routes/toolkit.ts", "server/routes/training.ts",
    "server/routes/underwriting.ts", "server/routes/virtual-terminal.ts",
    "server/routes/widget.ts", "server/routes/wizard.ts", "server/routes/workflows.ts",
    "server/routes/ghl.ts",
    // ── SDR sub-services — outbound gated by the SDR orchestrator ─────────────
    "server/services/sdr/ghl-sync-rules.ts",
    "server/services/sdr/proposal-tracking.ts",
    "server/services/sdr/webhook-handlers.ts",    // Inbound webhook processing, not marketing
    // ── Proposal / transactional services ─────────────────────────────────────
    "server/services/proposal-engine.ts",         // Transactional proposal delivery (accounts)
    "server/services/daily-outreach.ts",          // Legacy daily-outreach (replaced by orchestrator)
    // ── Reply / unsubscribe handlers ─────────────────────────────────────────
    "server/services/email-reply-handler.ts",
    "server/services/sms-reply-handler.ts",
  ]);

  // Matches the legacy normalized comparison OR a canonical authorize()/canExecute() call.
  // The authority/coordinator pattern: `await authorize(` or `await canExecute(` in non-comment
  // source is sufficient evidence that the pause gate is applied correctly.
  const NORMALIZED_PAUSE_PATTERN =
    /=== true|=== "true"|=== 'true'|await authorize\s*\(|await canExecute\s*\(/;

  // Strip single-line (//) and block (/* */) TypeScript/JS comments so that
  // commented-out code, log messages, and import-path strings inside comments
  // cannot satisfy the gate detectors.
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ")  // block comments
      .replace(/\/\/[^\n]*/g, "");         // line comments
  }

  // Discover all .ts files under server/services/ and server/routes/
  function walkDir(dir: string, files: string[] = []): string[] {
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) {
        walkDir(full, files);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(full);
      }
    }
    return files;
  }

  const candidateFiles = [
    ...walkDir("server/services"),
    ...walkDir("server/routes"),
  ];

  // Files that contain at least one outbound send token
  const outboundFiles: string[] = [];
  for (const filePath of candidateFiles) {
    const relPath = filePath.replace(/^\.\//, "");
    if (PAUSE_CHECK_EXEMPTIONS.has(relPath)) continue;
    let src: string;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const stripped = stripComments(src);
    const hasSend = OUTBOUND_SEND_TOKENS.some(t => stripped.includes(t));
    if (hasSend) outboundFiles.push(filePath);
  }

  // Assess each outbound file
  let staticScanFailed = false;
  const pausedFiles: string[] = [];
  const missingPause: string[] = [];
  const missingNorm: string[] = [];

  for (const filePath of outboundFiles) {
    const src = readFileSync(filePath, "utf8");
    const stripped = stripComments(src);
    // hasKey: legacy outboundGlobalPaused key, or canonical authority import, or coordinator call.
    // All three are checked on comment-stripped source so that commented-out code and
    // log messages cannot satisfy the detector.
    const hasKey =
      stripped.includes("outboundGlobalPaused") ||
      stripped.includes("outbound-pause-authority") ||
      /\bcanExecute\s*\(/.test(stripped);
    const hasNorm = NORMALIZED_PAUSE_PATTERN.test(stripped);
    const label = filePath.replace("server/", "");

    if (!hasKey) {
      missingPause.push(label);
      staticScanFailed = true;
    } else if (!hasNorm) {
      missingNorm.push(label);
      staticScanFailed = true;
    } else {
      pausedFiles.push(label);
    }
  }

  for (const f of pausedFiles) {
    console.log(`  ✓ ${f} — pause gate confirmed (outboundGlobalPaused or OutboundPauseAuthority/coordinator)`);
  }
  for (const f of missingPause) {
    console.error(`  ✗ KILL: ${f} — no pause gate found (neither outboundGlobalPaused nor OutboundPauseAuthority.authorize / coordinator.canExecute)`);
    console.error(`    Legacy:    const paused = await storage.getSystemSetting("outboundGlobalPaused"); if (paused === true || paused === "true") return;`);
    console.error(`    Canonical: const { authorize } = await import("./outbound-pause-authority"); const decision = await authorize({}); if (!decision.allowed) return;`);
  }
  for (const f of missingNorm) {
    console.error(`  ✗ KILL: ${f} — outboundGlobalPaused found but normalized comparison (=== true | === "true") MISSING`);
    console.error(`    Use: raw === true || raw === "true"  (not bare if (raw) which treats "false" as paused).`);
    console.error(`    Or upgrade to canonical: const { authorize } = await import("./outbound-pause-authority"); const decision = await authorize({}); if (!decision.allowed) return;`);
  }

  if (staticScanFailed) {
    console.error(
      `\n  ✗ KILL: ${missingPause.length + missingNorm.length} outbound file(s) missing the global-pause gate.` +
      `\n    To exempt a file (transport adapters, recovery paths, admin test routes), add it to` +
      `\n    PAUSE_CHECK_EXEMPTIONS in scripts/pre-deploy.ts with a one-line justification.\n`
    );
    process.exit(1);
  }
  console.log(
    `  ✓ All ${pausedFiles.length} discovered outbound file(s) have a recognised pause gate` +
    ` (${PAUSE_CHECK_EXEMPTIONS.size} files explicitly exempted)`
  );

  // ── 1. Server reachability check ───────────────────────────────────────────
  // Suites with requiresServer:true but skipWhenServerDown:false MUST run —
  // an unreachable server is a hard gate failure, not a silent skip.
  const serverSuites = selection.suites.filter(s => s.requiresServer);
  const mandatoryServerSuites = serverSuites.filter(s => !s.skipWhenServerDown);
  let serverReachable = false;
  if (serverSuites.length > 0) {
    printSectionHeader("Server health check");
    serverReachable = checkServerReachable();
    if (serverReachable) {
      console.log(`  ✓ Server reachable at ${BASE_URL}`);
    } else {
      console.warn(`  ⚠ Server not reachable at ${BASE_URL}`);
      if (mandatoryServerSuites.length > 0) {
        console.error("\n  ✗ KILL: The following suites REQUIRE a running server and cannot be skipped:");
        for (const s of mandatoryServerSuites) {
          console.error(`      • ${s.name}`);
        }
        console.error("\n  Start the dev server before running this gate, or use the wrapper:");
        console.error("    bash scripts/run-pre-deploy.sh");
        console.error("  See the header comment in scripts/pre-deploy.ts for details.\n");
        process.exit(1);
      }
      console.warn("    Remaining server-dependent suites (live-mode only) will be SKIPPED.");
    }
  }

  // ── 2. Run all suites ──────────────────────────────────────────────────────
  printSectionHeader("Running suites");

  const results: Array<{
    suite: Suite;
    exitCode: number;
    durationMs: number;
    diagnostic: string | null;
    status: "executed_pass" | "executed_fail" | "delegated_unverified" | "skipped_optional" | "skipped_opt_in";
    pauseAfter: boolean;
    pauseRestoreVerified: boolean;
  }> = [];
  const gateControlFailures: string[] = [];

  for (const suite of selection.suites) {
    // Only suites explicitly marked skipWhenServerDown may be skipped when the
    // server is absent.  Suites without that flag that require a server have
    // already caused a hard exit above, so this path is only reached for the
    // soft-skip candidates.
    const serverSkip =
      suite.requiresServer && !serverReachable && !!suite.skipWhenServerDown;
    const disposableDatabaseReady =
      process.env.NODE_ENV === "test" &&
      Boolean(process.env.DATABASE_URL) &&
      process.env.DATABASE_URL === process.env.TEST_DATABASE_URL;
    const disposableDatabaseSkip =
      Boolean(suite.requiresDisposableTestDatabase) && !disposableDatabaseReady;
    const optInSkip = shouldSkipExplicitDisposableOptIn(suite, selection.operatorIntent);
    const skip = serverSkip || disposableDatabaseSkip || optInSkip;

    console.log(`\n▶  ${suite.name}`);

    if (skip) {
      if (optInSkip) {
        console.log(
          "   HELD — auth concurrency was not opted in; use --include-auth-concurrency for the private full roster or exact-select the auth suite",
        );
      } else if (disposableDatabaseSkip) {
        console.log(
          "   (skipped — disposable PostgreSQL certification runs in deterministic-integration CI;",
        );
        console.log(
          "    set NODE_ENV=test with equal DATABASE_URL/TEST_DATABASE_URL to run it here)",
        );
      } else {
        console.log("   (skipped — server not reachable; live-mode suite)");
      }
      results.push({
        suite,
        exitCode: 0,
        durationMs: 0,
        diagnostic: null,
        status: optInSkip
          ? "skipped_opt_in"
          : disposableDatabaseSkip
            ? "delegated_unverified"
            : "skipped_optional",
        pauseAfter: true,
        pauseRestoreVerified: true,
      });
      continue;
    }

    const { exitCode, durationMs, diagnostic } = runSuite(suite, selection.operatorIntent);

    // Verify and restore pause after each suite
    const pauseAfter = await getPauseSetting();
    let pauseRestoreVerified = pauseAfter;
    if (!pauseAfter) {
      console.warn(`  ⚠ Pause was lifted during "${suite.name}" — restoring to true`);
      await setPauseSetting(true);
      pauseRestoreVerified = await getPauseSetting();
      if (!pauseRestoreVerified) {
        gateControlFailures.push(`outboundGlobalPaused could not be restored after ${suite.name}`);
      }
    }

    const icon = exitCode === 0 ? "✓" : "✗";
    const pauseSummary = pauseAfter
      ? "true ✓"
      : pauseRestoreVerified
        ? "FALSE → restored true ✓"
        : "FALSE ✗ restore unverified";
    console.log(`   ${icon} exit=${exitCode}  time=${formatDuration(durationMs)}  pause-after=${pauseSummary}`);
    if (diagnostic) console.log(`     child-process detail: ${diagnostic}`);

    results.push({
      suite,
      exitCode,
      durationMs,
      diagnostic,
      status: resolveSuiteExitStatus(exitCode),
      pauseAfter,
      pauseRestoreVerified,
    });
  }

  // ── 3. Final pause state verification ─────────────────────────────────────
  let finalPaused = await getPauseSetting();
  if (!finalPaused) {
    console.warn("\n  ⚠ Final pause check: outboundGlobalPaused is NOT true — restoring");
    await setPauseSetting(true);
    finalPaused = await getPauseSetting();
    if (!finalPaused) {
      gateControlFailures.push("final outboundGlobalPaused restoration could not be verified");
    }
  }

  // ── 4. Opt-in: Isolated Pause State-Machine test ─────────────────────────
  // This test mutates an isolated test namespace and requires TEST_DATABASE_URL,
  // TEST_REDIS_PREFIX, and NODE_ENV=test to be set by the caller.
  //
  // IMPORTANT: scripts/run-pre-deploy.sh must NOT set INTEGRATION_TESTS_OPT_IN.
  // This test is NEVER executed in ordinary CI without explicit operator action.
  //
  // Kill lines enforced by the test itself:
  //   - Refuses to run unless all four isolation guards are set
  //   - Provider fakes throw on any accidental outbound call
  //   - Cleanup leaves test namespace paused (not shared) on failure
  if (process.env.INTEGRATION_TESTS_OPT_IN === "1") {
    printSectionHeader("Opt-in: Isolated Pause State-Machine test (#1548B)");
    console.log("  INTEGRATION_TESTS_OPT_IN=1 detected — running isolated pause cycle unit test");
    console.log("  ⚠  This test uses TEST_DATABASE_URL and TEST_REDIS_PREFIX (isolated namespace).");
    console.log("  ⚠  It does NOT touch the shared development database or pause state.\n");

    const isolatedResult = spawnSync(
      "npx",
      ["tsx", "scripts/test-pause-cycle-unit.ts"],
      {
        env: { ...process.env },
        stdio: "inherit",
        encoding: "utf8",
        timeout: 120 * 1000,
      },
    );

    if ((isolatedResult.status ?? 1) !== 0) {
      console.error("\n  ✗ KILL: Isolated Pause State-Machine test FAILED");
      console.error("    Review the output above. Fix the state-machine regression before deploying.");
      process.exit(1);
    }
    console.log("\n  ✓ Isolated Pause State-Machine test passed");
  } else {
    console.log("\n▶  Isolated Pause State-Machine test (opt-in)");
    console.log("   SKIPPED — INTEGRATION_TESTS_OPT_IN is not set.");
    console.log("   To run: set NODE_ENV=test TEST_DATABASE_URL=<test-db> TEST_REDIS_PREFIX=<prefix>");
    console.log("           INTEGRATION_TESTS_OPT_IN=1 npx tsx scripts/pre-deploy.ts");
  }

  // ── 5. External config report ─────────────────────────────────────────────
  printSectionHeader("External provider configuration (non-blocking)");

  const configByCategory: Record<string, ConfigItem[]> = {};
  for (const item of EXTERNAL_CONFIG) {
    if (!configByCategory[item.category]) configByCategory[item.category] = [];
    configByCategory[item.category].push(item);
  }

  const missingConfig: string[] = [];
  for (const [cat, items] of Object.entries(configByCategory)) {
    console.log(`\n  [${cat.toUpperCase()}]`);
    for (const item of items) {
      const set = !!process.env[item.key];
      // Alternative env var (e.g. Replit integration key) satisfies the requirement
      const satisfiedByAlt = !set && item.satisfiedByEnv && !!process.env[item.satisfiedByEnv];
      // Item is optional when a gating env var is present (e.g. GHL configured → SMTP optional)
      const coveredByPrimary = !set && !satisfiedByAlt && item.optionalWhenEnv && !!process.env[item.optionalWhenEnv];

      let icon: string;
      let status: string;

      if (set) {
        icon = "✓"; status = "SET";
      } else if (satisfiedByAlt) {
        icon = "✓"; status = `SET via ${item.satisfiedByEnv}`;
      } else if (coveredByPrimary) {
        icon = "◌"; status = `optional — ${item.optionalNote ?? item.optionalWhenEnv + " is configured"}`;
      } else {
        icon = "○"; status = "not set";
        missingConfig.push(`${item.key} (${item.label})`);
      }
      console.log(`  ${icon} ${item.key.padEnd(34)} ${status} — ${item.label}`);
    }
  }

  if (missingConfig.length > 0) {
    console.log(`\n  ⚠ ${missingConfig.length} provider config item(s) not set.`);
    console.log("    These are NOT test failures — configure before first live traffic.");
  } else {
    console.log("\n  ✓ All required external config items are set or covered.");
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────────
  printBanner("Pre-Deploy Gate Results");

  const summary = summarizeGateResults(results, gateControlFailures);
  const passed = summary.passedCount;
  const failedSuites = results.filter(r => r.status === "executed_fail");
  const delegatedUnverified = results.filter(r => r.status === "delegated_unverified");
  const skipped = summary.skippedCount;
  const optInSkipped = summary.optInSkippedCount;
  const total = selection.suites.length;

  console.log(`\n  Suites:  ${passed}/${total} executed and passed`);
  console.log(`  Executed failures: ${summary.failedCount}; delegated/unverified: ${summary.delegatedCount}; optional skipped: ${skipped}; explicit opt-in skipped: ${optInSkipped}`);
  console.log(`  Gate-control failures: ${gateControlFailures.length}`);
  console.log(`  Pause state: ${finalPaused ? "TRUE ✓" : "FALSE ✗"} after all suites`);
  console.log(`  External config: ${EXTERNAL_CONFIG.length - missingConfig.length}/${EXTERNAL_CONFIG.length} set`);

  for (const r of results) {
    const icon = r.status === "executed_pass" ? "✓" : r.status === "executed_fail" ? "✗" : "○";
    const tag = ` (${r.status})`;
    console.log(`  ${icon} ${r.suite.name}${tag}`);
  }

  console.log("");

  // ── 6. Persist gate result to system_settings ─────────────────────────────
  const gateResult = {
    ranAt: new Date().toISOString(),
    passed: summary.passed,
    passedCount: passed,
    totalCount: total,
    fullRosterCount: MANDATORY_SUITES.length,
    selectedScripts: selection.explicit ? selection.requestedScripts : null,
    failedCount: summary.failedCount,
    delegatedUnverifiedCount: summary.delegatedCount,
    skippedCount: skipped,
    optInSkippedCount: optInSkipped,
    gateControlFailures,
    suites: results.map(r => ({
      name: r.suite.name,
      script: r.suite.script,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      diagnostic: r.diagnostic,
      pauseAfter: r.pauseAfter,
      pauseRestoreVerified: r.pauseRestoreVerified,
    })),
  };
  try {
    const { systemSettings } = await import("@shared/schema");
    await db.insert(systemSettings)
      .values({ key: "pre_deploy_last_result", value: gateResult as any })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: gateResult as any, updatedAt: new Date() },
      });
    console.log("  ✓ Gate result written to system_settings.pre_deploy_last_result");
  } catch (persistErr: any) {
    console.warn(`  ⚠ Could not persist gate result: ${persistErr?.message}`);
  }

  if (!summary.passed) {
    console.error(
      `\n❌  PRE-DEPLOY GATE FAILED — executed suite failures=${failedSuites.length}; ` +
      `delegated/unverified=${delegatedUnverified.length}; gate-control failures=${gateControlFailures.length}:`,
    );
    for (const r of failedSuites) {
      console.error(`     ✗ ${r.suite.name} (exit ${r.exitCode}${r.diagnostic ? `; ${r.diagnostic}` : ""})`);
    }
    for (const r of delegatedUnverified) {
      console.error(`     ✗ ${r.suite.name} (delegated execution not verified for this release)`);
    }
    for (const failure of gateControlFailures) console.error(`     ✗ Gate control: ${failure}`);
    for (const r of results.filter(r => r.status === "skipped_opt_in")) {
      console.error(`     ○ ${r.suite.name} was not run; it requires explicit disposable selection.`);
    }
    console.error("\n   Fix all failures before deploying.\n");
    await dbPool?.end();
    process.exit(1);
  }

  console.log(
    selection.explicit
      ? "✅  PRE-DEPLOY GATE PASSED — all explicitly selected disposable suites green (this is not a full-roster release approval).\n"
      : "✅  PRE-DEPLOY GATE PASSED — all required suites verified; explicit opt-in/live-only skips are listed separately.\n",
  );
  console.log("   The application is NOT deployed automatically.");
  console.log("   Review external config warnings above before first live traffic.\n");
  await dbPool?.end();
  process.exit(0);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMain = invokedPath === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === "--self-test") {
  runPureRegressionTests();
  console.log("pre-deploy selector/result regression tests: PASS");
} else if (isMain) {
  main().catch(async (err) => {
    console.error("\nFatal error in pre-deploy gate:", err?.message ?? err);
    await dbPool?.end().catch(() => {});
    process.exit(1);
  });
}
