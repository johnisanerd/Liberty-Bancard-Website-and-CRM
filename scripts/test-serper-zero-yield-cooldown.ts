/**
 * test-serper-zero-yield-cooldown.ts — Serper zero-yield cooldown tests (#1599)
 *
 * Fake fetch transport via SerperGateway fetchOverride — never contacts Serper.
 * Saves/restores the serper_control row; creates and removes its own merchants.
 *
 * 11 cases:
 *  1. no-result attempt 1 → serper_next_eligible_at ≈ +24 h
 *  2. no-result attempt 2 → ≈ +7 d
 *  3. no-result attempt 3+ → ≈ +30 d
 *  4. provider failure (5xx) leaves attempts + next_eligible untouched
 *  5. control failure (gate disabled) leaves attempts + next_eligible untouched
 *  6. partial match resets attempts, outcome=matched, ≈ +7 d cooldown
 *  7. complete match becomes ineligible for candidate selection
 *  8. concurrent workers cannot claim the same row (FOR UPDATE SKIP LOCKED)
 *  9. manual requeue is refused while the global gate is disabled
 * 10. manual requeue clears cooldown when gate permits
 * 11. backfilled zero-yield merchants are ineligible immediately after migration
 *
 * Run: npx tsx scripts/test-serper-zero-yield-cooldown.ts
 */

import { pool, db } from "../server/db";
import { SerperGateway } from "../server/services/serper-gateway";
import {
  enrichMerchantWithSerper,
  claimSerperCandidates,
  requeueSerperForMerchant,
} from "../server/services/sdr/serper-enrichment";

process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || "test-key-fake";

