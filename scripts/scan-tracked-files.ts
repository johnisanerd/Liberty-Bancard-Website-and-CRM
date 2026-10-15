#!/usr/bin/env tsx
/**
 * scripts/scan-tracked-files.ts — Repository file-exposure gate (BT-01)
 *
 * Fails (exit 1) when `git ls-files` contains any prohibited path:
 *   - anything under backups/                          (reason: BACKUP_DIR)
 *   - *.sql.gz / *.gz / *.tgz                          (reason: COMPRESSED_DUMP)
 *   - *.dump / *.bak                                   (reason: DB_DUMP)
 *   - *.sql outside migrations/                        (reason: RAW_SQL_OUTSIDE_MIGRATIONS)
 *   - *.xlsx / *.xls                                   (reason: SPREADSHEET_EXPORT)
 *   - *.zip                                            (reason: ARCHIVE)
 *   - *.csv outside allowlisted skill/data dirs        (reason: CSV_EXPORT)
 *
 * Prints only file paths and reason codes — never file contents.
 * Deterministic: output is sorted; repeated runs on the same tree are identical.
 * Read-only: never deletes or modifies any file.
 *
 * Usage: npx tsx scripts/scan-tracked-files.ts [--dir <repoRoot>]
 */

import { execFileSync } from "child_process";
import fs from "fs";
import pathModule from "path";
import { fileURLToPath } from "url";
import { resolve } from "path";

// Directory prefixes whose CSV files are approved (static reference data or
// synthetic test fixtures, not exports). fixtures/ contains only synthetic
// records ("Reconcile Fixture Alpha LLC", 555 phones) used by import tests.
const CSV_ALLOWLIST_PREFIXES = [".agents/skills/ui-ux-pro-max/data/"];
const CSV_EXACT_ALLOWLIST = new Set([
  "fixtures/csv-import/outscraper_missing_emails.csv",
  "fixtures/csv-import/reconciliation_all_invalid.csv",
  "fixtures/csv-import/reconciliation_mixed.csv",
  // Reviewed public registry fixture snapshots used by the source-registry
  // import path; these are reference inputs, not runtime exports.
  "scripts/fixtures/source-registry/dbpr-hr.csv",
  "scripts/fixtures/source-registry/mdade-lbt.csv",
]);

// SQL is only allowed inside the migrations tree
const SQL_ALLOWLIST_PREFIXES = ["migrations/"];

// Reviewed source resources used by the canonical-native certification
// harness, not query results, dumps or operational exports. Pin their Git
// blobs: changing a resource or using the same name for a dump fails closed.
const REVIEWED_SQL_RESOURCES: Record<string, string> = {
  "docs/certification/canonical-enrichment-native-before.sql": "b6042155865a5db03a50fa984e35876a7c9553d5",
  "docs/certification/canonical-enrichment-native-console.sql": "883c4b565adced5fc8abc344b6c9876b164f6a48",
  "docs/certification/canonical-enrichment-native-verify.sql": "343395c0873e2e23ba5ea36d9a8c4e4f00c0d6e8",
};
export function isReviewedSqlResource(path: string, blobSha: string): boolean {
  const expected = REVIEWED_SQL_RESOURCES[normalizeRepoPath(path)];
  return expected !== undefined && expected === blobSha;
}

// Explicit approved file paths (reviewed individually — contain no PII/dump data)
const EXACT_ALLOWLIST = new Set([
  "exports/ghl-workflow-checklist.csv", // GHL setup checklist doc, not a data export
  "server/add-indexes.sql", // DDL index script, no data
]);

interface Finding {
  path: string;
  reason: string;
}

export interface PastedDebtManifest {
  version: 1;
  owner: string;
  expiresOn: string;
  expiryTimeZone: "America/New_York";
  baselinePathCount: number;
  entries: Array<{ path: string; blobSha: string }>;
}

export interface TrackedFile {
  path: string;
  blobSha: string;
}

export interface PastedDebtSummary {
  baselineCount: number;
  unchangedCount: number;
  removedCount: number;
  changedOrConflictingCount: number;
  newProhibitedCount: number;
  owner: string;
  expiry: string;
}

const PASTED_DEBT_MANIFEST_PATH = "scripts/tracked-pasted-text-debt-manifest.json";
const SHA1_RE = /^[0-9a-f]{40}$/;
const MANIFEST_KEYS = ["baselinePathCount", "entries", "expiresOn", "expiryTimeZone", "owner", "version"];

