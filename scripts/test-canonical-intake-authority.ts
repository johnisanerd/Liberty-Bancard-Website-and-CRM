#!/usr/bin/env npx tsx
/**
 * Deterministic BT-08 kill-line test. Kept source-backed so it runs without
 * provider credentials or a running server.
 */
import fs from "fs";
import path from "path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const failures: string[] = [];
const writer = read("server/services/contact-writer.ts");
const imports = read("server/routes/imports.ts");
const sync = read("server/services/ghl-sync.ts");
const execution = read("server/services/import-execution.ts");
const recovery = read("server/services/csv-import-recovery.ts");
const schema = read("shared/schema.ts");

for (const required of ["enqueueContactProjection", 'mode: "local_first"', "recordContactIdentityObservations", "contact_intake_matched"]) {
  if (!writer.includes(required)) failures.push(`contact writer missing ${required}`);
}
if (/mode:\s*"ghl_upsert_first"/.test(writer)) failures.push("contact writer still exposes provider-first mode");
if (/\b(?:create|update)ContactGhlFirst\b/.test(writer)) failures.push("contact writer still exposes a legacy GHL-first adapter");
if (!imports.includes("claimCsvExecution") || !imports.includes("recordImportRowDisposition")) {
  failures.push("CSV route is not wired to durable execution/ledger primitives");
}
if (!sync.includes("processPendingContactProviderProjections") || !sync.includes("processEligibleContactProjections")) failures.push("GHL sync does not process durable projection intents");
if (/insert\(contactProviderProjections\)/.test(writer)) failures.push("contact writer writes projection rows directly instead of using the projection authority");
if (writer.includes('from "./ghl-sync"') || writer.includes("syncContactToGhl(")) {
  failures.push("contact writer bypasses the claimed provider projection worker");
}
if (!execution.includes("IMPORT_EXECUTION_LEASE_LOST") || !execution.includes("claimToken")) {
  failures.push("import ledger is not fenced by the execution claim token");
}
if (!writer.includes("importClaimToken") || !writer.includes("IMPORT_EXECUTION_LEASE_LOST")) {
  failures.push("canonical contact writer is not fenced by the import lease");
}
if (!recovery.includes("csvImports.executionId") || !schema.includes('executionId: uuid("execution_id")')) {
  failures.push("CSV UI projection is not durably linked to its import execution");
}
if (!read("server/services/contact-field-authority.ts").includes("ContactProtectedFieldError")) {
  failures.push("protected field authority is absent");
}
if (failures.length) {
  console.error("Canonical intake authority gate failed:");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log("✓ Canonical local-first intake authority boundaries are present");