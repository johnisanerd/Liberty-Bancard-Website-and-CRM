import assert from "node:assert/strict";
import {
  CONTACT_LINK_COVERAGE_BATCH_SQL,
  CONTACT_LINK_COVERAGE_PROCESSING_PAGE_SIZE,
  CONTACT_LINK_COVERAGE_WORKFLOW,
  initializeContactLinkCoverageRun,
  processContactLinkCoveragePage,
  emptyContactLinkCoverageCounts,
  type ContactLinkCoverageState,
} from "../services/contact-link-coverage";
import { CONTACT_LINK_COVERAGE_WATERMARK_SQL } from "../services/contact-link-coverage-query";

type QueryCall = { sql: string; params: any[] };

class FakeQueryClient {
  calls: QueryCall[] = [];
  checkpoints: ContactLinkCoverageState[] = [];
  priorCheckpoint: ContactLinkCoverageState | null = null;
  watermark = 0;
  total = 0;
  pages: any[][] = [];
  failBatchWith: Error | null = null;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    this.calls.push({ sql, params });
    const normalized = sql.trim();

    if (normalized.startsWith("SELECT details FROM audit_logs")) {
      return {
        rows: this.priorCheckpoint
          ? [{ details: JSON.stringify(this.priorCheckpoint) }]
          : [],
      };
    }
    if (sql === CONTACT_LINK_COVERAGE_WATERMARK_SQL) {
      return { rows: [{ watermark: this.watermark, total: this.total }] };
    }
    if (normalized === "SET LOCAL jit = off") return { rows: [] };
    if (sql === CONTACT_LINK_COVERAGE_BATCH_SQL) {
      if (this.failBatchWith) throw this.failBatchWith;
      assert.equal(params[2], CONTACT_LINK_COVERAGE_PROCESSING_PAGE_SIZE,
        "batch query should use the processing page limit");
      return { rows: this.pages.shift() ?? [] };
    }
    if (normalized.startsWith("INSERT INTO audit_logs")) {
      this.checkpoints.push(JSON.parse(params[3]));
      return { rows: [] };
    }
    throw new Error(`Unexpected fake query: ${normalized.slice(0, 80)}`);
  }

  lastCheckpoint(): ContactLinkCoverageState | null {
    return this.checkpoints.at(-1) ?? null;
  }
}

