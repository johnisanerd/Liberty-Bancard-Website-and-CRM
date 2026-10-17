/**
 * Read-only Serper lookup report: outcome mix, rejection reasons, repeat purchases and
 * request / reported-credit / ledger accounting, kept as separate figures.
 *
 *   npx tsx scripts/report-serper-lookup-outcomes.ts [--days=7] [--dashboard-used=N --dashboard-remaining=N]
 *
 * Dashboard figures are typed in by the operator (the provider search responses expose no
 * balance). The report prints them next to the ledger figures and the difference, but never
 * derives a per-call credit factor. It reads whichever database DATABASE_URL points at,
 * performs no writes and makes no provider calls.
 */
import { pool } from "../server/db";

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const days = Math.max(1, Math.min(90, Number(arg("days") ?? 7)));
const num = (v: unknown) => Number(v ?? 0);

async function main() {
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

  const outcomes = await q(
    `SELECT strategy_name, outcome_kind, count(*)::int AS attempts,
            COALESCE(sum(billed_units),0)::int AS requests,
            COALESCE(sum(reported_credits),0)::int AS reported_credits,
            count(reported_credits)::int AS attempts_reporting_credits
       FROM serper_lookup_attempts WHERE created_at>NOW()-make_interval(days=>$1)
      GROUP BY 1,2 ORDER BY 1,2`, [days]);
  console.log(`\n== Requests by strategy and outcome (last ${days}d) ==`);
  console.table(outcomes);

  const reasons = await q(
    `SELECT outcome_reason, count(*)::int AS attempts FROM serper_lookup_attempts
      WHERE created_at>NOW()-make_interval(days=>$1) AND outcome_kind='identity_rejected' AND outcome_reason IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [days]);
  console.log("\n== Rejection reasons (kg_ prefix = knowledge-graph candidate) ==");
  console.table(reasons);

  const repeats = await q(
    `SELECT lookups, count(*)::int AS distinct_business_queries FROM (
        SELECT correlation_hash, count(*)::int AS lookups FROM serper_lookup_attempts
         WHERE created_at>NOW()-make_interval(days=>$1) AND strategy_name='places_primary_name'
         GROUP BY 1) t GROUP BY 1 ORDER BY 1`, [days]);
  console.log("\n== Repeat purchases: first-strategy requests per distinct business query ==");
  console.table(repeats);

  const memory = await q(
    `SELECT COALESCE(outcome_class,'(claim only)') AS outcome_class, count(*)::int AS businesses,
            count(*) FILTER (WHERE expires_at>NOW())::int AS unexpired
       FROM sfp_serper_lookup_memory GROUP BY 1 ORDER BY 2 DESC`);
  console.log("\n== Lookup memory ==");
  console.table(memory);

  const control = (await q(
    `SELECT local_budget_units, consumed_units, reserved_units FROM provider_controls WHERE provider='serper' LIMIT 1`))[0];
  const requests = outcomes.reduce((a: number, r: any) => a + num(r.requests), 0);
  const reported = outcomes.reduce((a: number, r: any) => a + num(r.reported_credits), 0);
  const reporting = outcomes.reduce((a: number, r: any) => a + num(r.attempts_reporting_credits), 0);
  console.log(`\n== Accounting (separate figures; none is derived from another) ==`);
  console.log(`Requests sent (last ${days}d):                 ${requests}`);
  console.log(`Credits the provider reported (last ${days}d): ${reported} across ${reporting} attempts that reported a value`);
  console.log(`Local ledger consumed / reserved / ceiling:   ${control ? `${control.consumed_units} / ${control.reserved_units} / ${control.local_budget_units}` : "no provider_controls row"}`);
  const used = arg("dashboard-used"); const remaining = arg("dashboard-remaining");
  if (used || remaining) {
    console.log(`Dashboard (operator-entered):                 used=${used ?? "?"} remaining=${remaining ?? "?"}`);
    if (used && control) console.log(`Dashboard used minus ledger consumed:         ${Number(used) - num(control.consumed_units)} (a gap means the ledger is not measuring provider credits)`);
  }
  console.log("No per-call credit factor is assumed anywhere in this report.");
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
