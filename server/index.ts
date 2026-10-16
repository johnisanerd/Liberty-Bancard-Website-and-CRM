import express, { type Request, Response, NextFunction } from "express";
import {withTransactionPhase} from "./lib/transaction-observability";
import cookieParser from "cookie-parser";
import * as Sentry from "@sentry/node";
import { registerRoutes } from "./routes";
import { assertCro02PurposePolicies, assertCro02ShadowOnly } from "./services/commercial-resolution";
import { runProductionSeedConvergence, convergeContactRecordClassBackfill, convergeSfpIdentityQuarantineBusiness9555, convergeSfpWrongSiteDerivedEvidence9555 } from "./services/production-seed-convergence";
import { ensureSfpOutreachPolicyControlCheckConstraint } from "./services/cro03/sfp-outreach-policy";
// W13: Ceremony removed from startup — use scripts/cro03d-run-ceremony.ts offline.
import { serveStatic } from "./static";
import { createServer } from "http";
import { getQueueManager, shutdownQueueManager } from "./services/queue-manager";
import { seedDefaultData } from "./services/seed-workflows";
import { seedSequences } from "./services/seed-sequences";
import { seedVerticalCampaigns } from "./services/seed-vertical-campaigns";
import { seedStageRules, seedDemoProspects } from "./services/seed-automation";
import { startDailyMaintenanceScheduler, seedScottSendingIdentity } from "./services/sdr/inbox-rotation";
import { startContentScheduler } from "./services/content-scheduler";
import { seedContentEngine } from "./services/seed-content-engine";
import { runDrizzleMigrations } from "./db-migrate";
import { shouldRunStartupMigrations } from "./startup-migration-policy";
import { hydrateWorkflowEnvFromDb } from "./services/ghl-workflows";
import { getBackgroundProfile, getSelectiveGroups } from "./services/background-profile";
import { validateEnv } from "./lib/validate-env";
import { storage } from "./storage";
import { setDbContext } from "./lib/db-context";
import {
  recordCertificationHttpListener,
  resolveCertificationHttpContract,
} from "./lib/certification-http-contract";

// Validate required environment variables before anything else starts.
validateEnv();
const certificationHttpContract = resolveCertificationHttpContract(process.env);

// Initialize Sentry error monitoring as early as possible so it captures all
// subsequent errors including those that occur during startup.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
  console.log("[Sentry] Error monitoring initialized");
} else {
  console.warn("[Sentry] SENTRY_DSN not set — error monitoring is disabled");
}

// Build CORS origin allowlist from ALLOWED_ORIGINS env var (comma-separated).
// Falls back to the production domain so the app is safe out of the box.
import { getCorsOrigins } from "./lib/canonical-url";
import {
  createSecurityMiddleware,
  isDeniedCorsOriginError,
} from "./lib/security";
const _allowedOrigins: string[] = getCorsOrigins();

function validateCriticalEnvVars() {
  const criticalVars = [
    "GHL_LOCATION_ID",
    "GHL_PRIVATE_INTEGRATION_TOKEN",
    "APP_URL",
    "GHL_WEBHOOK_SECRET",
    "ADMIN_DIGEST_EMAIL",
  ];
  for (const name of criticalVars) {
    if (!process.env[name]) {
      console.warn(`[Config] WARNING: Missing critical env var: ${name}`);
    }
  }
}
validateCriticalEnvVars();

