#!/usr/bin/env tsx
/**
 * Task #752 — CSV Import Reconciliation Smoke Test
 *
 * Verifies that `/api/leads/import-csv` never drops rows invisibly:
 *
 *   totalRows === createdCount + duplicateCount + invalidCount + skippedCount + errorCount
 *
 * Scenarios covered:
 *  1. Generic mixed and all-invalid files stay custom and reconcile durably.
 *  2. Same content replays the original execution without duplicate effects.
 *  3. Common provider-overlap headers remain custom.
 *  4. Provider exports are admitted asynchronously, then reconcile their actual durable outcomes.
 *  5. Case, space, underscore, and hyphen normalization is deterministic.
 *
 * Run with the dev server up:
 *   BASE_URL=http://localhost:5000 npx tsx scripts/test-import-reconciliation.ts
 *
 * Requires a logged-in-capable test user. Prefers TEST_USER_* (or the dedicated
 * Playwright test user seeded by scripts/create-test-user.ts). On a fresh
 * disposable database where that user does not exist yet, it retries with the
 * ADMIN_SEED_* account that application startup has just created.
 *
 * Exits 0 if all assertions pass, 1 if any fail.
 */

import fs from "fs";
import path from "path";
import { classifyCsvSourceFormat } from "../server/services/import-normalizer";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? "playwright-test@libertybancard.internal";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? "PlaywrightTest2024!";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.error(`  \u2717 ${message}`);
  }
}

function extractCookie(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
}

async function login(): Promise<string> {
  async function attempt(email: string, password: string) {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return { res, body: res.ok ? "" : await res.text() };
  }

  let attemptResult = await attempt(TEST_EMAIL, TEST_PASSWORD);
  if (
    !attemptResult.res.ok &&
    process.env.ADMIN_SEED_EMAIL &&
    process.env.ADMIN_SEED_PASSWORD
  ) {
    attemptResult = await attempt(
      process.env.ADMIN_SEED_EMAIL,
      process.env.ADMIN_SEED_PASSWORD,
    );
  }

  if (!attemptResult.res.ok) {
    throw new Error(
      `Login failed: ${attemptResult.res.status} ${attemptResult.body}`,
    );
  }
  const setCookie = attemptResult.res.headers.getSetCookie?.() ?? [];
  return extractCookie(setCookie);
}

