import { spawnSync } from "node:child_process";

// Mounted GHL Integration Hub -> GHL Settings behavior (jsdom, injected fetch). It reproduces no
// live stall and claims no cause; it proves mounting is write-free and bounded in the modelled states.
const suites = [{ file: "client/src/pages/dashboard/GhlSettings.test.tsx", marker: "GHL_SETTINGS_MOUNTED_PASS" }];
let failed = false;
for (const suite of suites) {
  const run = spawnSync("npx", ["tsx", suite.file], { encoding: "utf8", timeout: 240_000 });
  const ok = run.status === 0 && run.stdout.includes(suite.marker);
  console.log(`${ok ? "PASS" : "FAIL"} ${suite.file}`);
  if (!ok) { failed = true; console.error(run.stdout.slice(-1500), run.stderr.slice(-1500)); }
}
if (failed) process.exit(1);
console.log("Stage 3 C5 mounted component behavior: passed (injected fetch; no sessions, DB or providers).");
