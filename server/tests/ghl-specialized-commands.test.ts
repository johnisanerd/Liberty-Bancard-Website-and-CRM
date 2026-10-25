import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  hasUnexpiredGhlCommandLease,
  lookupExistingGhlContactByEmail,
  permissionFields,
  runPendingGhlSpecializedCommands,
  PENDING_GHL_COMMAND_POINTERS_SQL,
} from "../services/ghl-specialized-commands";
import { evaluateGhlCapabilityPolicy } from "../services/ghl-sync-control";

let calls: Array<{ url: string; method: string }> = [];
const lookedUp = await lookupExistingGhlContactByEmail("known@example.test", {
  token: "test-token",
  locationId: "test-location",
  authorize: async ({ method }) => ({ allowed: method === "GET" }),
  fetcher: async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method) });
    return new Response(JSON.stringify({ contact: { id: "existing-ghl-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
assert.equal(lookedUp, "existing-ghl-id");
assert.equal(calls.length, 1);
assert.equal(calls[0].method, "GET");
assert.match(calls[0].url, /contacts\/search\/duplicate/);
assert.equal(hasUnexpiredGhlCommandLease({ leaseExpiresAt: new Date(10_000).toISOString() }, 9_999), true);
assert.equal(hasUnexpiredGhlCommandLease({ leaseExpiresAt: new Date(9_999).toISOString() }, 9_999), false);

const denied = evaluateGhlCapabilityPolicy({
  method: "PUT",
  path: "/contacts/existing-ghl-id",
  body: { customFields: [
    { key: "lb_can_email", field_value: "false" },
    { key: "lb_channel_permissions", field_value: "{\"email\":false}" },
  ] },
  locationId: "test-location",
}, {
  enabled: false,
  permissionsEnabled: true,
  epoch: 0,
  ownerProfile: null,
  selectedRuntime: null,
  nativeReview: {
    state: "unverified",
    reviewedAt: null,
    evidenceReference: null,
    allowedOperations: [],
  },
});
assert.equal(denied.allowed, false, "unreviewed permission writes must be blocked");
assert.equal(denied.reasonCode, "native_review_unverified");
const readAllowed = evaluateGhlCapabilityPolicy({
  method: "GET",
  path: "/contacts/search/duplicate?locationId=test-location&email=known%40example.test",
  locationId: "test-location",
}, {
  enabled: false, permissionsEnabled: false, epoch: 0,
  ownerProfile: null, selectedRuntime: null,
  nativeReview: { state: "unverified", reviewedAt: null,
    evidenceReference: null, allowedOperations: [] },
});
assert.equal(readAllowed.allowed, true, "disabled writes must not disable identity reads");

const optOutProjection = permissionFields([
  { channel: "email", payload: { lb_email_allowed: true } },
  { channel: "sms", payload: { lb_sms_allowed: true } },
  { channel: "voice_ai", payload: { lb_voice_ai_allowed: true } },
  { channel: "ringless_vm", payload: { lb_ringless_vm_allowed: true } },
  { channel: "manual_call", payload: { lb_manual_call_allowed: true } },
], { doNotContact: true, doNotAutoContact: false });
const projectedChannels = JSON.parse(optOutProjection.at(-1)!.field_value);
assert.deepEqual(projectedChannels, {
  email: false, sms: false, voice_ai: false, ringless_vm: false, manual_call: false,
});

const service = await readFile(new URL("../services/ghl-specialized-commands.ts", import.meta.url), "utf8");
const integrations = await readFile(new URL("../routes/integrations.ts", import.meta.url), "utf8");
const admin = await readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
assert.match(service, /BACKFILL_PAGE_SIZE = 50/);
assert.match(service, /\.limit\(Math\.min\(BACKFILL_PAGE_SIZE/);
assert.match(service, /FOR UPDATE/);
assert.match(service, /leaseToken/);
assert.match(service, /watermark/);
assert.match(service, /runPendingGhlSpecializedCommands/);
assert.match(service, /truth\.owner\.state !== "current"/);
assert.match(service, /control\.ownerProfile !== "ghl-sync-only"/);
assert.match(service, /readOnly && run\.kind !== "contact_id_backfill"/);
assert.match(service, /run\.cursor = previousCursor/);
assert.match(service, /releaseRun\(run, token, "retry"\)/);
assert.match(service, /withGhlCrmInflight\(decision, \(\) => fetch\(/);
const controlSource = await readFile(new URL("../services/ghl-sync-control.ts", import.meta.url), "utf8");
const barrier = controlSource.slice(controlSource.indexOf("export async function withGhlCrmInflight"));
assert.match(barrier, /registerGhlCrmInflight\(decision.epoch\)/);
assert.match(barrier, /recheckGhlCrmOperation\(decision\)/);
assert.match(barrier, /recheckGhlCrmPauseEpoch\(epoch\)/);
assert.match(barrier, /finally[\s\S]*deregisterGhlCrmInflight\(token\)/);
assert.match(service, /const body = \{ customFields: providerFields \}/);
assert.match(service, /getGhlCustomFieldInventory\(\)/);
assert.match(service, /providerFields\.some\(field => !field\.id\)/);
assert.match(service, /candidate\.id === field\.id/);
assert.doesNotMatch(service, /enroll|workflow|sequence/i);
assert.doesNotMatch(service, /UPDATE\s+contacts|INSERT\s+INTO\s+contacts/i);
assert.doesNotMatch(service, /syncContactToGhl|upsertGhlContact/);
assert.doesNotMatch(integrations, /contactProviderProjections/);
assert.match(integrations, /sync-permissions\/:runId\/step/);
assert.match(admin, /backfill-ghl-contacts\/:runId\/step/);
assert.match(admin, /ghl_semantic_stage_id_map/);
assert.match(admin, /fresh provider read/);

// Reproduce the real blocked-command pointer, without DB/provider writes.
const blockedRun = {
  runId: "test-shared-pointer", kind: "contact_id_backfill",
  state: "blocked", cursor: 0, createdAt: "2026-10-02T20:41:42.335Z",
  lastError: "GHL_CRM_CONTROL_DISABLED", leaseExpiresAt: null,
} as any;
let stepped = 0;
const recoveryDeps = {
  queryPointers: async (query: string, values: string[]) => {
    assert.equal(query, PENDING_GHL_COMMAND_POINTERS_SQL);
    assert.match(query, /key=\$1/);
    assert.match(query, /ghl_specialized_command_active_%/);
    assert.deepEqual(values, ["ghl_specialized_command_active"]);
    return { rows: [{ run_id: blockedRun.runId }] };
  },
  readRun: async () => blockedRun,
  stepRun: async (id: string, limit = 1) => {
    assert.equal(id, blockedRun.runId);
    assert.equal(limit, 1);
    stepped++;
    return { leaseBusy: false, run: { ...blockedRun, state: "pending", cursor: 1, processed: 1, lastError: null } };
  },
};
const recovered = await runPendingGhlSpecializedCommands(1, true, recoveryDeps);
assert.equal(recovered.advanced, true, "the shared pointer must recover a historical write-control-blocked read");
assert.equal(stepped, 1);
blockedRun.state = "running";
blockedRun.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
await runPendingGhlSpecializedCommands(1, true, recoveryDeps);
assert.equal(stepped, 2, "an interrupted running command with an expired lease is recoverable");
blockedRun.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
assert.equal((await runPendingGhlSpecializedCommands(1, true, recoveryDeps)).advanced, false);
assert.equal(stepped, 2, "a live owner lease must not be stolen");
blockedRun.leaseExpiresAt = null;
blockedRun.state = "blocked";
blockedRun.kind = "permission_projection";
assert.equal((await runPendingGhlSpecializedCommands(1, true, recoveryDeps)).advanced, false);
assert.equal(stepped, 2, "read-only recovery must never dispatch permission writes");
blockedRun.kind = "contact_id_backfill";
blockedRun.state = "complete";
assert.equal((await runPendingGhlSpecializedCommands(1, true, recoveryDeps)).advanced, false);
assert.equal(stepped, 2, "completed commands must not replay");
if (process.argv.includes("--database")) {
  const { pool } = await import("../db");
  try {
    // A read-only CTE shadows system_settings: exercise the actual selector
    // without inserting commands, changing production, or calling GHL.
    for (const [canonical, legacy, expected] of [
      ["shared-run", "legacy-run", "shared-run"],
      [null, "legacy-run", "legacy-run"],
      ["shared-run", null, "shared-run"],
      [null, null, null],
    ]) {
      const result = await pool.query(`
        WITH system_settings(key,value,updated_at) AS (
          VALUES ($1::text,to_jsonb($2::text),now()),
            ($1::text||'_contact_id_backfill',to_jsonb($3::text),now()-interval '1 day')
        ) ${PENDING_GHL_COMMAND_POINTERS_SQL}`,
        ["ghl_specialized_command_active", canonical, legacy]);
      assert.deepEqual(result.rows.map(row => row.run_id), expected ? [expected] : []);
    }
    console.log("GHL pointer SQL: canonical authority precedence, legacy fallback, and empty-pointer cases passed.");
  } finally { await pool.end(); }
}
console.log("GHL specialized command safety tests passed (mocked lookup, opt-out, unreviewed-write refusal, shared-pointer recovery, expired-lease recovery, bounded ownership).");