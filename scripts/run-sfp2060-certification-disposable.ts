#!/usr/bin/env npx tsx
/**
 * Task 2060 certification launcher. It creates one private, socket-only
 * PostgreSQL cluster, gives each certification its own migrated disposable
 * database, then destroys the entire cluster afterward.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  buildLocalRehearsalEnvironment,
  launchLocalPostgres16,
  type LocalCluster,
} from "./local-rehearsal-core";
import { launchSfp2060DisposableRedis } from "./sfp2060-disposable-redis";

const localRole = () => process.env.USER || process.env.LOGNAME || os.userInfo().username;

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const cluster: LocalCluster = await launchLocalPostgres16();
  let exitCode = 0;
  const redisInstances: Array<Awaited<ReturnType<typeof launchSfp2060DisposableRedis>>> = [];
  const redisPrefixes = new Set<string>();
  try {
    const baseEnv = buildLocalRehearsalEnvironment({
      PGUSER: localRole(),
      NODE_ENV: "test",
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || `${os.homedir()}/.config`,
      VG_PROVIDER_DENY_MODE: "1",
      GHL_TRANSPORT_FAILFAST: "true",
      EMAIL_TRANSPORT_FAILFAST: "true",
      SMS_TRANSPORT_FAILFAST: "true",
      SUNBIZ_ENRICHMENT_ENABLED: "false",
      SERPER_GATEWAY_ENABLED: "false",
      FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED: "true",
      CRO03_PROVIDER_TRANSPORT_ENABLED: "true",
      BACKGROUND_JOB_PROFILE: "selective:sfp-campaign-staging",
    });
    // These fixed keys are disposable test material, never inherited
    // credentials. Set them after the helper has scrubbed its input environment.
    baseEnv.MERCHANT_DATA_ENCRYPTION_KEY = "task-2060-disposable-only";
    baseEnv.CREDENTIAL_ENCRYPTION_KEY = "task-2060-disposable-only";

    const certifications = [
      { name: "contact-incremental-pages", script: "scripts/certification/test-contact-incremental-pages.ts", database: true },
      { name: "contact-source-only-reconsideration", script: "scripts/certification/test-source-only-link-reconsideration.ts", database: true },
      { name: "canonical-evidence-candidates", script: "scripts/certification/test-contact-business-evidence-candidates.ts", database: true },
      { name: "canonical-contact-link-automation", script: "scripts/certification/test-crm-contact-link-automation.ts", database: true },
      { name: "legacy-contact-link-dispositions", script: "scripts/certification/test-legacy-contact-link-dispositions.ts", database: true },
      { name: "canonical-flow-progression", script: "scripts/certification/test-canonical-flow-progression.ts", database: true },
      { name: "canonical-upload-recovery", script: "scripts/certification/test-provider-import-recovery.ts", database: true },
      { name: "canonical-provider-intake", script: "scripts/certification/test-canonical-provider-import.ts", database: true, poolMax:1 },
      { name: "canonical-transaction-leases", script: "scripts/certification/test-canonical-transaction-leases.ts", database: true, poolMax:1 },
      { name: "canonical-workbook-evidence", script: "scripts/certification/test-enrichment-workbooks.ts", database: true },
      { name: "canonical-workbook-intake", script: "scripts/certification/test-canonical-workbook-intake.ts", database: true },
      { name: "staged-email-materialization", script: "scripts/certification/test-staged-email-materialization.ts", database: true },
      { name: "first-party-native-install", script: "scripts/certification/test-first-party-native-install.ts", database: true },
      { name: "canonical-recipient-preparation", script: "scripts/certification/test-canonical-recipient-preparation.ts", database: true },
      { name: "canonical-address-validation", script: "scripts/certification/test-canonical-address-validation.ts", database: true },
      { name: "canonical-source-outbox", script: "scripts/certification/test-canonical-source-outbox.ts", database: true },
      { name: "canonical-owner-repair", script: "scripts/certification/test-canonical-address-preparation-owner-repair.ts", database: true },
      { name: "canonical-program-discovery", script: "scripts/certification/test-canonical-program-discovery.ts", database: true, seedMi09Pricing:true },
      { name: "serper-lookup-memory", script: "scripts/certification/test-serper-lookup-memory.ts", database: true, seedMi09Pricing:true },
      { name: "canonical-vertical-storage", script: "scripts/certification/test-canonical-vertical-storage.ts", database: true },
      { name: "preflight-build", script: "scripts/test-sfp2060-preflight-build.ts", database: true },
      { name: "publish-handoff", script: "scripts/test-sfp-publish-handoff-disposable.ts", database: true },
      { name: "operator-company-links", script: "scripts/test-corroborated-company-links.ts", database: true },
      { name: "contact-link-coverage-execution", script: "server/tests/contact-link-coverage.execution.test.ts", database: false },
      { name: "receipt-projection-repair", script: "server/tests/sfp-eligibility-receipt-repair.test.ts", database: false },
      { name: "outscraper-retrieval-task-query", script: "server/tests/sfp-outs-task-query.test.ts", database: true },
      { name: "safe-failure-diagnostics", script: "server/tests/sfp-failure-diagnostics.test.ts", database: false },
      { name: "publish-build-identity", script: "scripts/test-sfp-publish-build-identity.ts", database: false },
      { name: "five-vertical-fairness", script: "scripts/test-sfp-five-vertical-fairness-pure.ts", database: false },
      { name: "provider-contracts", script: "scripts/test-sfp-provider-contracts.ts", database: false },
      { name: "ready-held-consumer-contract", script: "scripts/test-sfp-ready-held-consumer-contract.ts", database: false },
      { name: "redis-reservation", script: "scripts/test-certification-redis-reservation.ts", database: true },
      { name: "automatic-continuity", script: "scripts/test-sfp2060-continuity-disposable.ts", database: true },
      { name: "unified-candidate-dedupe", script: "scripts/test-sfp-unified-candidate-dedupe.ts", database: true },
      { name: "classification-bridge", script: "scripts/test-sfp-classification-bridge.ts", database: true },
      { name: "free-continuation", script: "scripts/test-sfp-free-continuation-certification.ts", database: true },
      { name: "contact-link-source-recovery", script: "scripts/test-contact-link-source-recovery-disposable.ts", database: true },
      { name: "sdr-contact-candidate-collision", script: "scripts/test-sdr-contact-candidate-collision-disposable.ts", database: true },
      {
        name: "contact-source-bridge-2056",
        script: "scripts/test-sfp2056-c1-c2-c3-c6-contact-certification.ts",
        database: true,
        seedMi09Pricing: true,
      },
      { name: "integrated-pipeline", script: "scripts/test-sfp2060-integrated-pipeline.ts", database: true },
      { name: "crm-repair-v2", script: "scripts/test-crm-repair-v2-disposable.ts", database: true },
      { name: "legacy1999", script: "scripts/test-sfp1999-postmerge-audit-certification.ts", database: true, seedMi09Pricing: true },
      { name: "legacy2000", script: "scripts/test-sfp2000-disposable-certification.ts", database: true, seedMi09Pricing: true },
      { name: "legacy2001", script: "scripts/test-sfp2001-campaign-staging-certification.ts", database: true, seedMi09Pricing: true },
      { name: "commercial-authority", script: "scripts/test-commercial-classification.ts", database: true },
      { name: "contact-merge", script: "scripts/test-canonical-identity-merge.ts", database: true },
      { name: "legacy-sfp-cohort", script: "scripts/sfp-certification.ts", database: true, seedMi09Pricing: true },
    ] as const;
    const onlyName = process.argv[2] === "--only" ? process.argv[3] : undefined;
    if (process.argv[2] !== undefined && process.argv[2] !== "--only") {
      throw new Error("Usage: run-sfp2060-certification-disposable.ts [--only <certification-name>]");
    }
    if (process.argv[2] === "--only" && !onlyName) {
      throw new Error("Usage: run-sfp2060-certification-disposable.ts --only <certification-name>");
    }
    const selectedCertifications = onlyName
      ? certifications.filter((certification) => certification.name === onlyName)
      : certifications;
    if (onlyName && selectedCertifications.length === 0) {
      throw new Error(`Unknown Task 2060 disposable certification: ${onlyName}`);
    }
    for (const certification of selectedCertifications) {
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      if(certification.name==="canonical-contact-link-automation") {
        // Queue topology is an authority pin; enable the serial queue before
        // the first fixture Publish rather than changing topology mid-test.
        env.BACKGROUND_JOB_PROFILE="selective:sfp-campaign-staging,sfp-continuous-discovery";
      }
      if ("poolMax" in certification) env.DB_POOL_MAX=String(certification.poolMax);
      if (certification.database) {
        const dbName = `test_sfp2060_${certification.name.replace(/[^a-z0-9]/gi, "_")}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const admin = new pg.Client({
          host: cluster.socket.realpath,
          port: cluster.port,
          database: "postgres",
          user: localRole(),
        });
        await admin.connect();
        try {
          await admin.query(`CREATE DATABASE "${dbName}"`);
        } finally {
          await admin.end();
        }

        const dbUrl = `postgresql:///${dbName}?host=${encodeURIComponent(cluster.socket.realpath)}&port=${cluster.port}`;
        // The safety helper removes inherited database credentials. Only the
        // socket URL for this newly created suite database is restored here.
        env.DATABASE_URL = dbUrl;
        env.TEST_DATABASE_URL = dbUrl;
        const migrationExit = await run("npx", [
          "tsx", "-e",
          `import("./server/db-migrate").then(m=>m.runDrizzleMigrations()).then(()=>import("./server/db")).then(d=>d.pool.end()).catch(e=>{console.error(e);process.exit(1);})`,
        ], env);
        if (migrationExit !== 0) {
          throw new Error(`Task 2060 disposable migrations failed for ${certification.name} (exit ${migrationExit}).`);
        }
        if ("seedMi09Pricing" in certification && certification.seedMi09Pricing) {
          const seedExit = await run("npx", [
            "tsx", "scripts/seed-mi09-pricing.ts", "--apply", "--confirm-env=test",
          ], env);
          if (seedExit !== 0) {
            throw new Error(`Task 2060 disposable pricing seed failed for ${certification.name} (exit ${seedExit}).`);
          }
        }
        const redis = await launchSfp2060DisposableRedis({
          PATH: env.PATH,
          HOME: env.HOME,
          TMPDIR: env.TMPDIR,
          LANG: "C",
          LC_ALL: "C",
        });
        if (redisPrefixes.has(redis.prefix)) {
          await redis.stop();
          throw new Error("Task 2060 disposable Redis prefix collided across SQL certifications.");
        }
        redisPrefixes.add(redis.prefix);
        redisInstances.push(redis);
        // Every SQL certification owns a distinct Redis namespace and private
        // server, both attached only after the shared environment scrub.
        env.REDIS_URL = redis.url;
        env.TEST_REDIS_PREFIX = redis.prefix;
      }
      exitCode = await run("npx", ["tsx", certification.script], env);
      if (exitCode !== 0) break;
    }
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    // A failed teardown is a certification failure even when every assertion
    // passed. Stop every private Redis and the disposable PostgreSQL cluster.
    let cleanupFailed = false;
    try {
      await cluster.stop();
    } catch (error) {
      console.error("Task 2060 disposable PostgreSQL cluster teardown failed:", error);
      cleanupFailed = true;
    }
    for (const redis of redisInstances.reverse()) {
      try {
        await redis.stop();
      } catch (error) {
        console.error("Task 2060 disposable Redis teardown failed:", error);
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) exitCode = 1;
  }
  process.exitCode = exitCode;
}

void main();