export function normalizeRepoPath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function isPastedTextPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  const lower = normalized.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  return lower.startsWith("attached_assets/") && basename.startsWith("pasted") && basename.endsWith(".txt");
}

export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

export function isRatchetExpired(expiresOn: string, today: string): boolean {
  return expiresOn <= today;
}

function listTrackedFiles(repoDir: string): TrackedFile[] {
  const raw = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: repoDir,
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
  return raw.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const metadata = record.slice(0, tab).split(/\s+/);
    return { path: normalizeRepoPath(record.slice(tab + 1)), blobSha: metadata[1] ?? "" };
  });
}

function loadPastedDebtManifest(repoDir: string): { manifest: PastedDebtManifest | null; valid: boolean } {
  const manifestPath = pathModule.join(repoDir, PASTED_DEBT_MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) return { manifest: null, valid: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<PastedDebtManifest>;
    const entries = parsed.entries;
    const valid =
      Object.keys(parsed).sort().join(",") === MANIFEST_KEYS.join(",") &&
      parsed.version === 1 &&
      typeof parsed.owner === "string" &&
      parsed.owner.length > 0 &&
      typeof parsed.expiresOn === "string" &&
      isValidDateOnly(parsed.expiresOn) &&
      parsed.expiryTimeZone === "America/New_York" &&
      Number.isInteger(parsed.baselinePathCount) &&
      Array.isArray(entries) &&
      entries.length === parsed.baselinePathCount &&
      entries.every((entry) =>
        entry &&
        Object.keys(entry).sort().join(",") === "blobSha,path" &&
        typeof entry.path === "string" &&
        entry.path === normalizeRepoPath(entry.path) &&
        /^attached_assets\/Pasted[^/]*\.txt$/.test(entry.path) &&
        typeof entry.blobSha === "string" &&
        SHA1_RE.test(entry.blobSha)
      ) &&
      new Set(entries.map((entry) => entry.path)).size === entries.length &&
      new Set(entries.map((entry) => `${entry.path}\0${entry.blobSha}`)).size === entries.length &&
      entries.every((entry, index) => index === 0 || entries[index - 1].path.localeCompare(entry.path) < 0);
    return { manifest: valid ? parsed as PastedDebtManifest : null, valid };
  } catch {
    return { manifest: null, valid: false };
  }
}

