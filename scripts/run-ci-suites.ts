#!/usr/bin/env npx tsx
/**
 * Executes manifest-classified CI suites without invoking the production
 * pre-deploy gate.  The production gate has operational pause/audit side
 * effects; CI must run only on disposable infrastructure and own no release
 * state.
 */
import { execFileSync, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SUITE_MANIFEST,
  type SuiteCapability,
  type SuiteManifestEntry,
} from "./ci-suite-manifest";
import {
  spawnCertificationTsx,
  terminateCertificationChild,
} from "./certification-child-process";
import { assertCertificationServerReady } from "./certification-server-readiness";
import { assertDisposableTestInfrastructure } from "./test-infrastructure-guard";

const RUNNABLE_CAPABILITIES = new Set<SuiteCapability>([
  "deterministic-static",
  "deterministic-integration",
  "server-required",
  "external-security",
  "writable-build",
]);

function parseCapabilities(): SuiteCapability[] {
  const args = process.argv.slice(2);
  const selected: SuiteCapability[] = [];

  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--capability") continue;
    const capability = args[index + 1] as SuiteCapability | undefined;
    if (!capability || !RUNNABLE_CAPABILITIES.has(capability)) {
      throw new Error(
        `--capability must be one of: ${[...RUNNABLE_CAPABILITIES].join(", ")}`,
      );
    }
    selected.push(capability);
    index++;
  }

  if (selected.length !== 1) {
    throw new Error("Provide exactly one --capability value.");
  }
  return selected;
}