async function getCsrfToken(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/csrf-token`, {
    headers: { Cookie: cookie },
  });
  const data = await res.json();
  return data.token;
}

async function uploadCsv(cookie: string, csrf: string, filePath: string): Promise<any> {
  const fileBuffer = fs.readFileSync(filePath);
  return uploadCsvContent(cookie, csrf, fileBuffer, path.basename(filePath));
}

async function uploadCsvContent(
  cookie: string,
  csrf: string,
  content: Buffer | string,
  fileName: string,
): Promise<any> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/csv" }), fileName);

  const res = await fetch(`${BASE_URL}/api/leads/import-csv`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "x-csrf-token": csrf,
    },
    body: form,
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function findContacts(cookie: string, search: string): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/contacts?limit=50&search=${encodeURIComponent(search)}`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) throw new Error(`Contact lookup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body?.contacts ?? []);
}

function assertReconciled(label: string, body: any) {
  const { inserted = 0, duplicatesSkipped = 0, invalidRows = 0, skippedRows = 0, errors = 0 } = body;
  const totalRows = body.import?.totalRows;
  const reconciledTotal = inserted + duplicatesSkipped + invalidRows + skippedRows + errors;
  const dispositions = ["created", "matched_noop", "updated", "rejected", "deferred", "failed"];
  assert(
    typeof totalRows === "number",
    `${label}: response includes import.totalRows (got ${totalRows})`,
  );
  assert(
    reconciledTotal === totalRows,
    `${label}: totalRows(${totalRows}) === created(${inserted}) + duplicates(${duplicatesSkipped}) + invalid(${invalidRows}) + skipped(${skippedRows}) + errors(${errors}) = ${reconciledTotal}`,
  );
  assert(
    typeof body.invalidRows === "number" && typeof body.skippedRows === "number",
    `${label}: response JSON exposes both invalidRows and skippedRows fields`,
  );
  assert(
    dispositions.every((disposition) => typeof body.counts?.[disposition] === "number"),
    `${label}: response exposes all six durable disposition counts`,
  );
  assert(
    dispositions.reduce((total, disposition) => total + Number(body.counts?.[disposition] ?? 0), 0) === totalRows,
    `${label}: durable disposition counts reconcile to totalRows`,
  );
  if (!body.replayed) {
    assert(
      typeof body.import?.invalidRows === "number" && typeof body.import?.skippedRows === "number",
      `${label}: persisted csv_imports record has invalidRows and skippedRows columns populated`,
    );
    assert(
      body.import?.newRecords === body.counts.created &&
        body.import?.updatedRecords === body.counts.updated &&
        body.import?.duplicatesSkipped === body.counts.matched_noop &&
        body.import?.invalidRows === body.counts.rejected &&
        body.import?.skippedRows === body.counts.deferred &&
        body.import?.errorsCount === body.counts.failed,
      `${label}: csv_imports projection agrees with the immutable ledger summary`,
    );
  }
}

function assertCompletedProgress(label: string, body: any) {
  assert(
    body.import?.processedRows === body.import?.totalRows,
    `${label}: processedRows equals totalRows (${body.import?.processedRows}/${body.import?.totalRows})`,
  );
  assert(
    body.import?.completedAt !== null && body.import?.completedAt !== undefined,
    `${label}: import has completedAt populated`,
  );
  assert(
    body.import?.lastProgressAt !== null && body.import?.lastProgressAt !== undefined,
    `${label}: import has lastProgressAt populated`,
  );
}

async function assertAsyncImport(label: string, response: any, cookie: string, expectedRows: number) {
  assert(response.status === 202, `${label}: asynchronous admission returns HTTP 202 (got ${response.status})`);
  assert(response.body.status === "processing", `${label}: admission does not claim completion`);
  assert(response.body.executionId === response.body.import?.executionId,
    `${label}: admission identifies the exact durable execution`);
  assert(/^[a-f0-9]{64}$/.test(response.body.fileHash ?? ""),
    `${label}: admission preserves the original file hash`);
  assert(response.body.totalRows === expectedRows, `${label}: source denominator is retained`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const read = await fetch(`${BASE_URL}/api/csv-imports/${response.body.import.id}`, {
      headers: { Cookie: cookie },
    });
    if (!read.ok) throw new Error(`${label}: durable read failed with HTTP ${read.status}`);
    const record = await read.json();
    assert(record.executionId === response.body.executionId, `${label}: reader stays on the admitted execution`);
    if (record.status === "failed") throw new Error(`${label}: admitted execution failed`);
    if (record.status === "completed") {
      const completed = {
        import: record, counts: record.dispositionCounts,
        inserted: record.newRecords, duplicatesSkipped: record.duplicatesSkipped,
        invalidRows: record.invalidRows, skippedRows: record.skippedRows,
        errors: record.errorsCount,
      };
      assertReconciled(label, completed);
      assertCompletedProgress(label, completed);
      assert(record.recovery?.pendingFulfillmentRows === 0,
        `${label}: completion has no pending mailbox fulfillment`);
      return record;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: durable completion was not observed within the bounded test budget`);
}

