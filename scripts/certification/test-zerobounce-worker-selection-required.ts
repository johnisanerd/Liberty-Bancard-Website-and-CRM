import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import {
  applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount,
} from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "ZeroBounce worker selection-required certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { processZeroBounceRun } = await import("../../server/services/zerobounce-campaign-worker");

const tag = `zbsel_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };

await pool.query(`INSERT INTO provider_controls (provider,capability,enabled,circuit_state,local_budget_units,reserved_units,consumed_units,version)
  VALUES('zerobounce','email_validation',TRUE,'closed',100000,0,0,1)
  ON CONFLICT (provider) DO UPDATE SET enabled=TRUE,circuit_state='closed'`);
await pool.query("UPDATE zerobounce_campaigns SET status='cert_parked' WHERE status='active'");

// A production contact the canonical selection does not currently choose: no verified business link
// and no pending-validation preparation. createValidationIntent() returns false for it.
const contactId = Number((await pool.query(`INSERT INTO contacts (first_name,last_name,email,phone,record_class)
  VALUES('Selection','Required',$1,'','production') RETURNING id`, [`${tag}@example-test.com`])).rows[0].id);
const campaignId = String((await pool.query(`INSERT INTO zerobounce_campaigns (filter_definition,initial_eligible_total,created_by,status)
  VALUES($1::jsonb,1,$2,'active') RETURNING id`,
  [JSON.stringify({ issue: "unvalidated_email", minLeadScore: 0, contactIds: [contactId] }), tag])).rows[0].id);
const runId = String((await pool.query(`INSERT INTO zerobounce_runs (campaign_id,contact_limit,state,last_heartbeat_at)
  VALUES($1,10,'running',NOW()) RETURNING id`, [campaignId])).rows[0].id);

const verifyCalls: string[] = [];
const exit = await processZeroBounceRun(runId, {
  verifyEmail: async (email: string) => { verifyCalls.push(email); throw new Error("provider must not be reached"); },
  hasProviderKey: () => true,
} as any);
check(exit === "completed", "A contact the canonical selection does not choose does not fail or stall the run");
const attempt = (await pool.query("SELECT outcome,error_code,retryable FROM zerobounce_attempts WHERE campaign_id=$1 AND contact_id=$2", [campaignId, contactId])).rows[0];
check(attempt?.outcome === "skipped" && attempt.error_code === "canonical_validation_selection_required" && attempt.retryable === false,
  "The attempt is recorded as an explicit skip for the missing selection, not as an error carrying a TypeError");
check(verifyCalls.length === 0, "No provider validation was requested for an unselected contact");
check(Number((await pool.query("SELECT count(*)::int n FROM validation_intents WHERE contact_id=$1", [contactId])).rows[0].n) === 0,
  "No validation intent was created, so the selection rule was not bypassed");
check(getBlockedCertificationNetworkAttemptCount() === 0, "No attempted provider or network transport");
await pool.query("DELETE FROM zerobounce_campaigns WHERE id=$1", [campaignId]);
await pool.query("DELETE FROM contacts WHERE id=$1", [contactId]);
console.log(`PASS: ${checks} ZeroBounce worker selection-required checks`);
await pool.end();
