#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildCertificationEnvironment } from "./certification-process-env";

const compilerEnv = {
  NODE_ENV: "production",
  VG_PROVIDER_DENY_MODE: "1",
  CERTIFICATION_COMPILER_ONLY: "1",
  CERTIFICATION_ALLOWED_NETWORK_ORIGINS: "",
  CERTIFICATION_ALLOW_LOOPBACK: "0",
};
const preloadArgs = ["--require", "./scripts/certification-provider-deny-preload.cjs", "-e"];
const compilerProbe = spawnSync(process.execPath, [...preloadArgs, `
  const assert=require("node:assert/strict");
  assert.equal(process.env.NODE_ENV,"production");
  assert.throws(()=>require("node:net").connect({host:"127.0.0.1",port:1}),
    /production compiler socket denied/);
  assert.throws(()=>require("node:https").get("https://example.invalid"),
    /descendant network denied/);
  fetch("https://example.invalid").then(()=>process.exit(9)).catch(error=>{
    assert.match(error.message,/descendant network denied/);
    console.log("compiler denied");
  });
`], { env: compilerEnv, encoding: "utf8" });
assert.equal(compilerProbe.status, 0, compilerProbe.stderr);
assert.match(compilerProbe.stdout, /compiler denied/);
for (const env of [
  { ...compilerEnv, CERTIFICATION_COMPILER_ONLY: "0" },
  { ...compilerEnv, CERTIFICATION_ALLOW_LOOPBACK: "1" },
  { ...compilerEnv, CERTIFICATION_ALLOWED_NETWORK_ORIGINS: "https://example.invalid" },
]) {
  const rejected = spawnSync(process.execPath, [...preloadArgs, "process.exit(0)"],
    { env, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /requires test deny mode/);
}

const inherited: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/cert_test",
  TEST_DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/cert_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  TEST_REDIS_PREFIX: "ci_certification_process_env_12345_",
  CERTIFICATION_HTTP_HOST: "127.0.0.1",
  CERTIFICATION_HTTP_NONCE: "a".repeat(64),
  AI_INTEGRATIONS_OPENAI_API_KEY: "must-not-cross-process-boundary",
  GHL_PRIVATE_INTEGRATION_TOKEN: "must-not-cross-process-boundary",
  GHL_API_KEY: "must-not-cross-process-boundary",
  SDR_GHL_API_KEY: "must-not-cross-process-boundary",
  SMTP_HOST: "must-not-cross-process-boundary",
  SMTP_USER: "must-not-cross-process-boundary",
  SMTP_PASS: "must-not-cross-process-boundary",
  TWILIO_ACCOUNT_SID: "must-not-cross-process-boundary",
  TWILIO_AUTH_TOKEN: "must-not-cross-process-boundary",
  ZEROBOUNCE_API_KEY: "must-not-cross-process-boundary",
  SERPER_API_KEY: "must-not-cross-process-boundary",
  OUTSCRAPER_API_KEY: "must-not-cross-process-boundary",
  APOLLO_API_KEY: "must-not-cross-process-boundary",
  OCR_API_KEY: "must-not-cross-process-boundary",
  FUTURE_PROVIDER_SECRET: "must-not-cross-process-boundary",
  AUTH_ACTION_DB_TEST_OPT_IN: "must-not-cross-unless-declared",
};