export function classify(path: string): string | null {
  const normalized = normalizeRepoPath(path);
  if (EXACT_ALLOWLIST.has(normalized)) return null;
  const lower = normalized.toLowerCase();
  if (lower.startsWith("uploads/statement-command/")) return "STATEMENT_COMMAND_RUNTIME_FILE";
  if (lower.startsWith("backups/") || lower.includes("/backups/")) return "BACKUP_DIR";
  if (lower.endsWith(".sql.gz")) return "COMPRESSED_DUMP";
  if (lower.endsWith(".gz") || lower.endsWith(".tgz")) return "COMPRESSED_DUMP";
  if (lower.endsWith(".dump") || lower.endsWith(".bak")) return "DB_DUMP";
  if (lower.endsWith(".sql")) {
    if (SQL_ALLOWLIST_PREFIXES.some((p) => lower.startsWith(p))) return null;
    return "RAW_SQL_OUTSIDE_MIGRATIONS";
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "SPREADSHEET_EXPORT";
  if (lower.endsWith(".zip")) return "ARCHIVE";
  if (lower.endsWith(".csv")) {
    if (CSV_EXACT_ALLOWLIST.has(normalized)) return null;
    if (CSV_ALLOWLIST_PREFIXES.some((p) => normalized.startsWith(p))) return null;
    return "CSV_EXPORT";
  }
  return null;
}

export function scanTree(repoDir: string): Finding[] {
  const files = listTrackedFiles(repoDir);
  const findings: Finding[] = [];
  const loaded = loadPastedDebtManifest(repoDir);
  const manifest = loaded.manifest;
  const trackedByPath = new Map(files.map((file) => [file.path, file]));
  const manifestByPath = new Map(manifest?.entries.map((entry) => [entry.path, entry]) ?? []);
  const manifestBySha = new Map<string, string[]>();
  for (const entry of manifest?.entries ?? []) {
    manifestBySha.set(entry.blobSha, [...(manifestBySha.get(entry.blobSha) ?? []), entry.path]);
  }

  let unchangedCount = 0;
  let removedCount = 0;
  let changedOrConflictingCount = 0;
  let newProhibitedCount = 0;

  if (!loaded.valid && files.some((file) => isPastedTextPath(file.path))) {
    findings.push({ path: PASTED_DEBT_MANIFEST_PATH, reason: "GENERATED_TEXT_DEBT_MANIFEST_INVALID" });
  }
  const expiry = manifest?.expiresOn ?? "";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: manifest?.expiryTimeZone ?? "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const expired = !!manifest && isRatchetExpired(expiry, today);
  if (expired) {
    findings.push({ path: PASTED_DEBT_MANIFEST_PATH, reason: "GENERATED_TEXT_DEBT_RATCHET_EXPIRED" });
  }

  for (const entry of manifest?.entries ?? []) {
    const tracked = trackedByPath.get(entry.path);
    if (!tracked) removedCount++;
    else if (tracked.blobSha === entry.blobSha) unchangedCount++;
    else changedOrConflictingCount++;
  }

  for (const file of files) {
    const reason = isReviewedSqlResource(file.path, file.blobSha) ? null : classify(file.path);
    if (reason) findings.push({ path: file.path, reason });

    const exactDebt = manifestByPath.get(file.path);
    const knownBlobAtOtherPath = (manifestBySha.get(file.blobSha) ?? []).some((p) => p !== file.path);
    if (exactDebt) {
      if (file.blobSha !== exactDebt.blobSha) {
        findings.push({ path: file.path, reason: "GENERATED_TEXT_DEBT_CHANGED" });
      }
    } else if (knownBlobAtOtherPath) {
      findings.push({ path: file.path, reason: "GENERATED_TEXT_DEBT_RELOCATED" });
      changedOrConflictingCount++;
    } else if (isPastedTextPath(file.path)) {
      findings.push({ path: file.path, reason: "GENERATED_TEXT_NEW_PROHIBITED" });
      newProhibitedCount++;
    }
  }

  if (manifest && manifest.entries.some((entry) => !trackedByPath.has(entry.path))) {
    findings.push({ path: PASTED_DEBT_MANIFEST_PATH, reason: "GENERATED_TEXT_DEBT_MANIFEST_MISSING_PATH" });
  }

  const summary: PastedDebtSummary | null = manifest ? {
    baselineCount: manifest.baselinePathCount,
    unchangedCount,
    removedCount,
    changedOrConflictingCount,
    newProhibitedCount,
    owner: manifest.owner,
    expiry: manifest.expiresOn,
  } : null;
  if (summary) lastPastedDebtSummary = summary;

  const unique = new Map(findings.map((finding) => [`${finding.reason}\0${finding.path}`, finding]));
  findings.length = 0;
  findings.push(...unique.values());
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  return findings;
}

let lastPastedDebtSummary: PastedDebtSummary | null = null;

export function getLastPastedDebtSummary(): PastedDebtSummary | null {
  return lastPastedDebtSummary;
}

function main() {
  const dirIdx = process.argv.indexOf("--dir");
  const repoDir = dirIdx !== -1 ? process.argv[dirIdx + 1] : process.cwd();

  const findings = scanTree(repoDir);
  const summary = getLastPastedDebtSummary();
  if (summary) {
    console.log(
      `pasted-text debt: baseline=${summary.baselineCount} unchanged=${summary.unchangedCount} ` +
      `removed=${summary.removedCount} changed_or_conflicting=${summary.changedOrConflictingCount} ` +
      `new_prohibited=${summary.newProhibitedCount} owner=${JSON.stringify(summary.owner)} expiry=${summary.expiry}`,
    );
  }

  if (findings.length === 0) {
    console.log("scan-tracked-files: PASS — no prohibited tracked files found");
    process.exit(0);
  }

  console.error(`scan-tracked-files: FAIL — ${findings.length} prohibited tracked file(s):`);
  for (const f of findings) {
    console.error(`  [${f.reason}] ${f.path}`);
  }
  console.error(
    "\nRemove with `git rm --cached <path>` and ensure the pattern is in .gitignore.",
  );
  process.exit(1);
}

// Run only when executed directly (exact entrypoint match; never on import)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