function logEnvVarChecklist() {
  const checks: Array<{ envVar: string | string[]; feature: string }> = [
    { envVar: "PAYARC_API_KEY",             feature: "Payarc processor boarding (MID provisioning disabled without it)" },
    { envVar: "GHL_LOCATION_ID",           feature: "GoHighLevel CRM sync and all GHL communications" },
    { envVar: "GHL_DEFAULT_BOOKING_LINK",  feature: "{{link}} in SDR outreach templates (falls back to Calendly URL)" },
    { envVar: "GHL_WORKFLOW_BOOKING_LINK", feature: "Automated booking link workflow trigger via GHL" },
    { envVar: "GHL_BOOKING_URL",           feature: "Public 'Book a Call' CTA (VITE_GHL_BOOKING_URL must also be set for frontend)" },
    { envVar: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"], feature: "Push notifications (auto-generated fallback keys used — not portable across restarts without this)" },
    { envVar: "SENTRY_DSN",                feature: "Sentry error monitoring" },
    { envVar: "SERPER_API_KEY",            feature: "Serper.dev Google search enrichment in Outreach Command Center" },
    { envVar: "APOLLO_API_KEY",            feature: "Apollo.io B2B contact discovery" },
    { envVar: "PROXYCURL_API_KEY",         feature: "ProxyCurl LinkedIn enrichment" },
    { envVar: "APIFY_API_TOKEN",           feature: "Apify Yelp/Facebook business scraping" },
    { envVar: "OUTSCRAPER_API_KEY",        feature: "Outscraper Google Maps bulk data pulls" },
    { envVar: "SMTP_HOST",                 feature: "SMTP email fallback (used when GHL is not configured or contact has no GHL ID)" },
    { envVar: "SMTP_PASS",                 feature: "SMTP authentication — required alongside SMTP_HOST/USER for actual delivery" },
    { envVar: "AI_INTEGRATIONS_OPENAI_API_KEY", feature: "AI enrichment, intent classification, blueprint generation, proposal engine" },
  ];

  const missing: string[] = [];
  for (const check of checks) {
    const vars = Array.isArray(check.envVar) ? check.envVar : [check.envVar];
    const allMissing = vars.every((v) => !process.env[v]);
    if (allMissing) {
      const label = vars.join(" / ");
      missing.push(`  ✗ ${label.padEnd(35)} → ${check.feature}`);
    }
  }

  if (missing.length === 0) {
    console.log("[Config] ✓ All monitored environment variables are set.");
  } else {
    console.warn(`[Config] Missing optional/feature-gating env vars (${missing.length}):\n${missing.join("\n")}`);
  }
}

process.on("unhandledRejection", (reason: any) => {
  console.error("[Process] Unhandled promise rejection:", reason);
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  }
});

process.on("uncaughtException", (err: Error) => {
  console.error("[Process] Uncaught exception:", err);
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
  }
  process.exit(1);
});

let isShuttingDown = false;
const SHUTDOWN_HARD_CEILING_MS = parseInt(process.env.SHUTDOWN_HARD_CEILING_MS ?? "10000");
let sfpRuntimeOwnerHeartbeatTimer: NodeJS.Timeout | null = null;
let sfpRuntimeOwnerHeartbeatInFlight = false;
let lastSfpRuntimeHeartbeatReason: string | null = null;