function priorState(overrides: Partial<ContactLinkCoverageState> = {}): ContactLinkCoverageState {
  return {
    workflow: CONTACT_LINK_COVERAGE_WORKFLOW,
    runId: "prior-run",
    status: "ready",
    watermark: 20,
    cursor: 5,
    total: 3,
    processed: 1,
    counts: { ...emptyContactLinkCoverageCounts(), REVIEW: 1 },
    reasonCounts: { prior_reason: 1 },
    complete: false,
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function contactRow(contactId: number) {
  return {
    contactId,
    companyName: "Example Dental",
    emailDomain: "example-dental.invalid",
    emailHasExactlyOneAt: true,
    website: "https://example-dental.invalid",
    rowProvenance: {},
    recordClass: "production",
    emailStatus: "unvalidated",
    archived: false,
    existingMerchantCustomer: false,
    doNotContact: false,
    doNotAutoContact: false,
    optedOutEmail: false,
    optOutStatus: "active",
    unsubscribeStatus: "active",
    bounceStatus: "none",
    complaintStatus: "none",
    sourceEvents: [],
    businesses: [],
    rawSunbizCandidates: [],
  };
}

async function testInitializerFreezesScopeWithoutProcessing() {
  const client = new FakeQueryClient();
  client.watermark = 900;
  client.total = 17;

  const state = await initializeContactLinkCoverageRun(client, "operator-1");
  assert.equal(state.status, "ready");
  assert.equal(state.watermark, 900);
  assert.equal(state.total, 17);
  assert.equal(state.cursor, 0);
  assert.equal(state.processed, 0);
  assert.equal(client.calls.filter(call => call.sql === CONTACT_LINK_COVERAGE_WATERMARK_SQL).length, 1);
  assert.equal(client.calls.filter(call => call.sql === CONTACT_LINK_COVERAGE_BATCH_SQL).length, 0,
    "initialization must not process the first page");
  assert.deepEqual(client.lastCheckpoint(), state);

  const busyClient = new FakeQueryClient();
  busyClient.priorCheckpoint = priorState();
  busyClient.watermark = 100;
  busyClient.total = 4;
  await assert.rejects(
    initializeContactLinkCoverageRun(busyClient, "operator-1"),
    /CONTACT_LINK_COVERAGE_RESUME_REQUIRED/,
  );
  assert.equal(busyClient.calls.filter(call => call.sql === CONTACT_LINK_COVERAGE_WATERMARK_SQL).length, 0,
    "unfinished run rejection happens before collecting a new watermark");
  assert.equal(busyClient.checkpoints.length, 0);

  const completedClient = new FakeQueryClient();
  completedClient.priorCheckpoint = priorState({
    status: "completed",
    complete: true,
    processed: 3,
  });
  completedClient.watermark = 25;
  completedClient.total = 2;
  const afterCompleted = await initializeContactLinkCoverageRun(completedClient, "operator-2");
  assert.equal(afterCompleted.status, "ready");
  assert.equal(afterCompleted.total, 2);
  assert.notEqual(afterCompleted.runId, "prior-run");

  const emptyClient = new FakeQueryClient();
  const empty = await initializeContactLinkCoverageRun(emptyClient, "operator-3");
  assert.equal(empty.total, 0);
  assert.equal(empty.watermark, 0);
  assert.equal(empty.status, "completed");
  assert.equal(empty.complete, true);
  assert.equal(empty.processed, 0);
  assert.equal(emptyClient.calls.filter(call => call.sql === CONTACT_LINK_COVERAGE_BATCH_SQL).length, 0);
}

async function testProcessorProgressAndCompletion() {
  const client = new FakeQueryClient();
  client.pages = [[contactRow(10)], [contactRow(20)]];
  const initial = priorState({
    status: "ready",
    watermark: 20,
    cursor: 0,
    total: 2,
    processed: 0,
    counts: { ...emptyContactLinkCoverageCounts(), REVIEW: 1 },
    reasonCounts: { prior_reason: 1 },
  });

  const advanced = await processContactLinkCoveragePage(client, initial, "operator-1");
  assert.equal(advanced.status, "ready", "a partial page remains resumable");
  assert.equal(advanced.complete, false);
  assert.equal(advanced.cursor, 10);
  assert.equal(advanced.watermark, 20);
  assert.equal(advanced.total, 2);
  assert.equal(advanced.processed, 1);
  assert.equal(advanced.counts.REVIEW >= 1, true, "previous bucket counts survive page processing");
  assert.equal(advanced.reasonCounts.prior_reason, 1, "previous reason counts survive page processing");
  assert.equal(advanced.counts.REVIEW + advanced.counts.STRICT_AUTO_ELIGIBLE
    + advanced.counts.ALREADY_VERIFIED + advanced.counts.RECOVERABLE_IDENTITY
    + advanced.counts.NEEDS_BUSINESS_DISCOVERY + advanced.counts.OUT_OF_SCOPE
    + advanced.counts.SUPPRESSED + advanced.counts.UNUSABLE, 2);

  const completed = await processContactLinkCoveragePage(client, advanced, "operator-1");
  assert.equal(completed.status, "completed");
  assert.equal(completed.complete, true);
  assert.equal(completed.cursor, 20);
  assert.equal(completed.watermark, 20);
  assert.equal(completed.total, 2);
  assert.equal(completed.processed, 2);
  assert.equal(client.calls.filter(call => call.sql === CONTACT_LINK_COVERAGE_BATCH_SQL).length, 2);
  assert.ok(client.calls.filter(call => call.sql === CONTACT_LINK_COVERAGE_BATCH_SQL)
    .every(call => call.params[2] === 500));
  assert.equal(CONTACT_LINK_COVERAGE_PROCESSING_PAGE_SIZE, 500);
  assert.deepEqual(client.lastCheckpoint(), completed);
}

function testQueryPlanRegressions() {
  assert.match(
    CONTACT_LINK_COVERAGE_BATCH_SQL,
    /contact_identity_dba_key\s*=\s*contact_key\.key[\s\S]{0,250}AND se\.dba IS NOT NULL/,
    "the raw DBA-key branch must retain the partial-index predicate",
  );
  const businessData = CONTACT_LINK_COVERAGE_BATCH_SQL.match(/business_data AS \([\s\S]*?\n\)\nSELECT/);
  assert.ok(businessData, "batch SQL should retain its business_data CTE");
  assert.match(businessData[0], /FROM candidate_pairs cp[\s\S]*cp\.contact_id/);
  assert.doesNotMatch(businessData[0], /JOIN\s+page\b/i,
    "business_data must not redundantly join the page and multiply candidate rows");
}

async function testDenominatorDriftAndBatchFailure() {
  const driftClient = new FakeQueryClient();
  driftClient.pages = [[]];
  const drift = await processContactLinkCoveragePage(
    driftClient,
    priorState({ status: "ready", cursor: 3, watermark: 30, total: 2, processed: 1 }),
    null,
  );
  assert.equal(drift.status, "error");
  assert.equal(drift.complete, false);
  assert.equal(drift.lastError, "CONTACT_LINK_COVERAGE_DENOMINATOR_DRIFT:1/2");
  assert.equal(driftClient.lastCheckpoint()?.status, "error");

  const failureClient = new FakeQueryClient();
  const queryFailure = new Error("simulated batch query failure");
  failureClient.failBatchWith = queryFailure;
  const starting = priorState({
    status: "ready",
    cursor: 0,
    watermark: 50,
    total: 2,
    processed: 0,
    counts: emptyContactLinkCoverageCounts(),
    reasonCounts: {},
  });
  await assert.rejects(processContactLinkCoveragePage(failureClient, starting, null), /simulated batch query failure/);
  const savedAfterFailure = failureClient.lastCheckpoint();
  assert.ok(savedAfterFailure);
  assert.equal(savedAfterFailure.complete, false);
  assert.equal(savedAfterFailure.processed, 0);
  assert.equal(savedAfterFailure.cursor, 0);
  assert.equal(savedAfterFailure.status, "running");
  assert.equal(failureClient.calls.filter(call => call.sql === CONTACT_LINK_COVERAGE_BATCH_SQL).length, 1);
  assert.equal(failureClient.checkpoints.length, 1,
    "a failed query must not write a fabricated successful checkpoint");
}

async function main() {
  await testInitializerFreezesScopeWithoutProcessing();
  await testProcessorProgressAndCompletion();
  testQueryPlanRegressions();
  await testDenominatorDriftAndBatchFailure();
  console.log("contact-link-coverage execution tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});