const PREFIX = `zz-serper-cooldown-test-${Date.now()}`;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function fakeFetchByEndpoint(handlers: Record<string, { status: number; body: any }>) {
  return async (url: string) => {
    const key = url.includes("/places") ? "/places" : "/search";
    const h = handlers[key] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(h.body), {
      status: h.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function createMerchant(suffix: string, fields: Record<string, any> = {}): Promise<number> {
  const cols = ["business_name", ...Object.keys(fields).map(k => k)];
  const vals = [`${PREFIX}-${suffix}`, ...Object.values(fields)];
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO sdr_merchants (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`,
    vals,
  );
  return rows[0].id;
}

async function getMerchant(id: number) {
  const { rows } = await pool.query(`SELECT * FROM sdr_merchants WHERE id = $1`, [id]);
  return rows[0];
}

function hoursFromNow(ts: string | Date | null): number | null {
  if (!ts) return null;
  return (new Date(ts).getTime() - Date.now()) / 3_600_000;
}

async function setControl(fields: Record<string, any>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await pool.query(`UPDATE serper_control SET ${sets}, updated_at = now() WHERE id = 1`, keys.map(k => fields[k]));
}

async function main() {
  const { rows: origRows } = await pool.query(`SELECT * FROM serper_control WHERE id = 1`);
  const original = origRows[0];
  if (!original) { console.error("serper_control row missing — run migrations first."); process.exit(1); }

  const merchantIds: number[] = [];

  try {
    await setControl({
      enabled: true, state: "closed", consecutive_failures: 0, opened_at: null,
      reason_code: null, half_open_probe_claimed_at: null,
      window_calls: 0, window_successes: 0, window_failures: 0, local_budget: 50000,
    });

    const noResultGateway = new SerperGateway({
      fetchOverride: fakeFetchByEndpoint({ "/places": { status: 200, body: { places: [] } } }),
    });

    // ── Cases 1–3: progressive no-result backoff ─────────────────────────
    console.log("\nCases 1–3: progressive no-result cooldowns");
    const m1 = await createMerchant("backoff");
    merchantIds.push(m1);

    const r1 = await enrichMerchantWithSerper(m1, { gateway: noResultGateway });
    let row = await getMerchant(m1);
    let h = hoursFromNow(row.serper_next_eligible_at);
    check("attempt 1 → outcome no_result, attempts=1",
      r1.outcome === "no_result" && row.serper_no_result_attempts === 1 && row.serper_last_outcome === "no_result",
      JSON.stringify({ outcome: r1.outcome, attempts: row.serper_no_result_attempts }));
    check("attempt 1 → next_eligible ≈ +24h", h !== null && h > 23 && h < 25, `hours=${h}`);
    check("attempt 1 → last_serper_checked_at set", !!row.last_serper_checked_at);

    await pool.query(`UPDATE sdr_merchants SET serper_next_eligible_at = now() WHERE id = $1`, [m1]);
    await enrichMerchantWithSerper(m1, { gateway: noResultGateway });
    row = await getMerchant(m1);
    h = hoursFromNow(row.serper_next_eligible_at);
    check("attempt 2 → next_eligible ≈ +7d", row.serper_no_result_attempts === 2 && h !== null && h > 7 * 24 - 1 && h < 7 * 24 + 1, `attempts=${row.serper_no_result_attempts} hours=${h}`);

    await pool.query(`UPDATE sdr_merchants SET serper_next_eligible_at = now() WHERE id = $1`, [m1]);
    await enrichMerchantWithSerper(m1, { gateway: noResultGateway });
    row = await getMerchant(m1);
    h = hoursFromNow(row.serper_next_eligible_at);
    check("attempt 3 → next_eligible ≈ +30d", row.serper_no_result_attempts === 3 && h !== null && h > 30 * 24 - 1 && h < 30 * 24 + 1, `attempts=${row.serper_no_result_attempts} hours=${h}`);

    // ── Case 4: provider failure (5xx) leaves counters untouched ─────────
    console.log("\nCase 4: provider 5xx failure");
    const before4 = await getMerchant(m1);
    const gateway5xx = new SerperGateway({
      fetchOverride: fakeFetchByEndpoint({ "/places": { status: 500, body: {} } }),
    });
    const r4 = await enrichMerchantWithSerper(m1, { gateway: gateway5xx });
    row = await getMerchant(m1);
    // Since the Places-first identity lookup (#1768) the reason code is the lookup's provider-error
    // text, not the gateway's provider_5xx classification. The contract under test is that a 5xx
    // is a provider failure with a recorded reason, never a no-result.
    check("5xx → outcome provider_failure with a recorded 5xx reason",
      r4.outcome === "provider_failure" && row.serper_last_outcome === "provider_failure" &&
      /500|5xx/.test(String(row.serper_last_reason_code)) && row.serper_last_reason_code === r4.reasonCode,
      JSON.stringify({ outcome: r4.outcome, reason: row.serper_last_reason_code }));
    check("5xx → attempts + next_eligible + checked_at unchanged",
      row.serper_no_result_attempts === before4.serper_no_result_attempts &&
      String(row.serper_next_eligible_at) === String(before4.serper_next_eligible_at) &&
      String(row.last_serper_checked_at) === String(before4.last_serper_checked_at));

    // reset circuit damage from the 5xx failure
    await setControl({ state: "closed", consecutive_failures: 0, opened_at: null, reason_code: null });

    // ── Case 5: control failure (gate disabled) leaves counters untouched ─
    console.log("\nCase 5: gate disabled");
    await setControl({ enabled: false });
    const before5 = await getMerchant(m1);
    const r5 = await enrichMerchantWithSerper(m1, { gateway: noResultGateway });
    row = await getMerchant(m1);
    check("disabled → provider_failure reason=disabled, counters unchanged",
      r5.outcome === "provider_failure" && r5.reasonCode === "disabled" &&
      row.serper_last_reason_code === "disabled" &&
      row.serper_no_result_attempts === before5.serper_no_result_attempts &&
      String(row.serper_next_eligible_at) === String(before5.serper_next_eligible_at),
      JSON.stringify({ outcome: r5.outcome, reason: r5.reasonCode }));
    await setControl({ enabled: true });

    // ── Case 6: partial match resets attempts + 7d cooldown ──────────────
    console.log("\nCase 6: partial match");
    const m2 = await createMerchant("partial", { city: "Miami", state: "FL", zip: "33130" });
    merchantIds.push(m2);
    await pool.query(`UPDATE sdr_merchants SET serper_no_result_attempts = 2 WHERE id = $1`, [m2]);
    const partialGateway = new SerperGateway({
      fetchOverride: fakeFetchByEndpoint({
        "/places": { status: 200, body: { places: [{ title: `${PREFIX}-partial`, address: "1 Main St, Miami, FL 33130", phoneNumber: "(305) 555-0142" }] } },
        "/search": { status: 200, body: { organic: [] } },
      }),
    });
    const r6 = await enrichMerchantWithSerper(m2, { gateway: partialGateway });
    row = await getMerchant(m2);
    h = hoursFromNow(row.serper_next_eligible_at);
    check("partial match → matched, attempts reset to 0, phone captured",
      r6.outcome === "matched" && row.serper_no_result_attempts === 0 &&
      row.serper_last_outcome === "matched" && row.main_phone === "3055550142",
      JSON.stringify({ outcome: r6.outcome, attempts: row.serper_no_result_attempts, phone: row.main_phone }));
    check("partial match → cooldown ≈ +7d (not immediately re-selected)",
      h !== null && h > 7 * 24 - 1 && h < 7 * 24 + 1, `hours=${h}`);

    // ── Case 7: complete match becomes ineligible ─────────────────────────
    console.log("\nCase 7: complete match");
    const m3 = await createMerchant("complete", { city: "Miami", state: "FL", zip: "33130" });
    merchantIds.push(m3);
    const completeGateway = new SerperGateway({
      fetchOverride: fakeFetchByEndpoint({
        "/places": { status: 200, body: { places: [{ title: `${PREFIX}-complete`, website: "https://www.example-biz.com", phoneNumber: "(305) 555-0177", address: "1 Main St, Miami, FL 33130" }] } },
        "/search": { status: 200, body: { organic: [{ snippet: "contact us at info@example-biz.com" }] } },
      }),
    });
    const r7 = await enrichMerchantWithSerper(m3, { gateway: completeGateway });
    row = await getMerchant(m3);
    // Serper no longer collects email (identity kill line; claimSerperCandidates excludes
    // main_email), so a complete match is website + phone and no email is ever written.
    check("complete match → website and phone filled, no email, next_eligible NULL",
      r7.outcome === "matched" && !!row.website && !!row.main_phone && !row.main_email && row.serper_next_eligible_at === null,
      JSON.stringify({ website: row.website, phone: row.main_phone, email: row.main_email, next: row.serper_next_eligible_at }));
    const { rows: claim7 } = await pool.query(
      `SELECT id FROM sdr_merchants
       WHERE id = $1
         AND (website IS NULL OR main_phone IS NULL)
         AND do_not_contact_flag IS NOT TRUE
         AND (serper_next_eligible_at IS NULL OR serper_next_eligible_at <= now())`,
      [m3],
    );
    check("complete match → excluded from candidate eligibility", claim7.length === 0);

    // ── Case 8: concurrent workers cannot claim the same row ─────────────
    console.log("\nCase 8: concurrent claim (FOR UPDATE SKIP LOCKED)");
    const mA = await createMerchant("claim-a");
    const mB = await createMerchant("claim-b");
    merchantIds.push(mA, mB);

    let releaseTx1!: () => void;
    const tx1Holds = new Promise<void>((res) => { releaseTx1 = res; });
    let tx1Ids: number[] = [];
    let tx2Ids: number[] = [];

    const tx1Done = db.transaction(async (tx) => {
      const rows = await claimSerperCandidates(tx as any, 10000);
      tx1Ids = rows.map(r => Number(r.id));
      await tx1Holds; // keep locks while tx2 claims
    });
    // give tx1 time to acquire locks
    await new Promise(r => setTimeout(r, 800));
    await db.transaction(async (tx) => {
      const rows = await claimSerperCandidates(tx as any, 10000);
      tx2Ids = rows.map(r => Number(r.id));
    });
    releaseTx1();
    await tx1Done;

    const overlap = tx2Ids.filter(id => tx1Ids.includes(id));
    check("concurrent transactions claim disjoint rows",
      tx1Ids.length >= 2 && overlap.length === 0,
      `tx1=${tx1Ids.length} tx2=${tx2Ids.length} overlap=${overlap.length}`);
    check("test merchants were claimed by exactly one worker each",
      [mA, mB].every(id => tx1Ids.includes(id) !== tx2Ids.includes(id)),
      JSON.stringify({ mA_tx1: tx1Ids.includes(mA), mA_tx2: tx2Ids.includes(mA), mB_tx1: tx1Ids.includes(mB), mB_tx2: tx2Ids.includes(mB) }));

    // ── Case 9: requeue refused while gate disabled ───────────────────────
    console.log("\nCase 9: requeue blocked while gate disabled");
    await setControl({ enabled: false });
    await pool.query(
      `UPDATE sdr_merchants SET serper_next_eligible_at = now() + interval '7 days', serper_no_result_attempts = 2 WHERE id = $1`,
      [m1],
    );
    const rq1 = await requeueSerperForMerchant(m1);
    row = await getMerchant(m1);
    check("requeue refused with reason=disabled; cooldown intact",
      rq1.ok === false && rq1.reason === "disabled" &&
      row.serper_no_result_attempts === 2 && row.serper_next_eligible_at !== null,
      JSON.stringify(rq1));

    // ── Case 10: requeue clears cooldown when gate permits ───────────────
    console.log("\nCase 10: requeue success");
    await setControl({ enabled: true, state: "closed" });
    const rq2 = await requeueSerperForMerchant(m1);
    row = await getMerchant(m1);
    check("requeue clears next_eligible + attempts",
      rq2.ok === true && row.serper_next_eligible_at === null && row.serper_no_result_attempts === 0,
      JSON.stringify({ rq2, next: row.serper_next_eligible_at, attempts: row.serper_no_result_attempts }));

    // ── Case 11: backfilled merchants are ineligible now ──────────────────
    console.log("\nCase 11: backfill leaves zero-yield merchants ineligible");
    // The cooldown lapses by design, so a long-lived database cannot assert that rows from the
    // original migration are STILL cooling. Assert the contract two ways instead:
    // (1) no backfilled row lost its cooldown timestamp, and
    // (2) the migration's own UPDATE puts a never-checked zero-yield merchant into a future
    //     cooldown (run inside a transaction that is rolled back).
    const { rows: bf } = await pool.query(
      `SELECT count(*) FILTER (WHERE serper_next_eligible_at IS NULL) AS lost, count(*) AS total
       FROM sdr_merchants WHERE serper_last_reason_code = 'backfill_zero_yield'`,
    );
    check("no backfilled merchant lost its cooldown timestamp", Number(bf[0].lost) === 0, JSON.stringify(bf[0]));
    const migrationSql = (await import("node:fs")).readFileSync("migrations/0141_serper_merchant_cooldown.sql", "utf8");
    const backfill = migrationSql.slice(migrationSql.indexOf("UPDATE sdr_merchants"), migrationSql.indexOf(";", migrationSql.indexOf("UPDATE sdr_merchants")) + 1);
    const m11 = await createMerchant("backfill-probe");
    merchantIds.push(m11);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(backfill);
      const { rows: probe } = await client.query(
        `SELECT serper_next_eligible_at > now() AS cooling, serper_last_reason_code FROM sdr_merchants WHERE id=$1`, [m11]);
      check("the backfill statement puts a zero-yield merchant into a future cooldown",
        probe[0]?.cooling === true && probe[0]?.serper_last_reason_code === "backfill_zero_yield", JSON.stringify(probe[0]));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  } finally {
    // Cleanup test merchants (+ dependent rows) and restore control row.
    if (merchantIds.length > 0) {
      await pool.query(`DELETE FROM sdr_lead_events WHERE merchant_id = ANY($1)`, [merchantIds]).catch(() => {});
      await pool.query(`DELETE FROM sdr_lead_state WHERE merchant_id = ANY($1)`, [merchantIds]).catch(() => {});
      await pool.query(`DELETE FROM sdr_merchants WHERE id = ANY($1)`, [merchantIds]).catch(() => {});
    }
    const keys = Object.keys(original).filter(k => k !== "id");
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    await pool.query(`UPDATE serper_control SET ${sets} WHERE id = 1`, keys.map(k => original[k]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