async function startSfpRuntimeOwnerHeartbeat(): Promise<void> {
  const { claimSfpRuntimeDeploymentOwner, renewSfpRuntimeDeploymentOwner } =
    await import("./services/cro03/sfp-provider-operations");
  try {
    // Published artifacts advance the audited release selector atomically;
    // development and legacy identities still need explicit selection.
    await withTransactionPhase("sfp_runtime_startup_claim",claimSfpRuntimeDeploymentOwner);
    lastSfpRuntimeHeartbeatReason = null;
    log("[SFP Runtime] Current selected release owner established");
  } catch (error: any) {
    lastSfpRuntimeHeartbeatReason = String(error?.message ?? error);
    console.warn(`[SFP Runtime] Owner held at startup: ${lastSfpRuntimeHeartbeatReason}`);
  }

  if (sfpRuntimeOwnerHeartbeatTimer) return;
  sfpRuntimeOwnerHeartbeatTimer = setInterval(async () => {
    if (isShuttingDown || sfpRuntimeOwnerHeartbeatInFlight) return;
    sfpRuntimeOwnerHeartbeatInFlight = true;
    try {
      // Retry failed startup/expired ownership through the same fenced claim.
      // A retired build cannot advance the selector or steal the new lease.
      if (lastSfpRuntimeHeartbeatReason)
        await withTransactionPhase("sfp_runtime_heartbeat_claim",claimSfpRuntimeDeploymentOwner);
      else await withTransactionPhase("sfp_runtime_heartbeat_renewal",renewSfpRuntimeDeploymentOwner);
      if (lastSfpRuntimeHeartbeatReason) {
        log("[SFP Runtime] Selected live owner heartbeat resumed");
      }
      lastSfpRuntimeHeartbeatReason = null;
    } catch (error: any) {
      const reason = String(error?.message ?? error);
      if (reason !== lastSfpRuntimeHeartbeatReason) {
        console.warn(`[SFP Runtime] Heartbeat held: ${reason}`);
      }
      lastSfpRuntimeHeartbeatReason = reason;
    } finally {
      sfpRuntimeOwnerHeartbeatInFlight = false;
    }
  }, 30_000);
  sfpRuntimeOwnerHeartbeatTimer.unref();
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const { stopGhlReadBackfillWorker } = await import("./services/ghl-specialized-commands");
  stopGhlReadBackfillWorker();
  console.log(`[Process] ${signal} received — starting graceful shutdown (hard ceiling ${SHUTDOWN_HARD_CEILING_MS}ms)`);
  if (sfpRuntimeOwnerHeartbeatTimer) {
    clearInterval(sfpRuntimeOwnerHeartbeatTimer);
    sfpRuntimeOwnerHeartbeatTimer = null;
  }

  const forceExitTimer = setTimeout(() => {
    console.error(
      `[Process] Graceful shutdown exceeded ${SHUTDOWN_HARD_CEILING_MS}ms — forcing exit so the port is released for the next process`
    );
    process.exit(1);
  }, SHUTDOWN_HARD_CEILING_MS);
  forceExitTimer.unref();

  try {
    await shutdownQueueManager();
    console.log("[Process] Graceful shutdown complete");
    process.exit(0);
  } catch (err: any) {
    console.error("[Process] Error shutting down queue manager:", err.message);
    process.exit(1);
  } finally {
    clearTimeout(forceExitTimer);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const app = express();
const httpServer = createServer(app);

// Trust Replit's reverse proxy so req.hostname reflects X-Forwarded-Host
// (the custom domain, e.g. libertybancard.com) rather than the internal
// Replit hostname (liberty-bancard-system.replit.app).  Without this,
// Express uses the raw Host header set by the proxy and res.redirect('/path')
// constructs absolute URLs with the wrong hostname.
app.set("trust proxy", 1);

// Canonical-host redirect: intentionally removed.
// Application-layer host redirects (301 → libertybancard.com) consistently
// intercept Cloud Run's autoscale startup health probe — which uses an internal
// *.a.run.app hostname that doesn't match any safe-list pattern — causing every
// promote step to time out. Canonical host enforcement should be handled at the
// CDN / DNS layer (e.g. a Replit custom-domain redirect rule), not in Express.

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Common security headers must run before CORS so denied-origin responses have
// the same Helmet protections as every other response.
const { helmet: securityHeaders, cors: corsMiddleware } = createSecurityMiddleware(
  _allowedOrigins,
  process.env.NODE_ENV === "production" ? "production" : "development",
);
app.use(securityHeaders);
app.use(corsMiddleware);
// CORS failures are intentionally handled immediately after the CORS
// middleware. The typed error has a fixed public message and never reflects
// the rejected Origin header.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!isDeniedCorsOriginError(err)) return next(err);
  if (res.headersSent) return next(err);
  return res.status(403).json({ message: "CORS origin denied" });
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

// ---------------------------------------------------------------------------
// DB observability correlation middleware.
// Runs on every request and populates the AsyncLocalStorage context that
// server/db.ts reads when emitting db:slow_query / db:long_transaction logs.
// Kept deliberately lightweight — no I/O, no allocation beyond the tiny ctx.
// ---------------------------------------------------------------------------
app.use((req, _res, next) => {
  // Re-use an upstream request-id header when present (e.g. from a load
  // balancer), otherwise generate a compact random token.
  const correlationId: string =
    (typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null)
    ?? Math.random().toString(36).slice(2, 10);

  // Normalize the route: strip query string (already absent on req.path),
  // collapse numeric/UUID path segments so high-cardinality IDs don't create
  // unbounded label sets in any downstream log aggregator.
  const normalizedPath = req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid")
    .replace(/\/\d+/g, "/:id");

  setDbContext({
    correlationId,
    normalizedRoute: `${req.method} ${normalizedPath}`,
  });

  next();
});

(async () => {
  // C-03 (#1626): fail-fast fake GHL transport for test servers. When the
  // pre-deploy wrapper starts the server with GHL_TRANSPORT_FAILFAST=true, any
  // server-side call to the GHL API base URL throws TestTransportError instead
  // of reaching the real provider. Installed before registerRoutes so no
  // request handler can slip through before the intercept is active.
  if (process.env.GHL_TRANSPORT_FAILFAST === "true") {
    const { installGhlFailFastTransport } = await import("./services/ghl-test-transport");
    installGhlFailFastTransport();
  }

  if (shouldRunStartupMigrations(process.env.NODE_ENV)) {
    // Await core migrations without a whole-run timeout. The migration runner
    // applies schema DDL and journal migrations using a dedicated pg.Client with
    // statement_timeout=0 so that CREATE INDEX on large tables cannot be killed
    // mid-run. The optional knowledge-base seed at the end of runDrizzleMigrations
    // is already wrapped in its own try/catch and is non-fatal — no outer race
    // is needed. A timeout that wraps the entire function would misclassify a
    // legitimate long index build as a success, allowing deployment with a
    // partially applied schema.
    await runDrizzleMigrations();
  } else {
    console.log("[DB Migrate] Production startup migrations skipped — schema is managed by Replit Publish.");
    // Publish applies tables/columns/indexes/FKs but not function bodies or triggers. Install the
    // reviewed native objects (idempotent, drift-refusing, never throws) before workers start.
    const { shouldReconcileNativeObjects, reconcileNativeObjects } = await import("./native-objects/reconciler");
    if (shouldReconcileNativeObjects(process.env.NODE_ENV)) await reconcileNativeObjects();
    else console.log("[NativeObjects] Reconciliation disabled by NATIVE_OBJECT_RECONCILE=off.");
  }
  const { reconcileEnrichmentState, reconcileScoringState, seedAutomationRegistry } = await import("./services/startup-reconcile");
  await reconcileEnrichmentState();
  await reconcileScoringState();
  await seedAutomationRegistry();
  try {
    const { ensureCro07TaxonomyRegistered } = await import("./services/cro07-taxonomy");
    const taxonomy = await ensureCro07TaxonomyRegistered();
    console.log(`[CRO07] Canonical event taxonomy v${taxonomy.version} registered (${taxonomy.inserted} new entries)`);
  } catch (e: any) {
    console.error("[CRO07] Taxonomy registration failed — controlled-delivery taxonomy endpoints will be empty:", e?.message);
  }
  // Mark any previews left 'running' by a previous server process as interrupted.
  // This prevents stale running previews from ever being used for queuing after a restart.
  try {
    await storage.markInterruptedCampaignPreviews();
    console.log("[CampaignPreview] Startup: interrupted any stale running previews");
  } catch (e: any) {
    console.warn("[CampaignPreview] Startup interrupt-mark failed (non-fatal):", e?.message);
  }
  // Fail closed before route registration if an operator attempts an
  // unauthorized CRO-02 compare/enforce activation.
  assertCro02ShadowOnly();
  // Task #1750: single cross-cutting authority for every production-required
  // seed/backfill row a migration bakes in as an imperative INSERT/UPDATE.
  // Production is provisioned by Replit Publish schema sync, not the Drizzle
  // migration runner, so a table can exist with zero of its seed rows. Every
  // target here is insert-only and fails closed (throws, blocking startup)
  // on any conflict with canonical content.
  await runProductionSeedConvergence();
  const { convergeSfpRecipientPolicyV2, convergeSfpRecipientPolicyV3 } = await import("./services/cro03/sfp-recipient-policy-convergence");
  await convergeSfpRecipientPolicyV2();
  await convergeSfpRecipientPolicyV3();
  // Applies sfp_outreach_policy_control's singleton CHECK constraint
  // out-of-band — see ensureSfpOutreachPolicyControlCheckConstraint's doc
  // comment for why it cannot be declared in shared/schema.ts.
  await ensureSfpOutreachPolicyControlCheckConstraint();
  // W13: Ceremony artifacts no longer run at startup — use scripts/cro03d-run-ceremony.ts offline.
  await assertCro02PurposePolicies();
  await registerRoutes(httpServer, app);
  // Resume only durable, expired CSV executions after routes are registered.
  // Fire-and-forget: recovery is heavy (can process hundreds of thousands of
  // rows) and must not block startup or hold pool connections during the
  // critical startup window.  Each recovered execution claims its own lease
  // so concurrent restarts are safe.
  setImmediate(async () => {
    try {
      const { resumeExpiredCsvImports } = await import("./services/csv-import-recovery");
      const { processPersistedCsvImport } = await import("./services/csv-import-processor");
      const resumed = await resumeExpiredCsvImports(processPersistedCsvImport);
      if (resumed > 0) console.log(`[StartupReconcile] Resumed ${resumed} expired CSV import execution(s)`);
    } catch (error) {
      console.error("[StartupReconcile] CSV import recovery failed — will retry on next restart:", error);
    }
  });

  const { logSmtpStartupWarning } = await import("./services/smtp-email");
  logSmtpStartupWarning();

  // Sentry error-handler must be registered AFTER all routes so it can capture
  // errors propagated via next(err). It must also come BEFORE the generic error
  // handler below so Sentry receives the full error object.
  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;

    console.error("Internal Server Error:", err);

    // If the response is already started (e.g. SSE stream, chunked transfer),
    // calling next(err) routes into Sentry's error handler which tries to
    // append headers and causes ERR_HTTP_HEADERS_SENT.  Just destroy the
    // socket cleanly instead.
    if (res.headersSent) {
      res.destroy?.();
      return;
    }

    if (status >= 500) {
      return res.status(status).json({ message: "Internal server error" });
    }

    return res.status(status).json({ message: err.message || "Error" });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Restore field-sales freeze flag from DB BEFORE accepting traffic.
  // Fail-closed: defaults to frozen on DB error (see initializeFieldSalesFreezeState).
  // Must run before listen() so the rollback kill switch is active on first request.
  try {
    const { initializeFieldSalesFreezeState } = await import("./services/field-sales-rollback");
    await initializeFieldSalesFreezeState();
  } catch {
    // initializeFieldSalesFreezeState itself handles the fail-closed default; ignore re-throws
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: certificationHttpContract.host,
      reusePort: certificationHttpContract.reusePort,
    },
    async () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP_LISTENER_ADDRESS_UNAVAILABLE_AFTER_LISTEN");
      }
      recordCertificationHttpListener(
        address.address,
        address.port,
        certificationHttpContract.reusePort,
      );
      log(`serving on ${address.address}:${address.port}`);
      logEnvVarChecklist();
      // Fire-and-forget: reclassify contacts whose record_class is still 'unknown'.
      // Runs AFTER listen() so it never blocks port opening. Idempotent — no-op
      // once production contacts are classified. Not in SEED_TARGETS because the
      // full-table UPDATE can take >30s on a large DB and would time out startup.
      setImmediate(() => {
        convergeContactRecordClassBackfill().then((result) => {
          console.log(`[ContactClassBackfill] ${result.outcome}: ${result.detail}`);
        }).catch((err: any) => {
          console.error("[ContactClassBackfill] Failed (non-fatal, will retry on next restart):", err?.message ?? err);
        });
      });
      // sfp_identity_quarantine_business_9555 / sfp_wrong_site_derived_evidence_9555:
      // one-off historical-incident repairs for a single business, deliberately
      // NOT part of runProductionSeedConvergence()'s blocking startup chain (see
      // that file's SEED_TARGETS comment). Run after listen() so a slow/contended
      // production DB cannot delay port-open past the deploy health-check window.
      // Sequential (quarantine must land before the derived-evidence guard reads it).
      setImmediate(async () => {
        try {
          const quarantineResult = await convergeSfpIdentityQuarantineBusiness9555();
          console.log(`[SfpBusiness9555] identity_quarantine ${quarantineResult.outcome}: ${quarantineResult.detail}`);
          const evidenceResult = await convergeSfpWrongSiteDerivedEvidence9555();
          console.log(`[SfpBusiness9555] wrong_site_derived_evidence ${evidenceResult.outcome}: ${evidenceResult.detail}`);
        } catch (err: any) {
          console.error("[SfpBusiness9555] Backfill failed (non-fatal, will retry on next restart):", err?.message ?? err);
        }
      });
      // MI-06: Fire-and-forget reconciliation for pre-MI-06 businesses.mainEmail values.
      // For every businesses row where mainEmail IS NOT NULL and email_discovery_status IS NULL,
      // set email_discovery_status='discovered' and create a business_validation_intents row.
      setImmediate(() => {
        import("./services/cro03/business-validation-service").then(({ reconcileExistingBusinessEmails }) =>
          reconcileExistingBusinessEmails()
        ).then((result) => {
          if (result.processed > 0 || result.errors > 0) {
            console.log(`[MI06Reconcile] mainEmail reconciliation: processed=${result.processed} errors=${result.errors}`);
          }
        }).catch((err: any) => {
          console.error("[MI06Reconcile] Startup reconciliation failed (non-fatal):", err?.message ?? err);
        });
      });
      const certificationDenyMode = process.env.VG_PROVIDER_DENY_MODE === "1";
      // Read profile once, early — every gated block below references _bgProfile.
      // Fail-closed: absent/invalid → "off" (no workers, no seeds, no hydration).
      const _bgProfile = getBackgroundProfile();

      // ── PAUSE AUTHORITY INITIALIZATION (must complete before any worker starts) ──
      // Read and validate the global outbound pause state before starting any
      // outbound-capable service or worker. Missing/malformed/DB-error resolves
      // to paused (fail-closed). Only after the state is known and logged may
      // workers initialize. This prevents the startup race where workers could
      // begin processing before pause state is known.
      let pauseInitialized = false;
      try {
        const { initializePauseControl } = await import("./services/outbound-control-service");
        const pauseState = await initializePauseControl();
        log(
          `[PauseAuthority] Startup state: ${pauseState.state} epoch=${pauseState.epoch} ` +
          `source=${pauseState.source}` +
          (pauseState.reason ? ` reason="${pauseState.reason}"` : ""),
        );
        // Treat safe_default as a failed initialization — the canonical control
        // table was missing or unreadable. Workers must not start until the table
        // exists and can be read, because the authority cannot make authoritative
        // decisions and cannot fall back to legacy system_settings (which may be
        // explicitly unpaused).
        if (pauseState.source === "safe_default") {
          throw new Error(
            `Pause control table missing or unreadable (source=safe_default, state=${pauseState.state}). ` +
            `Apply migration 0133 and restart before starting outbound-capable workers.`,
          );
        }
        pauseInitialized = true;
      } catch (pauseInitErr: any) {
        // Fail-closed: if pause initialization throws or returns safe_default,
        // do NOT start outbound-capable workers.
        console.error(
          `[PauseAuthority] STARTUP ERROR: pause initialization failed — ` +
          `outbound workers blocked until resolved: ${pauseInitErr.message}`,
        );
        pauseInitialized = false;
      }

      // Restore field-sales freeze flag from DB (non-blocking for workers; defaults to frozen on failure)
      // Field-sales freeze state was already loaded synchronously before listen() above.

      // W01: selective mode starts only the named BullMQ capability groups.
      // full/core also run non-BullMQ seeds, schedulers, and GHL hydration.
      // Selective and off modes skip all of those.
      const _bgProfileAllowsNonBullmqWork = _bgProfile === "full" || _bgProfile === "core";

      if (_bgProfileAllowsNonBullmqWork) {
        // Seed legacy system_settings pause keys (for backward compat, channel-level pauses)
        (async () => {
          const CHANNEL_PAUSE_KEYS = [
            "outboundGlobalPaused",
            "emailChannelPaused",
            "smsChannelPaused",
            "coldEmailChannelPaused",
          ] as const;
          for (const key of CHANNEL_PAUSE_KEYS) {
            const existing = await storage.getSystemSetting(key);
            if (existing === null) {
              await storage.setSystemSetting(key, true);
              log(`[PauseSeed] ${key}=true seeded (fail-closed default)`);
            }
          }
        })().catch(err => console.warn("[PauseSeed] Non-critical seeding error:", err.message));

        seedDefaultData();
        seedSequences();
        seedVerticalCampaigns();
        seedStageRules();
        // Demo prospects only run when DEV_SEED_DEMO=true (never in production).
        if (process.env.DEV_SEED_DEMO === "true") {
          seedDemoProspects();
        }
      } else {
        log(`[BackgroundProfile] ${_bgProfile} — startup seeds and pause-key seeding skipped`);
      }

      // ── Workers start only after pause state is initialized ───────────────
      // If pauseInitialized=false, workers are skipped entirely (fail-closed).
      if (!pauseInitialized) {
        console.error(
          "[PauseAuthority] Workers NOT started — pause state unknown. " +
          "Resolve the DB error and restart to enable outbound processing.",
        );
        // Continue with non-outbound startup (routes, seeds, etc.)
      }

      // BullMQ durable job queue — replaces setInterval workers for GHL sync,
      // SLA checks, sequence processing, enrichment, discovery, and digests.
      // Requires a real Redis connection (REDIS_URL). A failed initialization
      // fails closed: a process-local interval fallback would let replicas
      // disagree on ownership (BullMQ on one, legacy loop on another).
      // NOTE: This block only executes when pause state was successfully initialized.
      if (certificationDenyMode) {
        log("[Certification] BullMQ workers disabled in provider deny mode");
      } else if (!pauseInitialized) { /* skip workers — outbound state unknown */ }
      else if (_bgProfile === "off") {
        log("[BackgroundProfile] off — BullMQ workers not started. Set BACKGROUND_JOB_PROFILE=full to enable.");
      } else {
      await startSfpRuntimeOwnerHeartbeat().catch((runtimeOwnerError: any) => {
        console.warn(`[SFP Runtime] Owner heartbeat setup deferred: ${runtimeOwnerError?.message ?? runtimeOwnerError}`);
      });
      // Free-only profiles must never acquire a GHL capability. The read-only
      // worker recovers only commands an admin already explicitly requested.
      if (_bgProfile === "full" || (_bgProfile === "selective" && getSelectiveGroups().some(
        group => ["provider-live", "ghl-integration", "ghl-sync-only"].includes(group)))) {
        const { startGhlReadBackfillWorker } = await import("./services/ghl-specialized-commands");
        startGhlReadBackfillWorker();
      }
      getQueueManager().then(async qm => {
        log("[Queue] BullMQ job queues initialized");
        // BullMQ's GHL_SYNC repeatable job is now the sole active GHL sync mechanism.
        // getQueueManager() tears down any partially-created queues/workers on failure
        // before propagating the error, so this branch and the legacy-fallback branch
        // below are mutually exclusive within a process.
        log("GHL sync mode: bullmq");
        // Also record a visible health signal so the Operator Dashboard's Job Queue
        // panel reflects sync mode, not just the startup log.
        const { recordWorkerSuccess, JOB_NAMES } = await import("./services/job-registry");
        await recordWorkerSuccess(JOB_NAMES.GHL_SYNC_MODE).catch(() => {});

        // ── CRO-03C Deployment Inventory Convergence ──────────────────────────
        // Ensures a valid deployment inventory row exists for the current release
        // so that POST /api/cro03c/runtime-attestations succeeds without a manual
        // offline ceremony run after every deploy.
        // Non-blocking: runs in background after workers have had time to register.
        setTimeout(async () => {
          try {
            const { convergeCro03cDeploymentInventory } = await import("./services/cro03-inventory-convergence");
            const result = await convergeCro03cDeploymentInventory({ workerWaitMs: 60_000 });
            if (result.converged) {
              log(`[CRO03C-Inventory] Converged: inventoryId=${result.inventoryId} replayed=${result.replayed} workers=${result.workerCount}`);
            } else {
              console.warn(`[CRO03C-Inventory] Convergence deferred: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
            }
          } catch (err: any) {
            console.warn("[CRO03C-Inventory] Convergence threw unexpectedly:", err?.message);
          }
        }, 10_000); // 10 s head-start so workers can register their first heartbeat
      }).catch(async err => {
        console.error("[Queue] Failed to initialize BullMQ — workers remain stopped (fail-closed):", err.message);
        log("GHL sync mode: unavailable");
        const { recordWorkerFailure, JOB_NAMES } = await import("./services/job-registry");
        await recordWorkerFailure(
          JOB_NAMES.GHL_SYNC_MODE,
          `GHL sync unavailable — BullMQ initialization failed: ${err.message}`
        ).catch(() => {});
      });
      }

      // Hydrate GHL workflow IDs from DB into process.env so they behave as env vars,
      // then run a non-blocking live validation against GHL to surface stale/deleted IDs.
      // W01: GHL hydration runs in full/core unconditionally. In selective mode it runs
      // only when the ghl-integration capability group is explicitly selected (workers
      // in that group depend on hydrated workflow IDs). All other selective profiles and
      // the "off" profile skip it.
      const _ghlGroupActive =
        _bgProfile === "full" ||
        _bgProfile === "core" ||
        (_bgProfile === "selective" &&
          (() => {
            try {
              const { getSelectiveGroups: _sg } = require("./services/background-profile");
              return (_sg() as string[]).includes("ghl-integration");
            } catch { return false; }
          })());
      if (_bgProfile === "off" || (!_ghlGroupActive)) {
        log(`[BackgroundProfile] ${_bgProfile} — GHL workflow hydration/live validation skipped`);
      } else if (certificationDenyMode) {
        log("[Certification] GHL workflow hydration/live validation disabled in provider deny mode");
      } else {
        hydrateWorkflowEnvFromDb().then(async n => {
          if (n > 0) log(`[GHL Workflows] Hydrated ${n} workflow IDs from DB into process.env`);
          // Validate configured workflow IDs against real GHL after hydration so all IDs are visible
          try {
            const { validateGhlWorkflowRegistry } = await import("./services/ghl-workflows");
            const { isSdrGhlConfigured } = await import("./services/sdr/ghl-client");
            const { isGhlConfigured } = await import("./services/ghl");
            if (isGhlConfigured() || isSdrGhlConfigured()) {
              const v = await validateGhlWorkflowRegistry();
              if (v.checkedCount === 0) {
                log(`[GHL Workflow Validation] No workflow IDs configured yet — skipping live check`);
              } else {
                const broken = v.unresolvedKeys.length + v.inactiveKeys.length;
                if (broken > 0) {
                  console.warn(
                    `[GHL Workflow Validation] STARTUP WARNING: ${broken} workflow ID(s) invalid ` +
                    `(${v.unresolvedKeys.length} not found in GHL, ${v.inactiveKeys.length} inactive). ` +
                    `Affected env keys: ${[...v.unresolvedKeys, ...v.inactiveKeys].join(", ")}. ` +
                    `These automations will silently skip until fixed.`
                  );
                } else {
                  log(`[GHL Workflow Validation] ${v.okCount}/${v.checkedCount} configured workflow IDs verified active in GHL`);
                }
              }
            }
          } catch (err: any) {
            console.warn(`[GHL Workflow Validation] Startup validation failed (non-critical): ${err.message}`);
          }
        }).catch(() => {});
      }

      // W01: seeds and non-BullMQ schedulers only in full/core mode.
      // Selective mode enables only named BullMQ capability groups — nothing else.
      if (_bgProfileAllowsNonBullmqWork) {
        // Seed Scott's sending identity as the primary SDR inbox if not already present
        seedScottSendingIdentity().catch(err => {
          console.error("[Seed] Failed to seed Scott sending identity:", err);
        });

        // Seed default sender profiles (sales / support / onboarding) into system_settings
        // so they are configurable via the admin UI without hardcoded fallbacks.
        import("./services/email-signatures").then(({ seedDefaultSignatures }) => {
          return seedDefaultSignatures();
        }).catch(err => {
          console.warn("[Seed] Sender profile seeding failed (non-critical):", err.message);
        });

        const { seedInboundMessageWorkflows } = await import("./services/seed-inbound-workflows");
        seedInboundMessageWorkflows().catch(err => {
          console.error("[Seed] Failed to seed inbound message workflows:", err);
        });

        // Seed statement acquisition cadence config if not already set.
        // Admins can tune these via the system_settings table without a redeploy.
        (async () => {
          const acqCfg = await storage.getSystemSetting("statement_acquisition_config");
          if (acqCfg === null) {
            await storage.setSystemSetting("statement_acquisition_config", {
              upload_nudge_sms_hours: 24,
              rep_task_hours: 48,
              educational_email_hours: 72,
              stall_escalation_days: 5,
            });
            log("[StatementAcquisition] Default cadence config seeded into system_settings");
          }
        })().catch(err => console.warn("[StatementAcquisition] Non-critical seeding error:", err.message));
      }

      if (_bgProfile === "off" || !_bgProfileAllowsNonBullmqWork) {
        log(`[BackgroundProfile] ${_bgProfile} — DailyMaintenanceScheduler not started`);
      } else if (!certificationDenyMode) {
        startDailyMaintenanceScheduler();
      } else {
        log("[Certification] Daily maintenance scheduler disabled in provider deny mode");
      }

      // Task #179 — Content Engine: scheduled blog publish + LinkedIn drafts
      // Only start when pause state is known — LinkedIn auto-publish is an
      // external outbound action and must not run when workers are blocked.
      // W01: also only in full/core mode — selective enrichment must not publish content.
      if (_bgProfile === "off" || !_bgProfileAllowsNonBullmqWork) {
        log(`[BackgroundProfile] ${_bgProfile} — ContentScheduler not started`);
      } else if (pauseInitialized) {
        if (!certificationDenyMode) {
          startContentScheduler();
        } else {
          log("[Certification] Content scheduler disabled in provider deny mode");
        }
      } else {
        console.warn("[ContentScheduler] NOT started — pause state unknown; LinkedIn auto-publish blocked until restart with control table available");
      }
      if (_bgProfileAllowsNonBullmqWork) {
        seedContentEngine().catch(err => {
          console.error("[Seed] Content Engine seeding failed:", err);
        });
      }
    },
  );
})();