async function runSuite(suite: SuiteManifestEntry, capability: SuiteCapability): Promise<void> {
  const timeoutMs = Number(process.env.CI_SUITE_TIMEOUT_MS ??
    suite.executionTimeoutMs ?? (suite.isolateInfrastructure ? 900_000 : 300_000));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("CI_SUITE_TIMEOUT_MS must be a finite value of at least 1000ms.");
  }
  const runId = process.env.CERTIFICATION_RUN_ID ?? randomUUID();
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "liberty-certification-"));
  const receiptPath = path.join(outputDirectory, "receipt.json");
  let releaseSuiteReservation = async (): Promise<void> => {};
  try {
    let suiteCwd = process.cwd();
    if (suite.workspace === "repository-build") {
      suiteCwd = path.join(outputDirectory, "workspace");
      await cp(process.cwd(), suiteCwd, {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(process.cwd(), source);
          return !(
            relative === ".git" ||
            relative.startsWith(`.git${path.sep}`) ||
            relative === ".local" ||
            relative.startsWith(`.local${path.sep}`) ||
            relative === ".cache" ||
            relative.startsWith(`.cache${path.sep}`) ||
            relative === ".agents" ||
            relative.startsWith(`.agents${path.sep}`) ||
            relative === "attached_assets" ||
            relative.startsWith(`attached_assets${path.sep}`) ||
            relative === "artifacts" ||
            relative.startsWith(`artifacts${path.sep}`) ||
            relative === "uploads" ||
            relative.startsWith(`uploads${path.sep}`) ||
            relative === ".pythonlibs" ||
            relative.startsWith(`.pythonlibs${path.sep}`) ||
            relative === "node_modules" ||
            relative.startsWith(`node_modules${path.sep}`) ||
            relative === "dist" ||
            relative.startsWith(`dist${path.sep}`)
          );
        },
      });
      // The build mints its identity from Git HEAD. Give the isolated copy
      // independent metadata, not a symlink into the creator's live checkout.
      // --no-checkout preserves the copied candidate files (including WIP);
      // --no-hardlinks prevents shared mutable Git objects/references.
      const metadataClone = path.join(outputDirectory, "git-source");
      execFileSync("git", ["clone", "--no-checkout", "--no-hardlinks", process.cwd(), metadataClone], {
        stdio: "pipe",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" },
      });
      await rename(path.join(metadataClone, ".git"), path.join(suiteCwd, ".git"));
      await symlink(path.join(process.cwd(), "node_modules"), path.join(suiteCwd, "node_modules"), "dir");
      await symlink(
        path.join(process.cwd(), "attached_assets"),
        path.join(suiteCwd, "attached_assets"),
        "dir",
      );
    }
    const suiteEnvironment: NodeJS.ProcessEnv = {
      ...suite.requiredEnv,
      CERTIFICATION_RUN_ID: runId,
      CERTIFICATION_SUITE_ID: suite.script,
      CERTIFICATION_RECEIPT_PATH: receiptPath,
      NODE_OPTIONS:
        `--require=${path.resolve(process.cwd(), "scripts/certification-provider-deny-preload.cjs")}`,
      CERTIFICATION_ALLOW_LOOPBACK:
        suite.network === "npm-registry-only" ? "0" : "1",
    };
    if (suite.network === "npm-registry-only") {
      const cacheDirectory = path.join(outputDirectory, "npm-cache");
      const npmConfigPath = path.join(outputDirectory, "npmrc");
      await mkdir(cacheDirectory);
      await writeFile(
        npmConfigPath,
        "registry=https://registry.npmjs.org/\nalways-auth=false\n",
        { mode: 0o600 },
      );
      Object.assign(suiteEnvironment, {
        HOME: outputDirectory,
        XDG_CONFIG_HOME: path.join(outputDirectory, "xdg-config"),
        XDG_CACHE_HOME: path.join(outputDirectory, "xdg-cache"),
        NPM_CONFIG_USERCONFIG: npmConfigPath,
        NPM_CONFIG_CACHE: cacheDirectory,
        CERTIFICATION_ALLOWED_NETWORK_ORIGINS: "https://registry.npmjs.org",
      });
    }
    if (suite.redis === "suite-isolated") {
      suiteEnvironment.TEST_REDIS_PREFIX =
        `${process.env.TEST_REDIS_PREFIX ?? "ci_certification_"}suite_` +
        `${randomUUID().replace(/-/g, "")}_`;
      const infrastructure = await assertDisposableTestInfrastructure({
        operation: `CI suite reservation ${suite.name}`,
        requireRedis: true,
        reserveRedisNamespace: true,
        env: { ...process.env, ...suiteEnvironment },
      });
      releaseSuiteReservation = infrastructure.releaseRedisReservation;
    }
    await new Promise<void>((resolve, reject) => {
    let output = "";
    const child: ChildProcess = spawnCertificationTsx(
      "scripts/run-denied-certification-suite.ts",
      [suite.script, capability],
      {
        env: suiteEnvironment,
        stdio: "pipe",
        profile:
          suite.database === "none" && suite.redis === "none"
            ? "stateless"
            : "stateful",
        cwd: suiteCwd,
      },
    );
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateCertificationChild(child).then(
        () => reject(new Error(`${suite.name} exceeded the ${timeoutMs}ms CI suite timeout.`)),
        reject,
      );
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${suite.name} could not start: ${error.message}`));
    });
    child.once("exit", async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await terminateCertificationChild(child);
        if (code === 0) resolve();
        else reject(new Error(`${suite.name} failed (exit=${code ?? "null"}, signal=${signal ?? "none"}).`));
      } catch (error) {
        reject(error);
      }
    });
    });
    if (suite.completion === "module-receipt") {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
      if (
        receipt.runId !== runId ||
        receipt.suiteId !== suite.script ||
        receipt.outcome !== "executed_pass" ||
        Number(receipt.coreAssertions) < 1 ||
        Number(receipt.fixtureGroups) < 1 ||
        receipt.cleanup !== "complete"
      ) {
        throw new Error(`${suite.name} produced an invalid or incomplete certification receipt.`);
      }
    }
  } finally {
    await releaseSuiteReservation();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [capability] = parseCapabilities();
  const suites = SUITE_MANIFEST.filter((suite) => suite.capability === capability);
  if (suites.length === 0) throw new Error(`No suites registered for ${capability}.`);

  if (capability === "deterministic-integration" || capability === "server-required") {
    await assertDisposableTestInfrastructure({
      operation: `CI ${capability}`,
      requireRedis: true,
    });
  }
  if (capability === "server-required") {
    await assertCertificationServerReady(
      process.env.BASE_URL ?? "http://127.0.0.1:5000",
    );
  }

  console.log(`\n══ CI ${capability}: ${suites.length} required suite(s) ══`);
  for (const [index, suite] of suites.entries()) {
    console.log(`\n[${index + 1}/${suites.length}] ${suite.name} — ${suite.script}`);
    await runSuite(suite, capability);
  }
  console.log(`\n✓ CI ${capability} completed: ${suites.length}/${suites.length} suites passed.`);
}

main().catch((error) => {
  console.error(`\n✗ CI suite runner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});