async function main() {
  console.log(`\nCSV Import Reconciliation Smoke Test (against ${BASE_URL})\n`);

  const cookie = await login();
  const csrf = await getCsrfToken(cookie);

  console.log("Scenario 1: mixed file, first upload (2 new + 1 blank-invalid + 1 missing-contact-invalid + 1 new)");
  const mixedPath = path.join(process.cwd(), "fixtures/csv-import/reconciliation_mixed.csv");
  const mixedRunId = Date.now().toString(36);
  const phoneSeed = String(Date.now()).slice(-6);
  const mixedContent = fs.readFileSync(mixedPath, "utf8")
    .replaceAll("Reconcile Fixture", `Reconcile ${mixedRunId} Fixture`)
    .replaceAll("alpha@reconcilefixture.com", `alpha-${mixedRunId}@reconcilefixture.com`)
    .replaceAll("beta@reconcilefixture.com", `beta-${mixedRunId}@reconcilefixture.com`)
    .replaceAll("delta@reconcilefixture.com", `delta-${mixedRunId}@reconcilefixture.com`)
    .replace("(305) 555-0201", `305${phoneSeed}1`)
    .replace("(305) 555-0202", `305${phoneSeed}2`)
    .replace("(305) 555-0204", `305${phoneSeed}4`);
  const first = await uploadCsvContent(cookie, csrf, mixedContent, path.basename(mixedPath));
  assert(first.status === 201, `Scenario 1: HTTP 201 (got ${first.status})`);
  assertReconciled("Scenario 1", first.body);
  assert(first.body.sourceFormat === "custom", `Scenario 1: ordinary headers remain custom (got ${first.body.sourceFormat})`);
  assert(first.body.inserted > 0, `Scenario 1: generic valid rows reach canonical contact intake (got ${first.body.inserted})`);
  assert(first.body.invalidRows >= 1, `Scenario 1: at least 1 invalid row detected (got ${first.body.invalidRows})`);
  assertCompletedProgress("Scenario 1", first.body);

  console.log("\nScenario 2: same mixed file uploaded again (replays the original durable execution)");
  const second = await uploadCsvContent(cookie, csrf, mixedContent, path.basename(mixedPath));
  assert(second.status === 200, `Scenario 2: HTTP 200 replay (got ${second.status})`);
  assert(second.body.replayed === true, "Scenario 2: response marks execution as replayed");
  assertReconciled("Scenario 2", second.body);
  assert(
    second.body.inserted === first.body.inserted,
    `Scenario 2: replay returns original created count without writing contacts (got ${second.body.inserted})`,
  );
  assert(
    second.body.execution?.id === first.body.import?.executionId,
    "Scenario 2: replay returns the original durable execution identity",
  );

  console.log("\nScenario 3: all-invalid file (every row invalid, zero created)");
  const invalidPath = path.join(process.cwd(), "fixtures/csv-import/reconciliation_all_invalid.csv");
  const invalidContent = `${fs.readFileSync(invalidPath, "utf8")}${"\n".repeat((Date.now() % 991) + 2)}`;
  const third = await uploadCsvContent(cookie, csrf, invalidContent, path.basename(invalidPath));
  assert(third.status === 201, `Scenario 3: HTTP 201 (got ${third.status})`);
  assertReconciled("Scenario 3", third.body);
  assert(third.body.inserted === 0, `Scenario 3: zero inserts (got ${third.body.inserted})`);
  assert(
    third.body.invalidRows === third.body.import?.totalRows,
    `Scenario 3: all rows counted invalid (invalidRows=${third.body.invalidRows}, totalRows=${third.body.import?.totalRows})`,
  );
  assert(third.body.sourceFormat === "custom", `Scenario 3: invalid generic headers remain custom (got ${third.body.sourceFormat})`);
  assertCompletedProgress("Scenario 3", third.body);

  console.log(
     "\nScenario 4: Outscraper business-only input is admitted and reconciled asynchronously",
  );
  // Generated fresh (unique company names + phone numbers) on every run so
  // this scenario is idempotent regardless of leftover data from prior runs.
  const runId = Date.now().toString(36);
  const outscraperCsv = [
    "Name,Telephone,Category,Rating,Review_Count,Address,Website,City,State",
    `Zzq ${runId} Auto Repair,(305) 555-9${runId.slice(-3)}1,Auto Repair,4.6,42,300 Sunshine Blvd,,Miami,FL`,
    `Zzq ${runId} Nail Spa,(305) 555-9${runId.slice(-3)}2,Salon/Spa,4.4,58,301 Coastal Way,,Miami,FL`,
    `Zzq ${runId} Family Dental,(305) 555-9${runId.slice(-3)}3,Healthcare,4.8,31,302 Downtown St,,Miami,FL`,
    `Zzq ${runId} Pizza Co,(305) 555-9${runId.slice(-3)}4,Restaurant,4.2,120,303 Palm Tree Ave,,Miami,FL`,
    "",
  ].join("\n");
  const fourth = await uploadCsvContent(cookie, csrf, outscraperCsv, `outscraper_missing_emails_${runId}.csv`);
   await assertAsyncImport("Scenario 4", fourth, cookie, 4);
  assert(
    fourth.body.sourceFormat === "google_maps_outscraper",
    `Scenario 4: distinctive Outscraper headers are recognized (got ${fourth.body.sourceFormat})`,
  );
  const outscraperContacts = await findContacts(cookie, `Zzq ${runId}`);
  assert(outscraperContacts.length === 0, `Scenario 4: provider rows created no contacts (found ${outscraperContacts.length})`);

  console.log(
    "\nScenario 5: common headers alone stay custom",
  );
  const ambiguousRunId = Date.now().toString(36);
  const ambiguousCsv = [
    "Name,Phone,Email,Company,Title,Industry",
    `Zzq ${ambiguousRunId} Ambiguous,(305) 555-8${String(Date.now()).slice(-3)}1,ambiguous-${ambiguousRunId}@example.com,Generic ${ambiguousRunId} Co,Owner,Services`,
    "",
  ].join("\n");
  const ambiguous = await uploadCsvContent(cookie, csrf, ambiguousCsv, "ambiguous_common_headers.csv");
  assert(ambiguous.status === 201, `Scenario 5: HTTP 201 (got ${ambiguous.status})`);
  assertReconciled("Scenario 5", ambiguous.body);
  assert(ambiguous.body.sourceFormat === "custom", `Scenario 5: common overlap headers remain custom (got ${ambiguous.body.sourceFormat})`);
  assert(ambiguous.body.inserted === 1, `Scenario 5: ambiguous row reaches canonical intake (got inserted=${ambiguous.body.inserted})`);
  assertCompletedProgress("Scenario 5", ambiguous.body);

  console.log(
     "\nScenario 6: Outscraper business-only input retains its provenance URL",
  );
  // An Outscraper CSV with a `source` column containing a provenance URL.
  // A recognized provider row must not create a contact or inherit the source
  // column as a lead source.
  const runId5 = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}5`;
  const outscraperWithSourceCsv = [
    "Name,Telephone,Category,Rating,Review_Count,Address,Website,City,State,source",
    `Zzq ${runId5} Source Test,(305) 555-9${runId5.slice(-3)}1,Auto Repair,4.6,42,300 Sunshine Blvd,,Miami,FL,https://www.google.com/maps/place/?q=place_id:ChIJXXX`,
    "",
  ].join("\n");
  const fifth = await uploadCsvContent(cookie, csrf, outscraperWithSourceCsv, `outscraper_source_col_${runId5}.csv`);
   await assertAsyncImport("Scenario 6", fifth, cookie, 1);
  assert(
    fifth.body.sourceFormat === "google_maps_outscraper",
    `Scenario 6: sourceFormat detected as google_maps_outscraper (got ${fifth.body.sourceFormat})`,
  );
  const outscraperSourceContacts = await findContacts(cookie, `Zzq ${runId5}`);
  assert(outscraperSourceContacts.length === 0, `Scenario 6: provider row created no contact (found ${outscraperSourceContacts.length})`);

  console.log(
     "\nScenario 7: Apollo input reconciles its current native outcome asynchronously",
  );
  const runId6 = Date.now().toString(36) + "6";
  const apolloCsv = [
    "First Name,Last Name,Title,Company,Email,Person LinkedIn URL,Industry",
    `Apolly ${runId6},Lead,Owner,Apollo Fixture ${runId6},apollo-${runId6}@example.com,https://www.linkedin.com/in/${runId6},Payments`,
    "",
  ].join("\n");
  const apollo = await uploadCsvContent(cookie, csrf, apolloCsv, `apollo_export_${runId6}.csv`);
   const apolloRecord = await assertAsyncImport("Scenario 7", apollo, cookie, 1);
  assert(
    apollo.body.sourceFormat === "apollo_lead_list",
    `Scenario 7: Apollo signature is recognized (got ${apollo.body.sourceFormat})`,
  );
  const apolloContacts = await findContacts(cookie, `Apolly ${runId6}`);
   assert(apolloContacts.length === apolloRecord.newRecords,
     `Scenario 7: actual contact creation agrees with the durable native outcome`);

  console.log(
    "\nScenario 8: normalized provider headers still classify consistently",
  );
  assert(
    classifyCsvSourceFormat([" NAME ", "telephone", "CATEGORY", "Rating"]) === "google_maps_outscraper",
    "Scenario 8: Outscraper signature is case/space insensitive",
  );
  assert(
    classifyCsvSourceFormat(["First_Name", "Last Name", "Person-LinkedIn-URL"]) === "apollo_lead_list",
    "Scenario 8: Apollo signature is case/underscore/hyphen insensitive",
  );
  assert(
    classifyCsvSourceFormat(["Name", "Phone", "Email"]) === "custom",
    "Scenario 8: one common overlap set remains custom",
  );
  assert(
    classifyCsvSourceFormat(["Email", "Company", "Title", "Industry"]) === "custom",
    "Scenario 8: common Apollo-like headers remain custom",
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
