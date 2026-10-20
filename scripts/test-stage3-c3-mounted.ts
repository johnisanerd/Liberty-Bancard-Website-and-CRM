import { spawnSync } from "node:child_process";

// Mounted-component behavior for C3 with injected fetch (jsdom). It exercises real component code,
// URL state, abort-signal wiring and state branches, but not real sessions, handlers or a database.
const suites: Array<{ file: string; marker: string }> = [
  { file: "client/src/pages/dashboard/UploadLedger.test.tsx", marker: "UPLOAD_LEDGER_UI_PASS" },
  { file: "client/src/pages/dashboard/CanonicalBacklog.test.tsx", marker: "CANONICAL_BACKLOG_UI_PASS" },
  { file: "client/src/pages/dashboard/LeadImports.test.tsx", marker: "LEAD_IMPORTS_WIZARD_UI_PASS" },
];
let failed = false;
for (const suite of suites) {
  const run = spawnSync("npx", ["tsx", suite.file], { encoding: "utf8", timeout: 180_000 });
  const ok = run.status === 0 && run.stdout.includes(suite.marker);
  console.log(`${ok ? "PASS" : "FAIL"} ${suite.file}`);
  if (!ok) { failed = true; console.error(run.stdout.slice(-1500), run.stderr.slice(-1500)); }
}
if (failed) process.exit(1);
console.log("Stage 3 C3 mounted component behavior: all suites passed (injected fetch; no sessions, DB or providers).");