const forbidden = [
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "GHL_PRIVATE_INTEGRATION_TOKEN",
  "GHL_API_KEY",
  "SDR_GHL_API_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "ZEROBOUNCE_API_KEY",
  "SERPER_API_KEY",
  "OUTSCRAPER_API_KEY",
  "APOLLO_API_KEY",
  "OCR_API_KEY",
  "FUTURE_PROVIDER_SECRET",
];
const childProbe = "console.log(JSON.stringify(process.env))";
for (const role of ["migration", "integration", "server"]) {
  const result = spawnSync(process.execPath, ["-e", childProbe], {
    env: buildCertificationEnvironment(inherited),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${role} child probe failed: ${result.stderr}`);
  const childEnv = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
  for (const key of forbidden) {
    assert.equal(childEnv[key], undefined, `${role} inherited ${key}`);
  }
  assert.equal(childEnv.VG_PROVIDER_DENY_MODE, "1");
  assert.equal(childEnv.GHL_TRANSPORT_FAILFAST, "true");
  assert.equal(childEnv.AUTH_ACTION_DB_TEST_OPT_IN, undefined);
  assert.equal(childEnv.CERTIFICATION_HTTP_HOST, "127.0.0.1");
  assert.equal(childEnv.CERTIFICATION_HTTP_NONCE, "a".repeat(64));
}

const authEnvironment = buildCertificationEnvironment(inherited, {
  AUTH_ACTION_DB_TEST_OPT_IN: "1",
});
assert.equal(authEnvironment.AUTH_ACTION_DB_TEST_OPT_IN, "1");
assert.throws(
  () => buildCertificationEnvironment(inherited, { UNDECLARED_OPT_IN: "1" }),
  /Undeclared certification child environment override/,
);
const statelessEnvironment = buildCertificationEnvironment(inherited, {}, "stateless");
for (const key of [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "REDIS_URL",
  "SESSION_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "MERCHANT_DATA_ENCRYPTION_KEY",
  "ADMIN_SEED_EMAIL",
  "ADMIN_SEED_PASSWORD",
]) {
  assert.equal(statelessEnvironment[key], undefined, `stateless child must scrub ${key}`);
}

for (const [outerPath, childPath] of [
  [
    "scripts/run-guarded-canonical-migration.ts",
    "scripts/run-guarded-canonical-migration-child.ts",
  ],
  [
    "scripts/run-denied-certification-server.ts",
    "scripts/run-denied-certification-server-child.ts",
  ],
] as const) {
  const outer = readFileSync(outerPath, "utf8");
  const child = readFileSync(childPath, "utf8");
  assert.ok(outer.includes("spawnCertificationTsx("), `${outerPath} does not spawn a clean child`);
  assert.ok(
    outer.includes(childPath),
    `${outerPath} does not launch its expected clean child entry point`,
  );
  const denyIndex = child.indexOf("applyCertificationProviderDenyBoundary(");
  const applicationImportIndex = child.indexOf('await import("../server/');
  assert.ok(denyIndex >= 0, `${childPath} does not apply provider denial`);
  assert.ok(
    child.includes("fatal: true"),
    `${childPath} does not make blocked provider attempts immediately fatal`,
  );
  assert.ok(
    applicationImportIndex > denyIndex,
    `${childPath} imports application code before provider denial`,
  );
  if (childPath.includes("server-child")) {
    const dummyAiIndex = child.indexOf("installCertificationLocalAiConstructorEnvironment()");
    assert.ok(
      dummyAiIndex > denyIndex && dummyAiIndex < applicationImportIndex,
      `${childPath} does not install the fixed local-only AI constructor environment`,
    );
  }
}

const queueManager = readFileSync("server/services/queue-manager.ts", "utf8");
const childProcess = readFileSync("scripts/certification-child-process.ts", "utf8");
assert.ok(childProcess.includes("detached: process.platform !== \"win32\""));
assert.ok(childProcess.includes("terminateCertificationChild"));
assert.ok(childProcess.includes("-child.pid"));
assert.ok(
  queueManager.includes('process.env.VG_PROVIDER_DENY_MODE !== "1"'),
  "queue startup health sweep is not suppressed in certification deny mode",
);
const serverIndex = readFileSync("server/index.ts", "utf8");
assert.ok(
  serverIndex.includes('const certificationDenyMode = process.env.VG_PROVIDER_DENY_MODE === "1"'),
  "server does not derive its certification deny-mode startup gate",
);
for (const expectedLog of [
  "BullMQ workers disabled in provider deny mode",
  "GHL workflow hydration/live validation disabled in provider deny mode",
  "Daily maintenance scheduler disabled in provider deny mode",
  "Content scheduler disabled in provider deny mode",
]) {
  assert.ok(serverIndex.includes(expectedLog), `server certification gate missing: ${expectedLog}`);
}

console.log("Certification child-process environment allowlist passed for migration, integration, and server.");