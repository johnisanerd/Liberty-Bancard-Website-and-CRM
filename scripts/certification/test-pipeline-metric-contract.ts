import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "pipeline metric contract certification", requireRedis: false });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool } = await import("../../server/db");
const { readPipelineAnalytics } = await import("../../server/services/revenue-read-authority");
const { computeRate } = await import("../../shared/metric-contract");
const { OPEN_SALES_LEAD_STAGES } = await import("../../shared/schema");
const nonce = randomUUID().replaceAll("-", "").slice(0, 10);
const repEmail = `rep-${nonce}@metric.example.test`, otherRep = `other-${nonce}@metric.example.test`;
let checks = 0;
const check = (v: unknown, m: string) => { assert(v, m); checks++; };
const deal = (stage: string, o: { owner?: string | null; cls?: string; archived?: boolean; pipeline?: string } = {}) =>
  pool.query(`INSERT INTO deals (stage,pipeline,owner,record_class,archived_at) VALUES($1,$2,$3,$4,$5)`,
    [stage, o.pipeline ?? "sales", o.owner === undefined ? null : o.owner, o.cls ?? "production", o.archived ? new Date() : null]);
const admin = { role: "admin", email: `admin-${nonce}@metric.example.test` };
const rep = { role: "agent", email: repEmail };
const stalePast = async (owner: string) => pool.query(`UPDATE deals SET updated_at = NOW() - INTERVAL '10 days' WHERE owner=$1 AND stage='Proposal Sent'`, [owner]);

try {
  // Rate helper.
  check(computeRate(0, 0).percent === null && !computeRate(0, 0).available, "Empty denominator is unavailable, never 0%");
  check(computeRate(1, 3).percent === 33 && computeRate(0, 4).percent === 0 && computeRate(0, 4).available, "A real 0% stays 0%");

  const base = (await readPipelineAnalytics(admin)).data.sales;
  const repBaseline = (await readPipelineAnalytics(rep)).data.sales;

  // Rep-owned fixtures cover every stage class, plus rows that must never count.
  for (const stage of OPEN_SALES_LEAD_STAGES) await deal(stage, { owner: repEmail });
  await deal("Nurture / Not Now", { owner: repEmail });
  await deal("Legacy Unknown Stage", { owner: repEmail });
  await deal("Closed Lost", { owner: repEmail });
  await deal("New Lead", { owner: repEmail, archived: true });
  await deal("New Lead", { owner: repEmail, cls: "test" });
  await deal("Closed Won", { owner: repEmail, cls: "test" });
  await deal("New Lead", { owner: otherRep });
  await deal("Closed Won", { owner: otherRep });
  await deal("Onboarding thing", { owner: repEmail, pipeline: "onboarding" });
  await stalePast(repEmail);

  const r = (await readPipelineAnalytics(rep)).data.sales;
  const d = (k: keyof typeof r) => (r[k] as number) - (repBaseline[k] as number);
  check(d("active") === OPEN_SALES_LEAD_STAGES.length, "Active pipeline counts exactly the shared open stages (Nurture, unknown, closed, archived and non-production excluded)");
  check(d("nurture") === 1 && d("unclassifiedStage") === 1, "Nurture and unrecognized stages are counted separately, not silently inside Active");
  check(d("closedLost") === 1 && d("closedWon") === 0, "Non-production and archived outcomes do not count; rep sees only own deals");
  check(d("total") === OPEN_SALES_LEAD_STAGES.length + 3 + 0 && d("total") === d("active") + d("nurture") + d("unclassifiedStage") + d("closedWon") + d("closedLost"),
    "Total equals open + nurture + unclassified + won + lost: every deal lands in exactly one bucket");
  check(d("stallingDeals") === 1, "Stalling counts open stages only");
  check(r.winRateBasis.numerator === r.closedWon && r.winRateBasis.denominator === r.closedWon + r.closedLost, "Win-rate basis exposes numerator and denominator");

  // Privileged scope sees the other rep's rows too.
  const a = (await readPipelineAnalytics(admin)).data.sales;
  check(a.active - base.active === OPEN_SALES_LEAD_STAGES.length + 1, "Privileged scope adds the other rep's open deal");
  check(a.closedWon - base.closedWon === 1, "Privileged scope adds the other rep's Closed Won");

  // Empty denominator and a decided deal.
  const lone = { role: "agent", email: `lone-${nonce}@metric.example.test` };
  await deal("New Lead", { owner: lone.email });
  const loneRes = (await readPipelineAnalytics(lone)).data.sales;
  check(loneRes.winRate === null && loneRes.winRateBasis.available === false && loneRes.winRateBasis.denominator === 0, "No decided deals: winRate is null and unavailable");
  await deal("Closed Won", { owner: lone.email });
  const won = (await readPipelineAnalytics(lone)).data.sales;
  check(won.winRate === 100 && won.winRateBasis.numerator === 1 && won.winRateBasis.denominator === 1, "One decided deal gives a real 100% with its fraction");
  await deal("Closed Lost", { owner: lone.email });
  check((await readPipelineAnalytics(lone)).data.sales.winRate === 50, "Win rate is won / (won + lost)");

  // Chargeback rate shares the contract.
  const { DatabaseStorage } = await import("../../server/storage");
  const storage = new (DatabaseStorage as any)();
  const none = await storage.getChargebackStats();
  if (none.thisMonthWinRateBasis.denominator === 0) check(none.thisMonthWinRate === null, "No decided disputes this month: rate is null");
  await pool.query(`INSERT INTO chargebacks (transaction_date,amount,card_brand,reason_code,status) VALUES(NOW(),100,'visa','10.4','Won'),(NOW(),100,'visa','10.4','Lost')`);
  const dec = await storage.getChargebackStats();
  check(dec.thisMonthWinRateBasis.denominator === none.thisMonthWinRateBasis.denominator + 2 && dec.thisMonthWinRate !== null, "Decided disputes produce a rate with numerator and denominator");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider network attempt");
  console.log(`Pipeline metric contract: ${checks} checks passed`);
} finally { await pool.end(); }
