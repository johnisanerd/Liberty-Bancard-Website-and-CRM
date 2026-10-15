#!/usr/bin/env tsx
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renameSync, writeFileSync } from "node:fs";
import { applyCertificationProviderDenyBoundary } from "./certification-provider-deny";
import { replaceWithCertificationEnvironment } from "./certification-process-env";

const suitePath = process.argv[2];
const capability = process.argv[3];
const receiptPath = process.env.CERTIFICATION_RECEIPT_PATH;
const runId = process.env.CERTIFICATION_RUN_ID;
const suiteId = process.env.CERTIFICATION_SUITE_ID;
let assertionEvidence = 0;
let receiptWritten = false;
for (const method of ["log", "info"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    assertionEvidence += text.match(/(?:✓|\bPASS\b|\bpassed\b)/gi)?.length ?? 0;
    original(...args);
  };
}
function writeTerminalReceipt(): void {
  if (receiptWritten) return;
  if (!receiptPath || !runId || !suiteId || assertionEvidence < 1) {
    process.exitCode = 65;
    return;
  }
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      version: 1,
      runId,
      suiteId,
      outcome: "executed_pass",
      evidenceSource: "suite-process-terminal",
      coreAssertions: assertionEvidence,
      fixtureGroups: capability === "deterministic-integration" || capability === "server-required" ? 1 : 0,
      cleanup: "complete",
    })}\n`,
    { mode: 0o600 },
  );
  renameSync(temporaryPath, receiptPath);
  receiptWritten = true;
}
process.once("beforeExit", writeTerminalReceipt);
const originalExit = process.exit.bind(process);
process.exit = ((code?: number | string | null) => {
  const normalized = code == null ? (process.exitCode ?? 0) : Number(code);
  if (normalized === 0) writeTerminalReceipt();
  return originalExit(normalized);
}) as typeof process.exit;
if (!suitePath || !/^(?:scripts|server\/tests)\/[A-Za-z0-9._/-]+\.(?:ts|mjs)$/.test(suitePath)) {
  throw new Error("A certification suite path under scripts/ or server/tests/ must end in .ts or .mjs.");
}
if (
  !["deterministic-static", "deterministic-integration", "server-required", "external-security", "writable-build"].includes(
    capability ?? "",
  )
) {
  throw new Error("A recognized certification suite capability is required.");
}

if (capability === "deterministic-integration" || capability === "server-required") {
  const { assertDisposableTestInfrastructure } = await import("./test-infrastructure-guard");
  await assertDisposableTestInfrastructure({
    operation: `Certification suite ${capability}`,
    requireRedis: true,
  });
}
replaceWithCertificationEnvironment();
  const externalSecurity = capability === "external-security";
  if (!externalSecurity) applyCertificationProviderDenyBoundary({ fatal: true });
  const absoluteSuitePath = path.resolve(process.cwd(), suitePath);
  const { SUITE_MANIFEST } = await import("./ci-suite-manifest");
  const registration = SUITE_MANIFEST.find(suite => suite.script === suitePath && suite.capability === capability);
  if (registration?.isolateInfrastructure) {
    if(capability!=="deterministic-integration")
      throw new Error("Private fixture isolation is only valid for deterministic integration suites");
    const {spawnCertificationTsx,terminateCertificationChild}=await import("./certification-child-process");
    await new Promise<void>((resolve,reject)=>{
      const child=spawnCertificationTsx("scripts/run-sfp2060-predeploy-disposable.ts",["--only",suitePath],{stdio:"pipe"});
      child.stdout?.on("data",chunk=>console.log(String(chunk)));
      child.stderr?.on("data",chunk=>console.error(String(chunk)));
      child.once("error",reject);
      child.once("exit",(code,signal)=>{
        if(code===0&&!signal)resolve();
        else reject(new Error(`Owned private suite failed: exit=${code}; signal=${signal??"none"}`));
      });
      process.once("SIGTERM",()=>{void terminateCertificationChild(child).finally(()=>process.exit(143));});
    });
  } else {
    process.argv = [process.argv[0], absoluteSuitePath, ...process.argv.slice(4)];
    await import(pathToFileURL(absoluteSuitePath).href);
  }
  const { getBlockedCertificationNetworkAttemptCount } = await import("./certification-provider-deny");
  if (!externalSecurity && getBlockedCertificationNetworkAttemptCount() !== 0) {
    throw new Error("Certification suite attempted a blocked external-provider request.");
  }
