#!/usr/bin/env tsx
/**
 * Deterministic regression coverage for repository artifact containment.
 * All integration fixtures are synthetic and live in disposable Git repositories.
 */

import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  classify,
  getLastPastedDebtSummary,
  isRatchetExpired,
  isValidDateOnly,
  normalizeRepoPath,
  scanTree,
  isReviewedSqlResource,
} from "./scan-tracked-files";

let pass = 0;
let fail = 0;

check("reviewed SQL source requires exact blob", isReviewedSqlResource(
  "docs/certification/canonical-enrichment-native-console.sql", "883c4b565adced5fc8abc344b6c9876b164f6a48"));
check("modified SQL source is prohibited", !isReviewedSqlResource(
  "docs/certification/canonical-enrichment-native-console.sql", "0000000000000000000000000000000000000000"));
check("same SQL blob at another path is prohibited", !isReviewedSqlResource(
  "exports/copied-console.sql", "883c4b565adced5fc8abc344b6c9876b164f6a48"));

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function initRepo(dir: string) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
}

function commitAll(dir: string, message: string) {
  execFileSync("git", ["add", "-A", "-f"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", message], { cwd: dir });
}

function writeFixture(dir: string, rel: string, content = "synthetic") {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function blobSha(dir: string, rel: string): string {
  return execFileSync("git", ["rev-parse", `:${rel}`], { cwd: dir, encoding: "utf8" }).trim();
}

function writeDebtManifest(dir: string, entries: Array<{ path: string; blobSha: string }>, expiresOn = "2099-12-31") {
  writeFixture(dir, "scripts/tracked-pasted-text-debt-manifest.json", JSON.stringify({
    version: 1,
    owner: "Synthetic Repository Owner",
    expiresOn,
    expiryTimeZone: "America/New_York",
    baselinePathCount: entries.length,
    entries: [...entries].sort((a, b) => a.path.localeCompare(b.path)),
  }, null, 2));
}

console.log("classify():");
check("statement command root blocked", classify("uploads/statement-command/x.pdf") === "STATEMENT_COMMAND_RUNTIME_FILE");
check("statement command nested path blocked", classify("uploads/statement-command/nested/x.pdf") === "STATEMENT_COMMAND_RUNTIME_FILE");
check("statement command casing blocked", classify("Uploads/Statement-Command/x.pdf") === "STATEMENT_COMMAND_RUNTIME_FILE");
check("statement command backslashes normalized", classify("uploads\\statement-command\\x.pdf") === "STATEMENT_COMMAND_RUNTIME_FILE");
check("dot segments normalized", normalizeRepoPath("uploads/./statement-command/x.pdf") === "uploads/statement-command/x.pdf");
check("backups dir blocked", classify("backups/db.sql.gz") === "BACKUP_DIR");
check("nested backups blocked", classify("data/backups/x.txt") === "BACKUP_DIR");
check("spreadsheet blocked", classify("attached_assets/leads.xlsx") === "SPREADSHEET_EXPORT");
check("archive blocked", classify("deep/archive.zip") === "ARCHIVE");
check("raw SQL blocked", classify("scripts/dump.sql") === "RAW_SQL_OUTSIDE_MIGRATIONS");
check("migration SQL allowed", classify("migrations/0001_init.sql") === null);
check("verified skill data CSV allowed", classify(".agents/skills/ui-ux-pro-max/data/colors.csv") === null);
check("adjacent agent CSV blocked", classify(".agents/skills/other/data.csv") === "CSV_EXPORT");
check("local CSV blocked", classify(".local/skills/demo/data.csv") === "CSV_EXPORT");
check("verified fixture allowed", classify("fixtures/csv-import/reconciliation_mixed.csv") === null);
check("other fixture CSV blocked", classify("fixtures/other/data.csv") === "CSV_EXPORT");
check("nested unverified fixture blocked", classify("fixtures/csv-import/nested/export.csv") === "CSV_EXPORT");
check("case-varied skill prefix blocked", classify(".AGENTS/skills/ui-ux-pro-max/data/colors.csv") === "CSV_EXPORT");
check("exact checklist allowed", classify("exports/ghl-workflow-checklist.csv") === null);
check("legitimate PDF allowed", classify("attached_assets/brand-guide.pdf") === null);
check("legitimate image allowed", classify("attached_assets/logo.png") === null);
check("calendar-valid expiry accepted", isValidDateOnly("2026-09-27"));
check("impossible expiry rejected", !isValidDateOnly("2026-02-30"));
check("ratchet fails on its expiry date", isRatchetExpired("2026-09-27", "2026-09-27"));

console.log("scanTree() forced-add behavior:");
const blockedRepo = mkdtempSync(join(tmpdir(), "scan-blocked-"));
try {
  initRepo(blockedRepo);
  const fixtures: Record<string, string> = {
    "server/index.ts": "// synthetic",
    "migrations/0001_init.sql": "-- synthetic",
    ".agents/skills/ui-ux-pro-max/data/ref.csv": "a,b",
    "fixtures/csv-import/reconciliation_mixed.csv": "a,b",
    "attached_assets/logo.png": "synthetic-image",
    "uploads/statement-command/nested/runtime.pdf": "synthetic-runtime",
    "attached_assets/Pasted-new-generated.txt": "synthetic-generated",
    "exports/renamed_export.csv": "a,b",
    "docs/certification/canonical-enrichment-native-console.sql": "-- unreviewed replacement",
  };
  for (const [rel, content] of Object.entries(fixtures)) writeFixture(blockedRepo, rel, content);
  commitAll(blockedRepo, "forced fixtures");

  const findings = scanTree(blockedRepo);
  const serialized = JSON.stringify(findings);
  check("forced-added statement file rejected", findings.some((f) =>
    f.path === "uploads/statement-command/nested/runtime.pdf" && f.reason === "STATEMENT_COMMAND_RUNTIME_FILE"));
  check("new pasted text rejected without policy", findings.some((f) =>
    f.path === "attached_assets/Pasted-new-generated.txt" && f.reason === "GENERATED_TEXT_NEW_PROHIBITED"));
  check("missing ratchet policy fails closed", findings.some((f) =>
    f.reason === "GENERATED_TEXT_DEBT_MANIFEST_INVALID"));
  check("unapproved CSV rejected", findings.some((f) => f.reason === "CSV_EXPORT"));
  check("diagnostics contain no fixture content", !serialized.includes("synthetic-runtime") && !serialized.includes("synthetic-generated"));
  check("findings are deterministic", JSON.stringify(scanTree(blockedRepo)) === serialized);

  const scanner = join(process.cwd(), "scripts/scan-tracked-files.ts");
  const blockedCli = spawnSync("npx", ["tsx", scanner, "--dir", blockedRepo], { encoding: "utf8" });
  const blockedOutput = `${blockedCli.stdout}\n${blockedCli.stderr}`;
  check("blocked CLI exits exactly 1", blockedCli.status === 1 && blockedCli.signal === null);
  check("blocked CLI proves expected path and reason",
    blockedOutput.includes("[STATEMENT_COMMAND_RUNTIME_FILE] uploads/statement-command/nested/runtime.pdf"));
  check("blocked CLI is not a launcher/runtime failure",
    !/ERR_MODULE_NOT_FOUND|Cannot find module|npm ERR!|SyntaxError|TypeError:|ReferenceError:/.test(blockedOutput));
} finally {
  rmSync(blockedRepo, { recursive: true, force: true });
}

console.log("bounded pasted-text ratchet:");
const debtRepo = mkdtempSync(join(tmpdir(), "scan-debt-"));
try {
  initRepo(debtRepo);
  const debtPath = "attached_assets/Pasted-grandfathered.txt";
  writeFixture(debtRepo, debtPath, "synthetic-debt-v1");
  commitAll(debtRepo, "baseline debt");
  const sha = blobSha(debtRepo, debtPath);
  writeDebtManifest(debtRepo, [{ path: debtPath, blobSha: sha }]);
  commitAll(debtRepo, "ratchet manifest");

  check("exact unchanged path and blob pair accepted", scanTree(debtRepo).length === 0);
  check("unchanged summary reconciles", getLastPastedDebtSummary()?.unchangedCount === 1);

  writeFixture(debtRepo, debtPath, "synthetic-debt-v2");
  commitAll(debtRepo, "changed debt");
  check("content change rejected by blob identity", scanTree(debtRepo).some((f) =>
    f.path === debtPath && f.reason === "GENERATED_TEXT_DEBT_CHANGED"));

  execFileSync("git", ["reset", "--hard", "HEAD^"], { cwd: debtRepo, stdio: "ignore" });
  mkdirSync(join(debtRepo, "docs"), { recursive: true });
  execFileSync("git", ["mv", debtPath, "docs/Pasted-grandfathered.txt"], { cwd: debtRepo });
  commitAll(debtRepo, "moved debt");
  const movedFindings = scanTree(debtRepo);
  check("renamed known blob rejected", movedFindings.some((f) =>
    f.path === "docs/Pasted-grandfathered.txt" && f.reason === "GENERATED_TEXT_DEBT_RELOCATED"));
  check("missing original path fails closed", movedFindings.some((f) =>
    f.reason === "GENERATED_TEXT_DEBT_MANIFEST_MISSING_PATH"));

  writeFixture(debtRepo, "attached_assets/nested/pAsTeD-copy.TxT", "synthetic-copy");
  commitAll(debtRepo, "case nested copy");
  check("nested case-varied generated text rejected", scanTree(debtRepo).some((f) =>
    f.path === "attached_assets/nested/pAsTeD-copy.TxT" && f.reason === "GENERATED_TEXT_NEW_PROHIBITED"));

  writeDebtManifest(debtRepo, [{ path: debtPath, blobSha: sha }], "2000-01-01");
  commitAll(debtRepo, "expired manifest");
  check("expired ratchet fails closed", scanTree(debtRepo).some((f) =>
    f.reason === "GENERATED_TEXT_DEBT_RATCHET_EXPIRED"));

  writeFixture(debtRepo, "scripts/tracked-pasted-text-debt-manifest.json", "{malformed");
  commitAll(debtRepo, "malformed manifest");
  check("malformed manifest fails closed", scanTree(debtRepo).some((f) =>
    f.reason === "GENERATED_TEXT_DEBT_MANIFEST_INVALID"));

  writeDebtManifest(debtRepo, [{ path: debtPath, blobSha: sha }], "2099-02-30");
  commitAll(debtRepo, "calendar-invalid manifest");
  check("calendar-invalid expiry fails closed", scanTree(debtRepo).some((f) =>
    f.reason === "GENERATED_TEXT_DEBT_MANIFEST_INVALID"));
} finally {
  rmSync(debtRepo, { recursive: true, force: true });
}

console.log("repository manifest metadata:");
const manifest = JSON.parse(readFileSync(join(process.cwd(), "scripts/tracked-pasted-text-debt-manifest.json"), "utf8"));
check("authorized baseline contains exactly the currently tracked pairs", manifest.baselinePathCount === 0 && manifest.entries.length === 0);
check("authorized owner recorded", manifest.owner === "Repository Owner");
check("authorized expiry recorded", manifest.expiresOn === "2026-12-31");
check("owner timezone recorded", manifest.expiryTimeZone === "America/New_York");
check("manifest entries are exact path plus SHA only", manifest.entries.every((entry: Record<string, unknown>) =>
  Object.keys(entry).sort().join(",") === "blobSha,path" &&
  typeof entry.path === "string" &&
  typeof entry.blobSha === "string"));
scanTree(process.cwd());
const liveSummary = getLastPastedDebtSummary();
check("live authorized baseline remains unchanged",
  liveSummary?.baselineCount === 0 &&
  liveSummary?.unchangedCount === 0 &&
  liveSummary?.removedCount === 0);
check("live post-baseline pasted additions remain prohibited", liveSummary?.newProhibitedCount === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
