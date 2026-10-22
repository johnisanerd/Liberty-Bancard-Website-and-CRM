#!/usr/bin/env tsx
/**
 * Disposable-PostgreSQL integration certification for the one-way GHL inbound
 * reconciliation service. GHL GETs are answered by an in-process fake; every
 * other fetch is denied. This script imports no server/job bootstrap module.
 *
 * Run only with DATABASE_URL=TEST_DATABASE_URL and NODE_ENV=test, against a
 * migrated disposable database (see .agents/memory/local-predeploy-database.md).
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { assertDisposableTestInfrastructure } from "./test-infrastructure-guard";

const assertNamed = (name: string, check: () => void) => {
  try {
    check();
    console.log(`PASS ${name}`);
  } catch (error) {
    throw new Error(`FAIL ${name}: ${(error as Error).message}`, { cause: error });
  }
};

async function main() {
  await assertDisposableTestInfrastructure({
    operation: "GHL inbound sync integration",
    requireRedis: false,
  });

  // Import only after the disposable-DB boundary has been proven.
  const { db, pool } = await import("../server/db");
  const { contacts } = await import("@shared/schema");
  const sync = await import("../server/services/ghl-inbound-sync");
  const ghlWebhook = await import("../server/services/ghl");

  const required = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name = ANY($1::text[])
  `, [[
    "contacts", "system_settings", "outbound_pause_control", "contact_source_events",
    "contact_provider_projections", "validation_intents", "contact_readiness_runs",
    "contact_identity_observations", "audit_logs", "contact_lead_scoring_jobs",
    "sequence_enrollments", "cr04_enrollment_intents",
  ]]);
  const requiredTables = new Set(required.rows.map((row) => row.table_name));
  assert.deepEqual(
    [...requiredTables].sort(),
    [
      "audit_logs", "contact_identity_observations", "contact_provider_projections",
      "contact_lead_scoring_jobs", "contact_readiness_runs", "contact_source_events",
      "contacts", "cr04_enrollment_intents", "outbound_pause_control",
      "sequence_enrollments", "system_settings", "validation_intents",
    ].sort(),
    "migrated canonical contact-writer tables are required",
  );

  const fixtureSuffix = randomUUID();
  const actorId = `ghl-inbound-integration-${fixtureSuffix}`;
  const updateGhlId = `it-update-${fixtureSuffix}`;
  const createGhlId = `it-create-${fixtureSuffix}`;
  const duplicateEmail = `duplicate-${fixtureSuffix}@example.test`;
  const conflictOwnedEmail = `owned-${fixtureSuffix}@example.test`;
  const conflictId = `email-disagrees-${fixtureSuffix}`;
  const linkedLocalEmail = `wrong-linked-local-${fixtureSuffix}@example.test`;
  const linkedRemoteEmail = `wrong-linked-remote-${fixtureSuffix}@example.test`;
  const recheckEmail = `recheck-${fixtureSuffix}@example.test`;
  const forbiddenUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalGhlToken = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
  const originalGhlApiKey = process.env.GHL_API_KEY;
  const originalLocation = process.env.GHL_LOCATION_ID;
  const originalWebhookSecret = process.env.GHL_WEBHOOK_SECRET;
  const pageSets: Array<Array<{ body?: unknown; expectedCursor?: string; timeout?: boolean; httpStatus?: number; redirect?: { status: number; location: string } }>> = [];
  let redirectDestinationRequests = 0;
  let fakeRedirect: { status: number; location: string } | null = null;
  const redirectServer = createServer((req, res) => {
    if (req.url === "/first" && fakeRedirect) {
      res.writeHead(fakeRedirect.status, { Location: fakeRedirect.location }).end();
    } else {
      redirectDestinationRequests++;
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"contacts":[],"meta":{}}');
    }
  });
  await new Promise<void>(resolve => redirectServer.listen(0, "127.0.0.1", resolve));
  const redirectOrigin = `http://127.0.0.1:${(redirectServer.address() as any).port}`;
  const fetchCalls: Array<{ url: string; method: string }> = [];
  const idempotencyKeys: Array<{ kind: "idem" | "execute"; key: string }> = [];
  const leaseTriggerName = `ghl_inbound_lease_test_${fixtureSuffix.replace(/-/g, "_")}`;
  const leaseFunctionName = `${leaseTriggerName}_fn`;
  const pauseTriggerName = `ghl_inbound_pause_test_${fixtureSuffix.replace(/-/g, "_")}`;
  const pauseFunctionName = `${pauseTriggerName}_fn`;

  process.env.GHL_PRIVATE_INTEGRATION_TOKEN = "integration-fake-token";
  delete process.env.GHL_API_KEY;
  process.env.GHL_LOCATION_ID = "integration-fake-location";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!url.startsWith("https://services.leadconnectorhq.com/contacts/") || method !== "GET") {
      forbiddenUrls.push(`${method} ${url}`);
      throw new Error("INTEGRATION_EXTERNAL_REQUEST_DENIED");
    }
    fetchCalls.push({ url, method });
    const pages = pageSets.at(-1);
    if (!pages?.length) throw new Error("INTEGRATION_FAKE_GHL_PAGE_UNAVAILABLE");
    const page = pages.shift()!;
    assert.equal(init?.redirect, "error", "actual service fetch boundary must reject HTTP redirects");
    if (page.timeout) {
      await new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("FIXTURE_TIMEOUT_SIGNAL_NOT_USED")), 2000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      });
    }
    if (page.httpStatus) return new Response("", { status: page.httpStatus });
    if (page.redirect) {
      fakeRedirect = page.redirect;
      return originalFetch(`${redirectOrigin}/first`, { ...init, headers: {} });
    }
    const parsed = new URL(url);
    if (page.expectedCursor !== undefined) {
      assert.equal(parsed.searchParams.get("startAfterId"), page.expectedCursor);
      assert.ok(parsed.searchParams.get("startAfter"));
    }
    return new Response(JSON.stringify(page.body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const fixtureEmails = [
    `fill-${fixtureSuffix}@example.test`, `new-${fixtureSuffix}@example.test`,
    duplicateEmail, conflictOwnedEmail, linkedLocalEmail, linkedRemoteEmail,
    recheckEmail, `mbx-${fixtureSuffix}@example.test`,
  ];
  const insertedContactIds: number[] = [];
  const runIds: string[] = [];
  let pauseRowId: number | null = null;
  let pauseBefore: Record<string, unknown> | null = null;
  let inboundEnabledBefore: unknown;
  let hadInboundEnabledBefore = false;
  let activeRunBefore: unknown;
  let hadActiveRunBefore = false;

  const seedContact = async (values: {
    email: string;
    ghlContactId?: string | null;
    firstName?: string;
    lastName?: string;
    phone?: string;
    companyName?: string | null;
    tags?: string[];
    consentSms?: boolean;
    consentEmail?: boolean;
    doNotContact?: boolean;
    status?: string;
    assignedTo?: string | null;
  }) => {
    const [contact] = await db.insert(contacts).values({
      firstName: values.firstName ?? "",
      lastName: values.lastName ?? "",
      email: values.email,
      phone: values.phone ?? "",
      companyName: values.companyName ?? null,
      ghlContactId: values.ghlContactId ?? null,
      tags: values.tags ?? ["local-tag"],
      consentSms: values.consentSms ?? true,
      consentEmail: values.consentEmail ?? false,
      doNotContact: values.doNotContact ?? true,
      status: values.status ?? "Qualified",
      assignedTo: values.assignedTo ?? "integration-owner@example.test",
    }).returning({ id: contacts.id });
    insertedContactIds.push(contact.id);
    return contact.id;
  };

  const withPages = (pages: Array<{ body: unknown; expectedCursor?: string }>) => {
    pageSets.push(pages);
  };
  const scanToReady = async (idempotencyKey: string, pages: Array<{ body: unknown; expectedCursor?: string }>) => {
    withPages(pages);
    idempotencyKeys.push({ kind: "idem", key: idempotencyKey });
    const preview = await sync.createGhlInboundPreview(idempotencyKey, actorId);
    runIds.push(preview.runId);
    let current = preview;
    for (let attempt = 0; current.state === "previewing" && attempt < 20; attempt++) {
      current = (await sync.advanceGhlInboundSyncStep(current.runId)).run;
    }
    assert.equal(current.state, "ready", `preview ${preview.runId} should reach ready`);
    return current;
  };
  const execute = async (runId: string, previewHash: string, key: string) => {
    idempotencyKeys.push({ kind: "execute", key });
    return sync.executeGhlInboundSync(runId, previewHash, key, actorId);
  };
  const onePage = (...items: unknown[]) => [{
    body: { contacts: items, meta: { total: items.length } },
  }];
  const source = (id: string, email: string, extras: Record<string, unknown> = {}) => ({
    id, firstName: "Remote", lastName: "Person", email, phone: "+1 555 222 3333",
    companyName: "Remote Company", locationId: "integration-fake-location", ...extras,
  });
  const getFixture = async (id: number) => {
    const result = await pool.query("SELECT * FROM contacts WHERE id=$1", [id]);
    return result.rows[0] as Record<string, any>;
  };
  const assertNoContactFor = async (email: string) => {
    const result = await pool.query("SELECT id FROM contacts WHERE lower(email)=lower($1)", [email]);
    assert.equal(result.rowCount, 0, `contact ${email} must not exist`);
  };
  const setPause = async (state: "paused" | "unpaused", incrementEpoch = false) => {
    await pool.query(
      `UPDATE outbound_pause_control SET state=$1, epoch=epoch + $2 WHERE id=$3`,
      [state, incrementEpoch ? 1 : 0, pauseRowId],
    );
  };
  const expectStepRejected = async (runId: string, codePattern: RegExp) => {
    let caught: unknown;
    try { await sync.advanceGhlInboundSyncStep(runId); } catch (error) { caught = error; }
    assert.ok(caught, `expected ${runId} apply step to reject`);
    assert.match((caught as Error).message, codePattern);
  };

  try {
    const oldEnabled = await pool.query("SELECT value FROM system_settings WHERE key='ghl_inbound_contact_sync_enabled'");
    hadInboundEnabledBefore = oldEnabled.rowCount === 1;
    inboundEnabledBefore = oldEnabled.rows[0]?.value;
    const oldActive = await pool.query("SELECT value FROM system_settings WHERE key='ghl_inbound_contact_sync_active'");
    hadActiveRunBefore = oldActive.rowCount === 1;
    activeRunBefore = oldActive.rows[0]?.value;

    const existingId = await seedContact({
      email: fixtureEmails[0],
      firstName: "",
      lastName: "Local Last",
      phone: "",
      companyName: "Local Company",
      ghlContactId: null,
    });
    const ownedId = await seedContact({
      email: conflictOwnedEmail,
      ghlContactId: `already-owned-${fixtureSuffix}`,
    });
    const linkedId = await seedContact({
      email: linkedLocalEmail,
      ghlContactId: conflictId,
      firstName: "Keep Me",
    });
    const beforeExisting = await getFixture(existingId);
    const initialPause = await pool.query<{ id: number }>("SELECT id FROM outbound_pause_control ORDER BY id LIMIT 1");
    if (initialPause.rowCount) {
      pauseRowId = initialPause.rows[0].id;
      const before = await pool.query("SELECT * FROM outbound_pause_control WHERE id=$1", [pauseRowId]);
      pauseBefore = before.rows[0];
      await setPause("paused");
    } else {
      const inserted = await pool.query<{ id: number }>(
        "INSERT INTO outbound_pause_control(state,reason,actor) VALUES('paused','isolated GHL inbound integration','integration') RETURNING id",
      );
      pauseRowId = inserted.rows[0].id;
    }

    const pages = [
      {
        body: {
          contacts: [
            source(updateGhlId, fixtureEmails[0]),
            source(`dupe-page-one-${fixtureSuffix}`, duplicateEmail),
          ],
          meta: {
            total: 6,
            nextPage: "https://services.leadconnectorhq.com/contacts/?locationId=integration-fake-location&limit=100&startAfter=2025-01-01T00%3A00%3A00.000Z&startAfterId=cursor-page-two",
          },
        },
      },
      {
        expectedCursor: "cursor-page-two",
        body: {
          contacts: [
            source(`dupe-page-two-${fixtureSuffix}`, duplicateEmail),
            source(createGhlId, fixtureEmails[1]),
            source(`owned-email-${fixtureSuffix}`, conflictOwnedEmail),
            source(conflictId, linkedRemoteEmail),
          ],
          meta: { total: 6 },
        },
      },
    ];
    const ready = await scanToReady(`ghl-inbound-main-${fixtureSuffix}`, pages);
    assertNamed("multi-page preview detects duplicate source email identities", () => {
      assert.equal(ready.counts.conflicts, 5); // includes the preserved-nonblank audit reason
      assert.equal(ready.counts.wouldUpdate, 1);
      assert.equal(ready.counts.wouldCreate, 1);
      assert.equal(ready.issues.filter((issue) => issue.reason === "duplicate_remote_identity").length, 2);
      assert.equal(fetchCalls.length, 2);
    });
    assertNamed("canonical GHL-ID/email disagreement is preview conflict", () => {
      assert.ok(ready.issues.some((issue) => issue.ghlContactId === `owned-email-${fixtureSuffix}`));
      assert.ok(ready.issues.some((issue) => issue.ghlContactId === conflictId));
      assert.equal(ownedId > 0 && linkedId > 0, true);
    });
    assert.equal((await getFixture(existingId)).first_name, beforeExisting.first_name);
    await assertNoContactFor(fixtureEmails[1]);
    assertNamed("preview is contact-write-free", () => {
      assert.equal(ready.state, "ready");
      assert.equal(ready.counts.created, 0);
      assert.equal(ready.counts.updated, 0);
    });

    // Idempotent preview replay returns the original durable run.
    const replay = await sync.createGhlInboundPreview(`ghl-inbound-main-${fixtureSuffix}`, actorId);
    assertNamed("preview idempotency replays same run", () => assert.equal(replay.runId, ready.runId));

    await execute(ready.runId, ready.previewHash!, `ghl-inbound-execute-${fixtureSuffix}`);
    // A still-live lease blocks another step owner without changing its run.
    await pool.query(
      `UPDATE system_settings SET value=jsonb_set(value,'{leaseExpiresAt}',to_jsonb((now()+interval '5 minutes')::text),true)
       WHERE key=$1`,
      [`ghl_inbound_contact_sync_run_${ready.runId}`],
    );
    const leaseResult = await sync.advanceGhlInboundSyncStep(ready.runId);
    assertNamed("active run lease blocks duplicate worker", () => {
      assert.equal(leaseResult.busy, true);
      assert.equal(leaseResult.run.state, "running");
    });
    await pool.query(
      `UPDATE system_settings SET value=value || '{"leaseToken":null,"leaseOwner":null,"leaseExpiresAt":null}'::jsonb
       WHERE key=$1`,
      [`ghl_inbound_contact_sync_run_${ready.runId}`],
    );

    const readinessBeforeApply = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM contact_readiness_runs",
    );
    const applied = await sync.advanceGhlInboundSyncStep(ready.runId);
    assertNamed("apply commits canonical blank-only update and new-contact creation", () => {
      assert.equal(applied.run.state, "complete");
      assert.equal(applied.run.counts.updated, 1);
      assert.equal(applied.run.counts.created, 1);
      assert.equal(applied.run.counts.skipped, 0);
    });
    const updated = await getFixture(existingId);
    assert.equal(updated.first_name, "Remote");
    assert.equal(updated.phone, "+1 555 222 3333");
    assert.equal(updated.last_name, "Local Last");
    assert.equal(updated.company_name, "Local Company");
    assert.equal(updated.ghl_contact_id, updateGhlId);
    assert.deepEqual(updated.tags, beforeExisting.tags);
    assert.equal(updated.consent_sms, beforeExisting.consent_sms);
    assert.equal(updated.consent_email, beforeExisting.consent_email);
    assert.equal(updated.do_not_contact, beforeExisting.do_not_contact);
    assert.equal(updated.status, beforeExisting.status);
    assert.equal(updated.assigned_to, beforeExisting.assigned_to);
    const createdResult = await pool.query(
      "SELECT * FROM contacts WHERE ghl_contact_id=$1",
      [createGhlId],
    );
    assert.equal(createdResult.rowCount, 1);
    const created = createdResult.rows[0];
    assert.equal(created.source_category, "ghl_sync");
    assert.equal(created.primary_source_category, "ghl_sync");
    assert.equal(created.primary_source_type, "inbound");
    const createdRelated = await pool.query<{
      events: number; projections: number; validation_intents: number; readiness_runs: number;
      scoring_jobs: number; sequence_enrollments: number; enrollment_intents: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM contact_source_events WHERE contact_id=$1) AS events,
        (SELECT count(*)::int FROM contact_provider_projections WHERE contact_id=$1) AS projections,
        (SELECT count(*)::int FROM validation_intents WHERE contact_id=$1) AS validation_intents,
        (SELECT count(*)::int FROM contact_readiness_runs) AS readiness_runs,
        (SELECT count(*)::int FROM contact_lead_scoring_jobs WHERE contact_id=$1) AS scoring_jobs,
        (SELECT count(*)::int FROM sequence_enrollments WHERE contact_id=$1) AS sequence_enrollments,
        (SELECT count(*)::int FROM cr04_enrollment_intents WHERE contact_id=$1) AS enrollment_intents
    `, [created.id]);
    const related = createdRelated.rows[0];
    assertNamed("canonical creation records provenance but no provider/validation/readiness intent", () => {
      assert.equal(related.events, 1);
      assert.equal(related.projections, 0);
      assert.equal(related.validation_intents, 0);
      assert.equal(related.readiness_runs, readinessBeforeApply.rows[0].count);
      assert.equal(related.scoring_jobs, 0);
      assert.equal(related.sequence_enrollments, 0);
      assert.equal(related.enrollment_intents, 0);
      assert.equal(created.email_status, "unvalidated");
      assert.equal(created.lead_score, 0);
    });

    // Exact execute idempotency replay cannot create or update a second time.
    const executeReplay = await execute(
      ready.runId, ready.previewHash!, `ghl-inbound-execute-${fixtureSuffix}`,
    );
    assertNamed("execute idempotency replays completed run without duplicate writes", () => {
      assert.equal(executeReplay.state, "complete");
      assert.equal(executeReplay.counts.created, 1);
      assert.equal(executeReplay.counts.updated, 1);
    });
    assert.equal((await pool.query("SELECT id FROM contacts WHERE ghl_contact_id=$1", [createGhlId])).rowCount, 1);

    const activeRaceKeys = [
      `active-race-one-${fixtureSuffix}`,
      `active-race-two-${fixtureSuffix}`,
    ];
    idempotencyKeys.push(...activeRaceKeys.map((key) => ({ kind: "idem" as const, key })));
    const activeRace = await Promise.allSettled(activeRaceKeys.map((key) =>
      sync.createGhlInboundPreview(key, actorId),
    ));
    const activeRaceFulfilled = activeRace.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof sync.createGhlInboundPreview>>> =>
      result.status === "fulfilled");
    const activeRaceRejected = activeRace.filter((result) => result.status === "rejected");
    assert.equal(activeRaceFulfilled.length, 1);
    assert.equal(activeRaceRejected.length, 1);
    const activeRaceRun = activeRaceFulfilled[0].value;
    runIds.push(activeRaceRun.runId);
    await pool.query(
      `UPDATE system_settings SET value=jsonb_set(jsonb_set(value,'{state}','"complete"'::jsonb),'{nextAction}','null'::jsonb)
       WHERE key=$1`,
      [`ghl_inbound_contact_sync_run_${activeRaceRun.runId}`],
    );
    assertNamed("active-pointer serialization permits exactly one concurrent preview", () => {
      assert.match((activeRaceRejected[0] as PromiseRejectedResult).reason.message, /GHL_INBOUND_COMMAND_ACTIVE/);
      assert.equal(activeRaceRun.state, "previewing");
    });

    // Identity recheck: create candidate appears after preview but before apply.
    const recheckReady = await scanToReady(`ghl-inbound-recheck-${fixtureSuffix}`, onePage(
      source(`recheck-${fixtureSuffix}`, recheckEmail),
    ));
    await execute(recheckReady.runId, recheckReady.previewHash!, `recheck-exec-${fixtureSuffix}`);
    const lateIdentityId = await seedContact({
      email: recheckEmail, ghlContactId: `different-local-ghl-${fixtureSuffix}`, firstName: "Late Local",
    });
    const recheckResult = await sync.advanceGhlInboundSyncStep(recheckReady.runId);
    assertNamed("apply rechecks identity and skips a post-preview matching contact", () => {
      assert.equal(recheckResult.run.state, "complete");
      assert.equal(recheckResult.run.counts.created, 0);
      assert.equal(recheckResult.run.counts.skipped, 1);
    });
    assert.equal((await getFixture(lateIdentityId)).first_name, "Late Local");
    assert.equal((await pool.query("SELECT id FROM contacts WHERE ghl_contact_id=$1", [`recheck-${fixtureSuffix}`])).rowCount, 0);

    // Shared mailbox protocol: an incoming apply that fills a blank email waits on the destination mailbox lock BEFORE
    // it row-locks the contact, so a competing mailbox writer (Data Health reconcile, Contact edit) serializes with it.
    const mbxEmail = `mbx-${fixtureSuffix}@example.test`;
    const mbxContactId = await seedContact({ email: "", ghlContactId: `mbx-${fixtureSuffix}`, firstName: "Blank Email" });
    const mbxReady = await scanToReady(`ghl-inbound-mbx-${fixtureSuffix}`, onePage(
      source(`mbx-${fixtureSuffix}`, mbxEmail),
    ));
    assert.equal(mbxReady.counts.wouldUpdate, 1, "blank-email contact is planned as an update");
    await execute(mbxReady.runId, mbxReady.previewHash!, `mbx-exec-${fixtureSuffix}`);
    const mbxHolder = await pool.connect();
    const mbxProbe = await pool.connect();
    let mbxStep: Promise<any> | null = null;
    let mbxSettled = false;
    try {
      await mbxHolder.query("BEGIN");
      await mbxHolder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`contact-mailbox:${mbxEmail}`]);
      mbxStep = sync.advanceGhlInboundSyncStep(mbxReady.runId).then(r => { mbxSettled = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 1500));
      let rowFreeWhileWaiting = false;
      await mbxProbe.query("BEGIN");
      try {
        await mbxProbe.query("SELECT id FROM contacts WHERE id=$1 FOR UPDATE NOWAIT", [mbxContactId]);
        rowFreeWhileWaiting = true;
      } catch { rowFreeWhileWaiting = false; }
      await mbxProbe.query("ROLLBACK");
      assertNamed("incoming apply waits on the destination mailbox lock without holding the contact row lock", () => {
        assert.equal(mbxSettled, false, "apply must wait for the mailbox holder");
        assert.equal(rowFreeWhileWaiting, true, "mailbox lock must be taken before the row lock");
      });
      await mbxHolder.query("COMMIT");
      const mbxResult = await mbxStep;
      assertNamed("incoming apply completes after the mailbox is released and fills the blank email", () => {
        assert.equal(mbxResult.run.state, "complete");
        assert.equal(mbxResult.run.counts.updated, 1);
      });
      assert.equal((await getFixture(mbxContactId)).email, mbxEmail);
    } finally {
      await mbxHolder.query("ROLLBACK").catch(() => undefined); mbxHolder.release();
      mbxProbe.release();
      await mbxStep?.catch(() => undefined);
    }

    // A no-longer-paused state must abort an entire apply transaction.
    const unpausedEmail = `unpaused-${fixtureSuffix}@example.test`;
    const unpausedReady = await scanToReady(`ghl-inbound-unpaused-${fixtureSuffix}`, onePage(
      source(`unpaused-${fixtureSuffix}`, unpausedEmail),
    ));
    await execute(unpausedReady.runId, unpausedReady.previewHash!, `unpaused-exec-${fixtureSuffix}`);
    await setPause("unpaused");
    await expectStepRejected(unpausedReady.runId, /NOT_PAUSED|PAUSE_EPOCH_CHANGED/);
    await assertNoContactFor(unpausedEmail);
    await setPause("paused");
    const unpausedRetry = await sync.advanceGhlInboundSyncStep(unpausedReady.runId);
    assertNamed("unpaused state rejects writes and permits safe retry after pause restoration", () => {
      assert.equal(unpausedRetry.run.state, "complete");
      assert.equal(unpausedRetry.run.counts.created, 1);
    });

    // Epoch drift while remaining paused must also revoke the preview authority.
    const epochEmail = `epoch-drift-${fixtureSuffix}@example.test`;
    const epochReady = await scanToReady(`ghl-inbound-epoch-${fixtureSuffix}`, onePage(
      source(`epoch-${fixtureSuffix}`, epochEmail),
    ));
    await execute(epochReady.runId, epochReady.previewHash!, `epoch-exec-${fixtureSuffix}`);
    await setPause("paused", true);
    await expectStepRejected(epochReady.runId, /EPOCH|AUTHORITY|PAUSE/);
    await assertNoContactFor(epochEmail);
    await pool.query(
      `UPDATE system_settings SET value=jsonb_set(jsonb_set(value,'{state}','"complete"'::jsonb),'{nextAction}','null'::jsonb)
       WHERE key=$1`,
      [`ghl_inbound_contact_sync_run_${epochReady.runId}`],
    );
    await pool.query(
      `UPDATE system_settings SET value=$1::jsonb WHERE key='ghl_inbound_contact_sync_active'`,
      [JSON.stringify(ready.runId)],
    );
    assertNamed("paused-epoch drift rejects stale apply authority without writes", () => {
      assert.equal(epochReady.state, "ready");
      assert.ok(epochReady.previewHash);
    });

    // Hold the contact transaction open and prove the pause-control row stays
    // shared-locked until its commit; a pause transition must wait, not race.
    const lockEmail = `pause-lock-${fixtureSuffix}@example.test`;
    const lockGhlId = `pause-lock-${fixtureSuffix}`;
    const lockReady = await scanToReady(`ghl-inbound-pause-lock-${fixtureSuffix}`, onePage(
      source(lockGhlId, lockEmail),
    ));
    await execute(lockReady.runId, lockReady.previewHash!, `pause-lock-exec-${fixtureSuffix}`);
    await pool.query(`
      CREATE FUNCTION ${pauseFunctionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.ghl_contact_id = '${lockGhlId}' THEN PERFORM pg_sleep(1.5); END IF;
        RETURN NEW;
      END $$;
    `);
    await pool.query(`
      CREATE TRIGGER ${pauseTriggerName} BEFORE INSERT ON contacts
      FOR EACH ROW EXECUTE FUNCTION ${pauseFunctionName}()
    `);
    const applyingWithPauseLock = sync.advanceGhlInboundSyncStep(lockReady.runId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pauseMutationStarted = Date.now();
    const concurrentPauseMutation = pool.query(
      "UPDATE outbound_pause_control SET state='unpaused',epoch=epoch+1 WHERE id=$1",
      [pauseRowId],
    );
    const [pauseLockedApply] = await Promise.all([applyingWithPauseLock, concurrentPauseMutation]);
    const pauseMutationWaitMs = Date.now() - pauseMutationStarted;
    await pool.query(`DROP TRIGGER ${pauseTriggerName} ON contacts`);
    await pool.query(`DROP FUNCTION ${pauseFunctionName}()`);
    await setPause("paused");
    assertNamed("pause authority row lock fences concurrent pause transition through commit", () => {
      assert.equal(pauseLockedApply.run.state, "complete");
      assert.ok(pauseMutationWaitMs >= 700, `pause mutation waited only ${pauseMutationWaitMs}ms`);
    });
    fixtureEmails.push(lockEmail);

    // Force a lease-token replacement after claim but before its apply
    // transaction reads the persisted authority. This proves the fence, not
    // merely the early "busy" response above.
    const staleEmail = `stale-lease-${fixtureSuffix}@example.test`;
    const staleReady = await scanToReady(`ghl-inbound-stale-lease-${fixtureSuffix}`, onePage(
      source(`stale-lease-${fixtureSuffix}`, staleEmail),
    ));
    await execute(staleReady.runId, staleReady.previewHash!, `stale-lease-exec-${fixtureSuffix}`);
    await pool.query(`
      CREATE FUNCTION ${leaseFunctionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key = 'ghl_inbound_contact_sync_run_${staleReady.runId}'
           AND NEW.value->>'state' = 'running'
           AND NEW.value->>'leaseToken' IS NOT NULL THEN
          NEW.value := jsonb_set(NEW.value, '{leaseToken}', '"forced-stale-token"'::jsonb);
        END IF;
        RETURN NEW;
      END $$;
    `);
    await pool.query(`
      CREATE TRIGGER ${leaseTriggerName} BEFORE UPDATE ON system_settings
      FOR EACH ROW EXECUTE FUNCTION ${leaseFunctionName}()
    `);
    await expectStepRejected(staleReady.runId, /LEASE_LOST/);
    await pool.query(`DROP TRIGGER ${leaseTriggerName} ON system_settings`);
    await pool.query(`DROP FUNCTION ${leaseFunctionName}()`);
    await assertNoContactFor(staleEmail);
    assertNamed("stale persisted lease token prevents apply writes", () => assert.equal(true, true));

    assertNamed("provider transport was restricted to fake GHL GET pagination", () => {
      assert.deepEqual(forbiddenUrls, []);
      assert.ok(fetchCalls.length >= 6);
      assert.ok(fetchCalls.every((call) =>
        call.method === "GET" && call.url.startsWith("https://services.leadconnectorhq.com/contacts/")));
    });

    assertNamed("malformed remote identifiers are rejected by the sanitizer", () => {
      assert.equal(sync.sanitizeGhlInboundContact({ id: "  ", email: "valid@example.test" }), null);
      assert.equal(sync.sanitizeGhlInboundContact({ id: "x".repeat(201), email: "valid@example.test" }), null);
      assert.equal(sync.sanitizeGhlInboundContact({ id: "bad-email", email: "not-an-email" })?.email, "");
    });

    await sync.setGhlInboundWebhookEnabled(true, {
      userId: "ghl-inbound-integration-user",
      actorId,
    });
    const partialGhlId = `partial-update-${fixtureSuffix}`;
    const partialEmail = `partial-local-${fixtureSuffix}@example.test`;
    fixtureEmails.push(partialEmail);
    const partialContactId = await seedContact({
      email: partialEmail,
      ghlContactId: partialGhlId,
      firstName: "",
      lastName: "Preserve Partial Last",
      phone: "+1 555 222 7777",
      companyName: null,
      tags: ["partial-local-tag"],
      consentSms: false,
      consentEmail: true,
      doNotContact: true,
      status: "Partial Local",
      assignedTo: "partial-owner@example.test",
    });
    const partialBefore = await getFixture(partialContactId);
    const partialPayload = {
      type: "ContactUpdate",
      eventId: `partial-event-${fixtureSuffix}`,
      contactId: partialGhlId,
      locationId: "integration-fake-location",
      firstName: "Filled Partial First",
      companyName: "Filled Partial Company",
    };
    const rawPartialPayload = JSON.stringify(partialPayload);
    const fakeWebhookSecret = `integration-webhook-secret-${fixtureSuffix}`;
    process.env.GHL_WEBHOOK_SECRET = fakeWebhookSecret;
    const partialSignature = createHmac("sha256", fakeWebhookSecret).update(rawPartialPayload).digest("hex");
    const dispatchSignedWebhook = async (payload: Record<string, unknown>) => {
      const raw = JSON.stringify(payload);
      const signature = createHmac("sha256", fakeWebhookSecret).update(raw).digest("hex");
      if (!ghlWebhook.validateGhlWebhookSignature(raw, signature)) {
        throw new Error("INTEGRATION_HMAC_SIGNATURE_REJECTED");
      }
      await ghlWebhook.handleGhlWebhook(payload);
    };
    assertNamed("signed partial contact event signature is authentic and tamper-sensitive", () => {
      assert.equal(ghlWebhook.validateGhlWebhookSignature(rawPartialPayload, partialSignature), true);
      assert.equal(ghlWebhook.validateGhlWebhookSignature(`${rawPartialPayload} `, partialSignature), false);
    });
    await dispatchSignedWebhook(partialPayload);
    const partialRunState = await pool.query<{ state: string; last_error: string | null }>(
      `SELECT value->>'state' AS state, value->>'lastError' AS last_error
       FROM system_settings
       WHERE key LIKE 'ghl_inbound_contact_sync_run_%'
         AND value->>'idempotencyKey' LIKE $1`,
      [`webhook:${partialGhlId}:%`],
    );
    assertNamed("partial webhook reconciliation reaches a completed apply state", () => {
      assert.equal(partialRunState.rowCount, 1);
      assert.equal(partialRunState.rows[0]?.state, "complete");
      assert.equal(partialRunState.rows[0]?.last_error, null);
    });
    const partialAfter = await getFixture(partialContactId);
    assertNamed("signed location-matched ID-only ContactUpdate fills gaps and preserves established values", () => {
      assert.equal(partialAfter.first_name, "Filled Partial First");
      assert.equal(partialAfter.company_name, "Filled Partial Company");
      assert.equal(partialAfter.email, partialBefore.email);
      assert.equal(partialAfter.phone, partialBefore.phone);
      assert.equal(partialAfter.last_name, partialBefore.last_name);
      assert.deepEqual(partialAfter.tags, partialBefore.tags);
      assert.equal(partialAfter.consent_sms, partialBefore.consent_sms);
      assert.equal(partialAfter.consent_email, partialBefore.consent_email);
      assert.equal(partialAfter.do_not_contact, partialBefore.do_not_contact);
      assert.equal(partialAfter.status, partialBefore.status);
      assert.equal(partialAfter.assigned_to, partialBefore.assigned_to);
    });

    const unmatchedPartialId = `partial-unmatched-${fixtureSuffix}`;
    await dispatchSignedWebhook({
      ...partialPayload,
      eventId: `unmatched-partial-event-${fixtureSuffix}`,
      contactId: unmatchedPartialId,
      firstName: "Must Not Create",
      companyName: "Unmatched Remote",
    });
    const unmatchedPartial = await pool.query(
      "SELECT id FROM contacts WHERE ghl_contact_id=$1",
      [unmatchedPartialId],
    );
    assertNamed("unmatched ID-only partial webhook stays skipped and cannot create", () => {
      assert.equal(unmatchedPartial.rowCount, 0);
    });

    const webhookId = `webhook-${fixtureSuffix}`;
    const webhookEmail = `webhook-${fixtureSuffix}@example.test`;
    fixtureEmails.push(webhookEmail);
    const webhookEventKey = `webhook:${webhookId}:event-${fixtureSuffix}`;
    idempotencyKeys.push({ kind: "idem", key: webhookEventKey });
    const webhookPayload = {
      eventId: `event-${fixtureSuffix}`,
      locationId: "integration-fake-location",
      contact: source(webhookId, webhookEmail),
    };
    await sync.reconcileGhlInboundWebhookContact(webhookPayload);
    await sync.reconcileGhlInboundWebhookContact(webhookPayload);
    const webhookContacts = await pool.query(
      "SELECT id FROM contacts WHERE ghl_contact_id=$1",
      [webhookId],
    );
    assert.equal(webhookContacts.rowCount, 1);
    const webhookEvents = await pool.query(
      "SELECT id FROM contact_source_events WHERE contact_id=$1 AND event_key=$2",
      [webhookContacts.rows[0].id, `ghl-inbound:${webhookId}`],
    );
    assertNamed("completed webhook event replay is idempotent", () => {
      assert.equal(webhookEvents.rowCount, 1);
      assert.deepEqual(forbiddenUrls, []);
    });
    for (const status of [302, 307]) {
      for (const location of [`${redirectOrigin}/redirected`, `${redirectOrigin}/contacts/?locationId=other`,
        `${redirectOrigin.replace("127.0.0.1", "127.0.0.2")}/alternate`, "https://example.invalid/contacts/"]) {
        await pool.query("DELETE FROM system_settings WHERE key='ghl_inbound_contact_sync_active'");
        pageSets.push([{ redirect: { status, location } }]);
        const redirectKey = randomUUID();
        idempotencyKeys.push({ kind: "idem", key: redirectKey });
        const redirectRun = await sync.createGhlInboundPreview(redirectKey, actorId);
        runIds.push(redirectRun.runId);
        await assert.rejects(sync.advanceGhlInboundSyncStep(redirectRun.runId), /fetch failed/);
        const refused = (await sync.getGhlInboundSyncRun(redirectRun.runId))!;
        assert.ok(refused.lastError, "failed read records an explicit safe error");
        assert.equal(refused.counts.created, 0);
        assert.equal(refused.counts.updated, 0);
        assert.notEqual(refused.state, "complete");
        assert.equal(redirectDestinationRequests, 0);
      }
    }
    assert.equal((await sync.getGhlInboundSyncStatus()).inboundEnabled, true, "read failure does not disable incoming");
    console.log("PASS actual fake-service 302/307 origin/path/location redirect rejection; zero destination requests or apply; incoming remains Enabled");
    const oldTimeout = process.env.GHL_REQUEST_TIMEOUT_MS;
    process.env.GHL_REQUEST_TIMEOUT_MS = "25";
    try {
      for (const failure of [{ timeout: true }, { httpStatus: 429 }]) {
        await pool.query("DELETE FROM system_settings WHERE key='ghl_inbound_contact_sync_active'");
        pageSets.push([{
          body: { contacts: [source(`retry-${fixtureSuffix}`, `retry-${fixtureSuffix}@example.test`)],
            meta: { total: 2, nextPage: 2, startAfter: "2025-01-01T00:00:00.000Z", startAfterId: "retry-cursor" } },
        }, { ...failure, expectedCursor: "retry-cursor" }]);
        const key = randomUUID();
        idempotencyKeys.push({ kind: "idem", key });
        const preview = await sync.createGhlInboundPreview(key, actorId);
        runIds.push(preview.runId);
        await sync.advanceGhlInboundSyncStep(preview.runId);
        const checkpoint = (await sync.getGhlInboundSyncRun(preview.runId))!;
        assert.equal(checkpoint.counts.scanned, 1);
        await assert.rejects(sync.advanceGhlInboundSyncStep(preview.runId));
        const failed = (await sync.getGhlInboundSyncRun(preview.runId))!;
        assert.equal(failed.state, "failed");
        assert.equal(failed.counts.scanned, checkpoint.counts.scanned);
        assert.equal(failed.counts.created, 0); assert.equal(failed.counts.updated, 0);
        assert.ok(failed.lastError);
        const calls = fetchCalls.length;
        assert.equal((await sync.createGhlInboundPreview(key, actorId)).runId, preview.runId);
        assert.equal((await sync.advanceGhlInboundSyncStep(preview.runId)).run.state, "failed");
        assert.equal(fetchCalls.length, calls, "failed replay neither advances cursor nor silently releases work");
        assert.equal((await sync.getGhlInboundSyncStatus()).inboundEnabled, true);
      }
    } finally {
      if (oldTimeout === undefined) delete process.env.GHL_REQUEST_TIMEOUT_MS;
      else process.env.GHL_REQUEST_TIMEOUT_MS = oldTimeout;
    }
    console.log("PASS actual timeout/429 second-page checkpoint preservation and safe terminal replay; zero apply and incoming remains Enabled");
  } finally {
    await new Promise<void>(resolve => redirectServer.close(() => resolve()));
    await pool.query(`DROP TRIGGER IF EXISTS ${leaseTriggerName} ON system_settings`).catch(() => undefined);
    await pool.query(`DROP FUNCTION IF EXISTS ${leaseFunctionName}()`).catch(() => undefined);
    await pool.query(`DROP TRIGGER IF EXISTS ${pauseTriggerName} ON contacts`).catch(() => undefined);
    await pool.query(`DROP FUNCTION IF EXISTS ${pauseFunctionName}()`).catch(() => undefined);
    globalThis.fetch = originalFetch;
    if (originalGhlToken === undefined) delete process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
    else process.env.GHL_PRIVATE_INTEGRATION_TOKEN = originalGhlToken;
    if (originalGhlApiKey === undefined) delete process.env.GHL_API_KEY;
    else process.env.GHL_API_KEY = originalGhlApiKey;
    if (originalLocation === undefined) delete process.env.GHL_LOCATION_ID;
    else process.env.GHL_LOCATION_ID = originalLocation;
    if (originalWebhookSecret === undefined) delete process.env.GHL_WEBHOOK_SECRET;
    else process.env.GHL_WEBHOOK_SECRET = originalWebhookSecret;

    if (fixtureEmails.length) {
      const emailList = fixtureEmails.concat([
        `wrong-linked-${fixtureSuffix}@example.test`,
        `unpaused-${fixtureSuffix}@example.test`,
        `epoch-drift-${fixtureSuffix}@example.test`,
      ]);
      const found = await pool.query<{ id: number }>(
        "SELECT id FROM contacts WHERE lower(email)=ANY($1::text[]) OR ghl_contact_id=ANY($2::text[])",
        [
          emailList.map((email) => email.toLowerCase()),
          [
            updateGhlId, createGhlId, conflictId, `recheck-${fixtureSuffix}`, `mbx-${fixtureSuffix}`,
            `unpaused-${fixtureSuffix}`, `epoch-${fixtureSuffix}`, `webhook-${fixtureSuffix}`,
          ],
        ],
      ).catch(() => ({ rows: [] as Array<{ id: number }> }));
      const ids = [...new Set([...insertedContactIds, ...found.rows.map((row) => row.id)])];
      await pool.query("DELETE FROM contact_source_events WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM contact_identity_observations WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM contact_provider_projections WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM validation_intents WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM contact_readiness_runs WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM contact_lead_scoring_jobs WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM cr04_enrollment_intents WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM sequence_enrollments WHERE contact_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM audit_logs WHERE entity_type='contact' AND entity_id=ANY($1::int[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1 AND action='ghl_inbound_webhook_control_changed'", [actorId]).catch(() => undefined);
      await pool.query("DELETE FROM contacts WHERE id=ANY($1::int[])", [ids]).catch(() => undefined);
    }
    if (runIds.length) {
      const webhookRuns = await pool.query<{ runId: string }>(
        `SELECT value->>'runId' AS "runId" FROM system_settings
         WHERE key LIKE 'ghl_inbound_contact_sync_run_%'
           AND value->>'idempotencyKey' LIKE $1`,
        [`webhook:webhook-${fixtureSuffix}:%`],
      ).catch(() => ({ rows: [] as Array<{ runId: string }> }));
      runIds.push(...webhookRuns.rows.map((row) => row.runId));
      await pool.query(
        "DELETE FROM system_settings WHERE key LIKE 'ghl_inbound_contact_sync_run_%' AND (value->>'runId')=ANY($1::text[])",
        [runIds],
      ).catch(() => undefined);
      await pool.query(
        `DELETE FROM system_settings WHERE key LIKE 'ghl_inbound_contact_sync_idem_%'
         AND value #>> '{}' = ANY($1::text[])`,
        [runIds],
      ).catch(() => undefined);
      await pool.query(
        `DELETE FROM system_settings WHERE key LIKE 'ghl_inbound_contact_sync_execute_%'
         AND value #>> '{}' = ANY($1::text[])`,
        [runIds],
      ).catch(() => undefined);
      const keys = idempotencyKeys.map(({ kind, key }) =>
        `ghl_inbound_contact_sync_${kind}_${createHash("sha256").update(`${actorId}:${key}`).digest("hex")}`);
      await pool.query("DELETE FROM system_settings WHERE key=ANY($1::text[])", [keys]).catch(() => undefined);
      if (hadActiveRunBefore) {
        await pool.query(
          `INSERT INTO system_settings(key,value,updated_at) VALUES('ghl_inbound_contact_sync_active',$1::jsonb,NOW())
           ON CONFLICT(key) DO UPDATE SET value=$1::jsonb,updated_at=NOW()`,
          [JSON.stringify(activeRunBefore)],
        ).catch(() => undefined);
      } else {
        await pool.query("DELETE FROM system_settings WHERE key='ghl_inbound_contact_sync_active'").catch(() => undefined);
      }
    }
    if (hadInboundEnabledBefore) {
      await pool.query(
        `INSERT INTO system_settings(key,value,updated_at) VALUES('ghl_inbound_contact_sync_enabled',$1::jsonb,NOW())
         ON CONFLICT(key) DO UPDATE SET value=$1::jsonb,updated_at=NOW()`,
        [JSON.stringify(inboundEnabledBefore)],
      ).catch(() => undefined);
    } else {
      await pool.query("DELETE FROM system_settings WHERE key='ghl_inbound_contact_sync_enabled'").catch(() => undefined);
    }
    if (pauseRowId !== null && pauseBefore) {
      await pool.query(
        `UPDATE outbound_pause_control SET state=$1,reason=$2,epoch=$3,actor=$4,idempotency_key=$5,committed_at=$6 WHERE id=$7`,
        [
          pauseBefore.state, pauseBefore.reason, pauseBefore.epoch, pauseBefore.actor,
          pauseBefore.idempotency_key, pauseBefore.committed_at, pauseRowId,
        ],
      ).catch(() => undefined);
    } else if (pauseRowId !== null) {
      await pool.query("DELETE FROM outbound_pause_control WHERE id=$1", [pauseRowId]).catch(() => undefined);
    }
    await pool.end();
  }

  console.log("GHL inbound sync PostgreSQL integration certification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});