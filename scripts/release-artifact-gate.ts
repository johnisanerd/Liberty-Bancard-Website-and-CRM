#!/usr/bin/env tsx
/**
 * Release artifact gate: typecheck, make a fresh production build, then scan
 * its server and public artifacts without ever logging matched secret values.
 */
import { spawnSync } from "node:child_process";
import { writeCandidateIdentity, captureCandidateSource } from "./fixtures/candidate-build-identity";

function run(command: string, args: string[]): void {
  const compiling = command === "npm" || command === "npm.cmd";
  const env = compiling && process.env.VG_PROVIDER_DENY_MODE === "1" ? {
    ...process.env,
    CERTIFICATION_COMPILER_ONLY: "1",
    CERTIFICATION_ALLOWED_NETWORK_ORIGINS: "",
    CERTIFICATION_ALLOW_LOOPBACK: "0",
  } : process.env;
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? "with a signal"}`);
  }
}

try {
  const source=await captureCandidateSource();
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
  run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/inventory-artifact-dependencies.ts", "--output", "dist/dependency-inventory.json"]);
  run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/scan-build-artifacts.ts"]);
  // Inventory is emitted after npm build; finalize only once every gated
  // output exists, otherwise reuse would correctly reject that extra file.
  await writeCandidateIdentity(process.cwd(),source);
  console.log("release-artifact-gate: PASS — typecheck, production build, dependency inventory, and redacting artifact scan completed");
} catch (error) {
  console.error(
    `release-artifact-gate: FAIL — ${error instanceof Error ? error.message : "release artifact gate failed"}`,
  );
  process.exitCode = 1;
}